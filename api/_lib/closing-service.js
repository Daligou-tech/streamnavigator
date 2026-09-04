// The document-only audit service.
//
// One entry point. It takes the documents the customer uploaded and returns
// everything the page needs: findings, what was checked, what could not be, the
// tier, and the price. Nothing in here consults a rate table, a benchmark
// corpus, a market average or any external data source. Every finding is
// arithmetic or a rule applied to the customer's own documents.
//
// Why this file exists rather than calling runClosingAudit directly:
//
//   1. A benchmark-free product needs a different headline. "10 of 14 fees, no
//      rate data" measures a corpus we no longer claim to have. The honest
//      denominator for this product is CHECKS, not fees: "19 of 24 checks ran,
//      5 need your Loan Estimate." That number can reach 24. The fee-coverage
//      number never could.
//
//   2. Price has to follow the analysis that actually ran. The catalog below
//      records, per check, which document it needs, so the upgrade price is
//      computed from checks that produced a result -- not from files that
//      arrived. An unreadable Loan Estimate does not become $59.
//
//   3. Benchmark findings are suppressed structurally, not by configuration.
//      Passing a null getBenchmark still emits a CANNOT_BENCHMARK finding per
//      fee, which would fill the report with a promise we are not making.

'use strict';

const audit = require('./closing-audit');
const { runClosingAudit, buildScorecard } = require('./closing-extract');
const loanMath = require('./closing-math');
const { checkSectionTotals } = require('./section-benchmark');
const { describeCoverage } = require('./benchmark-coverage');
const { buildEmails } = require('./closing-emails');

// Benchmarking is ON, but its gaps are disclosed by NAME rather than by count.
//
// The corpus is loaded where we hold data and returns null where we do not.
// CANNOT_BENCHMARK findings are still dropped from the customer's finding list,
// because "we have no rate data for your appraisal fee" is not a finding about
// her loan -- it is a fact about our corpus. That fact belongs in the coverage
// disclosure she reads BEFORE paying, naming the exact categories, not buried
// in the report she paid for.
//
// NO_BENCHMARKS remains exported for tests and for running the audit with
// benchmarking deliberately absent.
// The corpus is loaded once. If it is malformed it refuses to load entirely
// rather than serve part of itself, and every category falls back to unpriced.
let cachedGetBenchmark = null;
function defaultGetBenchmark() {
  if (cachedGetBenchmark) return cachedGetBenchmark;
  try {
    const { makeGetBenchmark } = require('./benchmark-corpus');
    const corpus = require('../../data/benchmarks.json');
    cachedGetBenchmark = makeGetBenchmark(corpus.rows || []);
  } catch (err) {
    console.error('[closing-service] benchmark corpus unavailable:', err.message);
    cachedGetBenchmark = NO_BENCHMARKS;
  }
  return cachedGetBenchmark;
}

const NO_BENCHMARKS = () => null;
NO_BENCHMARKS.stacked = () => ({ total: null, components: [] });

const BENCHMARK_CHECK_IDS = new Set(['BENCHMARK', 'TRANSFER_TAX_TOTAL']);

// ---------------------------------------------------------------------------
// the catalog
// ---------------------------------------------------------------------------

// Every check the service can run, and what it needs to run. This is the
// denominator on the scorecard and the basis for the price, so it is the one
// list that must stay in step with the engine. `test/closing-service.test.js`
// asserts that every checkId the engine can emit appears here.

const Needs = {
  CD: 'closing_disclosure',
  LE: 'loan_estimate',
  CONTRACT: 'purchase_contract',
  ANSWERS: 'your_answers',
  OTHER_DOC: 'another_document',
};

