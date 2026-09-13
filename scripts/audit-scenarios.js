#!/usr/bin/env node
// Planted-defect scenarios for the Closing Disclosure audit.
//
// audit-harness.js runs real documents and answers "does this produce false
// positives" — on every fixture in the repo it produces none. That is only half
// the question, and the less commercially important half. The other half is
// whether the checks fire at all, which a clean fixture can never establish:
// twenty-seven checks that always return "within norms" would score exactly the
// same on that harness as twenty-seven working ones.
//
// So each scenario below plants ONE defect of a known kind and asserts the
// check that owns it fires, with the right severity and the right dollar
// figure. No API key, no network.
//
//   node scripts/audit-scenarios.js
//   node scripts/audit-scenarios.js --verbose

'use strict';

const { runDocumentAudit } = require('../api/_lib/closing-service');

const verbose = process.argv.includes('--verbose');

const amt = (value, page = 2) => ({ value, confidence: 0.99, page });
const li = (section, label, amount, category, extra = {}) => Object.assign({
  section, label, amount, category, page: 2, confidence: 0.99,
  paid_by: 'borrower', shoppable: false, amount_present: true, paid_before_closing: false,
}, extra);

// A clean baseline: $300,000 at 6.5% over 360 months pays $1,896.20/mo, and
// against an amount financed of $296,479.76 that implies an APR of 6.614%.
// Every scenario starts from this and breaks exactly one thing.
function baseline(overrides = {}) {
  return Object.assign({
    document_type: 'closing_disclosure',
    is_final: true,
    transaction_type: 'purchase',
    closing_date: '2026-04-15',
    property_state: 'VA',
    property_address: '12 Example Street',
    loan_amount: 300000,
    sale_price: 375000,
    interest_rate_pct: 6.5,
    loan_term_years: 30,
    pages_present: 5,
    document_problems: [],
    prorations: [],
    line_items: [
      li('A', 'Underwriting Fee', 1095, 'origination'),
      li('B', 'Appraisal Fee', 650, 'appraisal'),
      li('C', 'Survey Fee', 475, 'survey'),
    ],
    section_totals: { A: amt(1095), B: amt(650), C: amt(475), J: amt(2220) },
    cash_to_close: {},
    monthly_principal_interest: amt(1896.2, 1),
    loan_calculations: {
      total_of_payments: amt(682632, 5),
      finance_charge: amt(386152.24, 5),
      amount_financed: amt(296479.76, 5),
      annual_percentage_rate_pct: 6.614,
      total_interest_percentage_pct: 127.5,
    },
    escrow: {},
    seller_credits_on_cd: [],
  }, overrides);
}

const FLAGGED = new Set([
  'confirmed_mathematical_error', 'potential_trid_violation',
  'potential_overcharge', 'potential_duplicate',
]);

const SCENARIOS = [];
const scenario = (name, expectCheckId, build) => SCENARIOS.push({ name, expectCheckId, build });

// --- arithmetic the document contradicts itself on -------------------------

scenario('APR disclosed below the note rate', 'LOAN_MATH_APR_FLOOR', () => ({
  extraction: baseline({
    loan_calculations: Object.assign(baseline().loan_calculations, {
      annual_percentage_rate_pct: 6.25,
    }),
  }),
  answers: {},
}));

scenario('monthly payment does not amortise the stated terms', 'LOAN_MATH_PI', () => ({
  extraction: baseline({ monthly_principal_interest: amt(1650.0, 1) }),
  answers: {},
}));

scenario('Total of Payments understates the payment schedule', 'LOAN_MATH_TOTAL_OF_PAYMENTS', () => ({
  extraction: baseline({
    loan_calculations: Object.assign(baseline().loan_calculations, {
      total_of_payments: amt(600000, 5),
    }),
  }),
  answers: {},
}));

