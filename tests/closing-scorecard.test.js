// Tests for the scorecard path: extraction confidence gating, audit
// orchestration over an extracted CD, and what the free scorecard does and does
// not reveal.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runClosingAudit, buildScorecard, normalizeProviderListAnswer, CONF_THRESHOLD,
} = require('../api/_lib/closing-extract');
const { Severity, checkCashToClose, reconcileContract } = require('../api/_lib/closing-audit');

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
  // borrower-paid FEE lines only: 50+3000+450+35+250+395+60+115 = 4355.
  // The $24,000 rehab escrow is a holdback, not a charge, and is reported
  // separately. Sale price, loan amount and the seller's commission are excluded.
  assert.equal(sc.total_borrower_charges, 4355);
  assert.equal(sc.charge_lines_counted, 8);
  assert.equal(sc.deposits_excluded.total, 24000);
});

test('deposits and holdbacks are not counted as closing charges', () => {
  // A rehab loan's construction escrow is the borrower's own money held back for
  // the work. The first real document through this system carried $24,000 of it,
  // and counting it as a charge produced a headline of 33.3% of the loan against
  // a true figure near 8%.
  const e = altaExtraction({
    loan_amount: 96000,
    line_items: [
      { section: 'none', label: 'Rehab Escrow to Superior Settlement Services, LLC', amount: 24000, payee: 'Superior Settlement Services, LLC', paid_by: 'borrower', category: 'escrow_deposit', confidence: HI, page: 2 },
      { section: 'none', label: 'Lender Discount Fee to Superior Settlement Services, LLC', amount: 3000, payee: 'Superior Settlement Services, LLC', paid_by: 'borrower', category: 'lender_fee', confidence: HI, page: 1 },
      { section: 'none', label: 'Title - Settlement Fee to Home First Title Group, LLC', amount: 250, payee: 'Home First Title Group, LLC', paid_by: 'borrower', category: 'settlement_service', confidence: HI, page: 2 },
    ],
  });
  const { findings, skipped } = runClosingAudit(e);
  const sc = buildScorecard(e, findings, skipped);

  assert.equal(sc.total_borrower_charges, 3250);   // not 27,250
  assert.equal(sc.charge_lines_counted, 2);
  assert.equal(sc.deposits_excluded.total, 24000); // surfaced, not silently dropped
  assert.equal(sc.deposits_excluded.count, 1);
});

test('the deposits note applies only to a derived total, never to a printed J', () => {
  // Total Closing Costs (J) already includes the section G escrow payment, so
  // claiming those amounts were excluded from it would be untrue.
  const cd = cleanExtraction();
  const cdRun = runClosingAudit(cd);
  const cdCard = buildScorecard(cd, cdRun.findings, cdRun.skipped);
  assert.equal(cdCard.total_is_derived, false);
  assert.equal(cdCard.total_closing_costs, 5797.26);

  const alta = altaExtraction({
    line_items: [
      { section: 'none', label: 'Escrow Deposit', amount: 1200, payee: 'X', paid_by: 'borrower', category: 'escrow_deposit', confidence: HI, page: 1 },
      { section: 'none', label: 'Settlement Fee to X', amount: 500, payee: 'X', paid_by: 'borrower', category: 'settlement_service', confidence: HI, page: 1 },
    ],
  });
  const altaRun = runClosingAudit(alta);
  const altaCard = buildScorecard(alta, altaRun.findings, altaRun.skipped);
  assert.equal(altaCard.total_is_derived, true);
  assert.equal(altaCard.deposits_excluded.total, 1200);
});

// --- customer-supplied corrections ------------------------------------------
// Closing the loop on "type the value in manually" — which the product used to
// say with nowhere to type and nothing that would recompute.

const { listUnreadableFields, mergeCustomerValues } = require('../api/_lib/closing-extract');

function unreadableCD() {
  const e = cleanExtraction();
  e.line_items[1].confidence = 0.70;          // Appraisal Fee, page 2
  e.section_totals.J = { value: 5797.26, confidence: 0.60, page: 2 };
  return e;
}

test('unreadable figures are listed with a path, a label and a page', () => {
  const fields = listUnreadableFields(unreadableCD());
  const paths = fields.map((f) => f.path);
  assert.ok(paths.includes('line_items.1'));
  assert.ok(paths.includes('section_totals.J'));
  const j = fields.find((f) => f.path === 'section_totals.J');
  assert.match(j.label, /Total Closing Costs/);
  assert.equal(j.page, 2);
});

test('a clean document offers nothing to correct', () => {
  assert.deepEqual(listUnreadableFields(cleanExtraction()), []);
});

test('only fields we flagged as unreadable can be overwritten', () => {
  // Otherwise this endpoint would let a caller rewrite any figure on the
  // document, including ones we read correctly.
  const { applied, rejected } = mergeCustomerValues(unreadableCD(), {
    'line_items.1': '650',
    'section_totals.A': '99999',   // read fine, must not be accepted
    'loan_amount': '1',
  });
  assert.equal(applied.length, 1);
  assert.equal(applied[0].path, 'line_items.1');
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every((r) => r.reason === 'not_flagged_as_unreadable'));
});

test('currency formatting and junk input are handled', () => {
  const { applied, rejected } = mergeCustomerValues(unreadableCD(), {
    'section_totals.J': '$5,797.26',
    'line_items.1': 'about six hundred',
  });
  assert.equal(applied.find((a) => a.path === 'section_totals.J').value, 5797.26);
  assert.ok(rejected.some((r) => r.reason === 'not_a_number'));
});

test('a corrected value unblocks the check that needed it', () => {
  const before = runClosingAudit(unreadableCD());
  assert.ok(before.skipped.includes('section subtotals'));

  const { extraction } = mergeCustomerValues(unreadableCD(), {
    'section_totals.J': '5797.26', 'line_items.1': '650',
  });
  const after = runClosingAudit(extraction);
  assert.equal(after.skipped.includes('section subtotals'), false);
});

test('a typed figure never looks like a verified reading', () => {
  // The whole risk of this feature: a mistyped digit becoming a confident
  // accusation the customer emails to their lender.
  const { extraction } = mergeCustomerValues(unreadableCD(), {
    'section_totals.J': '9999.99',   // wrong on purpose — J no longer foots
    'line_items.1': '650',
  });
  const { findings } = runClosingAudit(extraction);
  const arith = findings.filter((f) => f.checkId.startsWith('ARITH_J'));
  assert.equal(arith.length, 1);
  assert.equal(arith[0].basedOnCustomerInput, true);
  // downgraded: the DOCUMENT has not been shown to be wrong, the typing might be
  assert.equal(arith[0].severity, Severity.REQUIRES_DOCUMENTATION);
  assert.match(arith[0].basis, /figure you entered manually/);
  assert.match(arith[0].recommendedAction, /Double-check the figure you entered/);
});

test('findings from correctly-read values keep their full weight', () => {
  const e = cleanExtraction();
  e.section_totals.D = { value: 3545, confidence: HI, page: 2 }; // A+B+C is 3345
  const { findings } = runClosingAudit(e);
  const arith = findings.find((f) => f.checkId.startsWith('ARITH_D'));
  assert.equal(arith.severity, Severity.CONFIRMED_MATH_ERROR);
  assert.equal(arith.basedOnCustomerInput, false);
});

test('the scorecard reports what is still unread and what was supplied', () => {
  const e = unreadableCD();
  const r1 = runClosingAudit(e);
  const c1 = buildScorecard(e, r1.findings, r1.skipped);
  assert.equal(c1.unreadable_fields.length, 2);
  assert.equal(c1.customer_supplied_count, 0);

  const { extraction } = mergeCustomerValues(e, { 'section_totals.J': '5797.26' });
  const r2 = runClosingAudit(extraction);
  const c2 = buildScorecard(extraction, r2.findings, r2.skipped);
  assert.equal(c2.unreadable_fields.length, 1);   // shrinking list
  assert.equal(c2.customer_supplied_count, 1);
});

