// Unit tests for the deterministic Closing Disclosure audit checks. Every
// expected value here is hand-computed and stated in the comment above it, so a
// failure means the code moved, not that the fixture drifted.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Severity, EvidenceKind, Actionability, Bucket,
  rankFindings, daysToMonthEndInclusive, perDiem, checkPrepaidInterest,
  checkEscrowCushion, checkProration, checkSectionArithmetic, checkCashToClose,
  detectDuplicates, compareToBenchmark, assignBucket, businessDaysBetween,
  selectBaseline, analyzeTolerances, cureDeadlineNote, reconcileContract,
  gateExtraction, matchCharges, nameSimilarity,
} = require('../api/_lib/closing-audit');

// --- prepaid interest -------------------------------------------------------

test('day count runs from the closing date through month end, inclusive', () => {
  assert.equal(daysToMonthEndInclusive('2026-03-18'), 14); // 18..31 March
  assert.equal(daysToMonthEndInclusive('2026-02-01'), 28);
});

test('per-diem on a 365-day basis', () => {
  // 400,000 * 6.5% = 26,000 / 365 = 71.2328767
  assert.equal(Number(perDiem(400000, 6.5, 365).toFixed(4)), 71.2329);
});

test('a correct prepaid interest charge reconciles', () => {
  // 71.2328767 * 14 days = 997.26
  const f = checkPrepaidInterest({
    loanAmount: 400000, annualRatePct: 6.5, closingDate: '2026-03-18', chargedAmount: 997.26,
  });
  assert.equal(f.severity, Severity.WITHIN_NORMS);
  assert.equal(f.expected, 997.26);
});

test('a 360-day-basis lender also reconciles', () => {
  // 26,000 / 360 = 72.2222 * 14 = 1011.11
  const f = checkPrepaidInterest({
    loanAmount: 400000, annualRatePct: 6.5, closingDate: '2026-03-18', chargedAmount: 1011.11,
  });
  assert.equal(f.severity, Severity.WITHIN_NORMS);
  assert.equal(f.detail.basis, 360);
});

test('a wrong day count is caught and the implied days reverse-solved', () => {
  // billed 30 days instead of 14: 71.2328767 * 30 = 2136.99
  const f = checkPrepaidInterest({
    loanAmount: 400000, annualRatePct: 6.5, closingDate: '2026-03-18', chargedAmount: 2136.99,
  });
  assert.equal(f.severity, Severity.CONFIRMED_MATH_ERROR);
  assert.equal(f.expected, 997.26);          // canonical basis, not the nearest-fitting one
  assert.equal(f.dollarImpact, 1139.73);
  assert.equal(Math.round(f.detail.impliedDays), 30);
  assert.equal(f.askLender, true);
});

// --- escrow -----------------------------------------------------------------

test('escrow cushion exactly at the RESPA cap passes', () => {
  // (6000 + 1800) / 6 = 1300
  const f = checkEscrowCushion({ tax: 6000, hoi: 1800 }, 1300);
  assert.equal(f.severity, Severity.WITHIN_NORMS);
  assert.equal(f.expected, 1300);
  assert.equal(f.evidence, EvidenceKind.HARD_STATUTE);
});

test('escrow cushion over the cap is a potential overcharge', () => {
  const f = checkEscrowCushion({ tax: 6000, hoi: 1800 }, 1950);
  assert.equal(f.severity, Severity.POTENTIAL_OVERCHARGE);
  assert.equal(f.dollarImpact, 650);
});

test('no disbursement data means no conclusion, not a guess', () => {
  const f = checkEscrowCushion({}, 1300);
  assert.equal(f.severity, Severity.REQUIRES_DOCUMENTATION);
  assert.equal(f.evidence, EvidenceKind.NONE);
});

// --- prorations -------------------------------------------------------------

test("buyer's share of a calendar-year tax proration", () => {
  // 7300 / 365 = 20.00/day; 1..31 Dec = 31 days = 620.00
  const f = checkProration({
    label: 'County taxes', annualAmount: 7300,
    periodStart: '2026-01-01', periodEnd: '2026-12-31',
    prorationDate: '2026-12-01', chargedAmount: 620.0,
  });
  assert.equal(f.severity, Severity.WITHIN_NORMS);
  assert.equal(f.detail.days, 31);
});