const CATALOG = [
  // --- arithmetic on the CD itself -----------------------------------------
  { id: 'ARITH_CASH_TO_CLOSE', needs: Needs.CD, group: 'arithmetic',
    label: 'Cash to Close reconciles with the closing cost total' },
  { id: 'LOAN_MATH_PI', needs: Needs.CD, group: 'arithmetic',
    label: 'Monthly payment amortises the stated loan terms' },
  { id: 'LOAN_MATH_APR_FLOOR', needs: Needs.CD, group: 'arithmetic',
    label: 'APR is not below the note rate' },
  { id: 'LOAN_MATH_APR', needs: Needs.CD, group: 'arithmetic',
    label: 'APR agrees with the amount financed and payment' },
  { id: 'LOAN_MATH_FINANCE_CHARGE', needs: Needs.CD, group: 'arithmetic',
    label: 'Finance charge covers the interest the payments produce' },
  { id: 'LOAN_MATH_TOTAL_OF_PAYMENTS', needs: Needs.CD, group: 'arithmetic',
    label: 'Total of Payments covers the payment schedule' },
  { id: 'LOAN_MATH_AMOUNT_FINANCED', needs: Needs.CD, group: 'arithmetic',
    label: 'Amount financed does not exceed the loan amount' },
  { id: 'LOAN_MATH_TIP', needs: Needs.CD, group: 'arithmetic',
    label: 'Total Interest Percentage matches the schedule' },
  { id: 'LOAN_MATH_POINTS', needs: Needs.CD, group: 'arithmetic',
    label: 'Discount points match the percentage printed beside them' },
  { id: 'LOAN_MATH_ESCROW_MONTHLY', needs: Needs.CD, group: 'arithmetic',
    label: 'Monthly escrow matches the disclosed annual costs' },
  { id: 'PREPAID_INTEREST', needs: Needs.CD, group: 'arithmetic',
    label: 'Prepaid interest matches the per-diem and closing date' },
  { id: 'PRORATION', needs: Needs.CD, group: 'arithmetic',
    label: 'Tax and assessment prorations are correctly apportioned' },

  // --- structure and charges ------------------------------------------------
  { id: 'DUPLICATE_CANDIDATE', needs: Needs.CD, group: 'charges',
    label: 'No charge appears twice under different names' },
  { id: 'LENDER_FEE_STACKING', needs: Needs.CD, group: 'charges',
    label: 'Lender fees are not stacked into overlapping charges' },
  { id: 'ESCROW_CUSHION', needs: Needs.CD, group: 'charges',
    label: 'Escrow cushion is within the RESPA limit' },

  // --- document integrity ---------------------------------------------------
  { id: 'EXTRACTION_CONFIDENCE', needs: Needs.CD, group: 'document',
    label: 'Every figure used was read clearly' },
  { id: 'DOCUMENT_PROBLEM', needs: Needs.CD, group: 'document',
    label: 'The document is complete and legible' },
  { id: 'DOCUMENT_SCOPE', needs: Needs.CD, group: 'document',
    label: 'The document is the one the checks assume' },

  // --- needs your answers ---------------------------------------------------
  { id: 'PROPERTY_TYPE_HOA_MISMATCH', needs: Needs.ANSWERS, group: 'charges',
    label: 'HOA charges match the property type' },
  { id: 'PROPERTY_TYPE_NO_HOA', needs: Needs.ANSWERS, group: 'charges',
    label: 'No HOA charges on a property without an association' },

  // --- needs the Loan Estimate ---------------------------------------------
  { id: 'TRID_TRANSACTION_MISMATCH', needs: Needs.LE, group: 'tolerance',
    label: 'The Loan Estimate describes this same transaction' },
  { id: 'TRID_ZERO_TOLERANCE', needs: Needs.LE, group: 'tolerance',
    label: 'No zero-tolerance charge increased' },
  { id: 'TRID_TEN_PERCENT', needs: Needs.LE, group: 'tolerance',
    label: 'The 10% basket did not exceed its limit' },
  { id: 'TRID_BASELINE_TIMING', needs: Needs.LE, group: 'tolerance',
    label: 'The correct Loan Estimate was used as the baseline' },
  { id: 'TRID_BASELINE_CIRCUMSTANCE', needs: Needs.LE, group: 'tolerance',
    label: 'Any revised Loan Estimate had a valid changed circumstance' },
  { id: 'TRID_UNMATCHED_CHARGE', needs: Needs.LE, group: 'tolerance',
    label: 'Every charge on the CD traces back to the Loan Estimate' },

  // --- needs the purchase contract -----------------------------------------
  { id: 'CONTRACT_RECON', needs: Needs.CONTRACT, group: 'contract',
    label: 'The CD reflects the price, credits and dates you agreed' },
];

const CATALOG_BY_ID = new Map(CATALOG.map((c) => [c.id, c]));

const GROUP_LABELS = {
  arithmetic: 'Arithmetic on your Closing Disclosure',
  charges: 'Charges and escrow',
  document: 'Document integrity',
  tolerance: 'Were the increases permitted?',
  contract: 'Does it match your contract?',
};

// ---------------------------------------------------------------------------
// pricing
// ---------------------------------------------------------------------------

