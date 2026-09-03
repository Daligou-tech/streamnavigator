// HMDA benchmark builder.
//
// The script was written but never run against real data, which in this repo is
// the same class of mistake as `escH is not a function`: it parsed, so it looked
// finished. This suite executes it end to end against a CSV built to the
// documented FFIEC public LAR layout
// (https://ffiec.cfpb.gov/documentation/publications/loan-level-datasets/lar-data-fields).
//
// It cannot prove the real FFIEC file parses — only a real file can do that —
// but it proves the population filters actually exclude, that the arithmetic is
// right, and that a bad county map fails loudly instead of writing a corpus
// nothing can look up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hmda-benchmarks.js');
const FIPS_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-county-fips.js');
const { normaliseCountyName } = require('../scripts/build-county-fips');

// Exactly the columns the builder requires, named as FFIEC names them.
const COLUMNS = [
  'activity_year', 'state_code', 'county_code', 'action_taken', 'loan_purpose',
  'lien_status', 'occupancy_type', 'business_or_commercial_purpose',
  'reverse_mortgage', 'open-end_line_of_credit', 'derived_dwelling_category',
  'loan_amount', 'total_loan_costs', 'origination_charges',
];

// A loan that passes every population filter. Overrides make it fail one.
const PASSING = {
  activity_year: '2025',
  state_code: 'MD',
  county_code: '24005',
  action_taken: '1',
  loan_purpose: '1',
  lien_status: '1',
  occupancy_type: '1',
  business_or_commercial_purpose: '2',
  reverse_mortgage: '2',
  'open-end_line_of_credit': '2',
  derived_dwelling_category: 'Single Family (1-4 Units):Site-Built',
  loan_amount: '250000',
  total_loan_costs: '6000',
  origination_charges: '2000',
};

function csv(records) {
  const lines = [COLUMNS.join(',')];
  for (const r of records) lines.push(COLUMNS.map((c) => r[c] ?? '').join(','));
  return lines.join('\n') + '\n';
}

// n loans with origination_charges spread 1000..1000+n-1, so the median and
// 90th percentile are arithmetically predictable.
function spread(n, over = {}) {
  return Array.from({ length: n }, (_, i) => ({
    ...PASSING, ...over,
    origination_charges: String(1000 + i),
    total_loan_costs: String(5000 + i),
  }));
}

