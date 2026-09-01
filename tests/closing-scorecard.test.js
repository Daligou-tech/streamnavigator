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
  // These three were CANNOT_BENCHMARK, which is our missing rate data, not a
  // document the customer can supply. They are counted separately now.
  assert.ok(sc.cannot_benchmark_count >= 3);
  assert.equal(sc.needs_more_documents_count, 0);
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

// --- ALTA Settlement Statements ---------------------------------------------
// The title company's own form. Buyers routinely have this and believe it IS
// their closing paperwork, so refusing it loses customers holding a usable
// document. It carries the charges but not the loan terms.

function altaExtraction(over = {}) {
  return Object.assign({
    document_type: 'alta_settlement_statement',
    property_state: 'VA',
    property_county: 'Fairfax County',
    pages_present: 3,
    line_items: [
      { section: 'none', label: 'Settlement Fee', amount: 695, payee: 'Acme Title', category: 'settlement_service', confidence: HI, page: 1 },
      { section: 'none', label: 'Closing Fee', amount: 450, payee: 'Acme Title', category: 'settlement_service', confidence: HI, page: 1 },
      { section: 'none', label: "Owner's Title Policy", amount: 2905, payee: 'Acme Title', category: 'title_insurance_owners', confidence: HI, page: 2 },
      { section: 'none', label: 'Recording Fees', amount: 155, category: 'recording_fee', confidence: HI, page: 2 },
    ],
    prorations: [],
    seller_credits_on_cd: [],
    document_problems: [],
  }, over);
}

test('an ALTA statement is audited, not rejected', () => {
  const { findings } = runClosingAudit(altaExtraction());
  assert.ok(findings.length > 0);
  const sc = buildScorecard(altaExtraction(), findings, []);
  assert.equal(sc.document_label, 'ALTA Settlement Statement');
  assert.equal(sc.is_closing_disclosure, false);
});

test('duplicate detection works on a document with no lettered sections', () => {
  // This is the regression that mattered: charges on an ALTA carry section
  // 'none', and the detector used to only look at A, B, C and E.
  const { findings } = runClosingAudit(altaExtraction());
  const dupes = byCheck(findings, 'DUPLICATE_CANDIDATE');
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].dollarImpact, 450);
  assert.equal(dupes[0].detail.samePayee, true);
});

test('an ALTA audit states which checks it cannot run', () => {
  const { findings } = runClosingAudit(altaExtraction());
  const scope = byCheck(findings, 'DOCUMENT_SCOPE')[0];
  assert.equal(scope.severity, Severity.REQUIRES_DOCUMENTATION);
  assert.match(scope.basis, /prepaid interest/);
  assert.match(scope.basis, /escrow cushion/);
  assert.match(scope.recommendedAction, /Closing Disclosure/);
});

test('the scorecard tells the customer what the missing document costs them', () => {
  const e = altaExtraction();
  const { findings, skipped } = runClosingAudit(e);
  const sc = buildScorecard(e, findings, skipped);
  assert.ok(sc.checks_unavailable.includes('prepaid interest'));
  assert.ok(sc.checks_unavailable.includes('escrow cushion'));
  assert.ok(sc.checks_unavailable.includes('TRID tolerance testing'));
});

test('a real Closing Disclosure reports nothing as unavailable', () => {
  const e = cleanExtraction();
  const { findings, skipped } = runClosingAudit(e);
  const sc = buildScorecard(e, findings, skipped);
  assert.deepEqual(sc.checks_unavailable, []);
  assert.equal(sc.document_label, 'Closing Disclosure');
  assert.equal(byCheck(findings, 'DOCUMENT_SCOPE').length, 0);
});

test('a Loan Estimate or unrelated document is still not accepted', () => {
  const { ACCEPTED_DOCUMENT_TYPES } = require('../api/_lib/closing-extract');
  assert.deepEqual(ACCEPTED_DOCUMENT_TYPES, ['closing_disclosure', 'alta_settlement_statement']);
  assert.equal(ACCEPTED_DOCUMENT_TYPES.includes('loan_estimate'), false);
  assert.equal(ACCEPTED_DOCUMENT_TYPES.includes('other'), false);
});

// --- regression: a real ALTA statement from Baltimore City -------------------
// Lines taken from an actual customer document. The first live run flagged 29
// duplicates on this file, all false: the extractor writes the payee into the
// label ("Credit Report to Superior Settlement Services, LLC"), so matching the
// whole string made every fee paid to that company look like a settlement
// charge. A credit report and a rehab escrow are not duplicates.

