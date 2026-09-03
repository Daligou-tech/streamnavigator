#!/usr/bin/env node
// Builds benchmark rows for ALL 50 STATES from one free federal dataset.
//
// WHY THIS EXISTS
//
// County fee schedules are public everywhere, but there are ~3,100 counties and
// the fees customers actually suspect — origination, underwriting, processing —
// have no published rate table in ANY state. No state regulates them.
//
// HMDA closes that gap. Since 2018 the public loan-level HMDA data has carried
// origination_charges and total_loan_costs for covered originations. The
// Philadelphia Fed describes origination_charges as the borrower-paid total from
// Box A of the Closing Disclosure — the same box we extract. It is free,
// nationwide, and downloadable per state.
//
// So this produces DISTRIBUTION benchmarks: not "this fee should be $X" but
// "90% of comparable loans in your county paid less than $X". That is a market
// norm, and the corpus schema already forces it to be expressed as a range with
// a sample size, so it can never be presented to a customer as a rule.
//
// WHAT IT DOES NOT GIVE YOU
//
// Section totals, not line items. HMDA has Box A and Section D totals. It will
// never tell you a $995 underwriting fee is high — only that your origination
// charges as a whole sit above what comparable borrowers paid. Say that
// plainly to the customer; do not let the report imply otherwise.
//
// GETTING THE DATA
//
//   1. https://ffiec.cfpb.gov/data-browser/data/2025?category=states
//   2. Filter to a state, action taken = "Loan originated".
//   3. Download the CSV.
//   4. node scripts/build-hmda-benchmarks.js --in md-2025.csv --state MD --year 2025
//
// Repeat per state. Append the output rows into data/benchmarks.json.
//
// CAVEATS THE OUTPUT CARRIES INTO EVERY ROW
//
//   * Smaller-volume filers are partially exempt under EGRRCPA, so coverage is
//     not universal.
//   * The data lags roughly one year.
//   * Buckets below MIN_SAMPLE are dropped entirely rather than published thin.

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// The corpus refuses a range row under 30 observations. We require more,
// because these are split by loan-size band as well as county.
const MIN_SAMPLE = 100;

// Loan size changes fee levels more than anything else, so a single county
// distribution would compare a $90k loan to a $900k one. Bands in dollars.
const LOAN_BANDS = [
  { id: 'lt150k', min: 0, max: 150000, label: 'under $150,000' },
  { id: '150k-300k', min: 150000, max: 300000, label: '$150,000–$300,000' },
  { id: '300k-500k', min: 300000, max: 500000, label: '$300,000–$500,000' },
  { id: '500k-750k', min: 500000, max: 750000, label: '$500,000–$750,000' },
  { id: 'gte750k', min: 750000, max: Infinity, label: '$750,000 and above' },
];

// HMDA field -> our fee category. Both are Closing Disclosure box totals.
const FIELDS = [
  { hmda: 'origination_charges', category: 'origination_charges_total',
    label: 'Origination charges (Section A total)' },
  { hmda: 'total_loan_costs', category: 'total_loan_costs',
    label: 'Total loan costs (Section D total)' },
];

// Percentiles. low = median, high = 90th. A charge is only ever flagged for
// being ABOVE the 90th, so the median is context rather than a threshold.
const P_LOW = 0.50;
const P_HIGH = 0.90;

// ---------------------------------------------------------------------------

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

const bandFor = (amount) =>
  LOAN_BANDS.find((b) => amount >= b.min && amount < b.max) || null;