test('a proration error is flagged with its dollar impact', () => {
  const f = checkProration({
    label: 'County taxes', annualAmount: 7300,
    periodStart: '2026-01-01', periodEnd: '2026-12-31',
    prorationDate: '2026-12-01', chargedAmount: 820.0,
  });
  assert.equal(f.severity, Severity.CONFIRMED_MATH_ERROR);
  assert.equal(f.dollarImpact, 200);
});

// --- arithmetic -------------------------------------------------------------

const totals = (over = {}) => Object.assign({
  A: 3200, B: 1450, C: 2100, D: 6750,
  E: 1875, F: 2410, G: 1830, H: 500, I: 6615,
  J: 13365, lenderCredits: 0,
}, over);

test('a clean page 2 produces no findings', () => {
  assert.deepEqual(checkSectionArithmetic(totals()), []);
});

test('lender credits reduce J', () => {
  assert.deepEqual(checkSectionArithmetic(totals({ lenderCredits: 1000, J: 12365 })), []);
});

test('a subtotal that does not foot is a confirmed math error', () => {
  const out = checkSectionArithmetic(totals({ D: 6950 }));
  assert.equal(out[0].checkId, 'ARITH_D (Total Loan Costs)');
  assert.equal(out[0].dollarImpact, 200);
  assert.equal(out[0].severity, Severity.CONFIRMED_MATH_ERROR);
});

test('Cash to Close reconciles', () => {
  // 13365 + 80000 - 15000 - 6000 - 1200 = 71165
  const f = checkCashToClose({
    totalClosingCostsJ: 13365, downPaymentFundsFromBorrower: 80000,
    deposit: 15000, sellerCredits: 6000, adjustmentsAndOtherCredits: 1200,
    statedCashToClose: 71165,
  });
  assert.equal(f.severity, Severity.WITHIN_NORMS);
});

test('a Cash to Close mismatch is caught — this is the number they wire', () => {
  const f = checkCashToClose({
    totalClosingCostsJ: 13365, downPaymentFundsFromBorrower: 80000,
    deposit: 15000, sellerCredits: 6000, adjustmentsAndOtherCredits: 1200,
    statedCashToClose: 73665,
  });
  assert.equal(f.severity, Severity.CONFIRMED_MATH_ERROR);
  assert.equal(f.dollarImpact, 2500);
});

// --- duplicates -------------------------------------------------------------

test('settlement fee and closing fee from the same payee is a duplicate candidate', () => {
  const out = detectDuplicates([
    { section: 'B', label: 'Settlement Fee', amount: 695, payee: 'Acme Title LLC' },
    { section: 'C', label: 'Closing Fee', amount: 450, payee: 'Acme Title, LLC' },
  ]).filter((f) => f.checkId === 'DUPLICATE_CANDIDATE');
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, Severity.POTENTIAL_DUPLICATE);
  assert.equal(out[0].dollarImpact, 450);
  assert.equal(out[0].detail.samePayee, true);
});

test('unrelated fees do not produce false positives', () => {
  assert.deepEqual(detectDuplicates([
    { section: 'B', label: 'Appraisal Fee', amount: 650, payee: 'Valuation Co' },
    { section: 'C', label: 'Survey', amount: 475, payee: 'Survey Co' },
  ]), []);
});

test('three or more Section A lender charges surface as stacking', () => {
  const out = detectDuplicates([
    { section: 'A', label: 'Processing Fee', amount: 595, payee: 'Bank' },
    { section: 'A', label: 'Underwriting Fee', amount: 895, payee: 'Bank' },
    { section: 'A', label: 'Administration Fee', amount: 350, payee: 'Bank' },
  ]).filter((f) => f.checkId === 'LENDER_FEE_STACKING');
  assert.equal(out.length, 1);
  assert.equal(out[0].dollarImpact, 1840);
  assert.equal(out[0].severity, Severity.REQUIRES_DOCUMENTATION);
});

// --- benchmarks -------------------------------------------------------------

test('a missing benchmark never becomes a guess', () => {
  const f = compareToBenchmark('Attorney fee', 1200, null);
  assert.equal(f.severity, Severity.CANNOT_BENCHMARK);
  assert.match(f.basis, /Cannot benchmark/);
  assert.equal(f.expected, null);
});

