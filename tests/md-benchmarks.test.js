// Run: node test/md-benchmarks.test.js
// No test framework, no dependencies — this must run in CI and on Vercel's
// build image without an install step.

'use strict';

const assert = require('assert');
const path = require('path');

const { canonicalizeMdCounty } = require('../api/_lib/md-jurisdiction');
const { makeGetBenchmark, validateCorpus, coverageFor } = require('../api/_lib/benchmark-corpus');
const corpus = require('../data/benchmarks.json');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push(`${name}\n    ${err.message.split('\n')[0]}`); }
}

// ---------------------------------------------------------------------------
// 1. The corpus loads at all
// ---------------------------------------------------------------------------

test('corpus passes validateRow for every row', () => {
  assert.deepStrictEqual(validateCorpus(corpus.rows), []);
});

const NOW = new Date('2026-09-02T12:00:00Z');
const getBenchmark = makeGetBenchmark(corpus.rows, { now: () => NOW });

test('makeGetBenchmark accepts the shipped corpus', () => {
  assert.strictEqual(typeof getBenchmark, 'function');
});

// ---------------------------------------------------------------------------
// 2. Canonicalisation — open issue #2
// ---------------------------------------------------------------------------

const RESOLVES = [
  ['Baltimore City', 'Baltimore City'],
  ['BALTIMORE CITY', 'Baltimore City'],
  ['City of Baltimore', 'Baltimore City'],
  ['Baltimore County', 'Baltimore'],
  ['baltimore county', 'Baltimore'],
  ["Prince George's", "Prince George's"],
  ['Prince Georges County', "Prince George's"],
  ['PG County', "Prince George's"],
  ["St. Mary's", "St. Mary's"],
  ['St Marys', "St. Mary's"],
  ['SAINT MARYS COUNTY', "St. Mary's"],
  ["Queen Anne's County", "Queen Anne's"],
  ['Queen Annes', "Queen Anne's"],
  ['anne arundel', 'Anne Arundel'],
  ['Allegheny', 'Allegany'],           // misspelling of the MD county
  ['Harford Co.', 'Harford'],
  ['Rockville', 'Montgomery'],         // municipality in the county field
  ['Ellicott City', 'Howard'],
  ['Towson', 'Baltimore'],
];

for (const [input, expected] of RESOLVES) {
  test(`canonicalise ${JSON.stringify(input)} -> ${expected}`, () => {
    const r = canonicalizeMdCounty(input);
    assert.ok(r.ok, `expected a match, got: ${r.reason}`);
    assert.strictEqual(r.county, expected);
  });
}

test('bare "Baltimore" is refused as ambiguous, not guessed', () => {
  const r = canonicalizeMdCounty('Baltimore');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.ambiguous, true);
  assert.strictEqual(r.county, null);
});

test('bare "Baltimore" resolves when the city field settles it', () => {
  assert.strictEqual(canonicalizeMdCounty('Baltimore', { city: 'Towson' }).county, 'Baltimore');
  assert.strictEqual(
    canonicalizeMdCounty('Baltimore', { city: 'Baltimore City' }).county, 'Baltimore City');
});

test('an unknown name is refused rather than fuzzy-matched', () => {
  const r = canonicalizeMdCounty('Fairfax');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.ambiguous, false);
});

test('every canonical jurisdiction round-trips, Baltimore only when qualified', () => {
  const { CANONICAL_MD_JURISDICTIONS } = require('../api/_lib/md-jurisdiction');
  assert.strictEqual(CANONICAL_MD_JURISDICTIONS.length, 24); // 23 counties + Baltimore City
  for (const name of CANONICAL_MD_JURISDICTIONS) {
    // "Baltimore" is the one canonical name that is also a real ambiguity, so
    // it is required to carry "County" or "City". Covered by its own test above.
    const input = name === 'Baltimore' ? 'Baltimore County' : name;
    const r = canonicalizeMdCounty(input);
    assert.ok(r.ok, `${input} did not resolve`);
    assert.strictEqual(r.county, name);
  }
});

// ---------------------------------------------------------------------------
// 3. The bug this was built to stop
// ---------------------------------------------------------------------------

const stackFor = (county, salePrice, extra = {}) =>
  getBenchmark.stacked({
    category: 'transfer_tax', state: 'MD', county, salePrice, ...extra,
  });

test('Baltimore City and Baltimore County produce different totals', () => {
  const city = stackFor('Baltimore City', 400000);
  const county = stackFor('Baltimore County', 400000);
  // state 0.5% = 2000; local 1.5% = 6000; recordation 800 units x rate
  assert.strictEqual(city.total, 12000);    // + 800 x $5.00 = 4000
  assert.strictEqual(county.total, 10000);  // + 800 x $2.50 = 2000
  assert.notStrictEqual(city.total, county.total);
});

test('an ambiguous jurisdiction returns no total instead of the wrong one', () => {
  const s = stackFor('Baltimore', 400000);
  assert.strictEqual(s.total, null);
  assert.deepStrictEqual(s.components, []);
  assert.ok(/Baltimore City is an independent city/.test(s.unresolvedJurisdiction));
});

test('spelling variants of one county agree to the cent', () => {
  const a = stackFor("Prince George's", 525000).total;
  const b = stackFor('Prince Georges County', 525000).total;
  const c = stackFor('PG County', 525000).total;
  assert.strictEqual(a, b);
  assert.strictEqual(b, c);
});

