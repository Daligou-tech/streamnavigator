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
//   4. node scripts/build-county-fips.js --in county_fips_master.csv    (once)
//   5. node scripts/build-hmda-benchmarks.js --in md-2025.csv --state MD --year 2025 \
//        --counties data/county-fips.json
//
// Repeat per state.
//
// DO NOT MERGE THE OUTPUT INTO data/benchmarks.json YET
//
// Every row carries `loan_purpose`, because a refinance has no owner's title
// policy and no survey and so has a structurally lower Section D total than a
// purchase. Nothing in benchmark-corpus.js reads that field yet, so merging
// these rows today would let a refinance Closing Disclosure be scored against
// purchase-money distributions and flagged as above benchmark for a fee it was
// never going to carry.
//
// The gate to lift before merging: make the lookup match on loan_purpose the
// same way it matches on loan_band, and decline rather than fall back when the
// extraction has no transaction_type. Until then this script is a generator
// whose output goes in a file nobody loads.
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

// HMDA loan_purpose -> the population a benchmark row describes. Anything not
// listed (home improvement, "other", not applicable) is dropped rather than
// folded into a purchase or refinance distribution.
const PURPOSES = {
  '1':  { id: 'purchase',   label: 'home purchase' },
  '31': { id: 'refinance',  label: 'refinance' },
  '32': { id: 'refinance',  label: 'refinance' },
};

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
      // Every column the population filters depend on is required. If FFIEC
      // renames one, this exits rather than quietly building a corpus with
      // that filter switched off.
      const required = ['county_code', 'loan_amount', 'action_taken',
        'lien_status', 'occupancy_type', 'business_or_commercial_purpose',
        'reverse_mortgage', 'open-end_line_of_credit',
        'derived_dwelling_category', 'loan_purpose',
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

    // POPULATION FILTERS — the difference between a benchmark and a libel.
    //
    // Without these the bucket mixes loans that are not comparable to the
    // customer's, and every one of them mixes DOWNWARD. A subordinate-lien
    // HELOC carries near-zero origination charges; a business-purpose loan and
    // an investment property sit on a different fee schedule entirely. Blend
    // them into one distribution and the median and the 90th percentile both
    // fall, so an ordinary first-lien owner-occupied purchase reads as ABOVE
    // the spread. That is a false accusation about a real person's mortgage,
    // generated at scale, and it is the worst thing this product can do.
    //
    // Every field below is presence-checked in the header block, so an FFIEC
    // schema change fails loudly instead of silently dropping a filter.
    const isOne = (f) => String(cells[idx[f]] || '').trim() === '1';
    const isTwo = (f) => String(cells[idx[f]] || '').trim() === '2';

    if (!isOne('lien_status')) continue;              // first lien only
    if (!isOne('occupancy_type')) continue;           // principal residence
    if (!isTwo('business_or_commercial_purpose')) continue;
    if (!isTwo('reverse_mortgage')) continue;
    if (!isTwo('open-end_line_of_credit')) continue;  // excludes HELOCs

    // Site-built single family (1-4 units). Manufactured housing and 5+ unit
    // multifamily are different fee worlds; a Closing Disclosure audit is aimed
    // at the first.
    if (String(cells[idx['derived_dwelling_category']] || '').trim()
        !== 'Single Family (1-4 Units):Site-Built') continue;

    // Purchase and refinance are not interchangeable. A refinance usually has
    // no owner's title policy and no survey, so its Section D total is
    // structurally lower. Buckets are keyed by purpose and each row records
    // which population it describes, so a refinance can never be scored against
    // purchase money. There is deliberately no "all purposes" option.
    const purpose = PURPOSES[String(cells[idx.loan_purpose] || '').trim()];
    if (!purpose) continue;

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

      const key = `${county}|${purpose.id}|${band.id}|${f.hmda}`;
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
  const crossState = new Set();

  for (const [key, values] of buckets) {
    const [county, purposeId, bandId, hmdaField] = key.split('|');
    if (values.length < MIN_SAMPLE) { dropped += 1; continue; }

    const sorted = values.slice().sort((a, b) => a - b);
    const low = Math.round(percentile(sorted, P_LOW));
    const high = Math.round(percentile(sorted, P_HIGH));
    if (!(high > low)) { dropped += 1; continue; }

    const field = FIELDS.find((f) => f.hmda === hmdaField);
    const band = LOAN_BANDS.find((b) => b.id === bandId);
    const entry = fipsToName[county];
    // Accept both the { name, state } map this repo generates and a plain
    // FIPS -> "Name" map, so a hand-written map still works.
    const countyName = entry && typeof entry === 'object' ? entry.name : entry;
    if (!countyName) { unmappedFips.add(county); dropped += 1; continue; }
    // A FIPS code from another state means the wrong file was passed for
    // --state, which would file one state's fees under another's county name.
    if (entry && entry.state && entry.state !== state.toUpperCase()) {
      crossState.add(`${county} (${entry.state})`);
      dropped += 1;
      continue;
    }

    out.push({
      id: `hmda-${year}-${state.toLowerCase()}-${county}-${purposeId}-${bandId}-${hmdaField}`,
      fee_category: field.category,
      kind: 'range',
      low,
      high,
      sample_size: values.length,
      loan_band: bandId,
      loan_band_label: band.label,
      // Read by nothing yet. Until the lookup filters on it, these rows must
      // NOT be merged into data/benchmarks.json — see the gate in the header.
      loan_purpose: purposeId,
      jurisdiction_type: 'county',
      state: state.toUpperCase(),
      county: countyName,
      county_fips: county,
      evidence: 'market_norm:comparable_transactions',
      source_name:
        `Home Mortgage Disclosure Act loan-level data, ${year}, ${field.label}. `
        + `Median and 90th percentile of ${values.length} ${purposeId} originations in `
        + `this county for loans of ${band.label}. Population: first-lien, `
        + `owner-occupied, site-built single family (1-4 units), not a HELOC, `
        + `reverse mortgage or business-purpose loan.`,
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
  if (crossState.size) {
    console.log(`\n${crossState.size} FIPS code(s) belonged to a different state and were skipped:`);
    console.log('  ' + [...crossState].sort().join(', '));
    console.log(`  That usually means the CSV is not the --state ${state.toUpperCase()} file.`);
  }
  if (!out.length) {
    console.log('\nNo rows met the sample minimum. Either the file is small, or the '
      + 'cost fields are largely exempt for this state.');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