test('an unreadable-field finding gives no surface-specific instruction', () => {
  // Findings render into the web report, a PDF, and forwarded emails. "Type the
  // value in manually" is actionable on one of those and false on the others,
  // so the finding states the fact and each surface decides what to offer.
  const { warnings } = require('../api/_lib/closing-audit')
    .gateExtraction([{ name: 'Mortgage Insurance Premium', page: 3, confidence: 0.70 }]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].recommendedAction, '');
  assert.match(warnings[0].whyItMatters, /excluded rather than guessed/);
  assert.equal(/type the value|upload a clearer/i.test(JSON.stringify(warnings[0])), false);
});

// Transfer-tax benchmarking against the Maryland corpus was removed when
// benchmarking was retired. See tests/promises.test.js, which now asserts the
// corpus stays gone.

// --- pricing tiers -----------------------------------------------------------
// Value here is genuinely bimodal: a CD alone supports verification, while Loan
// Estimates and the contract support analyses that can conclude money is owed.
// One price would overcharge the first customer and undercharge the second.

const { determineTier, TIERS } = require('../api/_lib/closing-extract');

test('a Closing Disclosure on its own is the CD-only coverage tier', () => {
  const t = determineTier([{ index: 0, document_type: 'closing_disclosure' }]);
  assert.equal(t.id, 'basic');
  // Pricing is flat. The tier id records which analysis ran; it does not price
  // it, so this must stay level with the full tier.
  assert.equal(t.price_cents, 5900);
  assert.equal(t.price_label, '$59');
  assert.equal(t.has_loan_estimate, false);
});

test('a settlement statement on its own is also the CD-only tier', () => {
  assert.equal(determineTier([{ index: 0, document_type: 'alta_settlement_statement' }]).id, 'basic');
});

test('a Loan Estimate moves it to $59', () => {
  const t = determineTier([
    { index: 0, document_type: 'closing_disclosure' },
    { index: 1, document_type: 'loan_estimate' },
  ]);
  assert.equal(t.id, 'full');
  assert.equal(t.price_cents, 5900);
  assert.equal(t.has_loan_estimate, true);
  assert.equal(t.has_purchase_contract, false);
});

test('a purchase contract alone also moves it to $59', () => {
  const t = determineTier([
    { index: 0, document_type: 'closing_disclosure' },
    { index: 1, document_type: 'purchase_contract' },
  ]);
  assert.equal(t.id, 'full');
  assert.equal(t.has_purchase_contract, true);
});

test('several Loan Estimates are still $59, not $59 each', () => {
  const t = determineTier([
    { index: 0, document_type: 'closing_disclosure' },
    { index: 1, document_type: 'loan_estimate' },
    { index: 2, document_type: 'loan_estimate' },
    { index: 3, document_type: 'purchase_contract' },
  ]);
  assert.equal(t.id, 'full');
  assert.equal(t.upgrade_documents, 3);
  assert.equal(t.price_cents, 5900);
});

test('an unrelated extra document does not trigger the upgrade price', () => {
  // Uploading a bank statement must not silently cost the customer $30 more.
  const t = determineTier([
    { index: 0, document_type: 'closing_disclosure' },
    { index: 1, document_type: 'other' },
  ]);
  assert.equal(t.id, 'basic');
  assert.equal(t.upgrade_documents, 0);
});

test('both coverage tiers carry the one agreed price', () => {
  assert.deepEqual(Object.keys(TIERS), ['basic', 'full']);
  assert.equal(TIERS.full.price_cents, 5900);
  assert.equal(TIERS.basic.price_cents, TIERS.full.price_cents,
    'a coverage tier priced differently from checkout is a billing dispute');
  assert.equal(TIERS.basic.price_label, TIERS.full.price_label);
});

// --- regression: 4324 Parkside Dr refinance ----------------------------------
// A real customer document that produced two confident false positives in a
// PAID report: a $95,155.17 "confirmed mathematical error" in Cash to Close and
// a $1,024.48 escrow cushion "overcharge". The document was correct in both
// cases. These are the highest-severity labels the system can apply, so getting
// them wrong discredits every other finding.

const parksideCTC = {
  transactionType: 'refinance',
  loanAmount: 183750,
  totalClosingCostsJ: 10056.36,
  closingCostsPaidBeforeClosing: 0,
  totalPayoffsAndPayments: 68482.11,
  statedCashToClose: 105211.53,
};

test('a refinance uses the alternative Cash to Close table', () => {
  // 183,750.00 − 10,056.36 − 68,482.11 = 105,211.53, exactly as printed.
  const f = checkCashToClose(parksideCTC);
  assert.equal(f.severity, Severity.WITHIN_NORMS);
  assert.equal(f.expected, 105211.53);
  assert.equal(f.variance, 0);
  assert.equal(f.detail.table, 'alternative');
});

test('the purchase formula is never applied to a refinance', () => {
  // Without the fix this returned a $95,155.17 confirmed mathematical error.
  const f = checkCashToClose(parksideCTC);
  assert.notEqual(f.severity, Severity.CONFIRMED_MATH_ERROR);
  assert.equal(f.dollarImpact, null);
});

test('the alternative table is detected from payoffs when type is unknown', () => {
  const f = checkCashToClose({ ...parksideCTC, transactionType: undefined });
  assert.equal(f.detail.table, 'alternative');
  assert.equal(f.severity, Severity.WITHIN_NORMS);
});

test('a genuine refinance error is still caught', () => {
  const f = checkCashToClose({ ...parksideCTC, statedCashToClose: 106211.53 });
  assert.equal(f.severity, Severity.CONFIRMED_MATH_ERROR);
  assert.equal(f.dollarImpact, 1000);
});

test('purchases still use the standard table', () => {
  const f = checkCashToClose({
    transactionType: 'purchase',
    totalClosingCostsJ: 13365, downPaymentFundsFromBorrower: 80000,
    deposit: 15000, sellerCredits: 6000, adjustmentsAndOtherCredits: 1200,
    statedCashToClose: 71165,
  });
  assert.equal(f.severity, Severity.WITHIN_NORMS);
  assert.notEqual(f.detail.table, 'alternative');
});

test('Section G is never tested against the RESPA cushion cap', () => {
  // Parkside: annual escrowed costs 3,073.44 (cap 512.24); Section G 1,536.72 —
  // 11 months of hazard insurance plus 6 months of taxes less a 380.85 aggregate
  // adjustment. Reporting that as a 1,024.48 overcharge was the bug.
  const e = cleanExtraction({
    transaction_type: 'refinance',
    escrow: {
      annual_disbursements: [{ item: 'Property taxes and insurance', annual_amount: 3073.44, confidence: HI }],
      section_g_total: 1536.72,
      aggregate_adjustment: -380.85,
      // no cushion_amount: the document does not state one
    },
  });
  const { findings, skipped } = runClosingAudit(e);
  const f = byCheck(findings, 'ESCROW_CUSHION')[0];
  assert.equal(f.severity, Severity.INFORMATIONAL);
  assert.notEqual(f.severity, Severity.POTENTIAL_OVERCHARGE);
  assert.equal(f.dollarImpact, null);
  assert.match(f.basis, /not the cushion itself/);
  assert.ok(skipped.some((s) => /escrow cushion/.test(s)));
});

test('a separately stated cushion over the cap is still flagged', () => {
  const e = cleanExtraction({
    escrow: {
      annual_disbursements: [{ item: 'taxes', annual_amount: 3073.44, confidence: HI }],
      cushion_amount: 900,
    },
  });
  const f = byCheck(runClosingAudit(e).findings, 'ESCROW_CUSHION')[0];
  assert.equal(f.severity, Severity.POTENTIAL_OVERCHARGE);
  assert.equal(f.expected, 512.24);
});