scenario('Total Interest Percentage disagrees with the schedule', 'LOAN_MATH_TIP', () => ({
  extraction: baseline({
    loan_calculations: Object.assign(baseline().loan_calculations, {
      total_interest_percentage_pct: 88.0,
    }),
  }),
  answers: {},
}));

// --- charges ---------------------------------------------------------------

scenario('the same charge appears twice under different names', 'DUPLICATE_CANDIDATE', () => ({
  // Both in the settlement/closing/escrow cluster and payable to the same
  // provider. A shared payee is required: two similar charges from two
  // different providers are two providers, not a duplicate.
  extraction: baseline({
    line_items: [
      li('B', 'Settlement Fee', 850, 'settlement_service', { payee: 'Acme Title' }),
      li('B', 'Closing Fee', 500, 'settlement_service', { payee: 'Acme Title' }),
      li('B', 'Appraisal Fee', 650, 'appraisal'),
    ],
    section_totals: { A: amt(0), B: amt(2000), J: amt(2000) },
  }),
  answers: {},
}));

scenario('prepaid interest bills more days than the closing date supports', 'PREPAID_INTEREST', () => ({
  // 15 April disbursement leaves 16 days to month end. Billing 22 is the
  // overcharge the marketing page's sample report describes.
  extraction: baseline({
    prepaid_interest: { amount: 1175.24, days: 22, per_diem: 53.4247, confidence: 0.97, page: 2 },
  }),
  answers: {},
}));

scenario('escrow cushion exceeds the RESPA one-sixth limit', 'ESCROW_CUSHION', () => ({
  // A stated cushion is required. On a real Closing Disclosure it usually is
  // not stated — see the note in the audit report about what this means for
  // the sample on the marketing page.
  extraction: baseline({
    escrow: {
      annual_disbursements: [
        { item: 'Property Taxes', annual_amount: 4800, confidence: 0.97 },
        { item: "Homeowner's Insurance", annual_amount: 2616, confidence: 0.97 },
      ],
      cushion_amount: 1648,
      cushion_confidence: 0.97,
      section_g_total: 3000,
    },
  }),
  answers: {},
}));

scenario('escrow cushion on a normal CD, where no cushion is stated', 'ESCROW_CUSHION', () => ({
  // The realistic case: annual disbursements and an aggregate adjustment, no
  // stated cushion. Expected to produce an INFORMATIONAL finding, not a flag —
  // this scenario asserts the engine declines rather than guessing.
  extraction: baseline({
    escrow: {
      annual_disbursements: [{ item: 'Property Taxes, Insurance', annual_amount: 7416, confidence: 0.97 }],
      section_g_total: 1536.72,
      aggregate_adjustment: -380.85,
    },
  }),
  answers: {},
  expectSeverity: 'informational_only',
}));

scenario('HOA charges on a property the buyer says has no association', 'PROPERTY_TYPE_HOA_MISMATCH', () => ({
  extraction: baseline({
    line_items: baseline().line_items.concat([
      li('H', 'HOA Transfer Fee', 450, 'hoa'),
    ]),
  }),
  answers: { property_type: 'single_family' },
  // Deliberately not a flag. An HOA charge on a house the buyer called
  // single-family is more often a mislabelled answer or a community with dues
  // the buyer did not think of than an improper charge, and the engine asks
  // for documentation rather than making an accusation. Asserted here so a
  // later change that escalates it has to be a decision.
  expectSeverity: 'requires_documentation',
}));

// --- tolerance, which needs a Loan Estimate --------------------------------

const LE = (overrides = {}) => Object.assign({
  docId: 'LE1',
  dateIssued: '2026-03-14',
  loanAmount: 300000,
  interestRatePct: 6.5,
  propertyAddress: '12 Example Street',
  borrowerNames: [],
  lenderName: 'Example Bank',
  isRevised: false,
  changedCircumstance: null,
  charges: [
    { label: 'Underwriting Fee', amount: 795, category: 'origination', section: 'A', tolerance: 'zero' },
    { label: 'Appraisal Fee', amount: 650, category: 'appraisal', section: 'B', tolerance: 'zero' },
    { label: 'Survey Fee', amount: 475, category: 'survey', section: 'C', tolerance: 'ten_percent' },
  ],
}, overrides);