async function main() {
  const inPath = arg('in');
  const state = arg('state');
  const year = arg('year');
  const countyNames = arg('counties'); // optional JSON map of FIPS -> name

  if (!inPath || !state || !year) {
    console.error('Usage: node scripts/build-hmda-benchmarks.js --in <csv> --state <XX> --year <YYYY>');
    console.error('       [--counties county-fips.json]   FIPS -> county name map');
    process.exit(1);
  }
  if (!fs.existsSync(inPath)) {
    console.error(`Not found: ${inPath}`);
    process.exit(1);
  }

  // Required, not optional. HMDA identifies counties by 5-digit FIPS code, but
  // the benchmark lookup matches on county NAME and canonicalises it (Baltimore
  // City vs Baltimore County). Emitting FIPS codes would produce rows that
  // validate, load, and then never match a single lookup — a corpus that looks
  // full and answers nothing. Fail here instead.
  if (!countyNames) {
    console.error('--counties is required.\n');
    console.error('  HMDA gives 5-digit FIPS codes; the benchmark lookup needs county names.');
    console.error('  Supply a JSON map, e.g. { "24510": "Baltimore City", "24005": "Baltimore" }.');
    console.error('  The Census county FIPS list is at:');
    console.error('  https://www.census.gov/library/reference/code-lists/ansi.html');
    process.exit(1);
  }
  if (!fs.existsSync(countyNames)) {
    console.error(`Not found: ${countyNames}`);
    process.exit(1);
  }
  const fipsToName = JSON.parse(fs.readFileSync(countyNames, 'utf8'));

  const rl = readline.createInterface({
    input: fs.createReadStream(inPath), crlfDelay: Infinity,
  });

  let header = null;
  let idx = {};
  // key: `${countyFips}|${bandId}|${hmdaField}` -> number[]
  const buckets = new Map();
  let rows = 0;
  let usable = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    if (!header) {
      header = cells.map((c) => c.trim().toLowerCase());
      idx = Object.fromEntries(header.map((h, i) => [h, i]));
      const required = ['county_code', 'loan_amount', 'action_taken',
        ...FIELDS.map((f) => f.hmda)];
      const missing = required.filter((r) => !(r in idx));
      if (missing.length) {
        console.error(`CSV is missing required columns: ${missing.join(', ')}`);
        console.error('Download the loan-level CSV from the FFIEC Data Browser, not a summary table.');
        process.exit(1);
      }
      continue;
    }
    rows += 1;

    // Originations only. An application that never closed has no closing costs.
    if (String(cells[idx.action_taken]).trim() !== '1') continue;

    const loanAmount = Number(cells[idx.loan_amount]);
    if (!Number.isFinite(loanAmount) || loanAmount <= 0) continue;
    const band = bandFor(loanAmount);
    if (!band) continue;

    const county = String(cells[idx.county_code] || '').trim();
    if (!county) continue;

    let used = false;
    for (const f of FIELDS) {
      const raw = String(cells[idx[f.hmda]] || '').trim();
      // Exempt / NA / blank are all "not reported", not zero.
      if (!raw || /^(na|exempt)$/i.test(raw)) continue;
      const v = Number(raw);
      if (!Number.isFinite(v) || v <= 0) continue;
      // A charge above 20% of the loan is a data error, not a fee.
      if (v > loanAmount * 0.2) continue;

      const key = `${county}|${band.id}|${f.hmda}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(v);
      used = true;
    }
    if (used) usable += 1;
  }

  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  let dropped = 0;
  const unmappedFips = new Set();

  for (const [key, values] of buckets) {
    const [county, bandId, hmdaField] = key.split('|');
    if (values.length < MIN_SAMPLE) { dropped += 1; continue; }

    const sorted = values.slice().sort((a, b) => a - b);
    const low = Math.round(percentile(sorted, P_LOW));
    const high = Math.round(percentile(sorted, P_HIGH));
    if (!(high > low)) { dropped += 1; continue; }

    const field = FIELDS.find((f) => f.hmda === hmdaField);
    const band = LOAN_BANDS.find((b) => b.id === bandId);
    const countyName = fipsToName[county];
    if (!countyName) { unmappedFips.add(county); dropped += 1; continue; }

    out.push({
      id: `hmda-${year}-${state.toLowerCase()}-${county}-${bandId}-${hmdaField}`,
      fee_category: field.category,
      kind: 'range',
      low,
      high,
      sample_size: values.length,
      loan_band: bandId,
      loan_band_label: band.label,
      jurisdiction_type: 'county',
      state: state.toUpperCase(),
      county: countyName,
      county_fips: county,
      evidence: 'market_norm:comparable_transactions',
      source_name:
        `Home Mortgage Disclosure Act loan-level data, ${year}, ${field.label}. `
        + `Median and 90th percentile of ${values.length} originations in this county `
        + `for loans of ${band.label}.`,
      source_url: 'https://ffiec.cfpb.gov/data-browser/',
      effective_date: `${year}-01-01`,
      verified_at: today,
      // HMDA is annual. A distribution more than two years old should stop
      // answering rather than describe a market that has moved.
      stale_after_days: 760,
      exemption_note:
        'This is what comparable borrowers actually paid, not a rate anyone is '
        + 'required to charge. A charge above this spread is unusual, not an error. '
        + 'It covers the section total only, not any individual fee within it. '
        + 'Smaller lenders are partially exempt from reporting these fields, so the '
        + 'sample is not every loan in the county.',
    });
  }

  out.sort((a, b) => a.id.localeCompare(b.id));

  const outPath = arg('out', path.join('data', `hmda-${state.toLowerCase()}-${year}.json`));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ rows: out }, null, 2));

  console.log(`Read ${rows} rows, ${usable} with usable cost fields.`);
  console.log(`Wrote ${out.length} benchmark rows to ${outPath}.`);
  console.log(`Dropped ${dropped} buckets (below the ${MIN_SAMPLE}-loan minimum, or unmapped county).`);
  if (unmappedFips.size) {
    console.log(`\n${unmappedFips.size} FIPS code(s) had no name in your map and were skipped:`);
    console.log('  ' + [...unmappedFips].sort().join(', '));
    console.log('  Add them to the map and re-run, or those counties get no benchmark.');
  }
  if (!out.length) {
    console.log('\nNo rows met the sample minimum. Either the file is small, or the '
      + 'cost fields are largely exempt for this state.');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