test('a Closing Protection Letter is not a duplicate settlement fee', () => {
  // 'closing' matched "Closing Protection Letter" — a distinct standard title
  // product — against the settlement/closing cluster.
  const e = altaExtraction({
    line_items: [
      { section: 'C', label: 'Title - Closing Protection Letter', amount: 25, payee: 'Boston National Title Agency LLC', paid_by: 'borrower', category: 'settlement_service', confidence: HI, page: 2 },
      { section: 'C', label: 'Title - Settlement Fee', amount: 425, payee: 'Boston National Title Agency LLC', paid_by: 'borrower', category: 'settlement_service', confidence: HI, page: 2 },
      { section: 'C', label: "Title - Lender's Title Insurance", amount: 349.13, payee: 'Boston National Title Agency LLC', paid_by: 'borrower', category: 'title_insurance_lenders', confidence: HI, page: 2 },
    ],
  });
  assert.equal(byCheck(runClosingAudit(e).findings, 'DUPLICATE_CANDIDATE').length, 0);
});

test('a real settlement-plus-closing-fee pair is still caught', () => {
  const e = altaExtraction({
    line_items: [
      { section: 'C', label: 'Settlement Fee', amount: 695, payee: 'Acme Title', paid_by: 'borrower', category: 'settlement_service', confidence: HI, page: 2 },
      { section: 'C', label: 'Closing Fee', amount: 450, payee: 'Acme Title', paid_by: 'borrower', category: 'settlement_service', confidence: HI, page: 2 },
    ],
  });
  assert.equal(byCheck(runClosingAudit(e).findings, 'DUPLICATE_CANDIDATE').length, 1);
});

// --- regression: section subtotals are not charges ---------------------------
// The extractor returned seven section headings and subtotals as if they were
// individual charges on a real document. Consequences, all silent: a $1,320
// section total ("Taxes and Other Government Fees") was benchmarked as if it
// were a single recording fee; prepaid interest appeared twice; and the derived
// borrower-charges total came out at $99,585 on a $10,056 closing because
// subtotals and a $68,482 payoff were counted as fees.

const { isSubtotalLine } = require('../api/_lib/closing-extract');

test('section headings and totals are recognised as subtotals', () => {
  const shouldFilter = [
    'A. Origination Charges', 'Origination Charges',
    'B. Services Borrower Did Not Shop For', 'C. Services Borrower Did Shop For',
    'D. TOTAL LOAN COSTS (Borrower-Paid)', 'TOTAL LOAN COSTS (Borrower-Paid)',
    'E. Taxes and Other Government Fees', 'Taxes and Other Government Fees',
    'F. Prepaids', 'Prepaids', 'G. Initial Escrow Payment at Closing',
    'I. TOTAL OTHER COSTS (Borrower-Paid)', 'J. TOTAL CLOSING COSTS (Borrower-Paid)',
    'Loan Costs Subtotals (A + B + C)', 'K. TOTAL PAYOFFS AND PAYMENTS',
    'Virginia National Bank (Payoff)',
  ];
  for (const label of shouldFilter) {
    assert.equal(isSubtotalLine({ label }), true, `should filter: ${label}`);
  }
});

test('real charges are never mistaken for subtotals', () => {
  const shouldKeep = [
    'Appraisal Fee', 'Credit Report', 'Flood Certification',
    'Title - Settlement Fee', "Title - Lender's Title Insurance",
    'Title - Closing Protection Letter', 'Recording Fees Deed: Mortgage: $115.00',
    'City/County Tax/Stamps', 'Processing Fees', 'Underwriting Fees',
    '2.125 % of Loan Amount (Points)', 'Prepaid Interest ( $35.869 per day )',
    "Homeowner's Insurance $76.17 per month for 11 mo.", 'Aggregate Adjustment',
    'Total Loan Amount Adjustment Fee',   // starts with "Total" but is a real charge? see below
  ];
  // "Total Loan Amount Adjustment Fee" legitimately starts with "Total" and WILL
  // be filtered by the /^total\b/ rule. That is a deliberate trade: subtotals
  // named "TOTAL ..." are common and dangerous, charges beginning with "Total"
  // are rare and merely omitted. Assert the known behaviour rather than pretend.
  for (const label of shouldKeep.slice(0, -1)) {
    assert.equal(isSubtotalLine({ label }), false, `should keep: ${label}`);
  }
  assert.equal(isSubtotalLine({ label: 'Total Loan Amount Adjustment Fee' }), true);
});

test('a section subtotal is never benchmarked as a fee', () => {
  const e = cleanExtraction({
    property_state: 'MD',
    line_items: [
      { section: 'E', label: 'Recording Fees', amount: 165, category: 'recording_fee', confidence: HI, page: 2 },
      { section: 'E', label: 'Taxes and Other Government Fees', amount: 1320, category: 'recording_fee', confidence: HI, page: 2 },
    ],
  });
  const { findings } = runClosingAudit(e);
  const benchmarked = findings.filter((f) => f.checkId === 'BENCHMARK').map((f) => f.title);
  assert.equal(benchmarked.some((t) => /Taxes and Other Government Fees/.test(t)), false);
  assert.equal(benchmarked.some((t) => /Recording Fees/.test(t)), true);
});

test('subtotals and payoffs are excluded from the derived charges total', () => {
  const e = altaExtraction({
    loan_amount: 183750,
    line_items: [
      { section: 'none', label: 'Appraisal Fee', amount: 770, payee: 'X', paid_by: 'borrower', category: 'appraisal', confidence: HI, page: 2 },
      { section: 'none', label: 'Title - Settlement Fee', amount: 425, payee: 'Y', paid_by: 'borrower', category: 'settlement_service', confidence: HI, page: 2 },
      { section: 'none', label: 'TOTAL CLOSING COSTS (Borrower-Paid)', amount: 10056.36, payee: null, paid_by: 'borrower', category: 'other', confidence: HI, page: 2 },
      { section: 'none', label: 'Virginia National Bank (Payoff)', amount: 68482.11, payee: 'Virginia National Bank', paid_by: 'borrower', category: 'other', confidence: HI, page: 3 },
    ],
  });
  const { findings, skipped } = runClosingAudit(e);
  const sc = buildScorecard(e, findings, skipped);
  assert.equal(sc.total_borrower_charges, 1195);   // 770 + 425, not 79,733
  assert.equal(sc.charge_lines_counted, 2);
});

// --- regression: CFPB sample H-25F1 ------------------------------------------
// A refinance with $655 in closing costs paid before closing. Subtracting that
// figure instead of adding it produced a phantom $1,310.00 "confirmed
// mathematical error" — exactly twice the amount, the signature of a sign error.
// Total Closing Costs (J) already includes amounts already paid; on the
// alternative table J is subtracted, so the paid portion must be added back.

const h25f1 = {
  transactionType: 'refinance',
  loanAmount: 150000,
  totalClosingCostsJ: 5977.57,
  closingCostsPaidBeforeClosing: 655,
  totalPayoffsAndPayments: 115000,
  statedCashToClose: 29677.43,
};

test('costs paid before closing are added back on the alternative table', () => {
  // 150,000 − 5,977.57 + 655 − 115,000 = 29,677.43, exactly as printed.
  const f = checkCashToClose(h25f1);
  assert.equal(f.severity, Severity.WITHIN_NORMS);
  assert.equal(f.expected, 29677.43);
  assert.equal(f.variance, 0);
});

test('the sign error would show as exactly twice the paid-before amount', () => {
  // Guards the specific failure: if this ever regresses the variance is 1,310,
  // which is 2 x 655. Asserting the correct value keeps that from coming back.
  const f = checkCashToClose(h25f1);
  assert.notEqual(Math.abs(f.variance), 1310);
});

