// Run: node tests/title-rates.test.js
//
// Tests the SHIPPED corpus, not a fixture. Every figure asserted here is one
// the body that sets the rate publishes itself — the seven worked examples
// printed beneath the TDI table, the example the Florida DFS prints in its own
// consumer guide. If the corpus disagrees with the regulator, the corpus is
// wrong, and it is wrong in a document a customer sends their lender.
'use strict';

const assert = require('assert');
const corpus = require('../data/benchmarks.json');
const { makeGetBenchmark, validateCorpus } = require('../api/_lib/benchmark-corpus');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}\n    ${err.message.split('\n')[0]}`); }
}

// Pinned just after the verification date so staleness never fails this suite
// for the wrong reason.
const now = () => new Date('2026-09-03T00:00:00Z');
const get = makeGetBenchmark(corpus.rows, { now });

test('the shipped corpus passes its own validator', () => {
  assert.deepStrictEqual(validateCorpus(corpus.rows), []);
});

test('Texas matches every worked example TDI publishes with the table', () => {
  const published = [
    [268500, 1612], [4826600, 20762], [10902800, 41240], [17295100, 60428],
    [39351800, 99289], [75300200, 147153], [151250300, 238466],
  ];
  for (const [salePrice, expected] of published) {
    const bm = get({ category: 'title_insurance_owners', state: 'TX', salePrice });
    assert.strictEqual(bm.exact, expected, `TDI publishes $${expected} for a $${salePrice} policy`);
  }
});

test('Texas reads the flat sub-$100,000 table rather than extrapolating', () => {
  for (const [salePrice, expected] of [[25000, 308], [50000, 465], [67500, 575], [99500, 779], [100000, 780]]) {
    assert.strictEqual(get({ category: 'title_insurance_owners', state: 'TX', salePrice }).exact, expected);
  }
});

test('a Texas price between two brackets takes the higher bracket', () => {
  // The table reads "up to and including", so $49,750 is charged at the
  // $50,000 line. Rounding the other way understates the benchmark and turns a
  // correct premium into a phantom overcharge.
  assert.strictEqual(get({ category: 'title_insurance_owners', state: 'TX', salePrice: 49750 }).exact, 465);
});

test('Texas is a promulgated rate, never presented as a market range', () => {
  const bm = get({ category: 'title_insurance_owners', state: 'TX', salePrice: 268500 });
  assert.strictEqual(bm.evidence, 'hard_rule:promulgated_or_filed_rate');
  assert.strictEqual(bm.low, null);
  assert.strictEqual(bm.high, null);
});

test("Florida matches the DFS's own worked figures", () => {
  assert.strictEqual(get({ category: 'title_insurance_owners', state: 'FL', salePrice: 100000 }).exact, 575);
  assert.strictEqual(get({ category: 'title_insurance_owners', state: 'FL', salePrice: 300000 }).exact, 1575);
});

test('Florida charges an exact fraction of a thousand, not a rounded-up one', () => {
  // 100 x 5.75 + 168.5 x 5.00 = 575 + 842.50
  assert.strictEqual(get({ category: 'title_insurance_owners', state: 'FL', salePrice: 268500 }).exact, 1417.5);
});

test('Florida treats any fraction of $100 as a full $100 before the rate', () => {
  assert.strictEqual(get({ category: 'title_insurance_owners', state: 'FL', salePrice: 268401 }).exact, 1417.5);
});

test('Florida applies its $100 minimum premium', () => {
  assert.strictEqual(get({ category: 'title_insurance_owners', state: 'FL', salePrice: 10000 }).exact, 100);
});

test('Florida bracket bases are continuous across every tier boundary', () => {
  for (const boundary of [100000, 1000000, 5000000, 10000000]) {
    const below = get({ category: 'title_insurance_owners', state: 'FL', salePrice: boundary }).exact;
    const above = get({ category: 'title_insurance_owners', state: 'FL', salePrice: boundary + 1000 }).exact;
    assert.ok(above > below, `FL premium flatlines or falls crossing $${boundary}`);
  }
});

test("Florida's lender rate runs off the loan amount, not the sale price", () => {
  const bm = get({ category: 'title_insurance_lenders', state: 'FL', salePrice: 900000, loanAmount: 300000 });
  assert.strictEqual(bm.exact, 1575);
});

test('the Florida lender row warns that simultaneous issue is usually $25', () => {
  const row = corpus.rows.find((r) => r.id === 'fl-title-risk-premium-lenders');
  assert.ok(/\$25/.test(row.exemption_note));
});

test('a tiered row missing its bracket floor refuses to load', () => {
  // This is the regression that matters most: `from` used to default to 0, so
  // omitting it charged the marginal rate on the whole basis. The Texas
  // $268,500 policy computed as $2,106 against a published $1,612 — a 31%
  // overstatement carrying a promulgated-rate citation.
  const { validateRow } = require('../api/_lib/benchmark-corpus');
  const errs = validateRow({
    id: 'x', fee_category: 'title_insurance_owners', kind: 'tiered', basis: 'sale_price',
    jurisdiction_type: 'state', state: 'TX', evidence: 'hard_rule:promulgated_or_filed_rate',
    source_name: 'Texas Department of Insurance basic premium rate table',
    source_url: 'https://tdi.texas.gov/title/titlerates2026.html',
    effective_date: '2026-03-01', verified_at: '2026-09-02',
    tiers: [{ up_to: null, base: 780, rate_per_unit: 0.00494, unit_size: 1 }],
  });
  assert.ok(errs.some((e) => /missing numeric from/.test(e)), 'a missing bracket floor loaded silently');
});

test('the whole corpus goes quiet rather than stale', () => {
  const stale = makeGetBenchmark(corpus.rows, { now: () => new Date('2028-01-01T00:00:00Z') });
  assert.strictEqual(stale({ category: 'title_insurance_owners', state: 'TX', salePrice: 268500 }), null);
});

test('Maryland rows are untouched by the title-rate merge', () => {
  const md = corpus.rows.filter((r) => r.state === 'MD');
  assert.strictEqual(md.length, 48, 'Maryland row count changed');
  assert.ok(md.some((r) => r.kind === 'per_instrument'), 'the per-instrument recording fee row went missing');
});

if (failures.length) {
  console.log(`\n${failures.length} of ${passed + failures.length} failed:\n`);
  failures.forEach((f) => console.log(`  x ${f}\n`));
  process.exit(1);
}
console.log(`${passed}/${passed} passed`);