scenario('a zero-tolerance lender fee rose after the Loan Estimate', 'TRID_ZERO_TOLERANCE', () => ({
  extraction: baseline(),
  answers: { provider_list: 'yes' },
  loanEstimates: [LE()],
}));

scenario('the 10% basket exceeded its limit', 'TRID_TEN_PERCENT', () => ({
  extraction: baseline({
    line_items: [
      li('A', 'Underwriting Fee', 795, 'origination'),
      li('B', 'Appraisal Fee', 650, 'appraisal'),
      li('C', 'Survey Fee', 700, 'survey'),
    ],
    section_totals: { A: amt(795), B: amt(650), C: amt(700), J: amt(2145) },
  }),
  answers: { provider_list: 'yes' },
  loanEstimates: [LE()],
}));

// --- statutory transfer taxes ----------------------------------------------

// $375,000 in Richmond, VA with a $300,000 loan. Statute:
//   deed          375,000/100 x $0.25            = $937.50
//   local         one third of that              = $312.50
//   grantor       375,000/500 x $0.50            = $375.00
//   deed of trust 300,000/100 x $0.25            = $750.00
//   local on DoT  one third of that              = $250.00
//                                          total = $2,625.00
scenario('transfer taxes billed above the statutory total', 'TRANSFER_TAX_TOTAL', () => ({
  extraction: baseline({
    property_county: 'Richmond',
    line_items: baseline().line_items.concat([
      li('E', 'State Transfer Tax', 2000, 'transfer_tax'),
      li('E', 'County Transfer Tax', 1400, 'transfer_tax'),
    ]),
  }),
  answers: {},
}));

scenario('transfer taxes matching the statute are verified, not flagged', 'TRANSFER_TAX_TOTAL', () => ({
  extraction: baseline({
    property_county: 'Richmond',
    line_items: baseline().line_items.concat([
      li('E', 'State Transfer Tax', 1625, 'transfer_tax'),
      li('E', 'Grantor Tax', 1000, 'transfer_tax'),
    ]),
  }),
  answers: {},
  expectSeverity: 'within_norms',
}));

scenario('an unknown county can reconcile but never accuse', 'TRANSFER_TAX_TOTAL', () => ({
  // The two Northern Virginia regional fees are county-dependent. Without the
  // county we cannot know whether they apply, and a total missing them would
  // read as an overcharge of exactly their size.
  extraction: baseline({
    property_county: null,
    line_items: baseline().line_items.concat([
      li('E', 'State Transfer Tax', 2000, 'transfer_tax'),
      li('E', 'County Transfer Tax', 1400, 'transfer_tax'),
    ]),
  }),
  answers: {},
  expectSeverity: 'informational_only',
}));

// --- contract -------------------------------------------------------------

scenario('the seller credit is smaller than the contract provides', 'CONTRACT_RECON', () => ({
  extraction: baseline({
    seller_credits_on_cd: [
      { label: 'Seller credit toward closing costs', amount: 4500, confidence: 0.97 },
    ],
  }),
  answers: {},
  // An ARRAY of agreed terms, each with the provision it came from.
  contractTerms: [
    { label: 'Seller credit toward closing costs', amount: 6000, provision: 'paragraph 4(c)' },
  ],
}));

// --- tolerance bucketing, which decides whether a finding is an accusation --
//
// assignBucket() branches on the SECTION a charge sits in before anything else,
// and the bucket decides what the report tells the customer. A Section H charge
// carries no tolerance at all; a Section C charge with a written provider list
// sits in the 10% aggregate basket. Only a zero-tolerance charge produces "the
// lender owes this back".
//
// These assert the bucket directly rather than through a whole audit, because
// the failure they were written for is a field being dropped on the way in —
// invisible at the level of a finding, decisive at the level of the claim.
const audit = require('../api/_lib/closing-audit');

