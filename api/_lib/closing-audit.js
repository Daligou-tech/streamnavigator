// Deterministic Closing Disclosure audit checks.
//
// Why this file exists: before it, the entire Closing Navigator "audit" was a
// ~150-word prompt string that asked the model to judge fees "grounded in
// general knowledge of standard closing-cost tolerances". That is the model's
// priors sold to a customer as analysis. Everything here is arithmetic or a
// table lookup, and every finding carries the basis it was decided on.
//
// Rules this module enforces structurally, not by instruction:
//   * No check invents a benchmark. compareToBenchmark() takes the benchmark as
//     an argument and returns CANNOT_BENCHMARK when it is null.
//   * Hard rules (statutes, filed rate tables, government fee schedules,
//     internal arithmetic) are never presented as market norms, or vice versa.
//   * Nothing here reaches a legal conclusion. The strongest severity available
//     is POTENTIAL_TRID_VIOLATION.
//
// All money is handled as integer cents internally. Inputs and outputs are
// dollars as Numbers.

'use strict';

// ---------------------------------------------------------------------------
// money
// ---------------------------------------------------------------------------

const toCents = (d) => Math.round(Number(d) * 100);
const toDollars = (c) => Math.round(c) / 100;

// ---------------------------------------------------------------------------
// taxonomy
// ---------------------------------------------------------------------------

const Severity = {
  CONFIRMED_MATH_ERROR: 'confirmed_mathematical_error',
  POTENTIAL_TRID_VIOLATION: 'potential_trid_violation',
  POTENTIAL_OVERCHARGE: 'potential_overcharge',
  ABOVE_BENCHMARK: 'above_available_benchmark',
  POTENTIAL_DUPLICATE: 'potential_duplicate',
  REQUIRES_DOCUMENTATION: 'requires_documentation',
  CANNOT_BENCHMARK: 'cannot_benchmark',
  INFORMATIONAL: 'informational_only',
  WITHIN_NORMS: 'within_norms',
};

const EvidenceKind = {
  HARD_STATUTE: 'hard_rule:statute_or_regulation',
  HARD_RATE_TABLE: 'hard_rule:promulgated_or_filed_rate',
  HARD_FEE_SCHEDULE: 'hard_rule:government_fee_schedule',
  INTERNAL_ARITHMETIC: 'hard_rule:internal_arithmetic',
  CONTRACT: 'hard_rule:contract_provision',
  MARKET_RANGE: 'market_norm:published_range',
  COMPARABLES: 'market_norm:comparable_transactions',
  NONE: 'no_evidence_available',
};

const Actionability = {
  CHANGEABLE_BEFORE_CLOSING: 'still_changeable_before_closing',
  LIKELY_LOCKED: 'likely_locked_informational',
  POST_CLOSING_REMEDY: 'potential_post_closing_remedy',
  NEEDS_DOCS: 'requires_additional_documentation',
};

const SEVERITY_ORDER = {
  [Severity.CONFIRMED_MATH_ERROR]: 0,
  [Severity.POTENTIAL_TRID_VIOLATION]: 1,
  [Severity.POTENTIAL_OVERCHARGE]: 2,
  [Severity.POTENTIAL_DUPLICATE]: 3,
  [Severity.ABOVE_BENCHMARK]: 4,
  [Severity.REQUIRES_DOCUMENTATION]: 5,
  [Severity.CANNOT_BENCHMARK]: 6,
  [Severity.INFORMATIONAL]: 7,
  [Severity.WITHIN_NORMS]: 8,
};

function finding(f) {
  return Object.assign(
    {
      checkId: '',
      title: '',
      severity: Severity.INFORMATIONAL,
      evidence: EvidenceKind.NONE,
      actionability: Actionability.LIKELY_LOCKED,
      dollarImpact: null,
      charged: null,
      expected: null,
      variance: null,
      basis: '',
      whyItMatters: '',
      recommendedAction: '',
      askLender: false,
      askSettlement: false,
      // True when any input to this check was typed by the customer rather than
      // read from the document. We cannot verify what they typed, so a finding
      // built on it must never present itself as independently confirmed.
      basedOnCustomerInput: false,
      detail: {},
    },
    f
  );
}

// Ranks everything and drops nothing. The UI highlights the top 5; it must not
// be the thing that decides which findings exist.
// Applies the customer-input caveat to a finding: flags it, downgrades a
// "confirmed" mathematical error to something the customer must verify first,
// and says so in the basis. A confirmed error means the DOCUMENT is wrong. If
// the number came from the customer's own typing, that has not been established.
function markCustomerSourced(f) {
  if (!f) return f;
  f.basedOnCustomerInput = true;
  f.basis = (f.basis ? f.basis + ' ' : '') +
    'Based on a figure you entered manually, which we could not read from the document and cannot verify.';
  if (f.severity === Severity.CONFIRMED_MATH_ERROR) {
    f.severity = Severity.REQUIRES_DOCUMENTATION;
    f.title = f.title + ' (based on your entered figure)';
    f.recommendedAction =
      'Double-check the figure you entered against the document before raising this. ' +
      (f.recommendedAction || '');
  }
  return f;
}

function rankFindings(findings) {
  return [...findings].sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    return (b.dollarImpact || 0) - (a.dollarImpact || 0);
  });
}

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------

// Parse 'YYYY-MM-DD' as UTC so nothing shifts with the server's timezone.
function parseDate(s) {
  if (s instanceof Date) return s;
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

const isoDate = (d) => parseDate(d).toISOString().slice(0, 10);

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

function daysToMonthEndInclusive(closing) {
  const c = parseDate(closing);
  return daysInMonth(c.getUTCFullYear(), c.getUTCMonth()) - c.getUTCDate() + 1;
}

const DAY_MS = 86400000;
const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / DAY_MS);
const addDays = (d, n) => new Date(parseDate(d).getTime() + n * DAY_MS);

// ---------------------------------------------------------------------------
// 1. prepaid / per-diem interest
// ---------------------------------------------------------------------------

function perDiem(loanAmount, annualRatePct, basis) {
  return (Number(loanAmount) * (Number(annualRatePct) / 100)) / basis;
}