test('a promulgated rate mismatch is a hard finding', () => {
  const f = compareToBenchmark("Owner's title policy", 2905, {
    exact: 2405, evidence: EvidenceKind.HARD_RATE_TABLE,
    source: 'TX Basic Manual of Title Insurance, Rate Rule R-1', jurisdiction: 'TX',
  });
  assert.equal(f.severity, Severity.POTENTIAL_OVERCHARGE);
  assert.equal(f.dollarImpact, 500);
  assert.equal(f.evidence, EvidenceKind.HARD_RATE_TABLE);
});

test('a market range is labelled as a norm, not a limit', () => {
  const f = compareToBenchmark('Appraisal fee', 760, {
    low: 400, high: 700, evidence: EvidenceKind.MARKET_RANGE,
    source: 'Observed range', jurisdiction: 'Fairfax County, VA',
  });
  assert.equal(f.severity, Severity.ABOVE_BENCHMARK);
  assert.equal(f.dollarImpact, 60);
  assert.match(f.whyItMatters, /not a legal limit/);
});

test('far above the range escalates severity', () => {
  const f = compareToBenchmark('Appraisal fee', 1400, {
    low: 400, high: 700, evidence: EvidenceKind.MARKET_RANGE,
    source: 'Observed range', jurisdiction: 'VA',
  });
  assert.equal(f.severity, Severity.POTENTIAL_OVERCHARGE);
});

// --- tolerance buckets ------------------------------------------------------

test('no written provider list pushes shoppable services to zero tolerance', () => {
  const [b, why] = assignBucket(
    { label: 'Settlement Fee', amount: 695, category: 'settlement_service', shoppable: true },
    false
  );
  assert.equal(b, Bucket.ZERO);
  assert.match(why, /no written list/);
});

test('a shoppable service taken from the list is 10% cumulative', () => {
  const [b] = assignBucket(
    { category: 'settlement_service', shoppable: true, providerOnLenderList: true }, true
  );
  assert.equal(b, Bucket.TEN_PCT);
});

test('shopping off-list removes the tolerance', () => {
  const [b] = assignBucket(
    { category: 'settlement_service', shoppable: true, providerOnLenderList: false }, true
  );
  assert.equal(b, Bucket.NO_TOL);
});

test("don't-know defaults to the conservative bucket", () => {
  const [b] = assignBucket({ category: 'settlement_service', shoppable: true }, null);
  assert.equal(b, Bucket.ZERO);
});

test('transfer tax is zero tolerance; prepaid interest has none', () => {
  assert.equal(assignBucket({ category: 'transfer_tax' }, true)[0], Bucket.ZERO);
  assert.equal(assignBucket({ category: 'prepaid_interest' }, true)[0], Bucket.NO_TOL);
});

// --- baseline selection -----------------------------------------------------

const le = (docId, dateIssued, cc = null, dateReceived = null, charges = {}) =>
  ({ docId, dateIssued, dateReceived, changedCircumstanceDocumented: cc, charges });

test('a timely, documented revision becomes the baseline', () => {
  const { baseline, findings } = selectBaseline(
    [le('LE1', '2026-01-05'), le('LE2', '2026-02-01', true)], '2026-03-01'
  );
  assert.equal(baseline.docId, 'LE2');
  assert.deepEqual(findings, []);
});

test('an undocumented revision does not reset the baseline', () => {
  const { baseline, findings } = selectBaseline(
    [le('LE1', '2026-01-05'), le('LE2', '2026-02-01', false)], '2026-03-01'
  );
  assert.equal(baseline.docId, 'LE1');
  assert.equal(findings[0].checkId, 'TRID_BASELINE_CIRCUMSTANCE');
});

test('a revision delivered too late is flagged as a post-closing issue', () => {
  const { baseline, findings } = selectBaseline(
    [le('LE1', '2026-01-05'), le('LE2', '2026-02-26', true, '2026-02-26')], '2026-03-01'
  );
  assert.equal(baseline.docId, 'LE1');
  assert.equal(findings[0].checkId, 'TRID_BASELINE_TIMING');
  assert.equal(findings[0].actionability, Actionability.POST_CLOSING_REMEDY);
});

test('business day count excludes Sundays', () => {
  // Mon 2026-02-23 -> Sun 2026-03-01 is 6 calendar days, 5 excluding the Sunday
  assert.equal(businessDaysBetween('2026-02-23', '2026-03-01'), 5);
});

// --- tolerance analysis -----------------------------------------------------

