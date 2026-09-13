// The note rate, against the Loan Estimate.
//
// Every tolerance check in the engine is about CHARGES. None looked at the
// number those charges are attached to — and a quarter point on $300,000 over
// thirty years is roughly $16,000, larger than every finding this product has
// ever produced put together.
//
// checkTransactionMatch compares lender, address, borrower and loan amount to
// decide whether two documents describe the same loan, and deliberately does
// not compare the rate, because a loan whose rate moved is still the same loan.
// That is precisely why nothing was looking at it.
//
// The hard part is restraint. An unlocked rate is free to move, a float-down
// moves it in the customer's favour, and re-locking after an expiry at a higher
// rate is lawful. So this reports and asks; it never accuses, and it never
// attaches a dollar figure.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkRateAgainstEstimate, Severity } = require('../api/_lib/closing-audit');
const { runDocumentAudit } = require('../api/_lib/closing-service');

const check = (cd, le) => checkRateAgainstEstimate({
  cdRatePct: cd, leRatePct: le, leDocId: 'LE1', leDateIssued: '2026-03-14',
});

test('a rate that rose is reported, with both figures and the difference', () => {
  const f = check(6.875, 6.5);
  assert.equal(f.checkId, 'RATE_VS_ESTIMATE');
  assert.equal(f.severity, Severity.REQUIRES_DOCUMENTATION);
  assert.equal(f.charged, 6.875);
  assert.equal(f.expected, 6.5);
  assert.equal(f.variance, 0.375);
  assert.match(f.basis, /6\.5%/);
  assert.match(f.basis, /6\.875%/);
});

test('a rate that rose carries no dollar impact', () => {
  // The cost depends entirely on how long the loan is actually held. A
  // thirty-year figure would dwarf every real finding in the report, on an
  // assumption the customer never made.
  assert.equal(check(7.0, 6.5).dollarImpact, null);
});

test('a rate that rose is never called a violation', () => {
  const f = check(7.0, 6.5);
  assert.notEqual(f.severity, Severity.POTENTIAL_TRID_VIOLATION);
  assert.notEqual(f.severity, Severity.CONFIRMED_MATH_ERROR);
  assert.notEqual(f.severity, Severity.POTENTIAL_OVERCHARGE);
  assert.match(f.whyItMatters, /not necessarily an error/i);
  assert.match(f.recommendedAction, /whether your rate was locked/i);
});

test('a rate that fell is informational, not a finding against anyone', () => {
  const f = check(6.25, 6.5);
  assert.equal(f.severity, Severity.INFORMATIONAL);
  assert.equal(f.variance, -0.25);
});

test('an identical rate passes rather than going unmentioned', () => {
  const f = check(6.5, 6.5);
  assert.equal(f.severity, Severity.WITHIN_NORMS);
});

test('a difference below an eighth of a point is rounding, not a change', () => {
  // Rates are quoted in eighths. Anything smaller is two documents rounding
  // differently, and a phone call about it wastes the one call the customer
  // gets.
  assert.equal(check(6.55, 6.5).severity, Severity.WITHIN_NORMS);
  assert.equal(check(6.624, 6.5).severity, Severity.WITHIN_NORMS);
  assert.equal(check(6.625, 6.5).severity, Severity.REQUIRES_DOCUMENTATION);
});

test('a missing rate on either document produces nothing at all', () => {
  assert.equal(check(undefined, 6.5), null);
  assert.equal(check(6.5, null), null);
  assert.equal(check(NaN, 6.5), null);
});

// --- end to end -------------------------------------------------------------

const amt = (value, page = 2) => ({ value, confidence: 0.99, page });
const li = (section, label, amount, category) => ({
  section, label, amount, category, page: 2, confidence: 0.99,
  paid_by: 'borrower', shoppable: false, amount_present: true, paid_before_closing: false,
});

const extraction = (ratePct) => ({
  document_type: 'closing_disclosure',
  is_final: true,
  transaction_type: 'purchase',
  closing_date: '2026-04-15',
  property_state: 'VA',
  property_address: '12 Example Street',
  loan_amount: 300000,
  sale_price: 375000,
  interest_rate_pct: ratePct,
  loan_term_years: 30,
  pages_present: 5,
  document_problems: [],
  prorations: [],
  line_items: [li('A', 'Underwriting Fee', 1095, 'origination')],
  section_totals: { A: amt(1095), J: amt(1095) },
  cash_to_close: {},
  monthly_principal_interest: amt(1896.2, 1),
  loan_calculations: {},
  escrow: {},
  seller_credits_on_cd: [],
});

const loanEstimates = [{
  docId: 'LE1',
  dateIssued: '2026-03-14',
  loanAmount: 300000,
  interestRatePct: 6.5,
  propertyAddress: '12 Example Street',
  borrowerNames: [],
  lenderName: 'Example Bank',
  isRevised: false,
  changedCircumstance: null,
  charges: [{ label: 'Underwriting Fee', amount: 1095, category: 'origination', section: 'A', tolerance: 'zero' }],
}];

test('the check reaches the audit when a Loan Estimate was supplied', () => {
  const { findings } = runDocumentAudit({
    extraction: extraction(7.125),
    answers: { provider_list: 'yes' },
    loanEstimates,
  });
  const hit = findings.find((f) => f.checkId === 'RATE_VS_ESTIMATE');
  assert.ok(hit, 'the rate check must actually run through the service path');
  assert.equal(hit.severity, Severity.REQUIRES_DOCUMENTATION);
  assert.equal(hit.expected, 6.5);
});

test('without a Loan Estimate the check simply does not appear', () => {
  const { findings } = runDocumentAudit({ extraction: extraction(7.125), answers: {} });
  assert.equal(findings.filter((f) => f.checkId === 'RATE_VS_ESTIMATE').length, 0);
});