const BUCKETS = [
  ['Section C survey, written list given', { label: 'Survey Fee', amount: 700, category: 'survey', section: 'C', shoppable: false }, 'ten_percent_cumulative'],
  ['Section H owner’s title policy', { label: 'Owner’s Title Insurance (optional)', amount: 1800, category: 'title_insurance_owners', section: 'H', shoppable: false }, 'no_tolerance'],
  ['Section H home warranty', { label: 'Home Warranty', amount: 650, category: 'other', section: 'H', shoppable: false }, 'no_tolerance'],
  ['Section A underwriting fee', { label: 'Underwriting Fee', amount: 1095, category: 'origination', section: 'A', shoppable: false }, 'zero_tolerance'],
  ['Section E recording fee', { label: 'Recording Fees', amount: 260, category: 'recording_fee', section: 'E', shoppable: false }, 'ten_percent_cumulative'],
  ['Section E transfer tax', { label: 'State Transfer Tax', amount: 1875, category: 'transfer_tax', section: 'E', shoppable: false }, 'zero_tolerance'],
];

let bucketsOk = 0;
let bucketsBad = 0;
console.log('\nTOLERANCE BUCKETS');
for (const [name, charge, expected] of BUCKETS) {
  const [got] = audit.assignBucket(charge, true);
  if (got === expected) {
    bucketsOk++;
    console.log(`OK      ${name} -> ${got}`);
  } else {
    bucketsBad++;
    console.log(`WRONG   ${name}\n        expected ${expected}, got ${got}`);
  }
}
console.log(`${BUCKETS.length} buckets — ${bucketsOk} correct, ${bucketsBad} wrong\n`);

console.log('PLANTED DEFECTS');

// ---------------------------------------------------------------------------

let fired = 0;
let missed = 0;

for (const s of SCENARIOS) {
  let result;
  let error = null;
  try {
    result = runDocumentAudit(s.build());
  } catch (err) {
    error = err;
  }

  if (error) {
    missed++;
    console.log(`THREW   ${s.name}\n        ${error.message}`);
    continue;
  }

  const findings = result.findings || [];
  const built = s.build();
  // Most scenarios plant a defect and expect a flag. A couple plant a
  // REALISTIC case and assert the engine declines to conclude — those name the
  // severity they expect instead.
  const wanted = built.expectSeverity
    ? (f) => f.severity === built.expectSeverity
    : (f) => FLAGGED.has(f.severity);
  const hit = findings.filter((f) => f.checkId === s.expectCheckId && wanted(f));

  if (hit.length) {
    fired++;
    const f = hit[0];
    const impact = typeof f.dollarImpact === 'number' ? ` $${f.dollarImpact.toFixed(2)}` : '';
    console.log(`FIRES   ${s.name}\n        ${f.checkId} · ${f.severity}${impact}`);
    if (verbose) console.log(`        ${f.basis}`);
  } else {
    missed++;
    const sameId = findings.filter((f) => f.checkId === s.expectCheckId);
    console.log(`SILENT  ${s.name}`);
    console.log(`        expected ${s.expectCheckId} to flag; got `
      + (sameId.length
        ? sameId.map((f) => `${f.checkId}:${f.severity}`).join(', ')
        : 'no finding with that id at all'));
    if (verbose) {
      console.log('        all findings: '
        + findings.map((f) => `${f.checkId}:${f.severity}`).join(', '));
      if ((result.skipped || []).length) console.log(`        skipped: ${result.skipped.join('; ')}`);
    }
  }
}

console.log(`\n${SCENARIOS.length} scenarios — ${fired} fired, ${missed} silent`);
process.exitCode = missed ? 1 : 0;
