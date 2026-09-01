// Closing Disclosure extraction + audit orchestration.
//
// Split of responsibility, and the reason this file exists:
//   * The model EXTRACTS. It reads the PDF and reports what is printed on it,
//     with a confidence score per field. It does not judge anything.
//   * closing-audit.js DECIDES. Every flag, dollar figure, threshold and
//     severity comes from deterministic code with a citable basis.
//   * The model then WRITES UP the decisions (see navigator-engine.js).
//
// Keeping extraction and judgment apart is the whole point. A model asked to do
// both will quietly fill a gap in the first with a plausible guess and then
// reason from it.

'use strict';

const audit = require('./closing-audit');
const { makeGetBenchmark } = require('./benchmark-corpus');

// Loaded once per cold start. If the corpus file is malformed the corpus refuses
// to load entirely and every fee falls back to "cannot benchmark" — the safe
// direction. A broken corpus must never half-answer.
let defaultGetBenchmark = () => null;
try {
  const corpus = require('../../data/benchmarks.json');
  defaultGetBenchmark = makeGetBenchmark(corpus.rows || []);
} catch (err) {
  console.error('[benchmarks] corpus unavailable, all fees will report cannot-benchmark:', err.message);
}

const ANTHROPIC_MODEL = 'claude-sonnet-5';

// ---------------------------------------------------------------------------
// extraction tool
// ---------------------------------------------------------------------------

const CONFIDENCE_DESC =
  'Your confidence that you read this value correctly, 0 to 1. Below 0.85 the value is ' +
  'discarded rather than used. Score honestly — a low score costs the customer a re-upload, ' +
  'a wrong value costs them money. If the figure is faint, cropped, ambiguous, or you are ' +
  'inferring it rather than reading it, score it below 0.85.';

const amountField = (desc) => ({
  type: 'object',
  description: desc,
  properties: {
    value: { type: 'number', description: 'The dollar amount as printed, no currency symbol.' },
    confidence: { type: 'number', description: CONFIDENCE_DESC },
    page: { type: 'number', description: 'Page number this was read from.' },
  },
  required: ['value', 'confidence', 'page'],
});

