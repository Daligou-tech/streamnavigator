// Tests for the benchmark corpus. Most of these assert that the corpus REFUSES
// to answer — that is the behaviour that keeps a wrong number out of a customer's
// email to their lender.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MIN_RANGE_SAMPLE, validateRow, validateCorpus, isStale, makeGetBenchmark, coverageFor,
} = require('../api/_lib/benchmark-corpus');
const { EvidenceKind } = require('../api/_lib/closing-audit');

const TODAY = new Date('2026-09-01T00:00:00Z');
const now = () => TODAY;

// A well-formed row. Amounts here are fixtures, not real published rates.
const goodExact = (over = {}) => Object.assign({
  id: 'test-exact-1',
  fee_category: 'recording_fee',
  kind: 'exact',
  amount: 155,
  jurisdiction_type: 'county',
  state: 'VA',
  county: 'Fairfax County',
  evidence: EvidenceKind.HARD_FEE_SCHEDULE,
  source_name: 'Example County Recorder fee schedule',
  source_url: 'https://example.gov/fees',
  effective_date: '2026-01-01',
  verified_at: '2026-08-01',
}, over);

// --- provenance is mandatory ------------------------------------------------

test('a row with no source_url is rejected', () => {
  const errs = validateRow(goodExact({ source_url: undefined }));
  assert.ok(errs.some((e) => /source_url/.test(e)));
});

test('a row with no effective_date or verified_at is rejected', () => {
  assert.ok(validateRow(goodExact({ effective_date: undefined })).some((e) => /effective_date/.test(e)));
  assert.ok(validateRow(goodExact({ verified_at: undefined })).some((e) => /verified_at/.test(e)));
});

test('a well-formed row validates clean', () => {
  assert.deepEqual(validateRow(goodExact()), []);
});

// --- hard rules and market norms cannot be confused -------------------------

test('a market range cannot be labelled a hard rule', () => {
  const errs = validateRow({
    ...goodExact(), kind: 'range', low: 400, high: 700, sample_size: 100,
    amount: undefined, evidence: EvidenceKind.HARD_RATE_TABLE,
  });
  assert.ok(errs.some((e) => /range cannot be a hard rule/.test(e)));
});

test('a market norm cannot be expressed as an exact amount', () => {
  const errs = validateRow(goodExact({ evidence: EvidenceKind.MARKET_RANGE }));
  assert.ok(errs.some((e) => /must be expressed as a range/.test(e)));
});

test('a range with too small a sample is rejected', () => {
  const errs = validateRow({
    ...goodExact(), kind: 'range', low: 400, high: 700,
    sample_size: MIN_RANGE_SAMPLE - 1, amount: undefined,
    evidence: EvidenceKind.MARKET_RANGE,
  });
  assert.ok(errs.some((e) => /below the 30 minimum/.test(e)));
});

test('duplicate ids are rejected', () => {
  const errs = validateCorpus([goodExact(), goodExact()]);
  assert.ok(errs.some((e) => /duplicate id/.test(e)));
});

test('a corpus that fails validation refuses to load at all', () => {
  // Half-loading would answer confidently for some counties and stay silent for
  // others, with no way to tell which.
  assert.throws(
    () => makeGetBenchmark([goodExact({ source_url: undefined })]),
    /failed validation/
  );
});

// --- staleness --------------------------------------------------------------

test('a row verified long ago stops answering', () => {
  const stale = goodExact({ verified_at: '2024-01-01' });
  assert.equal(isStale(stale, TODAY), true);
  const get = makeGetBenchmark([stale], { now });
  assert.equal(get({ category: 'recording_fee', state: 'VA', county: 'Fairfax County' }), null);
});

test('a superseded row stops answering even if recently verified', () => {
  const row = goodExact({ verified_at: '2026-08-25', superseded_date: '2026-07-01' });
  assert.equal(isStale(row, TODAY), true);
});

test('a row not yet in effect does not answer', () => {
  const get = makeGetBenchmark([goodExact({ effective_date: '2027-01-01' })], { now });
  assert.equal(get({ category: 'recording_fee', state: 'VA', county: 'Fairfax County' }), null);
});

// --- lookup and jurisdiction precedence -------------------------------------

test('an unknown jurisdiction returns null, never a nearby answer', () => {
  const get = makeGetBenchmark([goodExact()], { now });
  assert.equal(get({ category: 'recording_fee', state: 'TX', county: 'Harris County' }), null);
  assert.equal(get({ category: 'recording_fee', state: 'VA', county: 'Arlington County' }), null);
});