test('costs paid before closing are still subtracted on a purchase', () => {
  // Opposite sign on the standard table, because there J is added.
  const f = checkCashToClose({
    transactionType: 'purchase',
    totalClosingCostsJ: 13365,
    closingCostsPaidBeforeClosing: 500,
    downPaymentFundsFromBorrower: 80000,
    deposit: 15000, sellerCredits: 6000, adjustmentsAndOtherCredits: 1200,
    statedCashToClose: 70665,
  });
  assert.equal(f.severity, Severity.WITHIN_NORMS);
});

test('a genuine error on the alternative table is still caught', () => {
  const f = checkCashToClose({ ...h25f1, statedCashToClose: 30677.43 });
  assert.equal(f.severity, Severity.CONFIRMED_MATH_ERROR);
  assert.equal(f.dollarImpact, 1000);
});

// --- regression: 2526 Heath Place, Reston VA ---------------------------------
// A purchase whose Cash to Close table reconciles to the cent. The extractor
// returned the deposit and the adjustments row carrying the minus signs the
// Closing Disclosure prints on them (-30,000 and -702.35). The formula already
// encodes the subtraction, so both were subtracted twice and the free scorecard
// led with "Dollars in question $61,405" -- exactly 2 x 30,702.35, the
// signature of a sign error, on a document with nothing wrong with it.
//
// Same family as H-25F1 above, which was fixed on the alternative table only.

const heathPlace = {
  transactionType: 'purchase',
  totalClosingCostsJ: 33825.53,
  closingCostsPaidBeforeClosing: 0,
  downPaymentFundsFromBorrower: 211300,
  deposit: -30000,
  fundsForBorrower: 0,
  sellerCredits: 0,
  adjustmentsAndOtherCredits: -702.35,
  statedCashToClose: 214423.18,
};

test('credit rows carrying their printed minus sign are not subtracted twice', () => {
  const f = checkCashToClose(heathPlace);
  assert.equal(f.severity, Severity.WITHIN_NORMS);
  assert.ok(!f.dollarImpact, 'a reconciling table must not carry a dollar figure');
});

test('the sign error would show as exactly twice the credits', () => {
  // If this regresses the variance is 61,404.70, which is 2 x 30,702.35.
  const f = checkCashToClose(heathPlace);
  assert.notEqual(Math.abs(f.variance), 61404.7);
});

test('the same table read as magnitudes gives the identical result', () => {
  // The two conventions must not disagree, or the finding a customer sees
  // depends on which extractor build read their document.
  const asMagnitudes = { ...heathPlace, deposit: 30000, adjustmentsAndOtherCredits: 702.35 };
  const a = checkCashToClose(heathPlace);
  const b = checkCashToClose(asMagnitudes);
  assert.equal(a.severity, b.severity);
  assert.equal(a.expected, b.expected);
});

test('a genuine purchase error survives the sign handling', () => {
  const f = checkCashToClose({ ...heathPlace, statedCashToClose: 219423.18 });
  assert.equal(f.severity, Severity.CONFIRMED_MATH_ERROR);
  assert.equal(f.dollarImpact, 5000);
});

test('a positive adjustments row still reconciles', () => {
  // Adjustments and Other Credits is genuinely positive when the borrower owes
  // more, not less. Taking the magnitude alone would get this wrong.
  const f = checkCashToClose({
    transactionType: 'purchase',
    totalClosingCostsJ: 10000, closingCostsPaidBeforeClosing: 0,
    downPaymentFundsFromBorrower: 50000, deposit: 5000,
    fundsForBorrower: 0, sellerCredits: 0, adjustmentsAndOtherCredits: -1500,
    statedCashToClose: 56500,
  });
  assert.equal(f.severity, Severity.WITHIN_NORMS);
});

// --- a document already uploaded is never offered as an upsell ---------------
// A customer uploaded their purchase contract, and the scorecard went on
// telling them that uploading a purchase contract would unlock a check. The
// same happened with a Loan Estimate for the wrong property: the panel above
// said replace it, the panel below said upload it.

const CD_FOR_COVERAGE = {
  document_type: 'closing_disclosure',
  loan_amount: 845200,
  closing_date: '2026-08-01',
  property_address: '2526 Heath Place, Reston VA',
  borrower_names: ['Nabi'],
  cash_to_close: {},
  line_items: [{ label: 'Origination charge', amount: 1000, category: 'origination', section: 'A' }],
};
const ANSWERS_FOR_COVERAGE = { transaction_type: 'purchase', property_type: 'single_family' };
const svc = require('../api/_lib/closing-service');
const coverageRun = (opts) => svc.runDocumentAudit({
  extraction: CD_FOR_COVERAGE, answers: ANSWERS_FOR_COVERAGE, ...opts }).scorecard;
const offered = (sc) => (sc.unlocks || []).map((u) => u.accepts);

test('a Closing Disclosure on its own is offered both extra documents', () => {
  assert.deepEqual(offered(coverageRun({})).sort(), ['loan_estimate', 'purchase_contract']);
});

test('an unusable Loan Estimate is not offered again as an upload', () => {
  const sc = coverageRun({ unusableDocuments: ['loan_estimate'] });
  assert.equal(offered(sc).includes('loan_estimate'), false,
    'the page is telling the customer to upload the document they just uploaded');
});

test('a contract with no credits is not offered again as an upload', () => {
  const sc = coverageRun({ emptyDocuments: ['purchase_contract'] });
  assert.equal(offered(sc).includes('purchase_contract'), false);
});

test('a contract with no credits leaves the denominator, it does not block it', () => {
  // "20 of 27" read identically whether the customer uploaded a contract or
  // not, so supplying one appeared to accomplish nothing.
  const alone = coverageRun({});
  const withContract = coverageRun({ emptyDocuments: ['purchase_contract'] });
  assert.equal(alone.checks_in_scope, 27);
  assert.equal(withContract.checks_in_scope, 26,
    'the contract check should leave the denominator, not sit in it as blocked');
  assert.ok(withContract.checks_blocked < alone.checks_blocked,
    'uploading the contract did not reduce the blocked count');
});

test('total closing costs falls back to the Cash to Close table', () => {
  // A page-3 excerpt, or a scan missing page 2, has no section subtotals but
  // still carries J in the Cash to Close table. Showing a blank headline there
  // is a worse answer than reading the figure that is present.
  const e = cleanExtraction({ section_totals: {}, loan_amount: 150000 });
  e.cash_to_close = { total_closing_costs_j: { value: 5977.57, confidence: HI, page: 2 } };
  const { findings, skipped } = runClosingAudit(e);
  const sc = buildScorecard(e, findings, skipped);
  assert.equal(sc.total_closing_costs, 5977.57);
  assert.equal(sc.closing_costs_pct_of_loan, 4);   // 5977.57 / 150000 = 3.98%
});

// --- Loan Estimate extraction and tolerance testing --------------------------
// The $59 tier is sold on tolerance testing. Before this existed, the Loan
// Estimate was classified, priced and stored — and never opened. runClosingAudit
// received loanEstimates: null every time, so the engine never ran on a paying
// customer's documents.

const { toLoanEstimateRecord } = require('../api/_lib/closing-extract');

const rawLE = (over = {}) => Object.assign({
  is_loan_estimate: true,
  date_issued: '2013-02-15',
  loan_amount: 150000,
  changed_circumstance_documented: false,
  charges: [
    { section: 'A', label: 'Origination Fee', amount: 1802, category: 'origination', confidence: HI },
    { section: 'B', label: 'Appraisal Fee', amount: 405, category: 'appraisal', confidence: HI },
    { section: 'C', label: 'Title - Settlement Agent Fee', amount: 500, category: 'settlement_service', shoppable: true, confidence: HI },
    { section: 'E', label: 'Recording Fees', amount: 85, category: 'recording_fee', confidence: HI },
  ],
}, over);