const EXTRACTION_TOOL = {
  name: 'submit_cd_extraction',
  description:
    'Report every value printed on this Closing Disclosure. Report only what is on the ' +
    'document. Never compute a missing value from other values, never carry a figure over ' +
    'from a different document, and never supply a typical or expected amount. If something ' +
    'is absent, omit it.',
  input_schema: {
    type: 'object',
    properties: {
      document_type: {
        type: 'string',
        enum: [
          'closing_disclosure', 'alta_settlement_statement', 'loan_estimate',
          'purchase_contract', 'other',
        ],
        description:
          'What this document actually is. Customers mislabel uploads routinely — an ALTA ' +
          'Settlement Statement is the title company\'s own form and is frequently mistaken for ' +
          'the Closing Disclosure. Report what it IS; both are usable here.',
      },
      is_final: {
        type: 'boolean',
        description: 'True if this appears to be the final Closing Disclosure rather than a preliminary or corrected one.',
      },
      property_address: { type: 'string' },
      property_state: { type: 'string', description: 'Two-letter state code from the property address.' },
      property_county: { type: 'string' },
      transaction_type: { type: 'string', enum: ['purchase', 'refinance', 'other'] },
      closing_date: { type: 'string', description: 'Closing/disbursement date as YYYY-MM-DD.' },
      loan_amount: { type: 'number' },
      interest_rate_pct: { type: 'number', description: 'Note rate as a percentage, e.g. 6.5 for 6.5%.' },
      loan_term_years: { type: 'number' },

      line_items: {
        type: 'array',
        description:
          'Every charge line on pages 2 and 3, in document order. One entry per printed line, ' +
          'including lines with a zero or blank borrower amount.',
        items: {
          type: 'object',
          properties: {
            section: {
              type: 'string',
              enum: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'none'],
              description:
                'The lettered section this line sits under. Use "none" for documents that have no ' +
                'lettered sections, such as an ALTA Settlement Statement.',
            },
            label: { type: 'string', description: 'The fee name exactly as printed.' },
            amount: { type: 'number', description: 'Amount in the borrower-at-closing column.' },
            payee: { type: 'string', description: 'The "to [provider]" name, if printed.' },
            paid_by: { type: 'string', enum: ['borrower', 'seller', 'other', 'lender'] },
            paid_before_closing: { type: 'boolean' },
            category: {
              type: 'string',
              enum: [
                'origination', 'lender_fee', 'credit_report', 'rate_lock_fee', 'appraisal',
                'settlement_service', 'title_insurance_owners', 'title_insurance_lenders',
                'survey', 'attorney', 'recording_fee', 'transfer_tax', 'prepaid_interest',
                'property_insurance', 'property_tax', 'escrow_deposit', 'hoa_dues',
                'optional_product', 'non_required_service', 'affiliate_service',
                'unshoppable_service', 'other',
              ],
              description:
                'Best classification of what kind of charge this is. This drives which ' +
                'tolerance rule applies, so classify by what the fee IS, not by which section ' +
                'it happens to be printed in.',
            },
            shoppable: {
              type: 'boolean',
              description: 'True if this line appears under Section C (services the borrower did shop for).',
            },
            confidence: { type: 'number', description: CONFIDENCE_DESC },
            page: { type: 'number' },
          },
          required: ['section', 'label', 'amount', 'confidence', 'page'],
        },
      },

      section_totals: {
        type: 'object',
        description: 'The printed subtotals. Report what is printed even if it looks wrong — that is exactly what we are checking.',
        properties: {
          A: amountField('Section A total'), B: amountField('Section B total'),
          C: amountField('Section C total'), D: amountField('Section D, Total Loan Costs'),
          E: amountField('Section E total'), F: amountField('Section F total'),
          G: amountField('Section G total'), H: amountField('Section H total'),
          I: amountField('Section I, Total Other Costs'),
          J: amountField('Section J, Total Closing Costs'),
          lender_credits: amountField('Lender credits, as a positive number'),
        },
      },

      cash_to_close: {
        type: 'object',
        description: 'The Calculating Cash to Close table on page 3.',
        properties: {
          total_closing_costs_j: amountField('Total closing costs (J)'),
          closing_costs_paid_before_closing: amountField('Closing costs paid before closing'),
          down_payment_funds_from_borrower: amountField('Down payment / funds from borrower'),
          deposit: amountField('Deposit, as a positive number'),
          funds_for_borrower: amountField('Funds for borrower, as a positive number'),
          seller_credits: amountField('Seller credits, as a positive number'),
          adjustments_and_other_credits: amountField('Adjustments and other credits, as a positive number'),
          stated_cash_to_close: amountField('Cash to Close as printed'),
        },
      },

      prepaid_interest: {
        type: 'object',
        description: 'The prepaid interest line in Section F.',
        properties: {
          amount: { type: 'number' },
          days: { type: 'number', description: 'Number of days as printed on the line, if stated.' },
          per_diem: { type: 'number', description: 'Per-day amount as printed, if stated.' },
          confidence: { type: 'number', description: CONFIDENCE_DESC },
          page: { type: 'number' },
        },
      },

      escrow: {
        type: 'object',
        description: 'Section G, initial escrow payment at closing, plus page 4 escrow detail.',
        properties: {
          annual_disbursements: {
            type: 'array',
            description: 'Each escrowed item and its estimated ANNUAL total, from the escrow account section on page 4.',
            items: {
              type: 'object',
              properties: {
                item: { type: 'string' },
                annual_amount: { type: 'number' },
                confidence: { type: 'number', description: CONFIDENCE_DESC },
              },
              required: ['item', 'annual_amount', 'confidence'],
            },
          },
          cushion_amount: { type: 'number', description: 'The aggregate adjustment / cushion amount, if separately stated.' },
          cushion_confidence: { type: 'number', description: CONFIDENCE_DESC },
        },
      },

      prorations: {
        type: 'array',
        description: 'Tax, HOA, or other prorated adjustments, from Section K/L or the adjustments lines.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            annual_amount: { type: 'number', description: 'The full-period amount being prorated, if stated.' },
            period_start: { type: 'string', description: 'YYYY-MM-DD' },
            period_end: { type: 'string', description: 'YYYY-MM-DD' },
            charged_amount: { type: 'number' },
            payer: { type: 'string', enum: ['buyer', 'seller'] },
            confidence: { type: 'number', description: CONFIDENCE_DESC },
          },
          required: ['label', 'charged_amount', 'confidence'],
        },
      },

      seller_credits_on_cd: {
        type: 'array',
        description: 'Any seller credit, concession, or repair credit lines, for reconciliation against the purchase contract.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            amount: { type: 'number' },
            confidence: { type: 'number', description: CONFIDENCE_DESC },
          },
          required: ['label', 'amount', 'confidence'],
        },
      },

      pages_present: { type: 'number', description: 'How many pages you could actually read.' },
      document_problems: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Anything wrong with the document itself: missing pages, cropped scans, illegible ' +
          'sections, a page that appears to be from a different loan. Be specific about which page.',
      },
    },
    required: ['document_type', 'line_items', 'pages_present'],
  },
};

