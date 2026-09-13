// The places this product deliberately declines to accuse.
//
// Every check here looks like a missed finding and is not. Each one costs the
// report a flag and buys back the thing the flag would have spent: a customer
// can only send one of these letters to their lender before the rest stop being
// read, and a confident accusation built on an assumption is how that happens.
//
// The 12 Sep audit listed these under "what should not be changed", which is
// also the reason to pin them. A restraint with no test looks exactly like an
// oversight to whoever comes next — and the obvious way to raise the findings
// count is to undo all four.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runDocumentAudit } = require('../api/_lib/closing-service');
const audit = require('../api/_lib/closing-audit');

const amt = (value, page = 2) => ({ value, confidence: 0.99, page });
const li = (section, label, amount, category, extra = {}) => Object.assign({
  section, label, amount, category, page: 2, confidence: 0.99,
  paid_by: 'borrower', shoppable: false, amount_present: true, paid_before_closing: false,
}, extra);

const base = (over = {}) => Object.assign({
  document_type: 'closing_disclosure',
  is_final: true,
  transaction_type: 'purchase',
  closing_date: '2026-04-15',
  property_state: 'VA',
  loan_amount: 300000,
  sale_price: 375000,
  interest_rate_pct: 6.5,
  loan_term_years: 30,
  pages_present: 5,
  document_problems: [],
  prorations: [],
  line_items: [li('A', 'Underwriting Fee', 1095, 'origination')],
  section_totals: { A: amt(1095), J: amt(1095) },
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
}, over);

const find = (findings, id) => findings.filter((f) => f.checkId === id);

// --- 1. an HOA charge on a house the buyer called single-family --------------

test('HOA charges on a "single family" answer ask for documentation rather than accusing', () => {
  const { findings } = runDocumentAudit({
    extraction: base({
      line_items: base().line_items.concat([li('H', 'HOA Transfer Fee', 450, 'hoa')]),
    }),
    answers: { property_type: 'single_family' },
  });

  const hits = find(findings, 'PROPERTY_TYPE_HOA_MISMATCH');
  assert.equal(hits.length, 1, 'the mismatch is still noticed');
  assert.equal(hits[0].severity, audit.Severity.REQUIRES_DOCUMENTATION,
    'an HOA charge on a house the buyer called single-family is far more often a mis-answered '
    + 'question, or a community with dues they did not think of, than an improper charge. '
    + 'Escalating it would accuse a settlement agent on the strength of a dropdown.');
});

// --- 2. a charge the Loan Estimate does not obviously contain ---------------

test('a charge missing from the Loan Estimate is not treated as a new fee', () => {
  const baseline = {
    docId: 'LE1',
    dateIssued: '2026-03-14',
    loanAmount: 300000,
    interestRatePct: 6.5,
    propertyAddress: '',
    borrowerNames: [],
    lenderName: '',
    isRevised: false,
    changedCircumstance: null,
    charges: [{ label: 'Underwriting Fee', amount: 1095, category: 'origination', section: 'A', tolerance: 'zero' }],
  };

  const { findings } = runDocumentAudit({
    extraction: base({
      line_items: base().line_items.concat([li('A', 'Administration Fee', 395, 'lender_fee')]),
      section_totals: { A: amt(1490), J: amt(1490) },
    }),
    answers: { provider_list: 'yes' },
    loanEstimates: [baseline],
  });

  const unmatched = find(findings, 'TRID_UNMATCHED_CHARGE');
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].severity, audit.Severity.REQUIRES_DOCUMENTATION);
  assert.equal(unmatched[0].dollarImpact, null,
    'it may be genuinely new, or the same fee worded differently that four matching passes '
    + 'still failed to recognise. Attaching a dollar figure turns a naming difference into '
    + 'money the customer believes they are owed.');

  assert.equal(find(findings, 'TRID_ZERO_TOLERANCE').length, 0,
    'and it must never appear as a tolerance violation');
});

// --- 3. an escrow cushion that cannot be derived from a Closing Disclosure ---

test('Section G is never tested against the RESPA cap', () => {
  // Section G is the whole opening deposit — months of funding plus any
  // cushion. The cap applies to the cushion alone, so applying it here would
  // flag a correctly funded escrow account on almost every closing.
  const { findings } = runDocumentAudit({
    extraction: base({
      escrow: {
        annual_disbursements: [{ item: 'Taxes and insurance', annual_amount: 7416, confidence: 0.97 }],
        section_g_total: 1536.72,
        aggregate_adjustment: -380.85,
      },
    }),
    answers: {},
  });

  const cushion = find(findings, 'ESCROW_CUSHION');
  assert.equal(cushion.length, 1);
  assert.equal(cushion[0].severity, audit.Severity.INFORMATIONAL);
  assert.equal(cushion[0].dollarImpact, null);
});

// --- 4. a transfer tax total in a jurisdiction we cannot fully model ---------

test('an incomplete transfer-tax jurisdiction reconciles but never accuses', () => {
  // Virginia's two regional fees are county-dependent. Without the county, a
  // total missing them reads as an overcharge of exactly their size.
  const { findings } = runDocumentAudit({
    extraction: base({
      property_county: null,
      line_items: base().line_items.concat([li('E', 'State Transfer Tax', 3400, 'transfer_tax')]),
      section_totals: { A: amt(1095), E: amt(3400), J: amt(4495) },
    }),
    answers: {},
  });

  const tax = find(findings, 'TRANSFER_TAX_TOTAL');
  assert.equal(tax.length, 1);
  assert.equal(tax[0].severity, audit.Severity.INFORMATIONAL);
  assert.notEqual(tax[0].severity, audit.Severity.POTENTIAL_OVERCHARGE);
});

test('the same charge in a county we can model is still flagged', () => {
  // The restraint above must not be bought by never flagging anything.
  const { findings } = runDocumentAudit({
    extraction: base({
      property_county: 'Richmond',
      line_items: base().line_items.concat([li('E', 'State Transfer Tax', 3400, 'transfer_tax')]),
      section_totals: { A: amt(1095), E: amt(3400), J: amt(4495) },
    }),
    answers: {},
  });

  const tax = find(findings, 'TRANSFER_TAX_TOTAL');
  assert.equal(tax.length, 1);
  assert.equal(tax[0].severity, audit.Severity.POTENTIAL_OVERCHARGE);
  assert.ok(tax[0].dollarImpact > 0);
});