test('a zero-tolerance increase produces a cure estimate', () => {
  const base = le('LE1', '2026-01-05', null, null,
    { uw: { label: 'Underwriting Fee', amount: 500, category: 'lender_fee' } });
  const out = analyzeTolerances(base,
    { uw: { label: 'Underwriting Fee', amount: 700, category: 'lender_fee' } }, true);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, Severity.POTENTIAL_TRID_VIOLATION);
  assert.equal(out[0].dollarImpact, 200);
  assert.match(out[0].basis, /1026\.19\(e\)\(3\)\(i\)/);
});

test('a decrease is not a violation', () => {
  const base = le('LE1', '2026-01-05', null, null,
    { uw: { label: 'Underwriting Fee', amount: 700, category: 'lender_fee' } });
  assert.deepEqual(
    analyzeTolerances(base, { uw: { label: 'Underwriting Fee', amount: 500, category: 'lender_fee' } }, true),
    []
  );
});

test('the 10% bucket is tested in aggregate', () => {
  // baseline 400 + 600 = 1000; allowed 1100; CD 500 + 650 = 1150; cure 50
  const base = le('LE1', '2026-01-05', null, null, {
    rec: { label: 'Recording fees', amount: 400, category: 'recording_fee' },
    ts: { label: 'Settlement fee', amount: 600, category: 'settlement_service', shoppable: true, providerOnLenderList: true },
  });
  const out = analyzeTolerances(base, {
    rec: { label: 'Recording fees', amount: 500, category: 'recording_fee' },
    ts: { label: 'Settlement fee', amount: 650, category: 'settlement_service', shoppable: true, providerOnLenderList: true },
  }, true);
  assert.equal(out.length, 1);
  assert.equal(out[0].checkId, 'TRID_TEN_PERCENT');
  assert.equal(out[0].expected, 1100);
  assert.equal(out[0].dollarImpact, 50);
});

test('an increase inside the 10% band is not flagged', () => {
  const base = le('LE1', '2026-01-05', null, null,
    { rec: { label: 'Recording fees', amount: 400, category: 'recording_fee' } });
  assert.deepEqual(
    analyzeTolerances(base, { rec: { label: 'Recording fees', amount: 430, category: 'recording_fee' } }, true),
    []
  );
});

test('answering "no" to the provider-list question moves money into the zero bucket', () => {
  const base = le('LE1', '2026-01-05', null, null,
    { t: { label: 'Settlement fee', amount: 600, category: 'settlement_service', shoppable: true } });
  const out = analyzeTolerances(base,
    { t: { label: 'Settlement fee', amount: 650, category: 'settlement_service', shoppable: true } }, false);
  assert.equal(out[0].checkId, 'TRID_ZERO_TOLERANCE');
  assert.equal(out[0].dollarImpact, 50);
});

test('a charge we cannot match is reported as ambiguous, not as an increase', () => {
  // This previously asserted the bug: an unmatched charge was reported as a
  // full-amount tolerance violation. A charge missing from the Loan Estimate may
  // be genuinely new, or may be the same charge under a different name. Claiming
  // the former manufactures a confident accusation out of a naming difference.
  const base = le('LE1', '2026-01-05', null, null, {});
  const out = analyzeTolerances(base,
    { admin: { label: 'Administration Fee', amount: 395, category: 'lender_fee' } }, true);
  assert.equal(out.length, 1);
  assert.equal(out[0].checkId, 'TRID_UNMATCHED_CHARGE');
  assert.equal(out[0].severity, Severity.REQUIRES_DOCUMENTATION);
  assert.equal(out[0].dollarImpact, null);   // never presented as money owed
  assert.equal(out[0].charged, 395);
});

test('the cure deadline is 60 days after consummation', () => {
  assert.match(cureDeadlineNote('2026-03-18'), /2026-05-17/);
});

// --- contract ---------------------------------------------------------------

test('a shrunken seller credit is caught', () => {
  const out = reconcileContract(
    [{ label: 'Seller credit', amount: 10000, provision: 'Section 12(b) of the purchase agreement' }],
    { 'Seller credit': 7500 }
  );
  assert.equal(out[0].severity, Severity.POTENTIAL_OVERCHARGE);
  assert.equal(out[0].dollarImpact, 2500);
  assert.equal(out[0].evidence, EvidenceKind.CONTRACT);
});

test('a credit that landed in full passes', () => {
  const out = reconcileContract(
    [{ label: 'Seller credit', amount: 10000, provision: 'Section 12(b)' }],
    { 'Seller credit': 10000 }
  );
  assert.equal(out[0].severity, Severity.WITHIN_NORMS);
});