function checkPrepaidInterest(opts) {
  const {
    loanAmount,
    annualRatePct,
    closingDate,
    chargedAmount,
    daysCharged = null,
    toleranceDollars = 1.0,
  } = opts;

  const charged = toCents(chargedAmount);
  const close = parseDate(closingDate);
  const days = daysCharged === null ? daysToMonthEndInclusive(close) : daysCharged;
  const actualBasis = isLeap(close.getUTCFullYear()) ? 366 : 365;
  const tol = toCents(toleranceDollars);

  const candidates = new Map();
  for (const basis of [actualBasis, 365, 360]) {
    candidates.set(basis, Math.round(toCents(perDiem(loanAmount, annualRatePct, basis) * days)));
  }

  for (const [basis, expected] of candidates) {
    if (Math.abs(expected - charged) <= tol) {
      return finding({
        checkId: 'PREPAID_INTEREST',
        title: 'Prepaid interest reconciles',
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.INTERNAL_ARITHMETIC,
        actionability: Actionability.LIKELY_LOCKED,
        charged: toDollars(charged),
        expected: toDollars(expected),
        variance: toDollars(charged - expected),
        basis: `${days} days x per-diem on a ${basis}-day basis`,
        detail: { days, basis },
      });
    }
  }

  // When nothing reconciles, report against the canonical actual-day basis
  // rather than whichever convention lands nearest the charge — the nearest
  // convention can be an artifact of the error and would mislead the customer.
  const expected = candidates.get(actualBasis);
  const pd = perDiem(loanAmount, annualRatePct, actualBasis);
  const impliedDays = pd ? charged / 100 / pd : 0;
  const variance = charged - expected;

  return finding({
    checkId: 'PREPAID_INTEREST',
    title: 'Prepaid interest does not reconcile to the note rate and closing date',
    severity:
      Math.abs(variance) > tol ? Severity.CONFIRMED_MATH_ERROR : Severity.INFORMATIONAL,
    evidence: EvidenceKind.INTERNAL_ARITHMETIC,
    actionability: Actionability.CHANGEABLE_BEFORE_CLOSING,
    dollarImpact: toDollars(Math.abs(variance)),
    charged: toDollars(charged),
    expected: toDollars(expected),
    variance: toDollars(variance),
    basis:
      `${loanAmount} at ${annualRatePct}% = ${toDollars(Math.round(toCents(pd)))}/day on a ` +
      `${actualBasis}-day basis; ${days} days from ${isoDate(close)} to month end`,
    whyItMatters:
      'Prepaid interest is a no-tolerance item under Reg Z, so a Loan Estimate comparison will ' +
      'never catch it. It is pure arithmetic and is routinely miscalculated when the closing date moves.',
    recommendedAction:
      `Ask the lender to show the day count. The charge implies about ${impliedDays.toFixed(1)} ` +
      `days, not ${days}.`,
    askLender: true,
    detail: {
      daysAssumed: days,
      impliedDays: Number(impliedDays.toFixed(2)),
      allConventions: Object.fromEntries([...candidates].map(([k, v]) => [k, toDollars(v)])),
    },
  });
}

// ---------------------------------------------------------------------------
// 2. escrow cushion — RESPA 12 CFR 1024.17(c)(1)(ii)
// ---------------------------------------------------------------------------

// IMPORTANT: cushionCharged must be the CUSHION, not the Section G total.
//
// Section G "Initial Escrow Payment at Closing" is the whole opening deposit —
// the months needed to fund upcoming disbursements PLUS any cushion, less the
// aggregate adjustment. The RESPA 1/6 cap applies only to the cushion.
//
// Passing Section G here was a shipped bug: a correct $1,536.72 initial deposit
// (11 months of hazard insurance + 6 months of taxes − $380.85 aggregate
// adjustment) was reported as a $1,024.48 overcharge against a $512.24 cushion
// cap. The aggregate adjustment is itself the mechanism that enforces the
// cushion limit, so its presence is evidence the calculation was done.
//
// A Closing Disclosure does not usually state the cushion separately. When it
// does not, this check must not run — see isSeparatelyStatedCushion below.
function checkEscrowCushion(annualDisbursements, cushionCharged) {
  const annualCents = Object.values(annualDisbursements || {}).reduce(
    (a, v) => a + toCents(v),
    0
  );

  if (annualCents <= 0) {
    return finding({
      checkId: 'ESCROW_CUSHION',
      title: 'Escrow cushion could not be tested',
      severity: Severity.REQUIRES_DOCUMENTATION,
      evidence: EvidenceKind.NONE,
      actionability: Actionability.NEEDS_DOCS,
      basis: 'No annual disbursement amounts were extracted from page 4.',
    });
  }

  const maxCushion = Math.round(annualCents / 6);
  const charged = toCents(cushionCharged);
  const variance = charged - maxCushion;

  if (variance <= 0) {
    return finding({
      checkId: 'ESCROW_CUSHION',
      title: 'Escrow cushion is within the RESPA maximum',
      severity: Severity.WITHIN_NORMS,
      evidence: EvidenceKind.HARD_STATUTE,
      actionability: Actionability.LIKELY_LOCKED,
      charged: toDollars(charged),
      expected: toDollars(maxCushion),
      variance: toDollars(variance),
      basis: '12 CFR 1024.17(c)(1)(ii): cushion capped at 1/6 of annual disbursements.',
    });
  }

  return finding({
    checkId: 'ESCROW_CUSHION',
    title: 'Escrow cushion exceeds the RESPA maximum',
    severity: Severity.POTENTIAL_OVERCHARGE,
    evidence: EvidenceKind.HARD_STATUTE,
    actionability: Actionability.CHANGEABLE_BEFORE_CLOSING,
    dollarImpact: toDollars(variance),
    charged: toDollars(charged),
    expected: toDollars(maxCushion),
    variance: toDollars(variance),
    basis:
      `Annual disbursements ${toDollars(annualCents)} / 6 = ${toDollars(maxCushion)} permitted ` +
      'cushion (12 CFR 1024.17(c)(1)(ii)).',
    whyItMatters: "Excess cushion is your cash sitting in the servicer's account at closing.",
    recommendedAction: 'Ask the lender to re-run the initial escrow account statement.',
    askLender: true,
  });
}

// ---------------------------------------------------------------------------
// 3. prorations
// ---------------------------------------------------------------------------

