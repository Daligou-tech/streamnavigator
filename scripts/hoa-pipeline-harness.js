#!/usr/bin/env node
// Runs the HOA post-processing against a synthesis with known answers.
//
// The HOA engine's model calls cannot run without credits, but almost
// everything that was added on 2026-09-13 happens AFTER the model returns:
// citations attach, percent funded is recomputed, uncited findings are
// demoted, the risk score is computed, caveats are added, and the whole thing
// is graded. All of that is testable for free, and none of it had ever been
// exercised against a realistic whole report rather than a hand-built object.
//
// tests/fixtures/maple-court-hoa.json is the synthesis a correct model would
// return from the four HOA PDFs in tmp-test-docs. It is deliberately imperfect
// in the ways a real one is: the model's own risk_score, a percent_funded it
// typed wrong, a finding whose citation will not resolve, and an empty
// missing_or_uncertain.
//
//   node scripts/hoa-pipeline-harness.js
//   node scripts/hoa-pipeline-harness.js --verbose

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  attachCitations, applyComputedRiskScore, demoteUncitedFindings,
  deriveHoaReserveFigures, checkHoaConsistency, hoaCaveats,
} = require('../api/_lib/hoa-engine');
const { seedMissingOrUncertain } = require('../api/_lib/report-consistency');

const verbose = process.argv.includes('--verbose');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'tests', 'fixtures', 'maple-court-hoa.json'), 'utf8'
));

// ---------------------------------------------------------------------------
// GROUND TRUTH — what the documents say, independent of what the model wrote
// ---------------------------------------------------------------------------
//
//   486,000 / 1,620,000 = 30.0% funded exactly. The model typed 45%.
//   60,000 contributed against 210,000 recommended -> Moderate
//   30% funded                                     -> Moderate
//   a $250,000 line of credit in the minutes       -> HIGH
//   delinquency 12.4%                              -> Moderate
//   a 5% named-storm deductible                    -> Moderate
//   mid-term likelihood "Likely"                   -> Moderate
//   so the computed score is HIGH, and the basis must name all of them.
//
//   The 2021 reserve study is five years old -> stale-study caveat.
//   Evidence id 404 does not exist, so that finding must lose its citation and
//   drop below the four that have one.

const EXPECT = {
  percentFunded: '30%',
  score: 'High',
  scoreMentions: [/23%|30% funded/, /borrowing/, /delinquency/, /below what the association/],
  citedFindings: 4,
  uncitedFindings: 1,
  caveatMatches: [/reserve study is from 2021/],
};

const problems = [];
const ok = [];
const check = (label, pass, detail) => (pass ? ok : problems).push(detail ? `${label} — ${detail}` : label);

// --- run the real pipeline, in the real order -------------------------------

const { report, droppedCitationRefs, unverifiedPinpoints } =
  attachCitations(JSON.parse(JSON.stringify(fixture.report)), fixture.evidence);

const derived = deriveHoaReserveFigures(report);
const citationOrder = demoteUncitedFindings(report);
const scoring = applyComputedRiskScore(report);
const caveats = seedMissingOrUncertain(report, hoaCaveats(report));
const { problems: consistency } = checkHoaConsistency({ report });

// --- assert against the documents -------------------------------------------

check('percent funded is recomputed from the balances',
  report.reserve_health.percent_funded === EXPECT.percentFunded,
  `expected ${EXPECT.percentFunded}, got ${report.reserve_health.percent_funded}`);

const kn = (report.key_numbers || []).find((n) => /funded/i.test(n.label));
check('the header key number follows the corrected figure',
  kn && kn.value === EXPECT.percentFunded,
  `expected ${EXPECT.percentFunded}, got ${kn && kn.value}`);

check('the risk score is computed, not the model\'s',
  scoring.score === EXPECT.score && scoring.diverged,
  `model said ${scoring.stated}, computed ${scoring.score}`);

check('the badge follows the computed score',
  report.headline_tag === `${EXPECT.score} risk`,
  `got "${report.headline_tag}"`);

EXPECT.scoreMentions.forEach((re) => {
  check(`the basis names ${re}`, re.test(report.risk_score_basis || ''));
});

check('the uncited finding was demoted',
  citationOrder.cited === EXPECT.citedFindings && citationOrder.uncited === EXPECT.uncitedFindings,
  `${citationOrder.cited} cited / ${citationOrder.uncited} uncited`);

check('the uncited finding is last',
  report.findings[report.findings.length - 1].uncited === true);

check('every finding above it kept a citation',
  report.findings.slice(0, EXPECT.citedFindings).every((f) => (f.citations || []).length > 0));

check('the unresolvable citation was counted',
  droppedCitationRefs === 1, `dropped ${droppedCitationRefs}`);

EXPECT.caveatMatches.forEach((re) => {
  check(`a caveat names ${re}`, (report.missing_or_uncertain || []).some((c) => re.test(c)));
});

check('missing_or_uncertain is no longer empty',
  (report.missing_or_uncertain || []).length > 0,
  'the schema requires it and the write-up left it empty');

check('the leasing cap survived into the report',
  report.restrictions.leasing.cap === '20% of units'
  && /waiting list/i.test(report.restrictions.leasing.current_status));

check('the leasing finding carries its page citation',
  (report.restrictions.leasing.citations || []).length === 2,
  `${(report.restrictions.leasing.citations || []).length} citations`);

check('no consistency problem survived the repairs',
  consistency.length === 0,
  consistency.map((p) => p.class).join(', '));

// --- report ------------------------------------------------------------------

console.log('HOA pipeline — Maple Court, against the documents\n');

if (verbose) {
  console.log(`  score      ${scoring.stated} (model)  ->  ${scoring.score} (computed)`);
  console.log(`  basis      ${report.risk_score_basis}\n`);
  console.log(`  corrected  ${derived.map((d) => `${d.field}: ${d.from} -> ${d.to}`).join('; ') || 'nothing'}`);
  console.log(`  citations  ${citationOrder.cited} cited, ${citationOrder.uncited} demoted, `
    + `${droppedCitationRefs} refs dropped, ${unverifiedPinpoints} pinpoints discarded`);
  console.log('\n  caveats added:');
  caveats.forEach((c) => console.log(`    · ${c.slice(0, 110)}...`));
  console.log('');
}

ok.forEach((t) => console.log(`  PASS  ${t}`));
problems.forEach((t) => console.log(`  FAIL  ${t}`));

console.log(`\n${ok.length} passed, ${problems.length} failed`);
process.exitCode = problems.length ? 1 : 0;