// --- extraction + ranking ---------------------------------------------------

test('low-confidence fields are excluded rather than guessed', () => {
  const { usable, warnings } = gateExtraction([
    { name: 'Loan amount', page: 1, confidence: 0.99 },
    { name: "Owner's title policy", page: 2, confidence: 0.42 },
  ]);
  assert.deepEqual(usable.map((f) => f.name), ['Loan amount']);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].actionability, Actionability.NEEDS_DOCS);
  assert.match(warnings[0].title, /page 2/);
});

test('ranking orders by severity then dollars, and drops nothing', () => {
  const fs = [
    { checkId: 'a', severity: Severity.INFORMATIONAL, dollarImpact: 0 },
    { checkId: 'b', severity: Severity.CONFIRMED_MATH_ERROR, dollarImpact: 25 },
    { checkId: 'c', severity: Severity.POTENTIAL_TRID_VIOLATION, dollarImpact: 2400 },
    { checkId: 'd', severity: Severity.CONFIRMED_MATH_ERROR, dollarImpact: 900 },
  ];
  assert.deepEqual(rankFindings(fs).map((f) => f.checkId), ['d', 'b', 'c', 'a']);
  assert.equal(rankFindings(fs).length, 4);
});

// --- charge matching between the two documents -------------------------------
// The single largest source of false positives. An exact-key match meant the
// same fee worded differently on each document did not pair, and the full amount
// was reported as a tolerance increase.

test('the same fee worded differently still matches', () => {
  const { pairs, unmatchedCd } = matchCharges(
    { 'settlement_service:settlement_agent_fee': { label: 'Settlement Agent Fee', amount: 500, category: 'settlement_service' } },
    { 'settlement_service:title_settlement_fee': { label: 'Title - Settlement Fee', amount: 500, category: 'settlement_service' } }
  );
  assert.equal(pairs.length, 1);
  assert.equal(unmatchedCd.length, 0);
  assert.equal(pairs[0].matchedBy, 'category+amount');
});

test('no violation is reported when the amount did not change', () => {
  const base = le('LE1', '2026-01-05', null, null, {
    'settlement_service:settlement_agent_fee': { label: 'Settlement Agent Fee', amount: 500, category: 'settlement_service' },
  });
  const out = analyzeTolerances(base, {
    'settlement_service:title_settlement_fee': { label: 'Title - Settlement Fee', amount: 500, category: 'settlement_service' },
  }, false);
  assert.deepEqual(out, []);
});

test('a real increase is still caught through a renamed line', () => {
  const base = le('LE1', '2026-01-05', null, null, {
    'lender_fee:underwriting_fee': { label: 'Underwriting Fee', amount: 500, category: 'lender_fee' },
  });
  const out = analyzeTolerances(base, {
    'lender_fee:underwriting_and_review_fee': { label: 'Underwriting and Review Fee', amount: 700, category: 'lender_fee' },
  }, true);
  assert.equal(out.length, 1);
  assert.equal(out[0].checkId, 'TRID_ZERO_TOLERANCE');
  assert.equal(out[0].dollarImpact, 200);
  assert.match(out[0].basis, /Matched to "Underwriting Fee"/);
});

test('a shared payee matches when names and amounts both differ', () => {
  const { pairs } = matchCharges(
    { 'settlement_service:closing_services': { label: 'Closing Services', amount: 400, category: 'settlement_service', payee: 'Acme Title LLC' } },
    { 'settlement_service:escrow_handling': { label: 'Escrow Handling', amount: 450, category: 'settlement_service', payee: 'Acme Title, LLC' } }
  );
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].matchedBy, 'category+payee');
});

test('one Loan Estimate charge is never consumed by two CD charges', () => {
  const { pairs, unmatchedCd } = matchCharges(
    { 'lender_fee:processing': { label: 'Processing Fee', amount: 500, category: 'lender_fee' } },
    {
      'lender_fee:processing': { label: 'Processing Fee', amount: 500, category: 'lender_fee' },
      'lender_fee:processing_2': { label: 'Processing Fee', amount: 500, category: 'lender_fee' },
    }
  );
  assert.equal(pairs.length, 1);
  assert.equal(unmatchedCd.length, 1);
});