const EXTRACTION_SYSTEM = `You are an extraction engine for mortgage closing documents. You read documents and report exactly what is printed on them.

You do not analyze, judge, compare, or advise. Something else does that with what you report.

Absolute rules:
- Report only values that are physically printed on the document. Never compute a value that is missing by deriving it from other values. Never fill in a typical or expected amount. Never carry a figure across from a different document.
- If a subtotal looks arithmetically wrong, report it as printed anyway. Detecting that is the entire point of the system you are feeding.
- Score confidence honestly on every field. A value below 0.85 confidence is discarded and the customer is asked for a clearer copy. That is a far better outcome than a confident wrong number, which becomes a dollar figure in a report the customer sends to their lender.
- If a document is not a Closing Disclosure, say so in document_type rather than trying to force its contents into this shape. An ALTA Settlement Statement is fully usable — report its charge lines, payees and prorations with section "none", and leave the CD-only fields (section_totals, cash_to_close, escrow) out rather than inventing them.
- Use document_problems generously. Missing pages and cropped scans are common and matter.

Respond ONLY by calling the submit_cd_extraction tool.`;

async function callAnthropic({ apiKey, system, tools, contentBlocks, maxTokens = 8000 }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system,
      tools,
      tool_choice: { type: 'tool', name: tools[0].name },
      messages: [{ role: 'user', content: contentBlocks }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Anthropic API error ${response.status}: ${errText.slice(0, 400)}`);
  }

  const data = await response.json();
  const toolUse = (data.content || []).find((b) => b.type === 'tool_use');
  if (!toolUse || !toolUse.input) throw new Error('Model did not return a tool call.');
  return toolUse.input;
}

async function extractClosingDisclosure(apiKey, contentBlocks) {
  return callAnthropic({
    apiKey,
    system: EXTRACTION_SYSTEM,
    tools: [EXTRACTION_TOOL],
    contentBlocks: [
      ...contentBlocks,
      { type: 'text', text: 'Extract everything printed on this document.' },
    ],
  });
}

// ---------------------------------------------------------------------------
// audit orchestration
// ---------------------------------------------------------------------------

// Both forms carry the fee lines the audit is built on. Only the Closing
// Disclosure carries loan terms, the lettered subtotals and the escrow
// disclosure, so an ALTA statement supports a real but narrower audit — and the
// customer is told exactly which checks it cannot support rather than being
// turned away or quietly given less.
const ACCEPTED_DOCUMENT_TYPES = ['closing_disclosure', 'alta_settlement_statement'];

const DOCUMENT_LABELS = {
  closing_disclosure: 'Closing Disclosure',
  alta_settlement_statement: 'ALTA Settlement Statement',
  loan_estimate: 'Loan Estimate',
  purchase_contract: 'purchase contract',
  other: 'document',
};

// Checks that structurally cannot run without the Closing Disclosure itself.
const CD_ONLY_CHECKS = [
  'section subtotals (A-J)',
  'Cash to Close',
  'prepaid interest',
  'escrow cushion',
  'TRID tolerance testing',
];

const CONF_THRESHOLD = 0.85;
const confident = (o) => o && typeof o.confidence === 'number' && o.confidence >= CONF_THRESHOLD;
const val = (o) => (confident(o) ? o.value : null);

// getBenchmark is injected. Until a benchmark corpus exists it returns null for
// everything, and every benchmarkable fee comes back "cannot benchmark" — which
// is the honest answer, not a gap to paper over.
function runClosingAudit(extraction, options = {}) {
  const {
    answers = {},
    loanEstimates = null,
    contractTerms = null,
    getBenchmark = defaultGetBenchmark,
  } = options;

  const e = extraction || {};
  const findings = [];
  const skipped = [];

  // --- extraction confidence gate, before anything is trusted ---------------
  const fields = (e.line_items || []).map((li, i) => ({
    name: li.label || `line ${i + 1}`,
    page: li.page || 0,
    confidence: typeof li.confidence === 'number' ? li.confidence : 0,
    item: li,
  }));
  const { usable, warnings } = audit.gateExtraction(fields, CONF_THRESHOLD);
  findings.push(...warnings);
  const lines = usable.map((f) => f.item);

  if (e.document_type === 'alta_settlement_statement') {
    findings.push(audit.finding({
      checkId: 'DOCUMENT_SCOPE',
      title: 'Audited from an ALTA Settlement Statement',
      severity: audit.Severity.REQUIRES_DOCUMENTATION,
      evidence: audit.EvidenceKind.NONE,
      actionability: audit.Actionability.NEEDS_DOCS,
      basis:
        'This is the settlement agent\'s statement, not the lender\'s Closing Disclosure. It carries ' +
        'the charge lines, payees and prorations, so fee-level checks run normally. It does not carry ' +
        'loan terms, the lettered subtotals or the escrow disclosure, so these could not be tested: ' +
        CD_ONLY_CHECKS.join(', ') + '.',
      whyItMatters:
        'Prepaid interest and the escrow cushion are two of the most commonly miscalculated figures ' +
        'in a closing, and neither can be checked without the Closing Disclosure.',
      recommendedAction:
        'Upload the Closing Disclosure as well — your lender must give it to you at least three ' +
        'business days before closing — and these checks will run against it.',
    }));
  }

  for (const p of e.document_problems || []) {
    findings.push(audit.finding({
      checkId: 'DOCUMENT_PROBLEM',
      title: 'Problem with the uploaded document',
      severity: audit.Severity.REQUIRES_DOCUMENTATION,
      evidence: audit.EvidenceKind.NONE,
      actionability: audit.Actionability.NEEDS_DOCS,
      basis: p,
      recommendedAction: 'Upload a complete, clearly legible copy of the affected page.',
    }));
  }

  // --- internal arithmetic --------------------------------------------------
  const st = e.section_totals || {};
  const totalsUsable = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].every((k) => confident(st[k]));
  if (totalsUsable) {
    findings.push(...audit.checkSectionArithmetic({
      A: val(st.A), B: val(st.B), C: val(st.C), D: val(st.D),
      E: val(st.E), F: val(st.F), G: val(st.G), H: val(st.H),
      I: val(st.I), J: val(st.J), lenderCredits: val(st.lender_credits) || 0,
    }));
  } else {
    skipped.push('section subtotals');
  }

  const ctc = e.cash_to_close || {};
  if (confident(ctc.stated_cash_to_close) && confident(ctc.total_closing_costs_j)) {
    findings.push(audit.checkCashToClose({
      totalClosingCostsJ: val(ctc.total_closing_costs_j),
      closingCostsPaidBeforeClosing: val(ctc.closing_costs_paid_before_closing) || 0,
      downPaymentFundsFromBorrower: val(ctc.down_payment_funds_from_borrower) || 0,
      deposit: val(ctc.deposit) || 0,
      fundsForBorrower: val(ctc.funds_for_borrower) || 0,
      sellerCredits: val(ctc.seller_credits) || 0,
      adjustmentsAndOtherCredits: val(ctc.adjustments_and_other_credits) || 0,
      statedCashToClose: val(ctc.stated_cash_to_close),
    }));
  } else {
    skipped.push('Cash to Close');
  }

  // --- prepaid interest -----------------------------------------------------
  const pi = e.prepaid_interest;
  if (pi && confident(pi) && e.loan_amount && e.interest_rate_pct && e.closing_date) {
    findings.push(audit.checkPrepaidInterest({
      loanAmount: e.loan_amount,
      annualRatePct: e.interest_rate_pct,
      closingDate: e.closing_date,
      chargedAmount: pi.amount,
      daysCharged: typeof pi.days === 'number' ? pi.days : null,
    }));
  } else {
    skipped.push('prepaid interest');
  }

  // --- escrow cushion -------------------------------------------------------
  const esc = e.escrow || {};
  const disb = (esc.annual_disbursements || []).filter((d) => d.confidence >= CONF_THRESHOLD);
  if (disb.length && typeof esc.cushion_amount === 'number' &&
      (esc.cushion_confidence || 0) >= CONF_THRESHOLD) {
    findings.push(audit.checkEscrowCushion(
      Object.fromEntries(disb.map((d) => [d.item, d.annual_amount])),
      esc.cushion_amount
    ));
  } else {
    skipped.push('escrow cushion');
  }

  // --- prorations -----------------------------------------------------------
  for (const p of e.prorations || []) {
    if (p.confidence < CONF_THRESHOLD) continue;
    if (!p.annual_amount || !p.period_start || !p.period_end || !e.closing_date) {
      skipped.push(`${p.label} proration`);
      continue;
    }
    findings.push(audit.checkProration({
      label: p.label,
      annualAmount: p.annual_amount,
      periodStart: p.period_start,
      periodEnd: p.period_end,
      prorationDate: e.closing_date,
      chargedAmount: p.charged_amount,
      payer: p.payer || 'buyer',
    }));
  }

  // --- duplicates and stacking ---------------------------------------------
  findings.push(...audit.detectDuplicates(lines.map((li) => ({
    section: li.section,
    label: li.label,
    amount: li.amount,
    payee: li.payee,
    paidBy: li.paid_by || 'borrower',
  }))));

  // --- benchmarks -----------------------------------------------------------
  const BENCHMARKABLE = new Set([
    'title_insurance_owners', 'title_insurance_lenders', 'recording_fee',
    'transfer_tax', 'appraisal', 'survey', 'attorney', 'settlement_service',
  ]);
  for (const li of lines) {
    if (!BENCHMARKABLE.has(li.category)) continue;
    if (!li.amount) continue;
    findings.push(audit.compareToBenchmark(li.label, li.amount, getBenchmark({
      category: li.category,
      state: e.property_state,
      county: e.property_county,
      loanAmount: e.loan_amount,
      salePrice: e.sale_price || null,
    })));
  }

  // --- TRID tolerances, only if Loan Estimates were supplied ----------------
  let cureNote = null;
  if (loanEstimates && loanEstimates.length && e.closing_date) {
    const { baseline, findings: baselineFindings } =
      audit.selectBaseline(loanEstimates, e.closing_date);
    findings.push(...baselineFindings);

    const cdCharges = {};
    for (const li of lines) {
      cdCharges[chargeKey(li)] = {
        label: li.label,
        amount: li.amount,
        category: li.category || 'other',
        shoppable: Boolean(li.shoppable),
        providerOnLenderList: answers.provider_on_lender_list ?? null,
      };
    }
    findings.push(...audit.analyzeTolerances(
      baseline, cdCharges, normalizeProviderListAnswer(answers.provider_list)
    ));
    cureNote = audit.cureDeadlineNote(e.closing_date);
  }

  // --- purchase contract ----------------------------------------------------
  if (contractTerms && contractTerms.length) {
    const cdCredits = {};
    for (const c of e.seller_credits_on_cd || []) {
      if (c.confidence >= CONF_THRESHOLD) cdCredits[c.label] = c.amount;
    }
    findings.push(...audit.reconcileContract(contractTerms, cdCredits));
  }

  return { findings: audit.rankFindings(findings), skipped, cureNote };
}

const chargeKey = (li) =>
  `${li.category || 'other'}:${String(li.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;

// "Don't know" and "no" are not the same as "yes", and only "yes" unlocks the
// 10% bucket for shoppable services. Anything other than an explicit yes is
// treated conservatively.
function normalizeProviderListAnswer(a) {
  if (a === 'yes' || a === true) return true;
  if (a === 'no' || a === false) return false;
  return null;
}

// ---------------------------------------------------------------------------
// free scorecard
// ---------------------------------------------------------------------------

const FLAG_SEVERITIES = new Set([
  audit.Severity.CONFIRMED_MATH_ERROR,
  audit.Severity.POTENTIAL_TRID_VIOLATION,
  audit.Severity.POTENTIAL_OVERCHARGE,
  audit.Severity.POTENTIAL_DUPLICATE,
  audit.Severity.ABOVE_BENCHMARK,
]);

const NEEDS_DOCS_SEVERITIES = new Set([
  audit.Severity.REQUIRES_DOCUMENTATION,
  audit.Severity.CANNOT_BENCHMARK,
]);

// Deliberately counts and headline figures only — enough to show the audit
// found something real, not enough to substitute for the paid report. It never
// names a flagged fee or its dollar impact.
function buildScorecard(extraction, findings, skipped = []) {
  const e = extraction || {};
  const st = e.section_totals || {};
  const totalClosingCosts = confident(st.J) ? val(st.J) : null;
  const loanAmount = typeof e.loan_amount === 'number' ? e.loan_amount : null;

  const flags = findings.filter((f) => FLAG_SEVERITIES.has(f.severity));
  const needsDocs = findings.filter((f) => NEEDS_DOCS_SEVERITIES.has(f.severity));
  const extractionWarnings = findings.filter((f) => f.checkId === 'EXTRACTION_CONFIDENCE');

  const isAlta = e.document_type === 'alta_settlement_statement';

  return {
    document_type: e.document_type || 'other',
    document_label: DOCUMENT_LABELS[e.document_type] || 'document',
    is_closing_disclosure: e.document_type === 'closing_disclosure',
    checks_unavailable: isAlta ? CD_ONLY_CHECKS : [],
    property_state: e.property_state || null,
    property_county: e.property_county || null,
    total_closing_costs: totalClosingCosts,
    loan_amount: loanAmount,
    closing_costs_pct_of_loan:
      totalClosingCosts !== null && loanAmount
        ? Math.round((totalClosingCosts / loanAmount) * 1000) / 10
        : null,
    flag_count: flags.length,
    needs_more_documents_count: needsDocs.length,
    extraction_warning_count: extractionWarnings.length,
    checks_skipped: skipped,
    line_items_read: (e.line_items || []).length,
    pages_read: e.pages_present || null,
  };
}

module.exports = {
  ANTHROPIC_MODEL,
  ACCEPTED_DOCUMENT_TYPES,
  DOCUMENT_LABELS,
  CD_ONLY_CHECKS,
  EXTRACTION_TOOL,
  EXTRACTION_SYSTEM,
  extractClosingDisclosure,
  runClosingAudit,
  buildScorecard,
  normalizeProviderListAnswer,
  chargeKey,
  CONF_THRESHOLD,
};