const REAL_ALTA_LINES = [
  { section: 'none', label: 'Sales Price of Property', amount: 90000, payee: null, paid_by: 'borrower', category: null, confidence: HI, page: 1 },
  { section: 'none', label: 'Loan Amount', amount: 96000, payee: null, paid_by: 'borrower', category: null, confidence: HI, page: 1 },
  { section: 'none', label: 'Credit Report to Superior Settlement Services, LLC', amount: 50, payee: 'Superior Settlement Services, LLC', paid_by: 'borrower', category: 'credit_report', confidence: HI, page: 1 },
  { section: 'none', label: 'Lender Discount Fee to Superior Settlement Services, LLC', amount: 3000, payee: 'Superior Settlement Services, LLC', paid_by: 'borrower', category: 'origination', confidence: HI, page: 1 },
  { section: 'none', label: 'Property Evaluation and Review to Superior Settlement Services, LLC', amount: 450, payee: 'Superior Settlement Services, LLC', paid_by: 'borrower', category: 'appraisal', confidence: HI, page: 1 },
  { section: 'none', label: 'Rehab Escrow to Superior Settlement Services, LLC', amount: 24000, payee: 'Superior Settlement Services, LLC', paid_by: 'borrower', category: 'escrow_deposit', confidence: HI, page: 2 },
  { section: 'none', label: 'Wire Fee to Superior Settlement Services, LLC', amount: 35, payee: 'Superior Settlement Services, LLC', paid_by: 'borrower', category: 'other', confidence: HI, page: 2 },
  { section: 'none', label: 'Title - Settlement Fee to Home First Title Group, LLC', amount: 250, payee: 'Home First Title Group, LLC', paid_by: 'borrower', category: 'settlement_service', confidence: HI, page: 2 },
  { section: 'none', label: 'Title - Title Examination to Home First Title Group, LLC', amount: 395, payee: 'Home First Title Group, LLC', paid_by: 'borrower', category: 'title_insurance_owners', confidence: HI, page: 2 },
  { section: 'none', label: 'Recording Fees (Deed) to Circuit Court for Baltimore City', amount: 60, payee: 'Circuit Court for Baltimore City', paid_by: 'borrower', category: 'recording_fee', confidence: HI, page: 2 },
  { section: 'none', label: 'Recording Fees (Mortgage) to Circuit Court for Baltimore City', amount: 115, payee: 'Circuit Court for Baltimore City', paid_by: 'borrower', category: 'recording_fee', confidence: HI, page: 2 },
  { section: 'none', label: 'Real Estate Commission Sellers Broker to Long & Foster', amount: 4950, payee: 'Long & Foster Real Estate Inc.', paid_by: 'seller', category: 'settlement_service', confidence: HI, page: 3 },
];

const realAlta = () => altaExtraction({
  property_state: 'MD', property_county: null, loan_amount: 96000,
  line_items: REAL_ALTA_LINES,
});

test('the payee embedded in a fee label does not create phantom duplicates', () => {
  const { findings } = runClosingAudit(realAlta());
  const dupes = byCheck(findings, 'DUPLICATE_CANDIDATE');
  assert.equal(dupes.length, 0, dupes.map((d) => d.title).join('\n'));
});

test('two charges from different providers are two providers, not a duplicate', () => {
  const { findings } = runClosingAudit(altaExtraction({
    line_items: [
      { section: 'none', label: 'Wire Fee to Superior Settlement Services', amount: 35, payee: 'Superior Settlement Services', paid_by: 'borrower', category: 'other', confidence: HI, page: 1 },
      { section: 'none', label: 'Title - Wire Fee to Home First Title', amount: 25, payee: 'Home First Title', paid_by: 'borrower', category: 'other', confidence: HI, page: 1 },
    ],
  }));
  assert.equal(byCheck(findings, 'DUPLICATE_CANDIDATE').length, 0);
});

test('a genuine same-payee duplicate is still caught', () => {
  const { findings } = runClosingAudit(altaExtraction({
    line_items: [
      { section: 'none', label: 'Settlement Fee to Acme Title', amount: 695, payee: 'Acme Title', paid_by: 'borrower', category: 'settlement_service', confidence: HI, page: 1 },
      { section: 'none', label: 'Closing Fee to Acme Title', amount: 450, payee: 'Acme Title', paid_by: 'borrower', category: 'settlement_service', confidence: HI, page: 1 },
    ],
  }));
  const dupes = byCheck(findings, 'DUPLICATE_CANDIDATE');
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].dollarImpact, 450);
});

test('missing rate data is not reported as a missing document', () => {
  // The customer cannot upload anything that fixes an empty benchmark corpus.
  const e = realAlta();
  const { findings, skipped } = runClosingAudit(e);
  const sc = buildScorecard(e, findings, skipped);
  assert.ok(sc.cannot_benchmark_count > 0);
  assert.equal(sc.needs_more_documents_count < sc.cannot_benchmark_count, true);
});

test('a settlement statement gets a total added up from its charge lines', () => {
  const e = realAlta();
  const { findings, skipped } = runClosingAudit(e);
  const sc = buildScorecard(e, findings, skipped);
  assert.equal(sc.total_closing_costs, null);        // no printed J on an ALTA
  assert.equal(sc.total_is_derived, true);           // so it is labelled calculated
  // borrower-paid charge lines only: 50+3000+450+24000+35+250+395+60+115 = 28355
  assert.equal(sc.total_borrower_charges, 28355);
  assert.equal(sc.charge_lines_counted, 9);
  // sale price, loan amount and the seller's commission are excluded
});