// ---------------------------------------------------------------------------
// 4. Arithmetic, checked by hand against the FY2026 DLS table
// ---------------------------------------------------------------------------

test('Howard at $500,000 stacks to $11,250', () => {
  // state 2500 + county transfer 1.25% 6250 + recordation 1000 x $2.50 = 2500
  assert.strictEqual(stackFor('Howard', 500000).total, 11250);
});

test('Frederick charges no local transfer tax', () => {
  // state 1500 + county transfer 0 + recordation 600 x $7.00 = 4200
  const s = stackFor('Frederick', 300000);
  assert.strictEqual(s.total, 5700);
  const local = s.components.find((c) => /local transfer/.test(c.label));
  assert.strictEqual(local.amount, 0);
  assert.ok(/without authority/.test(local.note));
});

test('recordation rounds up to the next whole $500', () => {
  // $400,001 -> 801 units in Baltimore County, not 800
  const s = stackFor('Baltimore County', 400001);
  const rec = s.components.find((c) => /recordation/.test(c.label));
  assert.strictEqual(rec.amount, 801 * 2.5);
});

test('Anne Arundel resolves below $1M and declines at or above it', () => {
  // state 3000 + transfer 1% 6000 + recordation 1200 x $3.50 = 4200
  assert.strictEqual(stackFor('Anne Arundel', 600000).total, 13200);
  assert.strictEqual(stackFor('Anne Arundel', 1200000).total, null);
});

test('every stacked total carries its component breakdown and a source', () => {
  const s = stackFor('Talbot', 450000);
  assert.strictEqual(s.components.length, 3);
  for (const c of s.components) {
    assert.ok(c.label && typeof c.amount === 'number');
    assert.ok(/^https?:\/\//.test(c.sourceUrl), `no source url on ${c.label}`);
  }
});

test('a county with no rows returns nothing', () => {
  assert.strictEqual(stackFor('Montgomery', 700000).total, null);
});

test('a non-Maryland state does not pick up Maryland rows', () => {
  const s = getBenchmark.stacked({
    category: 'transfer_tax', state: 'VA', county: 'Fairfax', salePrice: 400000,
  });
  assert.strictEqual(s.total, null);
});

// ---------------------------------------------------------------------------
// 5. The recording-fee row is loaded but dormant
// ---------------------------------------------------------------------------

test('recording fee returns nothing without an instrument count', () => {
  assert.strictEqual(getBenchmark({ category: 'recording_fee', state: 'MD' }), null);
});

test('recording fee computes once an instrument count is supplied', () => {
  const bm = getBenchmark({ category: 'recording_fee', state: 'MD', instrumentCount: 2 });
  assert.strictEqual(bm.exact, 120);
});

test('a nonsense instrument count is refused rather than coerced', () => {
  for (const n of [0, -1, 1.5, '2', null]) {
    assert.strictEqual(
      getBenchmark({ category: 'recording_fee', state: 'MD', instrumentCount: n }), null,
      `instrumentCount ${JSON.stringify(n)} should not produce a benchmark`);
  }
});

// ---------------------------------------------------------------------------
// 6. Staleness
// ---------------------------------------------------------------------------

test('the FY2026 tax rows stop answering once their window closes', () => {
  const later = makeGetBenchmark(corpus.rows, { now: () => new Date('2027-06-01') });
  assert.strictEqual(
    later.stacked({ category: 'transfer_tax', state: 'MD', county: 'Howard', salePrice: 500000 }).total,
    null);
});

// ---------------------------------------------------------------------------
// 7. Coverage, so the number in the scorecard is real
// ---------------------------------------------------------------------------

test('coverage reports transfer_tax as covered for a resolved MD county', () => {
  const cov = coverageFor(getBenchmark, { state: 'MD', county: 'Baltimore City', salePrice: 400000 });
  assert.ok(cov.covered.includes('transfer_tax'));
  assert.ok(cov.missing.includes('title_insurance_owners'));
});


// ---------------------------------------------------------------------------
// 8. City extracted from the one-line property address
// ---------------------------------------------------------------------------

const { cityFromAddress } = require('../api/_lib/md-jurisdiction');

test('cityFromAddress reads the city out of a normal address', () => {
  assert.strictEqual(cityFromAddress('1234 Main St, Towson, MD 21204'), 'Towson');
  assert.strictEqual(cityFromAddress('7 Light St, Baltimore City, MD'), 'Baltimore City');
  assert.strictEqual(cityFromAddress('9 A St, Ellicott City, MD 21043-1234'), 'Ellicott City');
});

test('cityFromAddress declines on shapes it does not recognise', () => {
  for (const a of ['', null, 'Baltimore', '1234 Main St']) {
    assert.strictEqual(cityFromAddress(a), null, `should not parse ${JSON.stringify(a)}`);
  }
});

test('an ambiguous county is rescued by the property address', () => {
  const s = getBenchmark.stacked({
    category: 'transfer_tax', state: 'MD', county: 'Baltimore', salePrice: 400000,
    propertyAddress: '1234 Main St, Towson, MD 21204',
  });
  assert.strictEqual(s.total, 10000); // Baltimore County rates
});

// ---------------------------------------------------------------------------

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n${failures.length} of ${total} failed:\n`);
  failures.forEach((f) => console.error('  x ' + f + '\n'));
  process.exit(1);
}
console.log(`${passed}/${total} passed`);