function checkProration(opts) {
  const {
    label,
    annualAmount,
    periodStart,
    periodEnd,
    prorationDate,
    chargedAmount,
    dayBasis = null,
    payer = 'buyer',
    toleranceDollars = 2.0,
  } = opts;

  const totalDays = daysBetween(periodStart, periodEnd) + 1;
  const basis = dayBasis || totalDays;
  const days =
    payer === 'buyer'
      ? daysBetween(prorationDate, periodEnd) + 1
      : daysBetween(periodStart, prorationDate);

  const daily = Number(annualAmount) / basis;
  const expected = Math.round(toCents(daily * days));
  const charged = toCents(chargedAmount);
  const variance = charged - expected;
  const ok = Math.abs(variance) <= toCents(toleranceDollars);

  return finding({
    checkId: 'PRORATION',
    title: `${label} proration`,
    severity: ok ? Severity.WITHIN_NORMS : Severity.CONFIRMED_MATH_ERROR,
    evidence: EvidenceKind.INTERNAL_ARITHMETIC,
    actionability: ok ? Actionability.LIKELY_LOCKED : Actionability.CHANGEABLE_BEFORE_CLOSING,
    dollarImpact: ok ? null : toDollars(Math.abs(variance)),
    charged: toDollars(charged),
    expected: toDollars(expected),
    variance: toDollars(variance),
    basis:
      `${Number(annualAmount).toFixed(2)} over ${basis} days = ${daily.toFixed(2)}/day; ` +
      `${days} days allocated to ${payer}`,
    recommendedAction: ok
      ? ''
      : 'Ask the settlement agent for the proration worksheet showing the tax period and day count.',
    askSettlement: !ok,
    detail: { days, basis },
  });
}

// ---------------------------------------------------------------------------
// 4. internal arithmetic — page 2 subtotals and page 3 Cash to Close
// ---------------------------------------------------------------------------

function checkSectionArithmetic(t, toleranceDollars = 1.0) {
  const out = [];
  const tol = toCents(toleranceDollars);
  const c = (k) => toCents(t[k] || 0);

  const cmp = (name, expected, stated, note) => {
    const variance = stated - expected;
    if (Math.abs(variance) <= tol) return;
    out.push(
      finding({
        checkId: `ARITH_${name}`,
        title: `${name} does not foot`,
        severity: Severity.CONFIRMED_MATH_ERROR,
        evidence: EvidenceKind.INTERNAL_ARITHMETIC,
        actionability: Actionability.CHANGEABLE_BEFORE_CLOSING,
        dollarImpact: toDollars(Math.abs(variance)),
        charged: toDollars(stated),
        expected: toDollars(expected),
        variance: toDollars(variance),
        basis: note,
        whyItMatters:
          'A subtotal that does not foot means either a line item is missing from the extract or ' +
          'the document itself is wrong.',
        recommendedAction:
          'Ask the settlement agent to reissue a corrected Closing Disclosure.',
        askSettlement: true,
      })
    );
  };

  cmp('D (Total Loan Costs)', c('A') + c('B') + c('C'), c('D'), 'D = A + B + C');
  cmp('I (Total Other Costs)', c('E') + c('F') + c('G') + c('H'), c('I'), 'I = E + F + G + H');
  cmp('J (Total Closing Costs)', c('D') + c('I') - c('lenderCredits'), c('J'),
    'J = D + I - lender credits');
  return out;
}

// The Closing Disclosure has TWO Cash to Close tables and they are not
// interchangeable.
//
// A purchase uses the standard table: closing costs, down payment, deposit,
// seller credits, adjustments. A refinance uses the alternative table, which is
// a completely different calculation — Loan Amount minus Total Closing Costs
// minus Total Payoffs and Payments.
//
// Applying the purchase formula to a refinance was a real, shipped bug: on an
// otherwise perfect refinance CD it produced a "confirmed mathematical error" of
// $95,155.17, because the purchase fields were all absent and the check expected
// Cash to Close to equal the closing costs alone. It went out as the headline of
// a paid report. Confirmed mathematical error is the strongest label this system
// can apply; using it on a false positive damages every other finding.
function checkCashToClose(c, toleranceDollars = 1.0) {
  const g = (k) => toCents(c[k] || 0);

  // The alternative table applies to refinances. Detect it from the transaction
  // type when given, and otherwise from the presence of payoffs, which only
  // appear on the alternative table.
  const isAlternative =
    c.transactionType === 'refinance' ||
    (c.transactionType !== 'purchase' && c.totalPayoffsAndPayments !== undefined
      && c.totalPayoffsAndPayments !== null);

  if (isAlternative) {
    if (!c.loanAmount) {
      return finding({
        checkId: 'ARITH_CASH_TO_CLOSE',
        title: 'Cash to Close could not be tested',
        severity: Severity.REQUIRES_DOCUMENTATION,
        evidence: EvidenceKind.NONE,
        actionability: Actionability.NEEDS_DOCS,
        basis: 'This looks like a refinance, which uses the alternative Cash to Close table. '
          + 'The loan amount could not be read, so the calculation could not be reproduced.',
      });
    }
    // Closing costs paid before closing is ADDED here, not subtracted.
    //
    // Total Closing Costs (J) already includes amounts the borrower has already
    // paid. On the standard purchase table J is added, so the paid portion is
    // subtracted back out. On this table J is SUBTRACTED, so the paid portion
    // must be added back. Subtracting it double-counts.
    //
    // Caught by CFPB sample H-25F1: $655 paid before closing produced a phantom
    // $1,310.00 "confirmed mathematical error" — exactly twice the figure.
    const expectedAlt =
      toCents(c.loanAmount) -
      g('totalClosingCostsJ') +
      g('closingCostsPaidBeforeClosing') -
      g('totalPayoffsAndPayments');
    const statedAlt = g('statedCashToClose');
    const varAlt = statedAlt - expectedAlt;
    const okAlt = Math.abs(varAlt) <= toCents(toleranceDollars);

    return finding({
      checkId: 'ARITH_CASH_TO_CLOSE',
      title: okAlt ? 'Cash to Close reconciles' : 'Cash to Close does not reconcile',
      severity: okAlt ? Severity.WITHIN_NORMS : Severity.CONFIRMED_MATH_ERROR,
      evidence: EvidenceKind.INTERNAL_ARITHMETIC,
      actionability: okAlt ? Actionability.LIKELY_LOCKED : Actionability.CHANGEABLE_BEFORE_CLOSING,
      dollarImpact: okAlt ? null : toDollars(Math.abs(varAlt)),
      charged: toDollars(statedAlt),
      expected: toDollars(expectedAlt),
      variance: toDollars(varAlt),
      basis: `Alternative Cash to Close table (refinance): loan amount `
        + `${toDollars(toCents(c.loanAmount))} less total closing costs `
        + `${toDollars(g('totalClosingCostsJ'))}`
        + (g('closingCostsPaidBeforeClosing')
            ? ` plus ${toDollars(g('closingCostsPaidBeforeClosing'))} already paid before closing`
            : '')
        + ` less total payoffs and payments ${toDollars(g('totalPayoffsAndPayments'))}.`,
      whyItMatters: okAlt ? '' : 'This is the number you receive or wire.',
      recommendedAction: okAlt ? ''
        : 'Ask the settlement agent to reconcile the Cash to Close table line by line.',
      askSettlement: !okAlt,
      detail: { table: 'alternative' },
    });
  }

  const expected =
    g('totalClosingCostsJ') -
    g('closingCostsPaidBeforeClosing') +
    g('downPaymentFundsFromBorrower') -
    g('deposit') -
    g('fundsForBorrower') -
    g('sellerCredits') -
    g('adjustmentsAndOtherCredits');

  const stated = g('statedCashToClose');
  const variance = stated - expected;

  if (Math.abs(variance) <= toCents(toleranceDollars)) {
    return finding({
      checkId: 'ARITH_CASH_TO_CLOSE',
      title: 'Cash to Close reconciles',
      severity: Severity.WITHIN_NORMS,
      evidence: EvidenceKind.INTERNAL_ARITHMETIC,
      actionability: Actionability.LIKELY_LOCKED,
      charged: toDollars(stated),
      expected: toDollars(expected),
      variance: toDollars(variance),
      basis: 'Calculating Cash to Close table, page 3',
    });
  }

  return finding({
    checkId: 'ARITH_CASH_TO_CLOSE',
    title: 'Cash to Close does not reconcile',
    severity: Severity.CONFIRMED_MATH_ERROR,
    evidence: EvidenceKind.INTERNAL_ARITHMETIC,
    actionability: Actionability.CHANGEABLE_BEFORE_CLOSING,
    dollarImpact: toDollars(Math.abs(variance)),
    charged: toDollars(stated),
    expected: toDollars(expected),
    variance: toDollars(variance),
    basis: 'Calculating Cash to Close table, page 3',
    whyItMatters: 'This is the number you wire. A discrepancy here is money.',
    recommendedAction:
      'Ask the settlement agent to reconcile the Cash to Close table line by line.',
    askSettlement: true,
  });
}