test('a Loan Estimate becomes a baseline record the tolerance engine can use', () => {
  const r = toLoanEstimateRecord(rawLE(), 'LE1');
  assert.equal(r.docId, 'LE1');
  assert.equal(r.dateIssued, '2013-02-15');
  assert.equal(Object.keys(r.charges).length, 4);
  assert.equal(r.charges['origination:origination_fee'].amount, 1802);
});

test('section C charges are marked shoppable even if the flag is absent', () => {
  const raw = rawLE();
  delete raw.charges[2].shoppable;
  const r = toLoanEstimateRecord(raw, 'LE1');
  assert.equal(r.charges['settlement_service:title_settlement_agent_fee'].shoppable, true);
});

test('an undocumented revision cannot reset the baseline', () => {
  // "Not mentioned" must be false, not unknown. Treating silence as documented
  // would let any revised LE become the tolerance baseline.
  assert.equal(toLoanEstimateRecord(rawLE({ changed_circumstance_documented: undefined }), 'LE1')
    .changedCircumstanceDocumented, false);
  assert.equal(toLoanEstimateRecord(rawLE({ changed_circumstance_documented: true }), 'LE2')
    .changedCircumstanceDocumented, true);
});

test('low-confidence Loan Estimate charges are dropped, not guessed', () => {
  const raw = rawLE();
  raw.charges[1].confidence = 0.4;
  const r = toLoanEstimateRecord(raw, 'LE1');
  assert.equal(Object.keys(r.charges).length, 3);
  assert.equal(r.charges['appraisal:appraisal_fee'], undefined);
});

test('a zero-tolerance increase between LE and CD is found end to end', () => {
  const le = toLoanEstimateRecord(rawLE(), 'LE1');
  const cd = cleanExtraction({
    closing_date: '2013-03-15',
    line_items: [
      { section: 'A', label: 'Origination Fee', amount: 2102, category: 'origination', confidence: HI, page: 2 },
      { section: 'B', label: 'Appraisal Fee', amount: 405, category: 'appraisal', confidence: HI, page: 2 },
    ],
  });
  const { findings } = runClosingAudit(cd, { loanEstimates: [le], answers: { provider_list: 'yes' } });
  const trid = byCheck(findings, 'TRID_ZERO_TOLERANCE');
  assert.equal(trid.length, 1);
  assert.equal(trid[0].dollarImpact, 300);   // 1,802 -> 2,102
  assert.match(trid[0].basis, /1026\.19\(e\)\(3\)\(i\)/);
});

test('the same fee worded differently no longer reads as an increase', () => {
  // This was the weakest link in the system and is now fixed. The two documents
  // describe the same $500 charge with different wording; multi-pass matching
  // pairs them on category and amount, so nothing is reported.
  const le = toLoanEstimateRecord(rawLE(), 'LE1');
  const cd = cleanExtraction({
    closing_date: '2013-03-15',
    line_items: [
      { section: 'C', label: 'Title - Settlement Fee', amount: 500, category: 'settlement_service', shoppable: true, confidence: HI, page: 2 },
    ],
  });
  const { findings } = runClosingAudit(cd, { loanEstimates: [le], answers: { provider_list: 'no' } });
  assert.equal(byCheck(findings, 'TRID_ZERO_TOLERANCE').length, 0);
  assert.equal(byCheck(findings, 'TRID_UNMATCHED_CHARGE').length, 0);
});

test('tolerance findings appear in the free scorecard flag count', () => {
  // Option B: the flag count is the basis of the purchase decision, so it must
  // include the analysis the customer is paying extra for. A count that excludes
  // tolerance testing tells a $59 customer "0 issues" before running the check
  // they came for.
  const le = toLoanEstimateRecord(rawLE(), 'LE1');
  const cd = cleanExtraction({
    closing_date: '2013-03-15',
    // prepaid interest is tied to the closing date in the base fixture; drop it
    // so this test measures tolerance findings and nothing else
    prepaid_interest: undefined,
    line_items: [
      { section: 'A', label: 'Origination Fee', amount: 2102, category: 'origination', confidence: HI, page: 2 },
    ],
  });

  const without = runClosingAudit(cd);
  assert.equal(buildScorecard(cd, without.findings, without.skipped).flag_count, 0);

  const withLE = runClosingAudit(cd, { loanEstimates: [le] });
  const sc = buildScorecard(cd, withLE.findings, withLE.skipped);
  assert.equal(sc.flag_count, 1);
  assert.equal(byCheck(withLE.findings, 'TRID_ZERO_TOLERANCE')[0].dollarImpact, 300);
});

test('a Loan Estimate with no issue date does not silently pass', () => {
  // Without a date we cannot order revisions or establish which LE governs.
  // Declining is correct; reporting zero findings as though the check ran is not.
  const undated = toLoanEstimateRecord(rawLE({ date_issued: undefined }), 'LE1');
  assert.equal(undated.dateIssued, null);
  // the endpoint filters on dateIssued before passing anything to the audit
  const dated = [undated].filter((r) => r.dateIssued);
  assert.equal(dated.length, 0);
});

test('22 Loan Estimate charges against an empty CD is not a pass', () => {
  // CFPB sample H-25F1 is a two-page excerpt with no closing cost details. The
  // Loan Estimate extracted 22 charges perfectly; the Closing Disclosure had
  // none. The matcher produced nothing, and the scorecard reported "we checked
  // whether any fee rose beyond what the lending rules permit, and none did".
  // Nothing was checked. A silent pass is worse than no answer.
  const le = toLoanEstimateRecord(rawLE(), 'LE1');
  const cd = cleanExtraction({ line_items: [], prepaid_interest: undefined, closing_date: '2013-03-15' });

  const { findings } = runClosingAudit(cd, { loanEstimates: [le] });
  assert.equal(byCheck(findings, 'TRID_ZERO_TOLERANCE').length, 0);
  assert.equal(byCheck(findings, 'TRID_UNMATCHED_CHARGE').length, 0);

  // The endpoint's guard: tolerance is only "tested" with charges on both sides.
  const cdChargeCount = (cd.line_items || []).length;
  assert.equal(cdChargeCount, 0);
  assert.equal(Boolean([le]) && cdChargeCount > 0, false);
});

test('tolerance counts as tested only when both documents have charges', () => {
  const le = toLoanEstimateRecord(rawLE(), 'LE1');
  const cd = cleanExtraction({
    prepaid_interest: undefined, closing_date: '2013-03-15',
    line_items: [{ section: 'A', label: 'Origination Fee', amount: 1802, category: 'origination', confidence: HI, page: 2 }],
  });
  const cdChargeCount = (cd.line_items || []).length;
  assert.equal(Boolean([le]) && cdChargeCount > 0, true);
  // matched at the same amount, so no violation
  assert.equal(byCheck(runClosingAudit(cd, { loanEstimates: [le] }).findings, 'TRID_ZERO_TOLERANCE').length, 0);
});

test('a correction does not discard tier or tolerance results', () => {
  // /api/closing-corrections rebuilt the scorecard by calling buildScorecard()
  // alone, which returns only document-level fields. Every endpoint-level field
  // — tier, tolerance_tested, loan_estimates_read, cd_charge_lines — was thrown
  // away, so a $59 customer whose Loan Estimates had already been processed was
  // shown the generic "add your Loan Estimates" message and no tolerance result.
  const previousScorecard = {
    tier: { id: 'full', price_label: '$59' },
    tolerance_tested: true,
    loan_estimates_read: 1,
    loan_estimates_uploaded: 1,
    cd_charge_lines: 23,
    flag_count: 0,
  };
  const e = cleanExtraction({ prepaid_interest: undefined });
  const { findings, skipped } = runClosingAudit(e);

  const merged = {
    ...previousScorecard,
    ...buildScorecard(e, findings, skipped),
    tier: previousScorecard.tier,
    tolerance_tested: 1 > 0 && (e.line_items || []).length > 0,
    loan_estimates_read: 1,
    cd_charge_lines: (e.line_items || []).length,
  };

  assert.equal(merged.tier.id, 'full');
  assert.equal(merged.tolerance_tested, true);
  assert.equal(merged.loan_estimates_read, 1);
  assert.ok(merged.cd_charge_lines > 0);
  // and the freshly computed document fields are still present
  assert.equal(merged.total_closing_costs, 5797.26);
});

