#!/usr/bin/env node
// Offline reproducibility harness for the HOA Risk Score.
//
// Before 2026-09-13 the score was a schema enum the model filled in, and the
// audit's complaint was not that it was wrong — it was that nobody could tell.
// Two runs on the same package could disagree and nothing would notice, so
// "reproducible" was untestable without spending real money on repeat paid runs.
//
// Computing the score made it testable for free. This is that test, at a scale
// unit tests do not reach: it sweeps the whole input space the rubric cares
// about, checks the properties that must hold across all of it, and prints the
// band boundaries so a change to a threshold is visible as a diff rather than
// as a surprise on somebody's report.
//
// What it checks:
//   * DETERMINISM   — the same inputs always produce the same score.
//   * MONOTONICITY  — a strictly worse association never scores better.
//   * NO SILENT LOW — "Low" is never reached by an absence of evidence.
//   * EXPLAINED     — every computed score names the rules that produced it.
//
//   node scripts/hoa-score-harness.js
//   node scripts/hoa-score-harness.js --verbose

'use strict';

const { scoreRisk } = require('../api/_lib/hoa-engine');

const verbose = process.argv.includes('--verbose');

const RANK = { Low: 0, Moderate: 1, High: 2, Critical: 3 };

const NO_SIGNALS = {
  unit_count: 84,
  delinquency_rate_pct: -1,
  annual_dues_per_unit: -1,
  special_assessment_announced: false,
  association_borrowing: false,
  material_litigation: false,
  insurance_red_flag: false,
  largest_component_due_months: -1,
  largest_component_cost: -1,
  reserve_study_year: 2025,
  evidence_ids: [],
};

const money = (n) => '$' + Math.round(n).toLocaleString('en-US');

// An association at a given percent funded, funding its study in full, with no
// other signal firing. The cleanest possible input at that funding level.
function atPercent(pct, signals = {}) {
  const fully = 1000000;
  const balance = Math.round(fully * (pct / 100));
  return {
    risk_score: 'Moderate',
    headline_tag: 'Moderate risk',
    risk_signals: { ...NO_SIGNALS, ...signals },
    reserve_health: {
      percent_funded: `${pct}%`,
      reserve_balance: money(balance),
      fully_funded_balance: money(fully),
      annual_contribution: '$100,000',
      recommended_contribution: '$100,000',
      assessment: '',
      citations: [],
    },
    short_term_risk: { likelihood: 'Unlikely' },
    mid_term_risk: { likelihood: 'Unlikely' },
  };
}

const problems = [];
const fail = (what) => problems.push(what);

// --- determinism -------------------------------------------------------------

for (let pct = 0; pct <= 100; pct += 1) {
  const a = scoreRisk(atPercent(pct));
  const b = scoreRisk(atPercent(pct));
  if (a.score !== b.score || a.basis !== b.basis) {
    fail(`determinism: ${pct}% funded scored ${a.score} then ${b.score}`);
  }
}

// --- band boundaries ---------------------------------------------------------

const bands = [];
let previous = null;
for (let pct = 0; pct <= 100; pct += 1) {
  const { score } = scoreRisk(atPercent(pct));
  if (score !== previous) {
    bands.push({ from: pct, score });
    previous = score;
  }
}

// --- monotonicity ------------------------------------------------------------
//
// More funding can never score worse. This is the property most likely to break
// when somebody adds a threshold, because the rules are written independently
// and only interact through the raise() ratchet.

for (let pct = 1; pct <= 100; pct += 1) {
  const worse = scoreRisk(atPercent(pct - 1)).score;
  const better = scoreRisk(atPercent(pct)).score;
  if (RANK[better] > RANK[worse]) {
    fail(`monotonicity: ${pct}% funded scored ${better}, worse than ${pct - 1}% at ${worse}`);
  }
}

// And a signal firing can only ever raise the score, never lower it.
const SIGNALS = [
  ['special_assessment_announced', true],
  ['association_borrowing', true],
  ['material_litigation', true],
  ['insurance_red_flag', true],
  ['delinquency_rate_pct', 14],
];
for (const [key, value] of SIGNALS) {
  for (const pct of [10, 25, 45, 60, 80, 95]) {
    const clean = scoreRisk(atPercent(pct)).score;
    const dirty = scoreRisk(atPercent(pct, { [key]: value })).score;
    if (RANK[dirty] < RANK[clean]) {
      fail(`monotonicity: ${key} LOWERED the score at ${pct}% funded (${clean} -> ${dirty})`);
    }
  }
}

// --- no silent Low -----------------------------------------------------------
//
// The worst available outcome is a clean score earned by an absence of
// documents. A package establishing nothing must fall back to the analytical
// read and say so, never to "Low".

const bare = [
  { risk_score: 'Moderate', risk_signals: null, reserve_health: {} },
  { risk_score: 'High', risk_signals: undefined, reserve_health: {} },
  { risk_score: 'Critical', reserve_health: { percent_funded: '', reserve_balance: '', fully_funded_balance: '' } },
];
for (const report of bare) {
  const { score, computed, basis } = scoreRisk(report);
  if (computed) fail(`no-silent-low: a package establishing nothing reported as computed (${score})`);
  if (score === 'Low') fail('no-silent-low: an empty package scored Low');
  if (!/do not establish/i.test(basis)) fail('no-silent-low: the fallback does not say why it is a read');
}

// --- explained ---------------------------------------------------------------

for (let pct = 0; pct <= 100; pct += 5) {
  const { score, computed, basis } = scoreRisk(atPercent(pct));
  if (!computed) continue;
  if (!basis || basis.length < 20) fail(`explained: ${pct}% funded scored ${score} with no basis`);
  if (score !== 'Low' && !/because/i.test(basis)) {
    fail(`explained: ${pct}% funded scored ${score} without naming a rule`);
  }
}

// --- report ------------------------------------------------------------------

console.log('HOA risk score — band boundaries at clean inputs\n');
bands.forEach((b, i) => {
  const to = i + 1 < bands.length ? bands[i + 1].from - 1 : 100;
  console.log(`  ${String(b.from).padStart(3)}% - ${String(to).padStart(3)}% funded   ${b.score}`);
});

if (verbose) {
  console.log('\nWorked examples');
  [8, 22, 45, 82].forEach((pct) => {
    const r = scoreRisk(atPercent(pct));
    console.log(`\n  ${pct}% funded -> ${r.score}`);
    console.log(`    ${r.basis}`);
  });
}

console.log('');
if (problems.length) {
  console.error(`FAIL  ${problems.length} propert${problems.length === 1 ? 'y' : 'ies'} broken\n`);
  problems.forEach((p) => console.error('  ' + p));
  process.exitCode = 1;
} else {
  console.log('PASS  determinism, monotonicity, no-silent-low, explained');
}