// ---------------------------------------------------------------------------
// 5. duplicate and stacked fee detection
// ---------------------------------------------------------------------------

const NOISE = /\b(fee|charge|to|the|and|of|for|inc|llc|company|co)\b|[^a-z0-9 ]/g;
const norm = (s) => String(s || '').toLowerCase().replace(NOISE, ' ').split(/\s+/).filter(Boolean).join(' ');

// Settlement statements write the payee into the fee label: "Credit Report to
// Superior Settlement Services, LLC". Matching against the whole string made
// every fee paid to that company look like a settlement charge, so a credit
// report and a rehab escrow came back as duplicates of each other. Match on the
// fee name only.
function feeNameOnly(label) {
  return String(label || '').split(/\s+(?:to|with|payable to)\s+/i)[0];
}

// Charges that merely CONTAIN a cluster word but are distinct products.
// "Title - Closing Protection Letter" contains "closing" and was flagged as a
// duplicate of a settlement fee on a real report; a CPL is a standard, separate
// title product. Note norm() strips the word "fee", so these must be matched on
// the surviving tokens rather than on full fee names.
const NOT_A_SERVICE_FEE = [
  'protection', 'letter', 'insurance', 'policy', 'binder', 'endorsement', 'premium',
];

const isDistinctProduct = (label) => {
  const n = norm(feeNameOnly(label));
  return NOT_A_SERVICE_FEE.some((w) => n.includes(w));
};

// Hypotheses, not accusations. Every pair is surfaced as a question.
const DUPLICATE_CLUSTERS = [
  ['settlement/closing/escrow services', ['settlement', 'closing', 'escrow', 'attorney closing']],
  ['title search / examination / abstract', ['title search', 'title exam', 'abstract']],
  ['courier / wire / delivery', ['courier', 'wire', 'delivery', 'overnight']],
  ['document preparation', ['doc prep', 'document preparation', 'document prep']],
  ['notary / signing', ['notary', 'signing']],
];

const STACKING_CLUSTER = [
  'processing', 'underwriting', 'administration', 'admin', 'application',
  'document', 'commitment', 'funding', 'origination',
];