test('an unknown category returns null', () => {
  const get = makeGetBenchmark([goodExact()], { now });
  assert.equal(get({ category: 'appraisal', state: 'VA', county: 'Fairfax County' }), null);
});

test('a county row beats a state row', () => {
  const stateRow = goodExact({
    id: 'state-row', jurisdiction_type: 'state', county: undefined, amount: 99,
  });
  const get = makeGetBenchmark([stateRow, goodExact()], { now });
  const bm = get({ category: 'recording_fee', state: 'VA', county: 'Fairfax County' });
  assert.equal(bm.exact, 155);
});

test('county names match with or without the word County', () => {
  const get = makeGetBenchmark([goodExact()], { now });
  assert.equal(get({ category: 'recording_fee', state: 'va', county: 'Fairfax' }).exact, 155);
});

test('the benchmark carries its provenance through to the finding', () => {
  const get = makeGetBenchmark([goodExact()], { now });
  const bm = get({ category: 'recording_fee', state: 'VA', county: 'Fairfax County' });
  assert.equal(bm.sourceUrl, 'https://example.gov/fees');
  assert.equal(bm.effectiveDate, '2026-01-01');
  assert.equal(bm.evidence, EvidenceKind.HARD_FEE_SCHEDULE);
  assert.equal(bm.jurisdiction, 'Fairfax County, VA');
});

// --- computed shapes --------------------------------------------------------

test('per_unit computes transfer tax and rounds units up', () => {
  // fixture: $1.00 per $500 of sale price, 425,100 -> ceil(850.2) = 851 units
  const row = {
    ...goodExact(), id: 'tt', fee_category: 'transfer_tax', kind: 'per_unit',
    amount: undefined, unit_amount: 1, unit_size: 500, basis: 'sale_price',
    jurisdiction_type: 'state', county: undefined,
  };
  const get = makeGetBenchmark([row], { now });
  const bm = get({ category: 'transfer_tax', state: 'VA', salePrice: 425100 });
  assert.equal(bm.exact, 851);
});

test('percent computes from the loan amount', () => {
  const row = {
    ...goodExact(), id: 'pct', fee_category: 'title_insurance_lenders', kind: 'percent',
    amount: undefined, rate_pct: 0.5, basis: 'loan_amount',
    jurisdiction_type: 'state', county: undefined, evidence: EvidenceKind.HARD_RATE_TABLE,
  };
  const get = makeGetBenchmark([row], { now });
  assert.equal(get({ category: 'title_insurance_lenders', state: 'VA', loanAmount: 400000 }).exact, 2000);
});

test('tiered computes a title rate from the correct bracket', () => {
  // fixture bracket: above 100k, base 500 plus 2 per 1,000 over 100k
  const row = {
    ...goodExact(), id: 'tier', fee_category: 'title_insurance_owners', kind: 'tiered',
    amount: undefined, basis: 'sale_price', jurisdiction_type: 'state', county: undefined,
    evidence: EvidenceKind.HARD_RATE_TABLE,
    tiers: [
      { up_to: 100000, from: 0, base: 500, rate_per_unit: 0, unit_size: 1000 },
      { up_to: null, from: 100000, base: 500, rate_per_unit: 2, unit_size: 1000 },
    ],
  };
  const get = makeGetBenchmark([row], { now });
  // 500,000 -> 500 + (400 units x 2) = 1300
  assert.equal(get({ category: 'title_insurance_owners', state: 'VA', salePrice: 500000 }).exact, 1300);
});

test('a computed row returns null when the input it needs is missing', () => {
  const row = {
    ...goodExact(), id: 'pct2', fee_category: 'title_insurance_lenders', kind: 'percent',
    amount: undefined, rate_pct: 0.5, basis: 'loan_amount',
    jurisdiction_type: 'state', county: undefined, evidence: EvidenceKind.HARD_RATE_TABLE,
  };
  const get = makeGetBenchmark([row], { now });
  assert.equal(get({ category: 'title_insurance_lenders', state: 'VA' }), null);
});

// --- coverage ---------------------------------------------------------------

test('coverage on an empty corpus is zero, not an error', () => {
  const get = makeGetBenchmark([], { now });
  const c = coverageFor(get, { state: 'VA', county: 'Fairfax County', loanAmount: 400000 });
  assert.equal(c.pct, 0);
  assert.equal(c.covered.length, 0);
  assert.equal(c.missing.length, 8);
});

test('coverage rises as rows are added', () => {
  const get = makeGetBenchmark([goodExact()], { now });
  const c = coverageFor(get, { state: 'VA', county: 'Fairfax County', loanAmount: 400000 });
  assert.equal(c.covered.includes('recording_fee'), true);
  assert.equal(c.pct, 13); // 1 of 8
});
