#!/usr/bin/env node
// Corpus freshness and coverage gate.
//
// WHY THIS EXISTS
//
// benchmark-corpus.js has isStale(), and it is unit tested. Nothing checked the
// ACTUAL corpus. The Maryland rows carry stale_after_days: 120 from a
// verified_at of 2026-09-02, so they stop answering on 2026-12-31 — at which
// point every Maryland customer silently drops to "we cannot price any of your
// charges" and no test goes red, because a stale row is handled gracefully by
// design. Graceful degradation with no alarm on it is how a product quietly
// stops working.
//
// Run: node scripts/check-corpus-freshness.js [--warn-days 30] [--json]
//
// Exit 1 when anything is already stale, or falls inside the warning horizon,
// or when usable coverage drops below the floor below.

'use strict';

const path = require('path');

const corpus = require(path.join(__dirname, '..', 'data', 'benchmarks.json'));
const { DEFAULT_STALE_AFTER_DAYS } = require(path.join(__dirname, '..', 'api', '_lib', 'benchmark-corpus'));
const rows = corpus.rows || [];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const warnDays = Number(arg('warn-days', 30));
const asJson = process.argv.includes('--json');
const today = new Date();

// A category is only USABLE if the extractor can produce that category from a
// document. recordation_tax rows are verified and correct and currently answer
// nothing, because closing-extract.js has no recordation_tax category, so a
// recordation line lands in transfer_tax on one document and recording_fee on
// the next. Counting them as coverage overstates the product to its owner.
//
// Keep this list in step with the extractor's fee categories. Moving a name
// from DORMANT to LIVE is the last step of wiring a category up, not the first.
const DORMANT_CATEGORIES = new Set(['recordation_tax']);

// Floors, not targets. These are the numbers below which the product has
// quietly lost a capability it advertises on the pricing card.
const FLOORS = {
  usable_rows: 20,
  states: 1,
};

// Mirrors isStale() exactly, including its fallback. An earlier version of this
// script treated a row without stale_after_days as immortal and reported a bug
// that did not exist — isStale falls back to DEFAULT_STALE_AFTER_DAYS, so the
// row expires on schedule. A gate that reports phantom failures gets ignored as
// fast as one that reports nothing, so it reads the constant rather than
// restating the rule.
function expiryOf(row) {
  if (!row.verified_at) return null;
  const d = new Date(row.verified_at);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + Number(row.stale_after_days || DEFAULT_STALE_AFTER_DAYS));
  if (row.superseded_date) {
    const sup = new Date(row.superseded_date);
    if (!Number.isNaN(sup.getTime()) && sup < d) return sup;
  }
  return d;
}

const daysUntil = (d) => Math.floor((d - today) / 86400000);

const report = {
  total_rows: rows.length,
  usable_rows: 0,
  dormant_rows: 0,
  by_state: {},
  by_category: {},
  expired: [],
  expiring_soon: [],
  undated: [],
};

for (const row of rows) {
  const cat = row.fee_category || '(none)';
  const state = row.state || '(none)';
  report.by_category[cat] = (report.by_category[cat] || 0) + 1;
  report.by_state[state] = (report.by_state[state] || 0) + 1;

  if (DORMANT_CATEGORIES.has(cat)) { report.dormant_rows += 1; } else { report.usable_rows += 1; }

  const exp = expiryOf(row);
  if (!exp) { report.undated.push(row.id); continue; }
  const left = daysUntil(exp);
  const entry = { id: row.id, expires: exp.toISOString().slice(0, 10), days_left: left };
  if (left < 0) report.expired.push(entry);
  else if (left <= warnDays) report.expiring_soon.push(entry);
}

report.states = Object.keys(report.by_state).filter((s) => s !== '(none)');

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Corpus: ${report.total_rows} rows — ${report.usable_rows} usable, ${report.dormant_rows} dormant.`);
  console.log(`States: ${report.states.join(', ') || '(none)'}`);
  console.log('Categories:');
  for (const [c, n] of Object.entries(report.by_category).sort()) {
    const flag = DORMANT_CATEGORIES.has(c) ? '  [DORMANT — extractor cannot produce this category]' : '';
    console.log(`  ${String(n).padStart(4)}  ${c}${flag}`);
  }
}

const problems = [];

if (report.expired.length) {
  problems.push(`${report.expired.length} row(s) are already stale and answering nothing:`);
  for (const e of report.expired.slice(0, 10)) problems.push(`    ${e.id} expired ${e.expires}`);
}
if (report.expiring_soon.length) {
  const soonest = report.expiring_soon.reduce((a, b) => (a.days_left < b.days_left ? a : b));
  problems.push(
    `${report.expiring_soon.length} row(s) expire within ${warnDays} days — soonest `
    + `${soonest.expires} (${soonest.days_left} days). Re-verify against the published `
    + `schedule and bump verified_at, or the coverage disappears silently.`);
}
if (report.undated.length) {
  problems.push(`${report.undated.length} row(s) have no usable verified_at and can never expire: `
    + report.undated.slice(0, 5).join(', '));
}
if (report.usable_rows < FLOORS.usable_rows) {
  problems.push(`Usable rows fell to ${report.usable_rows}, below the floor of ${FLOORS.usable_rows}.`);
}
if (report.states.length < FLOORS.states) {
  problems.push(`Corpus covers ${report.states.length} state(s), below the floor of ${FLOORS.states}.`);
}

if (problems.length) {
  console.error('\nCORPUS HEALTH FAILED\n');
  for (const p of problems) console.error('  ' + p);
  console.error('');
  process.exit(1);
}

console.log('\nCorpus health OK.');