function run(records, { counties, extraArgs = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmda-'));
  const inPath = path.join(dir, 'in.csv');
  const outPath = path.join(dir, 'out.json');
  const mapPath = path.join(dir, 'counties.json');
  fs.writeFileSync(inPath, csv(records));
  fs.writeFileSync(mapPath, JSON.stringify(counties ?? {
    '24005': { name: 'Baltimore', state: 'MD' },
    '24510': { name: 'Baltimore City', state: 'MD' },
  }));

  let stdout = '';
  let failed = false;
  try {
    stdout = execFileSync('node', [SCRIPT, '--in', inPath, '--state', 'MD',
      '--year', '2025', '--counties', mapPath, '--out', outPath, ...extraArgs],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    failed = true;
    stdout = (err.stdout || '') + (err.stderr || '');
  }
  const rows = fs.existsSync(outPath)
    ? JSON.parse(fs.readFileSync(outPath, 'utf8')).rows : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { rows, stdout, failed };
}

// --- it runs at all ---------------------------------------------------------

test('a clean file produces rows for both cost fields', () => {
  const { rows, failed } = run(spread(200));
  assert.equal(failed, false);
  const cats = rows.map((r) => r.fee_category).sort();
  assert.deepEqual(cats, ['origination_charges_total', 'total_loan_costs']);
  for (const r of rows) {
    assert.equal(r.kind, 'range');
    assert.equal(r.sample_size, 200);
    assert.equal(r.county, 'Baltimore');
    assert.equal(r.state, 'MD');
    assert.equal(r.jurisdiction_type, 'county');
    assert.equal(r.loan_purpose, 'purchase');
    assert.equal(r.evidence, 'market_norm:comparable_transactions');
    assert.ok(r.high > r.low, 'a range row must have a real spread');
  }
});

test('low is the median and high is the 90th percentile', () => {
  // 200 values 1000..1199. Median index floor(0.5 * 199) = 99 -> 1099.
  // 90th index floor(0.9 * 199) = 179 -> 1179.
  const { rows } = run(spread(200));
  const orig = rows.find((r) => r.fee_category === 'origination_charges_total');
  assert.equal(orig.low, 1099);
  assert.equal(orig.high, 1179);
});

// --- the population filters, one at a time ----------------------------------
//
// Each of these, if it leaked through, would drag the distribution DOWN and
// make an ordinary loan read as above benchmark.

const EXCLUDED = [
  ['a subordinate lien', { lien_status: '2' }],
  ['an investment property', { occupancy_type: '3' }],
  ['a business-purpose loan', { business_or_commercial_purpose: '1' }],
  ['a reverse mortgage', { reverse_mortgage: '1' }],
  ['a HELOC', { 'open-end_line_of_credit': '1' }],
  ['a manufactured home', { derived_dwelling_category: 'Single Family (1-4 Units):Manufactured' }],
  ['multifamily', { derived_dwelling_category: 'Multifamily:Site-Built (5+ Units)' }],
  ['an application that was denied', { action_taken: '3' }],
  ['a purchased loan', { action_taken: '6' }],
  ['a home improvement loan', { loan_purpose: '2' }],
];

for (const [what, override] of EXCLUDED) {
  test(`${what} is excluded from the distribution`, () => {
    // 150 clean loans at 1000..1149 plus 150 excluded ones priced at $1, which
    // would halve both percentiles if they got in.
    const contaminated = spread(150).concat(
      Array.from({ length: 150 }, () => ({
        ...PASSING, ...override, origination_charges: '1', total_loan_costs: '1',
      })));
    const { rows } = run(contaminated);
    const orig = rows.find((r) => r.fee_category === 'origination_charges_total');
    assert.equal(orig.sample_size, 150, `${what} reached the bucket`);
    assert.ok(orig.low >= 1000, `${what} dragged the median down to ${orig.low}`);
  });
}

test('purchase and refinance are kept in separate buckets', () => {
  const mixed = spread(150).concat(spread(150, { loan_purpose: '31' }));
  const { rows } = run(mixed);
  const purposes = [...new Set(rows.map((r) => r.loan_purpose))].sort();
  assert.deepEqual(purposes, ['purchase', 'refinance']);
  for (const r of rows) assert.equal(r.sample_size, 150);
  // Distinct ids, or one would overwrite the other on merge.
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
});

test('loan size bands are not blended', () => {
  const mixed = spread(150).concat(spread(150, { loan_amount: '600000' }));
  const { rows } = run(mixed);
  const bands = [...new Set(rows.map((r) => r.loan_band))].sort();
  assert.deepEqual(bands, ['150k-300k', '500k-750k']);
});

// --- values that are not numbers --------------------------------------------

test('NA, Exempt and blank cost fields are skipped, not read as zero', () => {
  const records = spread(150).concat(
    Array.from({ length: 60 }, (_, i) => ({
      ...PASSING,
      origination_charges: ['NA', 'Exempt', ''][i % 3],
      total_loan_costs: ['NA', 'Exempt', ''][i % 3],
    })));
  const { rows } = run(records);
  const orig = rows.find((r) => r.fee_category === 'origination_charges_total');
  assert.equal(orig.sample_size, 150);
  assert.ok(orig.low >= 1000, 'a non-numeric field was counted as $0');
});

test('a charge above 20% of the loan is treated as a data error', () => {
  const records = spread(150).concat(
    Array.from({ length: 60 }, () => ({
      ...PASSING, origination_charges: '200000', total_loan_costs: '200000',
    })));
  const { rows } = run(records);
  const orig = rows.find((r) => r.fee_category === 'origination_charges_total');
  assert.equal(orig.sample_size, 150);
});

// --- refusals ---------------------------------------------------------------

test('a bucket below the sample minimum is dropped, not published thin', () => {
  const { rows } = run(spread(99));
  assert.deepEqual(rows, []);
});

test('a missing required column fails loudly rather than dropping a filter', () => {
  // Simulates FFIEC renaming lien_status. Silently building without it is the
  // failure mode this check exists to prevent.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmda-'));
  const inPath = path.join(dir, 'in.csv');
  const mapPath = path.join(dir, 'counties.json');
  const cols = COLUMNS.filter((c) => c !== 'lien_status');
  const body = [cols.join(',')].concat(
    spread(200).map((r) => cols.map((c) => r[c] ?? '').join(','))).join('\n');
  fs.writeFileSync(inPath, body + '\n');
  fs.writeFileSync(mapPath, JSON.stringify({ '24005': { name: 'Baltimore', state: 'MD' } }));

  let out = '';
  let failed = false;
  try {
    execFileSync('node', [SCRIPT, '--in', inPath, '--state', 'MD', '--year', '2025',
      '--counties', mapPath, '--out', path.join(dir, 'o.json')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) { failed = true; out = (err.stdout || '') + (err.stderr || ''); }
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(failed, true, 'a missing filter column must not be survivable');
  assert.match(out, /lien_status/);
});

test('running without a county map refuses rather than emitting FIPS codes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmda-'));
  const inPath = path.join(dir, 'in.csv');
  fs.writeFileSync(inPath, csv(spread(200)));
  let out = '';
  let failed = false;
  try {
    execFileSync('node', [SCRIPT, '--in', inPath, '--state', 'MD', '--year', '2025'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) { failed = true; out = (err.stdout || '') + (err.stderr || ''); }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(failed, true);
  assert.match(out, /--counties is required/);
});

test('a county from another state is skipped, not filed under the wrong name', () => {
  // The commonest operator error: running the Virginia file with --state MD.
  const { rows, stdout } = run(spread(200), {
    counties: { '24005': { name: 'Fairfax', state: 'VA' } },
  });
  assert.deepEqual(rows, []);
  assert.match(stdout, /different state/);
});

test('an unmapped FIPS code is named in the output so the map can be fixed', () => {
  const { rows, stdout } = run(spread(200, { county_code: '24999' }));
  assert.deepEqual(rows, []);
  assert.match(stdout, /24999/);
});

// --- the county map ---------------------------------------------------------

test('county names normalise to the form the benchmark lookup matches', () => {
  // Baltimore County and Baltimore city are different taxing jurisdictions.
  assert.equal(normaliseCountyName('Baltimore County'), 'Baltimore');
  assert.equal(normaliseCountyName('Baltimore city'), 'Baltimore City');
  assert.equal(normaliseCountyName('Fairfax County'), 'Fairfax');
  assert.equal(normaliseCountyName('Fairfax city'), 'Fairfax City');
  // Left verbatim: this is how they are printed on a Closing Disclosure, and
  // benchmark-corpus norm() strips " parish" on both sides anyway.
  assert.equal(normaliseCountyName('Orleans Parish'), 'Orleans Parish');
  assert.equal(normaliseCountyName('North Slope Borough'), 'North Slope Borough');
  assert.equal(normaliseCountyName('Nome Census Area'), 'Nome Census Area');
  assert.equal(normaliseCountyName('District of Columbia'), 'District of Columbia');
});

test('the generated county map covers every state and matches the live corpus', () => {
  const mapPath = path.join(__dirname, '..', 'data', 'county-fips.json');
  assert.ok(fs.existsSync(mapPath),
    'data/county-fips.json is missing — run scripts/build-county-fips.js');
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const entries = Object.values(map);

  assert.ok(entries.length > 3000, `only ${entries.length} counties in the map`);
  assert.equal(new Set(entries.map((e) => e.state)).size, 51, '50 states plus DC');

  // Every FIPS key is a 5-digit zero-padded string, the form HMDA emits.
  for (const k of Object.keys(map)) assert.match(k, /^\d{5}$/);

  // The map must be able to name every county the corpus already prices, or
  // HMDA rows and statutory rows would disagree about what a county is called.
  const corpus = require('../data/benchmarks.json').rows.filter((r) => r.county);
  const names = new Set(entries.map((e) => e.name));
  const missing = [...new Set(corpus.map((r) => r.county))].filter((c) => !names.has(c));
  assert.deepEqual(missing, [],
    `corpus counties the FIPS map cannot name: ${missing.join(', ')}`);
});

// --- the gate ---------------------------------------------------------------

test('HMDA rows are not live in the corpus yet', () => {
  // These rows carry a loan_purpose that benchmark-corpus.js does not read.
  // Merging them before the lookup filters on it would score a refinance CD
  // against purchase-money distributions. This fails the build if someone
  // merges them early; delete it in the same change that makes the lookup
  // purpose-aware.
  const corpus = require('../data/benchmarks.json').rows;
  const live = corpus.filter((r) => String(r.id || '').startsWith('hmda-'));
  assert.deepEqual(live.map((r) => r.id), [],
    'HMDA rows are in data/benchmarks.json but the lookup still ignores '
    + 'loan_purpose — a refinance would be scored against purchase loans.');
});