function detectDuplicates(items) {
  const out = [];
  // 'none' covers documents without lettered sections — an ALTA Settlement
  // Statement lists the same charges with no A-H structure, and duplicate
  // detection is just as valuable there.
  const considered = (items || []).filter(
    (i) => ['A', 'B', 'C', 'E', 'none'].includes(i.section) && (i.paidBy || 'borrower') === 'borrower'
  );

  for (const [clusterName, keys] of DUPLICATE_CLUSTERS) {
    const hits = considered.filter(
      (i) => !isDistinctProduct(i.label) && keys.some((k) => norm(feeNameOnly(i.label)).includes(k))
    );
    for (let a = 0; a < hits.length; a++) {
      for (let b = a + 1; b < hits.length; b++) {
        const x = hits[a];
        const y = hits[b];
        const samePayee = Boolean(x.payee && y.payee && norm(x.payee) === norm(y.payee));
        const payeesUnknown = !x.payee && !y.payee;

        // Two similar charges from DIFFERENT providers are not a duplicate —
        // they are two providers. Without a shared payee there is no question
        // worth putting in front of a customer, and the noise buries the real
        // findings.
        if (!samePayee && !payeesUnknown) continue;

        const impact = Math.min(toCents(x.amount), toCents(y.amount));
        out.push(
          finding({
            checkId: 'DUPLICATE_CANDIDATE',
            title: `Possible duplicate: '${x.label}' and '${y.label}'`,
            severity: Severity.POTENTIAL_DUPLICATE,
            evidence: EvidenceKind.NONE,
            actionability: Actionability.CHANGEABLE_BEFORE_CLOSING,
            dollarImpact: toDollars(impact),
            basis:
              `Both lines fall in the ${clusterName} group` +
              (samePayee
                ? ` and are payable to the same provider (${x.payee}).`
                : '; payees differ or are not stated.'),
            whyItMatters:
              'Two charges for what may be the same service. This is a question to ask, not a ' +
              'proven duplicate — some providers legitimately bill these separately.',
            recommendedAction:
              `Ask the settlement agent what ${y.label} covers that ${x.label} does not.`,
            askSettlement: true,
            detail: {
              sectionA: x.section, amountA: toDollars(toCents(x.amount)),
              sectionB: y.section, amountB: toDollars(toCents(y.amount)),
              samePayee,
            },
          })
        );
      }
    }
  }

  const stacked = considered.filter(
    (i) => i.section === 'A' && STACKING_CLUSTER.some((k) => norm(feeNameOnly(i.label)).includes(k))
  );
  if (stacked.length >= 3) {
    const total = stacked.reduce((a, i) => a + toCents(i.amount), 0);
    out.push(
      finding({
        checkId: 'LENDER_FEE_STACKING',
        title: `${stacked.length} separate lender charges in Section A totaling ${toDollars(total)}`,
        severity: Severity.REQUIRES_DOCUMENTATION,
        evidence: EvidenceKind.NONE,
        actionability: Actionability.CHANGEABLE_BEFORE_CLOSING,
        dollarImpact: toDollars(total),
        basis: stacked.map((i) => `${i.label} ${toDollars(toCents(i.amount))}`).join('; '),
        whyItMatters:
          'Unbundling one origination charge into several line items is legal, but it is also ' +
          'where negotiable margin usually hides. Section A charges are zero-tolerance, so they ' +
          'are also the ones most likely to produce a cure if they moved.',
        recommendedAction:
          'Ask the lender which of these are third-party pass-throughs and which are lender ' +
          'revenue, and ask for a single bundled origination charge instead.',
        askLender: true,
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// 6. benchmark comparison — structurally cannot invent data
// ---------------------------------------------------------------------------

function compareToBenchmark(label, charged, bm) {
  const chargedC = toCents(charged);

  const cannot = () =>
    finding({
      checkId: 'BENCHMARK',
      title: `${label}: cannot benchmark`,
      severity: Severity.CANNOT_BENCHMARK,
      evidence: EvidenceKind.NONE,
      actionability: Actionability.NEEDS_DOCS,
      charged: toDollars(chargedC),
      basis: 'Cannot benchmark — insufficient reliable market data available for this fee.',
    });

  if (!bm) return cannot();

  const hard = [
    EvidenceKind.HARD_RATE_TABLE,
    EvidenceKind.HARD_FEE_SCHEDULE,
    EvidenceKind.HARD_STATUTE,
  ].includes(bm.evidence);

  if (bm.exact !== undefined && bm.exact !== null) {
    const exact = toCents(bm.exact);
    const variance = chargedC - exact;
    let severity;
    if (Math.abs(variance) <= 1) severity = Severity.WITHIN_NORMS;
    else if (hard && variance > 0) severity = Severity.POTENTIAL_OVERCHARGE;
    else severity = Severity.ABOVE_BENCHMARK;

    return finding({
      checkId: 'BENCHMARK',
      title: `${label}: ${severity === Severity.WITHIN_NORMS ? 'matches' : 'differs from'} the published rate`,
      severity,
      evidence: bm.evidence,
      actionability:
        severity === Severity.WITHIN_NORMS
          ? Actionability.LIKELY_LOCKED
          : Actionability.CHANGEABLE_BEFORE_CLOSING,
      dollarImpact: variance > 0 ? toDollars(variance) : null,
      charged: toDollars(chargedC),
      expected: toDollars(exact),
      variance: toDollars(variance),
      basis: bm.source + (bm.effectiveDate ? ` (effective ${bm.effectiveDate})` : ''),
      whyItMatters: hard
        ? 'This is a published, filed rate — not an average. A variance is a pricing error, not a negotiation.'
        : '',
      askSettlement: hard,
    });
  }

  if (bm.high === undefined || bm.high === null) return cannot();

  const high = toCents(bm.high);
  const low = toCents(bm.low || 0);
  const range = `${bm.source}: ${toDollars(low)}–${toDollars(high)} in ${bm.jurisdiction || 'this market'}`;

  if (chargedC <= high) {
    return finding({
      checkId: 'BENCHMARK',
      title: `${label}: within the observed range`,
      severity: Severity.WITHIN_NORMS,
      evidence: bm.evidence,
      actionability: Actionability.LIKELY_LOCKED,
      charged: toDollars(chargedC),
      expected: toDollars(high),
      basis: range,
    });
  }

  const variance = chargedC - high;
  return finding({
    checkId: 'BENCHMARK',
    title: `${label}: above the observed market range`,
    severity: chargedC / high >= 1.5 ? Severity.POTENTIAL_OVERCHARGE : Severity.ABOVE_BENCHMARK,
    evidence: bm.evidence,
    actionability: Actionability.CHANGEABLE_BEFORE_CLOSING,
    dollarImpact: toDollars(variance),
    charged: toDollars(chargedC),
    expected: toDollars(high),
    variance: toDollars(variance),
    basis: range,
    whyItMatters:
      'This is a market range, not a legal limit. Being above it is a reason to ask, not proof of a violation.',
    recommendedAction: `Ask what justifies ${toDollars(chargedC)} against a typical range topping out near ${toDollars(high)}.`,
    askSettlement: true,
  });
}

// ---------------------------------------------------------------------------
// 7. TRID tolerance engine
// ---------------------------------------------------------------------------

const Bucket = {
  ZERO: 'zero_tolerance',
  TEN_PCT: 'ten_percent_cumulative',
  NO_TOL: 'no_tolerance',
};

const ZERO_CATEGORIES = new Set([
  'origination', 'lender_fee', 'affiliate_service', 'unshoppable_service',
  'transfer_tax', 'rate_lock_fee', 'credit_report',
]);
const TEN_PCT_CATEGORIES = new Set(['recording_fee']);
const NO_TOL_CATEGORIES = new Set([
  'prepaid_interest', 'property_insurance', 'escrow_deposit', 'hoa_dues',
  'optional_product', 'non_required_service',
]);

// The Step-2 question about the written provider list is load-bearing. Under
// 1026.19(e)(3)(ii) the 10% bucket is only available for shoppable services
// when the creditor actually delivered the written list; commentary to
// 1026.19(e)(1)(vi) provides that if it did not, good faith is measured under
// (e)(3)(i) — zero tolerance. Answering "no" moves money into the bucket where
// any increase is a cure.
// Sections are printed on the form and prescribed by regulation, so they decide
// the tolerance bucket far more reliably than a category a model inferred:
//
//   A  Origination Charges ............... zero tolerance, 1026.19(e)(3)(i)
//   B  Services Borrower Did Not Shop For  zero tolerance — unshoppable by definition
//   C  Services Borrower Did Shop For .... depends on the written provider list
//   E  Taxes and Other Government Fees ... split: taxes zero, recording fees 10%
//   F  Prepaids .......................... no tolerance, 1026.19(e)(3)(iii)
//   G  Initial Escrow Payment ............ no tolerance
//   H  Other ............................. no tolerance, not creditor-required
//
// Section E is the one that genuinely needs the label: it holds both transfer
// and recordation taxes (zero tolerance) and recording fees (10% cumulative).
const SECTION_BUCKETS = {
  A: [Bucket.ZERO, 'Section A, Origination Charges — zero tolerance under 1026.19(e)(3)(i)'],
  B: [Bucket.ZERO, 'Section B, Services Borrower Did Not Shop For — zero tolerance under 1026.19(e)(3)(i)'],
  F: [Bucket.NO_TOL, 'Section F, Prepaids — not subject to a tolerance under 1026.19(e)(3)(iii)'],
  G: [Bucket.NO_TOL, 'Section G, Initial Escrow Payment — not subject to a tolerance under 1026.19(e)(3)(iii)'],
  H: [Bucket.NO_TOL, 'Section H, Other — not required by the creditor, so no tolerance applies'],
};

const TAX_LABEL = /\b(tax|taxes|stamp|stamps|recordation)\b/i;

function assignBucket(charge, lenderProvidedWrittenList) {
  const section = charge.section;

  // Section C is shoppable regardless of what the label says, so it routes into
  // the same written-list logic below.
  if (section && section !== 'none' && section !== 'C' && section !== 'D') {
    if (SECTION_BUCKETS[section]) return SECTION_BUCKETS[section];

    if (section === 'E') {
      return TAX_LABEL.test(feeNameOnly(charge.label || '')) || charge.category === 'transfer_tax'
        ? [Bucket.ZERO, 'Section E, a government transfer or recordation tax — zero tolerance under 1026.19(e)(3)(i)']
        : [Bucket.TEN_PCT, 'Section E, a recording fee — 10% cumulative bucket under 1026.19(e)(3)(ii)'];
    }
  }

  const shoppable = charge.shoppable || section === 'C';
  if (shoppable) {
    if (lenderProvidedWrittenList === false)
      return [Bucket.ZERO, 'no written list of providers was given, so the shopping exception is unavailable and this is tested at zero tolerance'];
    if (lenderProvidedWrittenList === null || lenderProvidedWrittenList === undefined)
      return [Bucket.ZERO, 'whether a written provider list was given is unknown; tested at zero tolerance pending confirmation'];
    if (charge.providerOnLenderList === false)
      return [Bucket.NO_TOL, "consumer selected a provider not on the lender's written list"];
    return [Bucket.TEN_PCT, "shoppable service taken from the lender's written list"];
  }

  // Fall back to the category only where no usable section was printed — an ALTA
  // settlement statement has no lettered sections at all.
  if (ZERO_CATEGORIES.has(charge.category))
    return [Bucket.ZERO, `${charge.category} is a zero-tolerance charge under 1026.19(e)(3)(i)`];
  if (NO_TOL_CATEGORIES.has(charge.category))
    return [Bucket.NO_TOL, `${charge.category} is not subject to a tolerance under 1026.19(e)(3)(iii)`];
  if (TEN_PCT_CATEGORIES.has(charge.category))
    return [Bucket.TEN_PCT, 'recording fees are in the 10% cumulative bucket under 1026.19(e)(3)(ii)'];
  return [Bucket.ZERO, 'service the consumer could not shop for'];
}

// convention 'precise': all calendar days except Sundays and federal holidays
//   (1026.2(a)(6), second sentence).
// convention 'general': Mon–Fri excluding holidays, a proxy for "days the
//   creditor is open for substantially all business functions".
// OPEN QUESTION: which definition governs the 4-business-day rule in
// 1026.19(e)(4)(ii) should be confirmed by counsel before it drives
// customer-facing output. Default is the more conservative (larger) count.
function businessDaysBetween(start, end, holidays = [], convention = 'precise') {
  const hol = new Set(holidays.map(isoDate));
  let n = 0;
  let d = parseDate(start);
  const target = parseDate(end);
  while (d < target) {
    d = addDays(d, 1);
    if (hol.has(isoDate(d))) continue;
    const dow = d.getUTCDay(); // 0 = Sunday
    if (convention === 'precise') {
      if (dow !== 0) n++;
    } else if (dow >= 1 && dow <= 5) n++;
  }
  return n;
}

// Do NOT default to the initial LE. The operative baseline is the most recent
// revised LE that was received at least 4 business days before consummation AND
// is supported by a documented changed circumstance. A revision failing either
// test is walked back, and the failure is itself a finding.
function selectBaseline(les, consummationDate, holidays = []) {
  const findings = [];
  const ordered = [...les].sort((a, b) => parseDate(a.dateIssued) - parseDate(b.dateIssued));
  if (!ordered.length) throw new Error('no loan estimates supplied');

  let baseline = ordered[0];
  for (const le of ordered.slice(1)) {
    const recv = le.dateReceived || le.dateIssued;
    const bd = businessDaysBetween(recv, consummationDate, holidays);
    const timely = bd >= 4;
    const supported = le.changedCircumstanceDocumented === true;

    if (timely && supported) {
      baseline = le;
      continue;
    }

    if (!timely) {
      findings.push(
        finding({
          checkId: 'TRID_BASELINE_TIMING',
          title: `Revised Loan Estimate ${le.docId} may not have been delivered in time to reset tolerances`,
          severity: Severity.POTENTIAL_TRID_VIOLATION,
          evidence: EvidenceKind.HARD_STATUTE,
          actionability: Actionability.POST_CLOSING_REMEDY,
          basis:
            `Received ${isoDate(recv)}, ${bd} business days before consummation ` +
            `${isoDate(consummationDate)}; 1026.19(e)(4)(ii) requires at least 4.`,
          whyItMatters:
            'If a revision cannot reset the baseline, the earlier LE governs and increases above ' +
            'it may require a cure.',
          recommendedAction:
            'Ask the lender for the delivery/receipt evidence for this revised LE.',
          askLender: true,
        })
      );
    }
    if (!supported) {
      findings.push(
        finding({
          checkId: 'TRID_BASELINE_CIRCUMSTANCE',
          title: `Revised Loan Estimate ${le.docId} has no documented changed circumstance on file`,
          severity: Severity.REQUIRES_DOCUMENTATION,
          evidence: EvidenceKind.HARD_STATUTE,
          actionability: Actionability.NEEDS_DOCS,
          basis:
            '1026.19(e)(3)(iv) permits a revised baseline only for enumerated reasons, documented ' +
            'by the creditor.',
          recommendedAction:
            'Ask the lender for the changed circumstance documentation supporting this revision. ' +
            'Until produced, the prior LE is treated as the baseline.',
          askLender: true,
        })
      );
    }
  }
  return { baseline, findings };
}

// Similarity on the fee name alone, payee stripped, after normalisation.
// Token overlap rather than edit distance: "Settlement Agent Fee" and
// "Title - Settlement Fee" share the token that matters, while a character
// metric would score them poorly because of the "Title - " prefix.
function nameSimilarity(a, b) {
  const ta = new Set(norm(feeNameOnly(a)).split(' ').filter(Boolean));
  const tb = new Set(norm(feeNameOnly(b)).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

// Pairs Loan Estimate charges with Closing Disclosure charges.
//
// The exact-key match this replaced was the single largest source of false
// positives: an LE saying "Settlement Agent Fee $500" and a CD saying
// "Title - Settlement Fee $500" failed to match, so the CD charge was treated as
// absent from the baseline and the FULL $500 was reported as a tolerance
// increase. Same fee, same amount, different wording.
//
// Passes run strongest-evidence-first and each Loan Estimate charge is consumed
// once. An identical amount in the same category is near-conclusive; a shared
// payee is strong; name similarity is the fallback.
function matchCharges(baselineCharges, cdCharges) {
  const leEntries = Object.entries(baselineCharges || {});
  const cdEntries = Object.entries(cdCharges || {});
  const usedLe = new Set();
  const pairs = [];
  const unmatchedCd = [];

  const take = (cdKey, cd, leKey, le, how) => {
    usedLe.add(leKey);
    pairs.push({ cdKey, cd, leKey, le, matchedBy: how });
  };

  const remaining = [];

  // Pass 1 — exact key.
  for (const [cdKey, cd] of cdEntries) {
    if (baselineCharges[cdKey] && !usedLe.has(cdKey)) take(cdKey, cd, cdKey, baselineCharges[cdKey], 'exact');
    else remaining.push([cdKey, cd]);
  }

  const passes = [
    // same category and an identical amount
    (cd, le) => le.category === cd.category && Math.abs(toCents(le.amount) - toCents(cd.amount)) <= 1,
    // same category and the same provider
    (cd, le) => le.category === cd.category && cd.payee && le.payee && norm(cd.payee) === norm(le.payee),
    // same category and a recognisably similar fee name
    (cd, le) => le.category === cd.category && nameSimilarity(cd.label, le.label) >= 0.5,
    // identical amount and a similar name, for a miscategorised line
    (cd, le) => Math.abs(toCents(le.amount) - toCents(cd.amount)) <= 1
      && nameSimilarity(cd.label, le.label) >= 0.34,
  ];
  const passNames = ['category+amount', 'category+payee', 'category+name', 'amount+name'];

  let pool = remaining;
  passes.forEach((test, i) => {
    const still = [];
    for (const [cdKey, cd] of pool) {
      const hit = leEntries.find(([leKey, le]) => !usedLe.has(leKey) && test(cd, le));
      if (hit) take(cdKey, cd, hit[0], hit[1], passNames[i]);
      else still.push([cdKey, cd]);
    }
    pool = still;
  });

  for (const [cdKey, cd] of pool) unmatchedCd.push({ cdKey, cd });
  const unmatchedLe = leEntries.filter(([k]) => !usedLe.has(k)).map(([leKey, le]) => ({ leKey, le }));

  return { pairs, unmatchedCd, unmatchedLe };
}

function analyzeTolerances(baseline, cdCharges, lenderProvidedWrittenList) {
  const findings = [];
  const { pairs, unmatchedCd } = matchCharges(baseline.charges, cdCharges);

  let tenBase = 0;
  let tenFinal = 0;
  const tenLines = [];

  for (const { cd, le, matchedBy } of pairs) {
    const [bucket, rationale] = assignBucket(cd, lenderProvidedWrittenList);
    const leAmt = toCents(le.amount);
    const cdAmt = toCents(cd.amount);

    if (bucket === Bucket.TEN_PCT) {
      tenBase += leAmt;
      tenFinal += cdAmt;
      tenLines.push(`${cd.label}: ${toDollars(leAmt)} -> ${toDollars(cdAmt)}`);
      continue;
    }
    if (bucket === Bucket.NO_TOL) continue;

    const delta = cdAmt - leAmt;
    if (delta <= 0) continue;

    // Zero tolerance is tested per charge under 1026.19(e)(3)(i): a decrease in
    // one charge does not offset an increase in another, so these are never
    // netted against each other.
    findings.push(
      finding({
        checkId: 'TRID_ZERO_TOLERANCE',
        title: `${cd.label} increased from the Loan Estimate`,
        severity: Severity.POTENTIAL_TRID_VIOLATION,
        evidence: EvidenceKind.HARD_STATUTE,
        actionability: Actionability.CHANGEABLE_BEFORE_CLOSING,
        dollarImpact: toDollars(delta),
        charged: toDollars(cdAmt),
        expected: toDollars(leAmt),
        variance: toDollars(delta),
        basis:
          `12 CFR 1026.19(e)(3)(i); ${rationale}. Baseline: ${baseline.docId} dated ` +
          `${isoDate(baseline.dateIssued)}` +
          (matchedBy === 'exact' ? '' :
            `. Matched to "${le.label}" on the Loan Estimate by ${matchedBy}`) + '.',
        whyItMatters:
          'Zero-tolerance charges may not increase at all unless a documented changed circumstance ' +
          'supported a valid revised Loan Estimate.',
        recommendedAction:
          `Ask the lender to either restore ${toDollars(leAmt)} or produce the changed circumstance ` +
          `documentation. Estimated cure: ${toDollars(delta)}.`,
        askLender: true,
        detail: { bucket, matchedBy },
      })
    );
  }

  // A charge we could not pair with anything on the Loan Estimate is AMBIGUOUS,
  // not proven new. It may genuinely be an added fee, or it may be the same fee
  // under a different name that four matching passes still failed to recognise.
  // Reporting the full amount as a tolerance violation — which this used to do —
  // manufactures a large, confident, citable accusation out of a naming
  // difference. It is reported as needing documentation instead, and carries no
  // dollar impact, so it can never present as money owed.
  for (const { cd } of unmatchedCd) {
    const [bucket] = assignBucket(cd, lenderProvidedWrittenList);
    if (bucket === Bucket.NO_TOL) continue;
    if (toCents(cd.amount) <= 0) continue;

    findings.push(
      finding({
        checkId: 'TRID_UNMATCHED_CHARGE',
        title: `${cd.label} does not appear on the Loan Estimate under a name we recognise`,
        severity: Severity.REQUIRES_DOCUMENTATION,
        evidence: EvidenceKind.NONE,
        actionability: Actionability.NEEDS_DOCS,
        dollarImpact: null,
        charged: toDollars(toCents(cd.amount)),
        basis:
          `We could not pair this ${toDollars(toCents(cd.amount))} charge with any line on ` +
          `${baseline.docId}. It may be a new charge, or the same charge worded differently. We do ` +
          `not treat it as an increase without knowing which.`,
        whyItMatters:
          'If it is genuinely new and falls in a zero-tolerance category, the full amount may be ' +
          'subject to a cure. If it is a renamed existing charge, nothing is owed.',
        recommendedAction:
          `Compare this line against your Loan Estimate. If there is no equivalent charge there, ` +
          `ask the lender to explain when it was added and why.`,
        askLender: true,
        detail: { bucket, unmatched: true },
      })
    );
  }

  if (tenBase > 0) {
    const allowed = Math.round(tenBase * 1.1);
    const excess = tenFinal - allowed;
    if (excess > 0) {
      findings.push(
        finding({
          checkId: 'TRID_TEN_PERCENT',
          title: '10% cumulative tolerance appears to be exceeded',
          severity: Severity.POTENTIAL_TRID_VIOLATION,
          evidence: EvidenceKind.HARD_STATUTE,
          actionability: Actionability.CHANGEABLE_BEFORE_CLOSING,
          dollarImpact: toDollars(excess),
          charged: toDollars(tenFinal),
          expected: toDollars(allowed),
          variance: toDollars(excess),
          basis:
            `12 CFR 1026.19(e)(3)(ii): baseline total ${toDollars(tenBase)} x 110% = ` +
            `${toDollars(allowed)}; Closing Disclosure total ${toDollars(tenFinal)}. Only charges ` +
            `matched to the Loan Estimate are included. Lines: ` + tenLines.join('; '),
          whyItMatters:
            'This bucket is tested in aggregate, so no single line has to look wrong for a cure to be owed.',
          recommendedAction: `Ask the lender for a cure of ${toDollars(excess)} and a corrected Closing Disclosure.`,
          askLender: true,
          detail: { bucket: Bucket.TEN_PCT },
        })
      );
    }
  }
  return findings;
}

// 1026.19(f)(2)(v) is the CREDITOR's deadline to refund and reissue — not a
// limitations period on the borrower. Stating it the other way around would
// understate the customer's position.
function cureDeadlineNote(consummationDate) {
  const deadline = isoDate(addDays(consummationDate, 60));
  return (
    `If a tolerance cure is owed, 12 CFR 1026.19(f)(2)(v) requires the lender to refund the excess ` +
    `and issue a corrected Closing Disclosure within 60 days of consummation — by ${deadline} for a ` +
    `${isoDate(consummationDate)} closing. Raising it inside that window is the cleanest path; it is ` +
    `the lender's cure deadline, not a bar on later claims.`
  );
}

// ---------------------------------------------------------------------------
// 8. purchase contract reconciliation
// ---------------------------------------------------------------------------

function reconcileContract(terms, cdCredits) {
  return (terms || []).map((t) => {
    const onCd = toCents((cdCredits || {})[t.label] || 0);
    const shortfall = toCents(t.amount) - onCd;

    if (shortfall <= 0) {
      return finding({
        checkId: 'CONTRACT_RECON',
        title: `${t.label} appears in full on the Closing Disclosure`,
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.CONTRACT,
        actionability: Actionability.LIKELY_LOCKED,
        charged: toDollars(onCd),
        expected: toDollars(toCents(t.amount)),
        basis: t.provision,
      });
    }

    return finding({
      checkId: 'CONTRACT_RECON',
      title: `${t.label} on the contract does not fully appear on the Closing Disclosure`,
      severity: Severity.POTENTIAL_OVERCHARGE,
      evidence: EvidenceKind.CONTRACT,
      actionability: Actionability.CHANGEABLE_BEFORE_CLOSING,
      dollarImpact: toDollars(shortfall),
      charged: toDollars(onCd),
      expected: toDollars(toCents(t.amount)),
      variance: toDollars(-shortfall),
      basis: `${t.provision} provides ${toDollars(toCents(t.amount))}; the Closing Disclosure shows ${toDollars(onCd)}.`,
      whyItMatters:
        'A missing negotiated credit is the single most recoverable error we look for, and a Loan ' +
        'Estimate comparison cannot detect it.',
      recommendedAction:
        `Send ${t.provision} to the settlement agent and ask for the remaining ${toDollars(shortfall)} ` +
        'to be added before the final figures are issued.',
      askSettlement: true,
    });
  });
}

// ---------------------------------------------------------------------------
// 9. extraction confidence gate
// ---------------------------------------------------------------------------

function gateExtraction(fields, threshold = 0.85) {
  const usable = [];
  const warnings = [];
  for (const f of fields || []) {
    if (f.confidence >= threshold) {
      usable.push(f);
      continue;
    }
    warnings.push(
      finding({
        checkId: 'EXTRACTION_CONFIDENCE',
        title: `Extraction warning: ${f.name} (page ${f.page})`,
        severity: Severity.REQUIRES_DOCUMENTATION,
        evidence: EvidenceKind.NONE,
        actionability: Actionability.NEEDS_DOCS,
        basis: `Read confidence ${f.confidence.toFixed(2)} is below the ${threshold.toFixed(2)} threshold.`,
        whyItMatters:
          'We do not run checks on numbers we cannot read. This field was excluded rather than guessed, ' +
          'so any check that needed it did not run.',
        // Deliberately states a fact rather than issuing an instruction. Findings
        // are rendered into the web report, a PDF, and emails the customer may
        // forward. "Type the value in manually" is only actionable on a page with
        // an input box; in a PDF it is simply false. Each surface decides what to
        // offer about an unreadable field — the finding only reports it.
        recommendedAction: '',
      })
    );
  }
  return { usable, warnings };
}

module.exports = {
  feeNameOnly,
  matchCharges,
  nameSimilarity,
  markCustomerSourced,
  Severity, EvidenceKind, Actionability, Bucket,
  toCents, toDollars, finding, rankFindings,
  daysToMonthEndInclusive, perDiem, checkPrepaidInterest,
  checkEscrowCushion, checkProration,
  checkSectionArithmetic, checkCashToClose,
  detectDuplicates, compareToBenchmark,
  assignBucket, businessDaysBetween, selectBaseline, analyzeTolerances, cureDeadlineNote,
  reconcileContract, gateExtraction,
};
