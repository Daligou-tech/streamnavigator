// Which tolerance bucket a charge lands in decides what the report ACCUSES.
//
// assignBucket() reads the Closing Disclosure section before anything else, and
// it has always been right. What was wrong was the object handed to it:
// closing-extract.js built cdCharges with label, amount, category, shoppable and
// providerOnLenderList, and no section. Every section branch was therefore
// skipped and most charges fell through to the closing default, zero tolerance.
//
// That is not a missing finding. It is the wrong KIND of finding:
//
//   * A zero-tolerance finding says the lender may owe the money back. It
//     carries a dollar impact, a cure deadline, and it is written into the
//     letter the customer signs their own name to and sends their lender.
//   * Section H charges are not subject to any tolerance at all under
//     12 CFR 1026.19(e)(3)(iii) — an owner's title policy, a home warranty.
//   * A shoppable Section C charge taken from the lender's written list is
//     tested in a 10% AGGREGATE under 1026.19(e)(3)(ii), not per charge.
//
// So the dropped field let the product demand refunds it had no basis to
// demand, and at the same time made check 23 — the 10% basket — unreachable,
// because nothing ever landed in the basket to overflow it.
//
// These tests exist at two levels deliberately. The bucket table checks the
// rule. The end-to-end test checks the PLUMBING, because the rule was never the
// thing that broke.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const audit = require('../api/_lib/closing-audit');
const { runDocumentAudit } = require('../api/_lib/closing-service');

// --- the rule ---------------------------------------------------------------

const WITH_WRITTEN_LIST = true;

const CASES = [
  {
    what: 'Section A origination charge',
    charge: { label: 'Underwriting Fee', amount: 1095, category: 'origination', section: 'A', shoppable: false },
    bucket: 'zero_tolerance',
    why: 'lender fees may not increase at all — 1026.19(e)(3)(i)',
  },
  {
    what: 'Section B service the borrower did not shop for',
    charge: { label: 'Appraisal Fee', amount: 650, category: 'appraisal', section: 'B', shoppable: false },
    bucket: 'zero_tolerance',
    why: 'not shoppable, so zero tolerance',
  },
  {
    what: 'Section C shoppable service, written list given',
    charge: { label: 'Survey Fee', amount: 700, category: 'survey', section: 'C', shoppable: false },
    bucket: 'ten_percent_cumulative',
    why: 'the shopping exception is available, so this is tested in aggregate, not per charge',
  },
  {
    what: 'Section E recording fee',
    charge: { label: 'Recording Fees', amount: 260, category: 'recording_fee', section: 'E', shoppable: false },
    bucket: 'ten_percent_cumulative',
    why: 'recording fees sit in the 10% bucket — 1026.19(e)(3)(ii)',
  },
  {
    what: 'Section E transfer tax',
    charge: { label: 'State Transfer Tax', amount: 1875, category: 'transfer_tax', section: 'E', shoppable: false },
    bucket: 'zero_tolerance',
    why: 'a government transfer tax is zero tolerance even though it shares a section with recording fees',
  },
  {
    what: "Section H owner's title policy",
    charge: { label: "Owner's Title Insurance (optional)", amount: 1800, category: 'title_insurance_owners', section: 'H', shoppable: false },
    bucket: 'no_tolerance',
    why: 'not required by the creditor, so no tolerance applies — this must never produce an accusation',
  },
  {
    what: 'Section H home warranty',
    charge: { label: 'Home Warranty', amount: 650, category: 'other', section: 'H', shoppable: false },
    bucket: 'no_tolerance',
    why: 'same — an optional product the creditor did not require',
  },
  {
    what: 'Section F prepaid interest',
    charge: { label: 'Prepaid Interest', amount: 1175.24, category: 'prepaid_interest', section: 'F', shoppable: false },
    bucket: 'no_tolerance',
    why: 'prepaids are not subject to a tolerance — 1026.19(e)(3)(iii)',
  },
];

for (const c of CASES) {
  test(`${c.what} is ${c.bucket}`, () => {
    const [bucket] = audit.assignBucket(c.charge, WITH_WRITTEN_LIST);
    assert.equal(bucket, c.bucket, `${c.what}: ${c.why}`);
  });
}

test('a shoppable Section C charge drops to zero tolerance when no written list was given', () => {
  // Not a bug — 1026.19(e)(1)(vi). Without the written list the shopping
  // exception is unavailable, so good faith is measured at zero tolerance.
  const charge = { label: 'Survey Fee', amount: 700, category: 'survey', section: 'C', shoppable: false };
  const [bucket] = audit.assignBucket(charge, false);
  assert.equal(bucket, 'zero_tolerance');
});

