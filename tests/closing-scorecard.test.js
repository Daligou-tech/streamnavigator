// Tests for the scorecard path: extraction confidence gating, audit
// orchestration over an extracted CD, and what the free scorecard does and does
// not reveal.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runClosingAudit, buildScorecard, normalizeProviderListAnswer, CONF_THRESHOLD,
} = require('../api/_lib/closing-extract');
const { Severity } = require('../api/_lib/closing-audit');

const HI = 0.98; // confident read
const LO = 0.40; // unreadable

const amt = (value, page = 2, confidence = HI) => ({ value, confidence, page });

// A clean CD: everything foots, prepaid interest is right, nothing duplicated.
function cleanExtraction(over = {}) {
  return Object.assign({
    document_type: 'closing_disclosure',
    is_final: true,
    property_state: 'VA',
    property_county: 'Fairfax County',
    transaction_type: 'purchase',
    closing_date: '2026-03-18',
    loan_amount: 400000,
    interest_rate_pct: 6.5,
    pages_present: 5,
    line_items: [
      { section: 'A', label: 'Origination Charge', amount: 2000, payee: 'Bank', category: 'origination', confidence: HI, page: 2 },
      { section: 'B', label: 'Appraisal Fee', amount: 650, payee: 'Valuation Co', category: 'appraisal', confidence: HI, page: 2 },
      { section: 'C', label: 'Title - Settlement Fee', amount: 695, payee: 'Acme Title', category: 'settlement_service', shoppable: true, confidence: HI, page: 2 },
      { section: 'E', label: 'Recording Fees', amount: 155, category: 'recording_fee', confidence: HI, page: 2 },
    ],
    section_totals: {
      A: amt(2000), B: amt(650), C: amt(695), D: amt(3345),
      E: amt(155), F: amt(997.26), G: amt(1300), H: amt(0), I: amt(2452.26),
      J: amt(5797.26), lender_credits: amt(0),
    },
    cash_to_close: {
      total_closing_costs_j: amt(5797.26, 3),
      down_payment_funds_from_borrower: amt(80000, 3),
      deposit: amt(15000, 3),
      stated_cash_to_close: amt(70797.26, 3),
    },
    prepaid_interest: { amount: 997.26, confidence: HI, page: 2 },
    escrow: {
      annual_disbursements: [
        { item: 'Property taxes', annual_amount: 6000, confidence: HI },
        { item: 'Homeowner\u2019s insurance', annual_amount: 1800, confidence: HI },
      ],
      cushion_amount: 1300,
      cushion_confidence: HI,
    },
    prorations: [],
    seller_credits_on_cd: [],
    document_problems: [],
  }, over);
}

const bySeverity = (fs, sev) => fs.filter((f) => f.severity === sev);
const byCheck = (fs, id) => fs.filter((f) => f.checkId === id);

test('a clean Closing Disclosure produces no math errors', () => {
  const { findings } = runClosingAudit(cleanExtraction());
  assert.equal(bySeverity(findings, Severity.CONFIRMED_MATH_ERROR).length, 0);
});

test('a subtotal that does not foot is caught end to end', () => {
  const e = cleanExtraction();
  e.section_totals.D = amt(3545); // A+B+C is 3345
  const { findings } = runClosingAudit(e);
  const errs = bySeverity(findings, Severity.CONFIRMED_MATH_ERROR);
  assert.ok(errs.some((f) => f.checkId.startsWith('ARITH_D')));
  assert.equal(errs.find((f) => f.checkId.startsWith('ARITH_D')).dollarImpact, 200);
});

test('wrong prepaid interest is caught from the extraction', () => {
  const e = cleanExtraction({ prepaid_interest: { amount: 2136.99, confidence: HI, page: 2 } });
  const { findings } = runClosingAudit(e);
  const f = byCheck(findings, 'PREPAID_INTEREST')[0];
  assert.equal(f.severity, Severity.CONFIRMED_MATH_ERROR);
  assert.equal(f.expected, 997.26);
});