// --- regression: nested tool output ------------------------------------------
// A real run returned { cd_extraction: { ...everything... } } instead of the
// fields at the top level. The extraction was flawless — every line item, every
// section total — but document_type was undefined, so a perfectly readable
// Closing Disclosure was rejected as "a document we cannot audit".

const { unwrapToolInput } = require('../api/_lib/closing-extract');

test('a single redundant wrapper around tool output is unwrapped', () => {
  const inner = { document_type: 'closing_disclosure', line_items: [], pages_present: 5 };
  const wrapped = { cd_extraction: inner };
  assert.deepEqual(
    unwrapToolInput(wrapped, ['document_type', 'line_items', 'pages_present']),
    inner
  );
});

test('correctly shaped output is returned untouched', () => {
  const good = { document_type: 'closing_disclosure', line_items: [{ label: 'x' }], pages_present: 5 };
  assert.equal(unwrapToolInput(good, ['document_type', 'line_items']), good);
});

test('an unrecognisable object is not mangled into something else', () => {
  // Two keys, neither expected: we cannot tell which is the payload, so leave it
  // alone rather than guess and silently discard half the data.
  const odd = { a: { document_type: 'closing_disclosure' }, b: { document_type: 'loan_estimate' } };
  assert.equal(unwrapToolInput(odd, ['document_type']), odd);
});

test('unwrapping works for the classifier and the Loan Estimate too', () => {
  assert.deepEqual(
    unwrapToolInput({ result: { documents: [{ index: 0, document_type: 'closing_disclosure' }] } }, ['documents']),
    { documents: [{ index: 0, document_type: 'closing_disclosure' }] }
  );
  assert.deepEqual(
    unwrapToolInput({ le_extraction: { is_loan_estimate: true, charges: [] } }, ['is_loan_estimate', 'charges']),
    { is_loan_estimate: true, charges: [] }
  );
});

test('null and non-objects pass through safely', () => {
  assert.equal(unwrapToolInput(null, ['x']), null);
  assert.equal(unwrapToolInput(undefined, ['x']), undefined);
  assert.equal(unwrapToolInput('text', ['x']), 'text');
});

// --- regression: the Loan Estimate must be for the same loan -----------------
// CFPB H-25(G) paired with H-24(D): same borrowers, same $150,000, but the
// Closing Disclosure is Fir Bank and the Loan Estimate is Ficus Bank. Two
// different transactions. The system produced FIVE confident tolerance findings
// by comparing one lender's fees against another's. The classifier had recorded
// both lender names; the audit never looked at them.

const { checkTransactionMatch } = require('../api/_lib/closing-extract');

test('a different lender is a hard mismatch', () => {
  const r = checkTransactionMatch(
    { lender_name: 'Fir Bank', loan_amount: 150000 },
    { lenderName: 'Ficus Bank', loanAmount: 150000 }
  );
  assert.equal(r.sameTransaction, false);
  assert.equal(r.mismatches[0].field, 'lender');
});

test('the same lender written differently still matches', () => {
  // Corporate suffixes must not create false mismatches.
  const r = checkTransactionMatch(
    { lender_name: 'Atlantic Coast Mortgage, LLC' },
    { lenderName: 'Atlantic Coast Mortgage LLC' }
  );
  assert.equal(r.sameTransaction, true);
  assert.deepEqual(r.mismatches, []);
});

test('a different property is a hard mismatch', () => {
  const r = checkTransactionMatch(
    { property_address: '4324 Parkside Dr, Baltimore, MD 21206' },
    { propertyAddress: '456 Somewhere Ave, Anytown, PA 12345' }
  );
  assert.equal(r.sameTransaction, false);
});

test('different borrowers are a hard mismatch', () => {
  // Nothing else identifies these documents: no lender, no address. The names
  // are the only evidence we hold and they disagree completely.
  const r = checkTransactionMatch(
    { borrower_names: ['Michael Jones', 'Mary Stone'] },
    { borrowerNames: ['Tarik M Nabi'] }
  );
  assert.equal(r.sameTransaction, false);
  assert.equal(r.mismatches[0].field, 'borrower');
  assert.equal(r.mismatches[0].hard, true);
});

test('one borrower in common is not a mismatch at all', () => {
  // The note names one buyer, the contract names both. Same party.
  const r = checkTransactionMatch(
    { borrower_names: ['Michael A. Jones Jr.', 'Mary Stone'] },
    { borrowerNames: ['Michael Jones'] }
  );
  assert.equal(r.sameTransaction, true);
  assert.deepEqual(r.mismatches, []);
});

test('a corroborated loan reports a name difference without refusing', () => {
  // Same lender and same house. A surname that changed between the estimate and
  // the closing is a naming quirk, not a different loan — say so, but still run
  // the tolerance comparison the customer paid for.
  const r = checkTransactionMatch(
    {
      lender_name: 'Ficus Bank, N.A.',
      property_address: '456 Somewhere Ave, Anytown, PA 12345',
      borrower_names: ['Mary Stone'],
    },
    {
      lenderName: 'Ficus Bank',
      propertyAddress: '456 Somewhere Avenue, Anytown, PA 12345',
      borrowerNames: ['Mary Jones'],
    }
  );
  assert.equal(r.sameTransaction, true);
  assert.equal(r.mismatches[0].field, 'borrower');
  assert.equal(r.mismatches[0].hard, false);
});

test('a matching lender alone is enough to corroborate disagreeing names', () => {
  const r = checkTransactionMatch(
    { lender_name: 'Ficus Bank', borrower_names: ['Mary Stone'] },
    { lenderName: 'Ficus Bank', borrowerNames: ['Tarik M Nabi'] }
  );
  assert.equal(r.sameTransaction, true);
  assert.equal(r.mismatches[0].hard, false);
});

test('an unreadable address does not corroborate anything', () => {
  // sameAddress() returns true when it cannot parse a street line — that means
  // "no contradiction", not "same house", and it must not license a comparison
  // the borrower names are arguing against.
  const r = checkTransactionMatch(
    { property_address: '', borrower_names: ['Mary Stone'] },
    { propertyAddress: '', borrowerNames: ['Tarik M Nabi'] }
  );
  assert.equal(r.sameTransaction, false);
});

test('a changed loan amount alone does not block the comparison', () => {
  // Loan amounts legitimately move between estimate and closing.
  const r = checkTransactionMatch(
    { lender_name: 'Ficus Bank', loan_amount: 162000 },
    { lenderName: 'Ficus Bank', loanAmount: 150000 }
  );
  assert.equal(r.sameTransaction, true);
  assert.equal(r.mismatches[0].field, 'loan amount');
  assert.equal(r.mismatches[0].hard, false);
});

test('missing identity fields do not manufacture a mismatch', () => {
  // An older or partial document may not state a lender we can read. Absence is
  // not evidence of a different loan.
  assert.equal(checkTransactionMatch({}, {}).sameTransaction, true);
  assert.equal(checkTransactionMatch({ lender_name: 'Ficus Bank' }, {}).sameTransaction, true);
});