// --- the plumbing -----------------------------------------------------------
//
// The rule above was correct the whole time the product was shipping wrong
// answers. Only a test that goes through runDocumentAudit catches the field
// being dropped on the way in.

const amt = (value, page = 2) => ({ value, confidence: 0.99, page });
const li = (section, label, amount, category, extra = {}) => Object.assign({
  section, label, amount, category, page: 2, confidence: 0.99,
  paid_by: 'borrower', shoppable: false, amount_present: true, paid_before_closing: false,
}, extra);

function extractionWith(lineItems, totals) {
  return {
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
    line_items: lineItems,
    section_totals: totals,
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
  };
}

const loanEstimate = (charges) => [{
  docId: 'LE1',
  dateIssued: '2026-03-14',
  loanAmount: 300000,
  interestRatePct: 6.5,
  propertyAddress: '12 Example Street',
  borrowerNames: [],
  lenderName: 'Example Bank',
  isRevised: false,
  changedCircumstance: null,
  charges,
}];

const idsOf = (findings) => findings.map((f) => f.checkId);

test('a Section C increase with a written list feeds the 10% basket, not a zero-tolerance accusation', () => {
  const result = runDocumentAudit({
    extraction: extractionWith(
      [
        li('A', 'Underwriting Fee', 795, 'origination'),
        li('B', 'Appraisal Fee', 650, 'appraisal'),
        li('C', 'Survey Fee', 700, 'survey'),
      ],
      { A: amt(795), B: amt(650), C: amt(700), J: amt(2145) }
    ),
    answers: { provider_list: 'yes' },
    loanEstimates: loanEstimate([
      { label: 'Underwriting Fee', amount: 795, category: 'origination', section: 'A', tolerance: 'zero' },
      { label: 'Appraisal Fee', amount: 650, category: 'appraisal', section: 'B', tolerance: 'zero' },
      { label: 'Survey Fee', amount: 475, category: 'survey', section: 'C', tolerance: 'ten_percent' },
    ]),
  });

  const ten = result.findings.find((f) => f.checkId === 'TRID_TEN_PERCENT');
  assert.ok(ten, 'the 10% basket check must be reachable at all — it was not');
  // 475 * 1.1 = 522.50 allowed; 700 charged.
  assert.equal(ten.dollarImpact, 177.5);

  assert.ok(
    !idsOf(result.findings).includes('TRID_ZERO_TOLERANCE'),
    'a shoppable Section C charge must never be reported as a zero-tolerance violation '
    + 'when the lender gave a written provider list'
  );
});

test('a Section H charge that increased produces no tolerance accusation at all', () => {
  const result = runDocumentAudit({
    extraction: extractionWith(
      [
        li('A', 'Underwriting Fee', 795, 'origination'),
        li('H', "Owner's Title Insurance (optional)", 2400, 'title_insurance_owners'),
      ],
      { A: amt(795), H: amt(2400), J: amt(3195) }
    ),
    answers: { provider_list: 'yes' },
    loanEstimates: loanEstimate([
      { label: 'Underwriting Fee', amount: 795, category: 'origination', section: 'A', tolerance: 'zero' },
      { label: "Owner's Title Insurance (optional)", amount: 1800, category: 'title_insurance_owners', section: 'H', tolerance: 'none' },
    ]),
  });

  const accusations = result.findings.filter(
    (f) => f.checkId === 'TRID_ZERO_TOLERANCE' || f.checkId === 'TRID_TEN_PERCENT'
  );
  assert.deepEqual(
    accusations, [],
    'Section H charges carry no tolerance under 1026.19(e)(3)(iii). A $600 increase in an '
    + 'optional owner\'s policy is not money the lender owes back, and saying so in a letter '
    + 'to the lender is the most damaging thing this product can do.'
  );
});

test('a genuine Section A increase is still reported', () => {
  // The guard above must not be bought by suppressing real findings.
  const result = runDocumentAudit({
    extraction: extractionWith(
      [li('A', 'Underwriting Fee', 1095, 'origination')],
      { A: amt(1095), J: amt(1095) }
    ),
    answers: { provider_list: 'yes' },
    loanEstimates: loanEstimate([
      { label: 'Underwriting Fee', amount: 795, category: 'origination', section: 'A', tolerance: 'zero' },
    ]),
  });

  const zero = result.findings.find((f) => f.checkId === 'TRID_ZERO_TOLERANCE');
  assert.ok(zero, 'a lender fee that rose $300 after the Loan Estimate is exactly what this product sells');
  assert.equal(zero.dollarImpact, 300);
});