// Flat $59. Two-tier pricing was retired: the old structure charged $30 more
// for supplying better documents, which gave price-sensitive customers a reason
// to withhold exactly the documents that find recoverable money. `basic` and
// `full` survive as coverage labels — which analysis ran — so both must carry
// the same number. The page prints $59 and the pay button always uses the full
// Stripe link; anything here that disagrees is a mispriced payload waiting to
// be rendered.
const FLAT_PRICE = 59;
const PRICES = { basic: FLAT_PRICE, full: FLAT_PRICE };

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

const isEmptyObject = (o) => !o || (typeof o === 'object' && Object.keys(o).length === 0);

/**
 * @param {object}   input
 * @param {object}   input.extraction     the Closing Disclosure extraction
 * @param {object[]} [input.loanEstimates]
 * @param {object}   [input.contractTerms]
 * @param {object}   [input.answers]
 * @param {string[]} [input.unusableDocuments] e.g. ['loan_estimate'] when a file
 *        arrived but could not be read. Present so the price explanation can say
 *        WHY it dropped, rather than silently charging less.
 */
function runDocumentAudit(input = {}) {
  const {
    extraction,
    loanEstimates = null,
    contractTerms = null,
    answers = {},
    unusableDocuments = [],
    getBenchmark = defaultGetBenchmark(),
  } = input;

  if (!extraction) throw new Error('runDocumentAudit requires an extraction');

  // --- run the engine, benchmarks absent ------------------------------------
  const engine = runClosingAudit(extraction, {
    answers, loanEstimates, contractTerms, getBenchmark,
  });

  const engineFindings = (engine.findings || engine || [])
    .filter((f) => !BENCHMARK_CHECK_IDS.has(f.checkId))
    .filter((f) => f.severity !== audit.Severity.CANNOT_BENCHMARK);
  const engineSkipped = engine.skipped || [];

  // --- document-intrinsic loan math ----------------------------------------
  const lc = extraction.loan_calculations || {};
  const esc = extraction.escrow || {};
  const v = (x) => (x && typeof x.value === 'number' ? x.value : (typeof x === 'number' ? x : null));

  const math = loanMath.runLoanMath({
    loanAmount: extraction.loan_amount,
    annualRatePct: extraction.interest_rate_pct,
    termMonths: extraction.loan_term_years ? extraction.loan_term_years * 12 : null,
    statedPI: v(extraction.monthly_principal_interest),
    amountFinanced: v(lc.amount_financed),
    financeCharge: v(lc.finance_charge),
    totalOfPayments: v(lc.total_of_payments),
    statedApr: lc.annual_percentage_rate_pct,
    statedTipPct: lc.total_interest_percentage_pct,
    monthlyEscrow: v(esc.monthly_escrow_payment),
    escrowedPropertyCostsYear1: v(esc.escrowed_property_costs_year1),
    pointsLines: (extraction.points_lines || []).map((p) => ({
      pointsPct: p.points_pct, chargedAmount: p.charged_amount,
    })),
    terms: extraction.loan_terms_features || {},
  });

  // Section totals against what comparable loans actually paid. This is the
  // only check resting on other people's transactions, and section-benchmark.js
  // caps its severity so it can never read as an established overcharge.
  const st = extraction.section_totals || {};
  const sectionCtx = {
    state: extraction.property_state,
    county: extraction.property_county,
    propertyAddress: extraction.property_address,
    loanAmount: extraction.loan_amount,
    salePrice: extraction.sale_price,
  };
  const sections = checkSectionTotals({
    sectionTotals: { A: v(st.A), D: v(st.D) },
    getBenchmark,
    ctx: sectionCtx,
  });

  const findings = [...engineFindings, ...math.findings, ...sections.findings];
  const skipped = [...engineSkipped, ...math.skipped, ...sections.skipped];

  // Which named charge categories we can price for THIS property. Read before
  // payment, so nobody buys a report to discover what is not in it.
  const presentCategories = [...new Set(
    (extraction.line_items || []).map((li) => li.category).filter(Boolean)
  )];
  const benchmarkCoverage = describeCoverage(getBenchmark, sectionCtx, presentCategories);

  // --- what documents do we actually have, usably? -------------------------
  const have = {
    [Needs.CD]: true,
    [Needs.LE]: Array.isArray(loanEstimates) && loanEstimates.length > 0,
    [Needs.CONTRACT]: !isEmptyObject(contractTerms),
    [Needs.ANSWERS]: !isEmptyObject(answers),
    [Needs.OTHER_DOC]: false,
  };

  // --- coverage: which catalog checks produced a result ---------------------
  const emitted = new Set(findings.map((f) => f.checkId));

  // A refinance has no purchase contract, so a check that needs one is not
  // waiting on a document the customer forgot — it does not apply to this
  // transaction at all. Reporting it as blocked asks a refinancing customer for
  // a sales contract that does not exist, and inflates the denominator with a
  // check that can never run.
  const isRefinance = String(answers.transaction_type || '').toLowerCase() === 'refinance';

  const coverage = CATALOG.map((c) => {
    if (isRefinance && c.needs === Needs.CONTRACT) {
      return {
        ...c,
        status: 'not_applicable',
        notApplicableReason: 'There is no purchase contract on a refinance.',
        outOfScope: true,
      };
    }
    if (!have[c.needs]) {
      return { ...c, status: 'needs_document', blockedBy: c.needs };
    }
    if (emitted.has(c.id)) return { ...c, status: 'ran' };
    // The document is here but the check produced nothing. Either it had no
    // subject on this loan (no points charged, no prorations) or an input was
    // unreadable. skipped[] carries the reason when there is one.
    return { ...c, status: 'not_applicable' };
  });

  const ran = coverage.filter((c) => c.status === 'ran');
  // A check that executed and found nothing wrong is a passing check, not an
  // absent one. `ran` above is emitted-based and drives pricing, so it stays as
  // it is; but it must never be the number shown to a customer. On a clean
  // document it is zero, which would tell the person whose closing is in good
  // order that we did nothing for them. `attempted` is the honest denominator:
  // every check whose inputs were present, whatever the outcome.
  const attempted = coverage.filter((c) => c.status === 'ran' || c.status === 'not_applicable'
    ? have[c.needs] && !c.outOfScope
    : false);
  // Checks that cannot apply to this transaction are removed from the
  // denominator rather than counted against it.
  const inScopeTotal = CATALOG.length - coverage.filter((c) => c.outOfScope).length;
  const blocked = coverage.filter((c) => c.status === 'needs_document');
  const notApplicable = coverage.filter((c) => c.status === 'not_applicable');

  // --- tier and price: follows analysis that RAN ---------------------------
  const upgradeRan = ran.filter((c) => c.needs === Needs.LE || c.needs === Needs.CONTRACT);
  const isFull = upgradeRan.length > 0;

  const downgradeReasons = [];
  for (const d of unusableDocuments) {
    downgradeReasons.push(
      d === 'loan_estimate'
        ? 'A Loan Estimate was uploaded but could not be read, so tolerance testing did not run.'
        : d === 'purchase_contract'
          ? 'A purchase contract was uploaded but could not be read, so contract reconciliation did not run.'
          : `An uploaded ${d} could not be used.`);
  }
  if (!isFull && have[Needs.LE] && !unusableDocuments.includes('loan_estimate')) {
    downgradeReasons.push(
      'The Loan Estimate was readable but did not describe this same loan, so tolerance '
      + 'testing could not run against it.');
  }

  const price = isFull ? PRICES.full : PRICES.basic;

  // --- scorecard ------------------------------------------------------------
  const base = buildScorecard(extraction, findings, skipped);

  // Strip the benchmark vocabulary. These fields describe a corpus this service
  // does not use, and leaving them at zero reads as a failure rather than an
  // absence.
  delete base.benchmarkable_count;
  delete base.cannot_benchmark_count;

  const scorecard = {
    ...base,
    checks_run: ran.length,
    checks_total: CATALOG.length,
    checks_blocked: blocked.length,
    checks_not_applicable: notApplicable.length,
    // The honest headline for a document-only product: a denominator that can
    // actually be reached, and the exact documents that would reach it.
    // Two numbers, deliberately separate: how much of the audit we could run,
    // and how much it found. Collapsing them is what made a good result look
    // like a failure.
    checks_attempted: attempted.length,
    checks_in_scope: inScopeTotal,
    findings_count: ran.length,
    coverage_headline: blocked.length === 0
      ? `All ${inScopeTotal} checks that apply to your closing ran.`
      : `${attempted.length} of ${inScopeTotal} checks ran. `
        + `${blocked.length} need ${describeBlockers(blocked)}.`,
    unlocks: buildUnlocks(blocked),
    benchmark_coverage: benchmarkCoverage,
    // Removed: a four-line justification in small grey type, sitting directly
    // beneath a panel that had already made the same point in bullets. It was
    // read by nobody and pushed the unlock actions below the fold.
    evidence_basis: null,
  };

  // Ranked once, then reused. The emails must list findings in the same order
  // the report shows them, or a customer reading both sees two different
  // priorities for the same document.
  const rankedFindings = audit.rank ? audit.rank(findings) : findings;

  // Drafts for the customer to send. Routing is not decided here: every finding
  // already carries askLender / askSettlement, set by the check that produced
  // it. Either draft is null when nothing was routed to that party, and a clean
  // document correctly produces no emails at all.
  // Only fields the extractor actually captures. There is no loan number, no
  // settlement agent name and no contact names in the schema, so those are left
  // out rather than passed as undefined — buildEmails drops what it is not
  // given and never prints a placeholder at the customer.
  const emails = buildEmails(rankedFindings, {
    propertyAddress: extraction.property_address,
    closingDate: extraction.closing_date,
    borrowerName: Array.isArray(extraction.borrower_names)
      ? extraction.borrower_names.filter(Boolean).join(' and ')
      : null,
    lenderName: extraction.lender_name,
  });

  return {
    findings: rankedFindings,
    emails,
    skipped,
    coverage,
    coverage_by_group: groupCoverage(coverage),
    scorecard,
    tier: {
      id: isFull ? 'full' : 'basic',
      price,
      has_loan_estimate: have[Needs.LE],
      has_purchase_contract: have[Needs.CONTRACT],
      upgrade_checks_ran: upgradeRan.map((c) => c.id),
      price_explanation: isFull
        ? `${upgradeRan.length} additional checks ran against your extra documents.`
        : 'Priced at the Closing Disclosure rate because no check requiring another '
          + 'document produced a result.',
      downgrade_reasons: downgradeReasons,
    },
  };
}

