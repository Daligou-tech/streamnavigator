// Tests the SHIPPED corpus, not a fixture.
//
// Every assertion here is a figure published by the authority that sets the
// rate — the seven worked examples in the TDI rate table, the example the
// Florida DFS prints in its own consumer guide, the statutory arithmetic in
// Maryland. If the corpus disagrees with the body that promulgated the rate,
// the corpus is wrong, and it is wrong in a document a customer sends their
// lender. That is what these tests exist to catch.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const corpus = require('../data/benchmarks.json');
const { makeGetBenchmark, validateCorpus, coverageFor } = require('../api/_lib/benchmark-corpus');

// Pin "now" just after the verification date so staleness never makes the
// suite fail for the wrong reason. Staleness is exercised separately below.
const now = () => new Date('2026-09-03T00:00:00Z');
const get = makeGetBenchmark(corpus.rows, { now });

// --- the corpus loads at all ------------------------------------------------

test('the shipped corpus passes its own validator', () => {
  assert.deepEqual(validateCorpus(corpus.rows), []);
});

test('every row carries a resolvable source and a verification date', () => {
  for (const row of corpus.rows) {
    assert.match(row.source_url, /^https:\/\//, `${row.id} has no https source`);
    assert.ok(row.source_name.length > 20, `${row.id} has a uselessly terse source_name`);
    assert.match(row.verified_at, /^\d{4}-\d{2}-\d{2}$/, `${row.id} has no verified_at`);
  }
});

// --- Texas: all seven examples published in the TDI rate table --------------

test('Texas matches every worked example TDI publishes with the table', () => {
  const published = [
    [268500, 1612],
    [4826600, 20762],
    [10902800, 41240],
    [17295100, 60428],
    [39351800, 99289],
    [75300200, 147153],
    [151250300, 238466],
  ];
  for (const [salePrice, expected] of published) {
    const bm = get({ category: 'title_insurance_owners', state: 'TX', salePrice });
    assert.equal(bm.exact, expected, `TDI publishes $${expected} for a $${salePrice} policy`);
  }
});

test('Texas reads the flat sub-$100,000 table rather than extrapolating', () => {
  const cases = [[25000, 308], [50000, 465], [67500, 575], [99500, 779], [100000, 780]];
  for (const [salePrice, expected] of cases) {
    assert.equal(get({ category: 'title_insurance_owners', state: 'TX', salePrice }).exact, expected);
  }
});

test('a Texas price between two brackets takes the higher bracket, not the lower', () => {
  // The table reads "policy face amount up to and including", so $49,750 is
  // charged at the $50,000 line. Rounding the other way undercharges the
  // benchmark and turns a correct premium into a phantom overcharge.
  assert.equal(get({ category: 'title_insurance_owners', state: 'TX', salePrice: 49750 }).exact, 465);
});

test('Texas is a promulgated rate, not a market range', () => {
  const bm = get({ category: 'title_insurance_owners', state: 'TX', salePrice: 268500 });
  assert.equal(bm.evidence, 'hard_rule:promulgated_or_filed_rate');
  assert.equal(bm.low, null);
  assert.equal(bm.high, null);
});

// --- Florida: the example the Department of Financial Services publishes ----

test("Florida matches the DFS's own worked figures", () => {
  // DFS: a $100,000 owner's policy is $575. Its consumer guide works a
  // $300,000 purchase to $1,575.
  assert.equal(get({ category: 'title_insurance_owners', state: 'FL', salePrice: 100000 }).exact, 575);
  assert.equal(get({ category: 'title_insurance_owners', state: 'FL', salePrice: 300000 }).exact, 1575);
});

test('Florida charges an exact fraction of a thousand, not a rounded-up one', () => {
  // $268,500: 100 x 5.75 + 168.5 x 5.00 = 575 + 842.50.
  assert.equal(get({ category: 'title_insurance_owners', state: 'FL', salePrice: 268500 }).exact, 1417.5);
});

test('Florida treats any fraction of $100 as a full $100 before applying the rate', () => {
  // $268,401 rounds up to $268,500 of liability, so it costs the same.
  assert.equal(get({ category: 'title_insurance_owners', state: 'FL', salePrice: 268401 }).exact, 1417.5);
});

test('Florida applies its $100 minimum premium', () => {
  // 10 x 5.75 = 57.50, below the promulgated floor.
  assert.equal(get({ category: 'title_insurance_owners', state: 'FL', salePrice: 10000 }).exact, 100);
});

test('Florida bracket bases are continuous across every tier boundary', () => {
  for (const boundary of [100000, 1000000, 5000000, 10000000]) {
    const below = get({ category: 'title_insurance_owners', state: 'FL', salePrice: boundary }).exact;
    const above = get({ category: 'title_insurance_owners', state: 'FL', salePrice: boundary + 1000 }).exact;
    assert.ok(above > below, `FL premium falls or flatlines crossing $${boundary}`);
  }
});

test("Florida's lender rate runs off the loan amount, not the sale price", () => {
  const bm = get({ category: 'title_insurance_lenders', state: 'FL', salePrice: 900000, loanAmount: 300000 });
  assert.equal(bm.exact, 1575);
});

test('the Florida lender row warns that simultaneous issue is usually $25', () => {
  const row = corpus.rows.find((r) => r.id === 'fl-title-risk-premium-lenders');
  assert.match(row.exemption_note, /\$25/);
});

// --- Maryland: recordation and transfer taxes -------------------------------

test('Maryland recordation tax charges a whole unit for each part of $500', () => {
  // Worcester: $3.30 per $500. $400,000 is exactly 800 units.
  assert.equal(
    get({ category: 'recordation_tax', state: 'MD', county: 'Worcester', salePrice: 400000 }).exact,
    2640,
  );
  // $400,001 rounds up to 801 units — the statute says "rounded up to the next
  // higher $500", so the part unit is charged in full.
  assert.equal(
    get({ category: 'recordation_tax', state: 'MD', county: 'Worcester', salePrice: 400001 }).exact,
    2643.3,
  );
});

test('recordation tax is staged under its own category and does not stack yet', () => {
  // It is a zero-tolerance tax and belongs in the stacked total on the merits,
  // but the extractor has no recordation_tax category, so folding it in today
  // would raise the statutory bar on documents that never listed the line.
  // Flipping STACK_RECORDATION_INTO_TRANSFER_TAX in the build script is the
  // single switch; this test is here so the switch cannot be thrown silently.
  const rows = corpus.rows.filter((r) => r.fee_category === 'recordation_tax');
  assert.equal(rows.length, 24);
  assert.ok(rows.every((r) => r.stackable === false));
});

test('a stacked Maryland total is the sum of every level that levies', () => {
  // Baltimore County, $500,000: state transfer 0.5% = 2,500; county transfer
  // 1.5% = 7,500; recordation $2.50 per $500 x 1,000 units = 2,500.
  const s = get.stacked({ category: 'transfer_tax', state: 'MD', county: 'Baltimore County', salePrice: 500000 });
  assert.equal(s.total, 10000);
  assert.equal(s.components.length, 2);
  const labels = s.components.map((c) => c.label).sort();
  assert.deepEqual(labels, [
    'Baltimore County transfer tax',
    'Maryland state transfer tax',
  ]);
});

test('Baltimore City and Baltimore County are not the same jurisdiction', () => {
  // The extractor has been seen returning both spellings for one document.
  // They carry different recordation rates, so conflating them is a wrong
  // dollar figure, not a cosmetic difference.
  // Both levy 1.5% transfer tax, so the transfer stack alone cannot tell them
  // apart — the recordation rate is what differs, and differs by $2,500 on a
  // $500,000 sale.
  const city = get({ category: 'recordation_tax', state: 'MD', county: 'Baltimore City', salePrice: 500000 });
  const county = get({ category: 'recordation_tax', state: 'MD', county: 'Baltimore County', salePrice: 500000 });
  assert.equal(city.exact, 5000);   // $5.00 per $500
  assert.equal(county.exact, 2500); // $2.50 per $500
  assert.notEqual(city.exact, county.exact);
});

test('a county with no local transfer tax says so instead of going silent', () => {
  // Frederick levies none. An explicit zero is what lets the audit flag a
  // county transfer tax line that should not exist at all; a missing row would
  // just look like a coverage gap.
  const bm = get({ category: 'transfer_tax', state: 'MD', county: 'Frederick', salePrice: 500000 });
  assert.ok(bm !== null);
  const s = get.stacked({ category: 'transfer_tax', state: 'MD', county: 'Frederick', salePrice: 500000 });
  assert.equal(s.total, 2500); // state only; Frederick's county transfer tax is a real zero
  const zero = s.components.find((c) => c.label === 'Frederick County transfer tax');
  assert.equal(zero.amount, 0);
});

test('Montgomery and Anne Arundel refuse to total rather than understate', () => {
  for (const county of ['Montgomery', 'Anne Arundel']) {
    const s = get.stacked({ category: 'transfer_tax', state: 'MD', county, salePrice: 1200000 });
    assert.equal(s.total, null, `${county} produced a total it cannot justify`);
    assert.deepEqual(s.components, []);
    assert.match(s.unavailableReason, /confirm/i);
  }
});

test('an unavailable row never answers a lookup with a number', () => {
  // Anne Arundel's county transfer tax cannot be quoted as one rate, so the
  // lookup must fall through to the state row rather than inventing a figure.
  const bm = get({ category: 'transfer_tax', state: 'MD', county: 'Anne Arundel', salePrice: 500000 });
  assert.equal(bm.exact, 2500);                 // the 0.5% state tax
  assert.equal(bm.jurisdiction, 'MD');          // state row, not the county hole
  // Its recordation tax IS a single rate and is known.
  assert.equal(get({ category: 'recordation_tax', state: 'MD', county: 'Anne Arundel', salePrice: 500000 }).exact, 3500);
});

test('every Maryland county in the corpus is covered for both taxes', () => {
  const counties = new Set(
    corpus.rows.filter((r) => r.state === 'MD' && r.jurisdiction_type === 'county').map((r) => r.county),
  );
  assert.equal(counties.size, 24, 'Maryland has 23 counties plus Baltimore City');
  for (const county of counties) {
    const forCounty = corpus.rows.filter((r) => r.county === county);
    assert.equal(forCounty.length, 2, `${county} should carry a recordation row and a transfer row`);
  }
});

test('Maryland recording fees are the clerk schedule, not the recordation tax', () => {
  // These are different charges in different TRID tolerance buckets and the
  // names invite exactly this confusion.
  const bm = get({ category: 'recording_fee', state: 'MD', county: 'Howard', salePrice: 500000 });
  assert.equal(bm.exact, 120);
  assert.equal(bm.evidence, 'hard_rule:government_fee_schedule');
});

// --- coverage ---------------------------------------------------------------

test('coverage is reported honestly for a covered and an uncovered state', () => {
  const md = coverageFor(get, { state: 'MD', county: 'Howard', salePrice: 500000, loanAmount: 400000 });
  assert.ok(md.covered.includes('transfer_tax'));
  assert.ok(md.covered.includes('recording_fee'));
  assert.ok(md.missing.includes('appraisal'), 'appraisal is not benchmarked yet and must say so');

  const va = coverageFor(get, { state: 'VA', county: 'Fairfax County', salePrice: 500000, loanAmount: 400000 });
  assert.equal(va.pct, 0, 'Virginia is not in the corpus and must report zero, not a default');
});

// --- staleness --------------------------------------------------------------

test('the whole corpus goes quiet rather than stale', () => {
  const later = () => new Date('2028-01-01T00:00:00Z');
  const stale = makeGetBenchmark(corpus.rows, { now: later });
  assert.equal(stale({ category: 'title_insurance_owners', state: 'TX', salePrice: 268500 }), null);
  assert.equal(stale.stacked({ category: 'transfer_tax', state: 'MD', county: 'Howard', salePrice: 500000 }).total, null);
});