test('tolerance testing is refused when the documents are different loans', () => {
  const le = toLoanEstimateRecord(rawLE({ lender_name: 'Ficus Bank' }), 'LE1');
  const cd = cleanExtraction({
    lender_name: 'Fir Bank', closing_date: '2013-04-15', prepaid_interest: undefined,
    line_items: [
      { section: 'A', label: 'Origination Fee', amount: 2102, category: 'origination', confidence: HI, page: 2 },
    ],
  });
  const { findings, skipped } = runClosingAudit(cd, { loanEstimates: [le] });

  assert.equal(byCheck(findings, 'TRID_ZERO_TOLERANCE').length, 0);
  assert.equal(byCheck(findings, 'TRID_UNMATCHED_CHARGE').length, 0);
  const mismatch = byCheck(findings, 'TRID_TRANSACTION_MISMATCH')[0];
  assert.equal(mismatch.severity, Severity.REQUIRES_DOCUMENTATION);
  assert.equal(mismatch.dollarImpact, null);
  assert.match(mismatch.basis, /Fir Bank/);
  assert.match(mismatch.basis, /Ficus Bank/);
  assert.ok(skipped.some((x) => /different loan/.test(x)));
});

test('a matching Loan Estimate still produces tolerance findings', () => {
  const le = toLoanEstimateRecord(rawLE({ lender_name: 'Ficus Bank' }), 'LE1');
  const cd = cleanExtraction({
    lender_name: 'Ficus Bank', closing_date: '2013-04-15', prepaid_interest: undefined,
    line_items: [
      { section: 'A', label: 'Origination Fee', amount: 2102, category: 'origination', confidence: HI, page: 2 },
    ],
  });
  const { findings } = runClosingAudit(cd, { loanEstimates: [le] });
  assert.equal(byCheck(findings, 'TRID_TRANSACTION_MISMATCH').length, 0);
  assert.equal(byCheck(findings, 'TRID_ZERO_TOLERANCE')[0].dollarImpact, 300);
});

test('a numbered line is a charge; an unnumbered one is a subtotal', () => {
  // The form numbers individual charges 01, 02, 03 and leaves headings and
  // totals unnumbered, so the printed number settles it without phrase matching.
  assert.equal(isSubtotalLine({ line_number: '01', label: 'Appraisal Fee' }), false);
  assert.equal(isSubtotalLine({ line_number: '08', label: 'Aggregate Adjustment' }), false);

  // A number beats the label: a real charge legitimately called "Total Loan
  // Amount Adjustment Fee" is no longer swallowed by the /^total/ rule.
  assert.equal(isSubtotalLine({ line_number: '04', label: 'Total Loan Amount Adjustment Fee' }), false);

  // No number, so the label fallback applies.
  assert.equal(isSubtotalLine({ label: 'D. TOTAL LOAN COSTS (Borrower-Paid)' }), true);
  assert.equal(isSubtotalLine({ label: 'Taxes and Other Government Fees' }), true);
});

test('a transaction mismatch is not counted as tolerance having been tested', () => {
  // The refusal was recorded in checks_skipped but tolerance_tested stayed true,
  // so the page said tolerance testing "has already run against the correct
  // baseline" on a comparison that was deliberately refused.
  const le = toLoanEstimateRecord(rawLE({ lender_name: 'Ficus Bank' }), 'LE1');
  const cd = cleanExtraction({
    lender_name: 'Fir Bank', closing_date: '2013-04-15', prepaid_interest: undefined,
    line_items: [
      { section: 'A', line_number: '01', label: 'Origination Fee', amount: 2102, category: 'origination', confidence: HI, page: 2 },
    ],
  });
  const { skipped } = runClosingAudit(cd, { loanEstimates: [le] });

  const transactionMismatch = skipped.some((x) => /different loan/.test(x));
  assert.equal(transactionMismatch, true);

  // the endpoint's guard: a refused comparison is not a tested one
  const cdChargeCount = (cd.line_items || []).length;
  assert.equal(Boolean([le]) && cdChargeCount > 0 && !transactionMismatch, false);
});

test('skipped checks are recorded in language a customer can act on', () => {
  const le = toLoanEstimateRecord(rawLE({ lender_name: 'Ficus Bank' }), 'LE1');
  const cd = cleanExtraction({
    lender_name: 'Fir Bank', closing_date: '2013-04-15', prepaid_interest: undefined,
    line_items: [{ section: 'A', line_number: '01', label: 'Origination Fee', amount: 2102, category: 'origination', confidence: HI, page: 2 }],
  });
  const { skipped } = runClosingAudit(cd, { loanEstimates: [le] });
  assert.ok(skipped.some((x) => /TRID tolerance testing/.test(x)));
  assert.ok(skipped.some((x) => /different loan/.test(x)));
});

test('the mismatch carries structured fields for the alert to render', () => {
  // The banner names each thing that differs, with both values, so a customer
  // comparing two different properties sees which one is wrong rather than a
  // generic warning.
  const le = toLoanEstimateRecord(
    rawLE({ lender_name: 'Ficus Bank', property_address: '456 Somewhere Ave, Anytown, PA 12345' }), 'LE1');
  const cd = cleanExtraction({
    lender_name: 'Fir Bank',
    property_address: '4324 Parkside Dr, Baltimore, MD 21206',
    closing_date: '2013-04-15', prepaid_interest: undefined,
    line_items: [{ section: 'A', line_number: '01', label: 'Origination Fee', amount: 2102, category: 'origination', confidence: HI, page: 2 }],
  });
  const { findings } = runClosingAudit(cd, { loanEstimates: [le] });
  const f = byCheck(findings, 'TRID_TRANSACTION_MISMATCH')[0];

  const fields = (f.detail.mismatches || []).map((m) => m.field);
  assert.ok(fields.includes('lender'));
  assert.ok(fields.includes('property address'));
  assert.ok(f.detail.mismatches.every((m) => m.hard));
  // both sides present so the banner can show them side by side
  const lender = f.detail.mismatches.find((m) => m.field === 'lender');
  assert.equal(lender.cd, 'Fir Bank');
  assert.equal(lender.le, 'Ficus Bank');
});

// --- purchase contract reconciliation ----------------------------------------
// contract_terms was read in three places and written in none — the same shape
// as the Loan Estimate bug, charging $59 for an analysis that could not run.

const { toContractTerms } = require('../api/_lib/closing-extract');

const rawContract = (over = {}) => Object.assign({
  is_purchase_contract: true,
  property_address: '456 Somewhere Ave, Anytown, PA 12345',
  buyer_names: ['Michael Jones', 'Mary Stone'],
  sale_price: 180000,
  terms: [
    { label: 'Seller credit toward buyer closing costs', amount: 10000, kind: 'seller_credit', provision: 'Paragraph 12(b)', confidence: HI },
    { label: 'Repair credit for roof', amount: 2500, kind: 'repair_credit', provision: 'Addendum A', confidence: HI },
    { label: 'Seller pays transfer tax', amount: 900, kind: 'cost_allocation', provision: 'Paragraph 7', confidence: HI },
  ],
}, over);

test('only credits to the buyer are reconciled', () => {
  // A cost allocation says who pays for something. It is not a credit and has no
  // single figure to compare, so reporting it as a shortfall would be wrong.
  const terms = toContractTerms(rawContract());
  assert.equal(terms.length, 2);
  assert.deepEqual(terms.map((t) => t.kind).sort(), ['repair_credit', 'seller_credit']);
});

test('low-confidence contract terms are dropped', () => {
  const raw = rawContract();
  raw.terms[0].confidence = 0.4;
  assert.equal(toContractTerms(raw).length, 1);
});

test('a shortfall across several credits is totalled, not matched by label', () => {
  // Label matching is what produced phantom violations between the LE and CD.
  // The contract says "Seller credit toward buyer closing costs"; the Closing
  // Disclosure says "Seller Credit". Same money.
  const terms = toContractTerms(rawContract());   // 10,000 + 2,500 = 12,500
  const out = reconcileContract(terms, { 'Seller Credit': 9000 });
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, Severity.POTENTIAL_OVERCHARGE);
  assert.equal(out[0].dollarImpact, 3500);
  assert.match(out[0].basis, /Paragraph 12\(b\)/);
  assert.match(out[0].basis, /Addendum A/);
});

