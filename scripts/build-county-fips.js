#!/usr/bin/env node
// Generates data/county-fips.json: 5-digit FIPS -> { name, state }.
//
// WHY THIS EXISTS
//
// HMDA identifies counties by 5-digit FIPS. The benchmark lookup matches on
// county NAME. build-hmda-benchmarks.js refuses to run without this map, on
// purpose: emitting FIPS codes as county names would produce rows that
// validate, load, and then never match a single lookup — a corpus that looks
// full and answers nothing.
//
// NAME FORM
//
// benchmark-corpus.js `norm()` lowercases and strips a trailing " county" or
// " parish" on BOTH sides of the comparison, so those two suffixes are free.
// The remaining forms are not, so this script normalises to the shape the
// existing Maryland rows already use:
//
//   "Baltimore County"  -> "Baltimore"       (matches md-jurisdiction)
//   "Baltimore city"    -> "Baltimore City"  (independent city, NOT the county)
//   "Orleans Parish"    -> "Orleans Parish"  (left alone; norm() strips it)
//   "Nome Census Area"  -> "Nome Census Area"
//   "District of Columbia" -> unchanged
//
// The 40 Census rows ending in lowercase " city" are Virginia's independent
// cities plus Baltimore city. They are separate taxing jurisdictions from the
// county of the same name, which is the whole reason md-jurisdiction.js exists,
// so the suffix is preserved and capitalised rather than stripped.
//
// SOURCE
//
//   node scripts/build-county-fips.js --in county_fips_master.csv
//
// The input is the Census/ANSI county list. Any CSV works provided it carries
// `fips`, `county_name`, `state_abbr` and `sumlev` columns; rows other than
// sumlev 50 (county level) are dropped.
//
// Getting a name wrong here fails SAFE: the row stops matching and the customer
// is told the charge could not be priced. It cannot produce a wrong number.
// That is the opposite of getting a RATE wrong, which is why rate rows are
// hand-verified against statute and these are not.

'use strict';

const fs = require('fs');
const path = require('path');

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

// Exported so the test can assert the rules without a CSV on disk.
function normaliseCountyName(raw) {
  const n = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!n) return '';
  // Independent cities: capitalise, never strip. "Baltimore city" and
  // "Baltimore County" are two different taxing jurisdictions.
  if (/ city$/.test(n)) return n.replace(/ city$/, ' City');
  if (/ City$/.test(n)) return n;
  // Free suffix — norm() strips it at lookup time either way, and the existing
  // Maryland rows are stored bare.
  if (/ County$/.test(n)) return n.replace(/ County$/, '');
  // Parish / Borough / Census Area / Municipality are left verbatim: they are
  // how the jurisdiction is printed on a Closing Disclosure, and there is no
  // canonicaliser for them outside Maryland.
  return n;
}

function main() {
  const inPath = arg('in');
  const outPath = arg('out', path.join(__dirname, '..', 'data', 'county-fips.json'));

  if (!inPath) {
    console.error('Usage: node scripts/build-county-fips.js --in <county_fips_master.csv> [--out data/county-fips.json]');
    process.exit(1);
  }
  if (!fs.existsSync(inPath)) {
    console.error(`Not found: ${inPath}`);
    process.exit(1);
  }

  // The Census list is not UTF-8 clean (Spanish-language Puerto Rico names).
  const text = fs.readFileSync(inPath, 'latin1');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = parseCsvLine(lines[0]).map((c) => c.trim().toLowerCase());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  for (const req of ['fips', 'county_name', 'state_abbr', 'sumlev']) {
    if (!(req in idx)) {
      console.error(`Input CSV is missing the "${req}" column. Columns seen: ${header.join(', ')}`);
      process.exit(1);
    }
  }

  const map = {};
  let skipped = 0;
  const states = new Set();

  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    if (String(cells[idx.sumlev]).trim() !== '50') { skipped += 1; continue; }
    // HMDA county_code is a zero-padded 5-digit string. The Census list drops
    // the leading zero on Alabama through Connecticut, so pad it back or every
    // lookup in nine states silently misses.
    const fips = String(cells[idx.fips]).trim().padStart(5, '0');
    const name = normaliseCountyName(cells[idx.county_name]);
    const state = String(cells[idx.state_abbr]).trim().toUpperCase();
    if (!fips || !name || !state) { skipped += 1; continue; }
    map[fips] = { name, state };
    states.add(state);
  }

  const entries = Object.keys(map).length;
  if (entries < 3000) {
    console.error(`Only ${entries} counties parsed — expected ~3,140. Refusing to write a truncated map.`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(map, null, 0) + '\n');
  console.log(`Wrote ${entries} counties across ${states.size} states/territories to ${outPath}`);
  console.log(`Skipped ${skipped} non-county rows.`);
}

if (require.main === module) main();

module.exports = { normaliseCountyName };