test('an unreadable line item is excluded rather than used', () => {
  const e = cleanExtraction();
  e.line_items.push({
    section: 'C', label: "Owner's Title Policy", amount: 2905,
    category: 'title_insurance_owners', confidence: LO, page: 2,
  });
  const { findings } = runClosingAudit(e);
  const warn = byCheck(findings, 'EXTRACTION_CONFIDENCE');
  assert.equal(warn.length, 1);
  assert.match(warn[0].title, /Owner's Title Policy/);
  // and it must not have been benchmarked or duplicate-checked
  assert.equal(findings.some((f) => f.title && f.title.includes("Owner's Title Policy: ")), false);
});

test('checks whose inputs are missing are reported as skipped, not passed', () => {
  const e = cleanExtraction({ prepaid_interest: undefined, escrow: {} });
  const { skipped } = runClosingAudit(e);
  assert.ok(skipped.includes('prepaid interest'));
  assert.ok(skipped.includes('escrow cushion'));
});

test('document problems reported by the extractor become findings', () => {
  const e = cleanExtraction({ document_problems: ['Page 3 is cut off at the bottom.'] });
  const { findings } = runClosingAudit(e);
  const f = byCheck(findings, 'DOCUMENT_PROBLEM')[0];
  assert.equal(f.severity, Severity.REQUIRES_DOCUMENTATION);
  assert.match(f.basis, /Page 3/);
});

test('benchmarkable fees come back cannot-benchmark while the corpus is empty', () => {
  const { findings } = runClosingAudit(cleanExtraction());
  const cb = bySeverity(findings, Severity.CANNOT_BENCHMARK);
  assert.ok(cb.length >= 3); // appraisal, settlement, recording
  assert.ok(cb.every((f) => /insufficient reliable market data/.test(f.basis)));
});

test('an injected benchmark is used, and a hard rate table outranks a market range', () => {
  const e = cleanExtraction();
  e.line_items.push({
    section: 'C', label: "Owner's Title Policy", amount: 2905,
    category: 'title_insurance_owners', confidence: HI, page: 2,
  });
  const { findings } = runClosingAudit(e, {
    getBenchmark: ({ category }) => category === 'title_insurance_owners'
      ? { exact: 2405, evidence: 'hard_rule:promulgated_or_filed_rate', source: 'State filed rate', jurisdiction: 'VA' }
      : null,
  });
  const f = findings.find((x) => x.title && x.title.includes("Owner's Title Policy"));
  assert.equal(f.severity, Severity.POTENTIAL_OVERCHARGE);
  assert.equal(f.dollarImpact, 500);
});

// --- the provider-list answer -----------------------------------------------

test('only an explicit yes unlocks the 10% bucket', () => {
  assert.equal(normalizeProviderListAnswer('yes'), true);
  assert.equal(normalizeProviderListAnswer('no'), false);
  assert.equal(normalizeProviderListAnswer('dont_know'), null);
  assert.equal(normalizeProviderListAnswer(undefined), null);
});

test('answering no to the provider-list question changes the tolerance outcome', () => {
  const e = cleanExtraction();
  const les = [{
    docId: 'LE1', dateIssued: '2026-01-05', dateReceived: '2026-01-05',
    changedCircumstanceDocumented: null,
    // A realistic LE lists every charge. A charge absent from the baseline is
    // correctly treated as a full increase, so a sparse fixture would test
    // nothing but that.
    charges: {
      'origination:origination_charge': { label: 'Origination Charge', amount: 2000, category: 'origination' },
      'appraisal:appraisal_fee': { label: 'Appraisal Fee', amount: 650, category: 'appraisal' },
      'settlement_service:title_settlement_fee': { label: 'Title - Settlement Fee', amount: 600, category: 'settlement_service', shoppable: true },
      'recording_fee:recording_fees': { label: 'Recording Fees', amount: 155, category: 'recording_fee' },
    },
  }];

  const withList = runClosingAudit(e, { loanEstimates: les, answers: { provider_list: 'yes' } });
  const withoutList = runClosingAudit(e, { loanEstimates: les, answers: { provider_list: 'no' } });

  // 600 -> 695 sits inside the 10% band, so with a list there is no violation;
  // without a list the same increase is tested at zero tolerance.
  assert.equal(byCheck(withList.findings, 'TRID_ZERO_TOLERANCE').length, 0);
  const zero = byCheck(withoutList.findings, 'TRID_ZERO_TOLERANCE');
  assert.equal(zero.length, 1);
  assert.equal(zero[0].dollarImpact, 95);
});

test('a cure deadline note is produced only when Loan Estimates were supplied', () => {
  assert.equal(runClosingAudit(cleanExtraction()).cureNote, null);
  const withLes = runClosingAudit(cleanExtraction(), {
    loanEstimates: [{ docId: 'LE1', dateIssued: '2026-01-05', dateReceived: '2026-01-05', changedCircumstanceDocumented: null, charges: {} }],
  });
  assert.match(withLes.cureNote, /2026-05-17/);
});

// --- the free scorecard ------------------------------------------------------

test('the scorecard reports headline figures and counts', () => {
  const e = cleanExtraction();
  const { findings, skipped } = runClosingAudit(e);
  const sc = buildScorecard(e, findings, skipped);
  assert.equal(sc.is_closing_disclosure, true);
  assert.equal(sc.total_closing_costs, 5797.26);
  assert.equal(sc.loan_amount, 400000);
  assert.equal(sc.closing_costs_pct_of_loan, 1.4); // 5797.26 / 400000 = 1.449% -> 1.4
  assert.equal(sc.property_county, 'Fairfax County');
  assert.ok(sc.needs_more_documents_count >= 3);
});

test('the scorecard counts real flags', () => {
  const e = cleanExtraction({ prepaid_interest: { amount: 2136.99, confidence: HI, page: 2 } });
  const { findings, skipped } = runClosingAudit(e);
  assert.equal(buildScorecard(e, findings, skipped).flag_count, 1);
});

test('the scorecard never leaks a flagged fee name or its dollar impact', () => {
  const e = cleanExtraction({ prepaid_interest: { amount: 2136.99, confidence: HI, page: 2 } });
  e.line_items.push(
    { section: 'B', label: 'Settlement Fee', amount: 695, payee: 'Acme Title', category: 'settlement_service', confidence: HI, page: 2 },
    { section: 'E', label: 'Closing Fee', amount: 450, payee: 'Acme Title', category: 'settlement_service', confidence: HI, page: 2 }
  );
  const { findings, skipped } = runClosingAudit(e);
  const sc = buildScorecard(e, findings, skipped);
  const blob = JSON.stringify(sc);

  assert.ok(sc.flag_count >= 2);
  // the paid report's content must not appear anywhere in the free payload
  assert.equal(/Settlement Fee|Closing Fee|Prepaid interest/i.test(blob), false);
  assert.equal(blob.includes('1139.73'), false);
  assert.equal(blob.includes('recommendedAction'), false);
});

test('an unreadable document surfaces its warning count on the scorecard', () => {
  const e = cleanExtraction();
  e.line_items[1].confidence = LO;
  const { findings, skipped } = runClosingAudit(e);
  assert.equal(buildScorecard(e, findings, skipped).extraction_warning_count, 1);
});

test('the confidence threshold is the documented 0.85', () => {
  assert.equal(CONF_THRESHOLD, 0.85);
});