function describeBlockers(blocked) {
  const labels = {
    [Needs.LE]: 'your Loan Estimate',
    [Needs.CONTRACT]: 'your purchase contract',
    [Needs.ANSWERS]: 'two quick answers from you',
    [Needs.OTHER_DOC]: 'another document',
  };
  const uniq = [...new Set(blocked.map((c) => c.blockedBy))].map((k) => labels[k] || k);
  if (uniq.length === 1) return uniq[0];
  return `${uniq.slice(0, -1).join(', ')} and ${uniq[uniq.length - 1]}`;
}

// Every blocked check is an upsell with a specific, actionable ask. Your note
// flagged dead-end upsells -- "needs the initial escrow account statement" with
// nowhere to upload one. Each entry here names a document the page can accept.
function buildUnlocks(blocked) {
  const byNeed = new Map();
  for (const c of blocked) {
    if (!byNeed.has(c.blockedBy)) byNeed.set(c.blockedBy, []);
    byNeed.get(c.blockedBy).push(c.label);
  }
  const copy = {
    [Needs.LE]: {
      title: 'Upload your Loan Estimate',
      why: 'It is the only way to test whether a fee was allowed to increase. Your lender '
        + 'sent it within three business days of your application.',
      accepts: 'loan_estimate',
    },
    [Needs.CONTRACT]: {
      title: 'Upload your purchase contract',
      why: 'It is the only record of the price, credits and dates you actually agreed to.',
      accepts: 'purchase_contract',
    },
    [Needs.ANSWERS]: {
      // The count is wrong the moment a question is added or made conditional,
      // and it was: the provider-list question is now only asked when a Loan
      // Estimate is present, so "two questions" overstated it on a CD-only
      // audit. Say what it is for instead of how many there are.
      title: 'Answer the property type question',
      why: 'It cannot be read off the Closing Disclosure.',
      accepts: 'answers',
    },
  };
  return [...byNeed.entries()]
    .filter(([need]) => copy[need])
    .map(([need, checks]) => ({ ...copy[need], unlocks_count: checks.length, unlocks: checks }));
}

function groupCoverage(coverage) {
  const out = {};
  for (const c of coverage) {
    if (!out[c.group]) out[c.group] = { label: GROUP_LABELS[c.group] || c.group, checks: [] };
    out[c.group].checks.push({ id: c.id, label: c.label, status: c.status });
  }
  return out;
}

module.exports = {
  runDocumentAudit,
  CATALOG,
  CATALOG_BY_ID,
  Needs,
  PRICES,
  BENCHMARK_CHECK_IDS,
  NO_BENCHMARKS,
};