test('unrelated charges do not get force-matched', () => {
  const { pairs, unmatchedCd } = matchCharges(
    { 'appraisal:appraisal_fee': { label: 'Appraisal Fee', amount: 650, category: 'appraisal' } },
    { 'recording_fee:recording_fees': { label: 'Recording Fees', amount: 155, category: 'recording_fee' } }
  );
  assert.equal(pairs.length, 0);
  assert.equal(unmatchedCd.length, 1);
});

test('the 10% bucket only aggregates matched charges', () => {
  // An unmatched charge added to the total with a zero baseline would inflate the
  // cumulative test and produce a phantom cure.
  const base = le('LE1', '2026-01-05', null, null, {
    'recording_fee:recording_fees': { label: 'Recording Fees', amount: 400, category: 'recording_fee' },
  });
  const out = analyzeTolerances(base, {
    'recording_fee:recording_fees': { label: 'Recording Fees', amount: 420, category: 'recording_fee' },
    'recording_fee:e_recording_fee': { label: 'E-Recording Fee', amount: 900, category: 'recording_fee' },
  }, true);
  assert.equal(out.some((f) => f.checkId === 'TRID_TEN_PERCENT'), false);
  assert.equal(out.filter((f) => f.checkId === 'TRID_UNMATCHED_CHARGE').length, 1);
});

test('name similarity scores the case that broke it', () => {
  assert.ok(nameSimilarity('Settlement Agent Fee', 'Title - Settlement Fee') >= 0.5);
  assert.ok(nameSimilarity('Appraisal Fee', 'Recording Fees') < 0.34);
});

// --- tolerance buckets from the printed section ------------------------------
// The bucket used to be decided by a category the model inferred. The section
// letter is printed on the form and prescribed by regulation, so it is both more
// reliable and citable.

test('Section A and B are zero tolerance whatever the label says', () => {
  assert.equal(assignBucket({ section: 'A', label: 'Points', category: 'other' }, true)[0], Bucket.ZERO);
  assert.equal(assignBucket({ section: 'B', label: 'Appraisal Fee', category: 'other' }, true)[0], Bucket.ZERO);
  assert.match(assignBucket({ section: 'B', label: 'Appraisal Fee' }, true)[1], /Did Not Shop For/);
});

test('Section C follows the written provider list, not the category', () => {
  assert.equal(assignBucket({ section: 'C', label: 'Title - Settlement Fee' }, true)[0], Bucket.TEN_PCT);
  assert.equal(assignBucket({ section: 'C', label: 'Title - Settlement Fee' }, false)[0], Bucket.ZERO);
  assert.equal(
    assignBucket({ section: 'C', label: 'Title - Settlement Fee', providerOnLenderList: false }, true)[0],
    Bucket.NO_TOL
  );
});

test('Section E splits taxes from recording fees', () => {
  // Both sit in the same section but fall in different buckets.
  assert.equal(assignBucket({ section: 'E', label: 'City/County Tax/Stamps' }, true)[0], Bucket.ZERO);
  assert.equal(assignBucket({ section: 'E', label: 'Transfer Taxes' }, true)[0], Bucket.ZERO);
  assert.equal(assignBucket({ section: 'E', label: 'Recording Fees' }, true)[0], Bucket.TEN_PCT);
});

test('Sections F, G and H carry no tolerance', () => {
  assert.equal(assignBucket({ section: 'F', label: 'Prepaid Interest' }, true)[0], Bucket.NO_TOL);
  assert.equal(assignBucket({ section: 'G', label: 'Property Taxes' }, true)[0], Bucket.NO_TOL);
  assert.equal(assignBucket({ section: 'H', label: "Owner's Title Insurance (optional)" }, true)[0], Bucket.NO_TOL);
});

test('the printed section overrides a miscategorised charge', () => {
  // The model calling a Section B appraisal "prepaid_interest" would previously
  // have moved it into the no-tolerance bucket and hidden a real violation.
  const [bucket] = assignBucket(
    { section: 'B', label: 'Appraisal Fee', category: 'prepaid_interest' }, true
  );
  assert.equal(bucket, Bucket.ZERO);
});

test('the category still decides when no section was printed', () => {
  // ALTA settlement statements have no lettered sections.
  assert.equal(assignBucket({ section: 'none', category: 'lender_fee' }, true)[0], Bucket.ZERO);
  assert.equal(assignBucket({ category: 'prepaid_interest' }, true)[0], Bucket.NO_TOL);
  assert.equal(assignBucket({ category: 'recording_fee' }, true)[0], Bucket.TEN_PCT);
});