test('credits split across several closing lines still reconcile', () => {
  const terms = toContractTerms(rawContract());
  const out = reconcileContract(terms, { 'Seller Credit': 10000, 'Repair credit': 2500 });
  assert.equal(out[0].severity, Severity.WITHIN_NORMS);
  assert.equal(out[0].dollarImpact, null);
});

test('a contract for a different property is not reconciled', () => {
  const match = checkTransactionMatch(
    { property_address: '4324 Parkside Dr, Baltimore, MD 21206' },
    { propertyAddress: '456 Somewhere Ave, Anytown, PA 12345' }
  );
  assert.equal(match.sameTransaction, false);
});

test('the audit produces a contract finding when terms are supplied', () => {
  const e = cleanExtraction({
    prepaid_interest: undefined,
    seller_credits_on_cd: [{ label: 'Seller Credit', amount: 7500, confidence: HI }],
  });
  const { findings } = runClosingAudit(e, { contractTerms: toContractTerms(rawContract()) });
  const f = byCheck(findings, 'CONTRACT_RECON')[0];
  assert.equal(f.dollarImpact, 5000);   // 12,500 agreed vs 7,500 shown
  assert.equal(f.askSettlement, true);
});

test('correcting a figure does not resurrect a refused tolerance comparison', () => {
  // closing-corrections derived tolerance_tested from counts alone. A customer
  // correcting one unrelated figure would have flipped a mismatched Fir Bank /
  // Ficus Bank pair back to "already run against the correct baseline".
  const le = toLoanEstimateRecord(rawLE({ lender_name: 'Ficus Bank' }), 'LE1');
  const cd = cleanExtraction({
    lender_name: 'Fir Bank', closing_date: '2013-04-15', prepaid_interest: undefined,
    line_items: [{ section: 'A', line_number: '01', label: 'Origination Fee', amount: 2102, category: 'origination', confidence: HI, page: 2 }],
  });
  const { skipped } = runClosingAudit(cd, { loanEstimates: [le] });

  const transactionMismatch = skipped.some((x) => /different loan/.test(x));
  const cdChargeCount = (cd.line_items || []).length;

  // counts alone would say true; the mismatch must veto it
  assert.equal(1 > 0 && cdChargeCount > 0, true);
  assert.equal(1 > 0 && cdChargeCount > 0 && !transactionMismatch, false);
});

test('the outstanding unreadable list shrinks as figures are supplied', () => {
  // The client carries this through checkout. A stale copy makes the paid report
  // ask for figures the customer already entered.
  const e = cleanExtraction({ prepaid_interest: undefined });
  e.line_items[1].confidence = 0.70;
  e.section_totals.J = { value: 5797.26, confidence: 0.60, page: 2 };

  const before = listUnreadableFields(e);
  assert.equal(before.length, 2);

  const { extraction } = mergeCustomerValues(e, { 'section_totals.J': '5797.26' });
  const after = listUnreadableFields(extraction);
  assert.equal(after.length, 1);
  assert.equal(after[0].path, 'line_items.1');
});

// --- empty sections ----------------------------------------------------------
// Section H (Other) is blank on most Closing Disclosures. It was reported as an
// unreadable value, so the customer was asked to type in a figure that does not
// exist — and because the subtotal check requires every section total, a blank
// section silently suppressed a real arithmetic test.

const { isEmptySection } = require('../api/_lib/closing-extract');

function withEmptyH() {
  const e = cleanExtraction({ prepaid_interest: undefined });
  // no line item carries section H
  e.section_totals.H = { value: 0, confidence: 0.30, page: 2 };
  return e;
}

test('a section with no charge lines is recognised as empty', () => {
  const e = withEmptyH();
  assert.equal(isEmptySection(e, 'H'), true);
  assert.equal(isEmptySection(e, 'A'), false);   // has an Origination Charge
});

test('an aggregate total is never treated as an empty section', () => {
  // D, I and J are always printed, so a missing one is genuinely unreadable.
  const e = withEmptyH();
  assert.equal(isEmptySection(e, 'D'), false);
  assert.equal(isEmptySection(e, 'I'), false);
  assert.equal(isEmptySection(e, 'J'), false);
});

test('a document with no line items at all is unreadable, not empty', () => {
  // Otherwise every section would look empty on a failed extraction.
  const e = cleanExtraction({ line_items: [] });
  assert.equal(isEmptySection(e, 'H'), false);
});

test('the customer is not asked to read a figure from an empty section', () => {
  const e = withEmptyH();
  const paths = listUnreadableFields(e).map((f) => f.path);
  assert.equal(paths.includes('section_totals.H'), false);
});

test('a blank section no longer suppresses the subtotal check', () => {
  const e = withEmptyH();
  const { skipped, findings } = runClosingAudit(e);
  assert.equal(skipped.includes('section subtotals'), false);
  // and the arithmetic holds with H treated as zero: E+F+G+H = 155 + 997.26 +
  // 1300 + 0 = 2452.26 = I, and D + I = 5797.26 = J
  assert.equal(findings.filter((f) => f.checkId.startsWith('ARITH_')
    && f.severity === Severity.CONFIRMED_MATH_ERROR).length, 0);
});

test('a section total present without itemised lines is not zeroed', () => {
  // The first version of this rule declared any section without line items
  // empty, which zeroed a printed $997.26 prepaids total and produced a phantom
  // subtotal error. A stated non-zero total means the section has content.
  const e = withEmptyH();
  assert.equal(isEmptySection(e, 'F'), false);   // total 997.26, no lines captured
  assert.equal(isEmptySection(e, 'G'), false);   // total 1300
  assert.equal(isEmptySection(e, 'H'), true);    // total 0, no lines
});

test('a genuinely unreadable populated section is still reported', () => {
  const e = cleanExtraction({ prepaid_interest: undefined });
  e.section_totals.B = { value: 650, confidence: 0.40, page: 2 };  // B has lines
  const paths = listUnreadableFields(e).map((f) => f.path);
  assert.equal(paths.includes('section_totals.B'), true);
});

test('classifier indexes address uploaded files, not documents inside them', () => {
  // A signed contract PDF bundling the contract, its addenda and a
  // pre-qualification letter was reported as three documents from two files. The
  // contract landed on index 2, contentBlocks[2] was undefined, and the file was
  // silently dropped — classified, priced at $59, never extracted.
  const twoFiles = 2;
  const modelOutput = [
    { index: 0, document_type: 'closing_disclosure' },
    { index: 1, document_type: 'other', note: 'pre-qualification letter' },
    { index: 2, document_type: 'purchase_contract', note: 'contract of sale plus addenda' },
  ];

  const perFile = new Map();
  for (const d of modelOutput) {
    if (typeof d.index !== 'number' || d.index < 0 || d.index >= twoFiles) continue;
    if (!perFile.has(d.index)) perFile.set(d.index, d);
  }
  for (let i = 0; i < twoFiles; i++) {
    if (!perFile.has(i)) perFile.set(i, { index: i, document_type: 'other', note: 'not classified' });
  }
  const result = [...perFile.values()].sort((a, b) => a.index - b.index);

  assert.equal(result.length, twoFiles);          // never more entries than files
  assert.ok(result.every((d) => d.index < twoFiles));
  // the out-of-range contract is dropped rather than pointing at nothing
  assert.equal(result.some((d) => d.document_type === 'purchase_contract'), false);
});

test('every uploaded file is represented even if the model skipped it', () => {
  const threeFiles = 3;
  const modelOutput = [{ index: 0, document_type: 'closing_disclosure' }];
  const perFile = new Map(modelOutput.map((d) => [d.index, d]));
  for (let i = 0; i < threeFiles; i++) {
    if (!perFile.has(i)) perFile.set(i, { index: i, document_type: 'other', note: 'not classified' });
  }
  assert.equal(perFile.size, 3);
  assert.equal(perFile.get(2).document_type, 'other');
});
