#!/usr/bin/env node
// Offline audit harness.
//
// Runs the whole pipeline over saved extractions and prints every finding. No
// API key, no network, no deploy, no upload — about a second.
//
// This is the thing that should have existed before most of the work it now
// guards. Four bugs in one day were features wired to nothing: an extractor
// written, unit-tested, and never called by anything. Each was found by a
// customer-facing upload, one round trip at a time. This finds them in one run,
// because it exercises the real call path rather than a mock of it.
//
// What it catches:      wiring, empty sections, index mismatches, false
//                       positives, crashes, and any finding whose severity or
//                       dollar figure changes unexpectedly.
// What it cannot catch: a misunderstanding of the form itself. The fixtures are
//                       extractions, so if the audit misreads what a section
//                       means, the fixture agrees with it. Only real documents
//                       test that.
//
// Usage:
//   node scripts/audit-harness.js                 all fixtures
//   node scripts/audit-harness.js parkside        one, by name
//   node scripts/audit-harness.js --verbose       every finding, not just flags
//   node scripts/audit-harness.js --json          machine-readable
//
// Adding a fixture: drop a JSON file in tests/fixtures/. Capture a real one with
//   select form_data->'extraction' from navigator_submissions where id = '...';
// and save it as { "name": "...", "note": "...", "extraction": { ... } }.
// Optionally add "loanEstimates", "contractTerms" and "answers".

const fs = require('node:fs');
const path = require('node:path');

const { runClosingAudit, buildScorecard } = require('../api/_lib/closing-extract');

const FIXTURE_DIR = path.join(__dirname, '..', 'tests', 'fixtures');
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const asJson = args.includes('--json');
const filter = args.find((a) => !a.startsWith('--'));

const FLAGGED = new Set([
  'confirmed_mathematical_error', 'potential_trid_violation', 'potential_overcharge',
  'potential_duplicate', 'above_available_benchmark',
]);

function loadFixtures() {
  if (!fs.existsSync(FIXTURE_DIR)) return [];
  return fs.readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')) }))
    .filter((f) => !filter || (f.name || f.file).includes(filter));
}

function runOne(fx) {
  const started = Date.now();
  let result, error = null;
  try {
    result = runClosingAudit(fx.extraction, {
      answers: fx.answers || {},
      loanEstimates: fx.loanEstimates || null,
      contractTerms: fx.contractTerms || null,
    });
  } catch (err) {
    error = err;
    result = { findings: [], skipped: [] };
  }

  const scorecard = error ? null
    : buildScorecard(fx.extraction, result.findings, result.skipped);

  return {
    name: fx.name || fx.file,
    note: fx.note || '',
    ms: Date.now() - started,
    error: error ? `${error.message}\n${error.stack.split('\n')[1] || ''}` : null,
    findings: result.findings,
    skipped: result.skipped,
    scorecard,
  };
}

function printOne(r) {
  const bar = '='.repeat(72);
  console.log(`\n${bar}\n${r.name}${r.note ? '  —  ' + r.note : ''}\n${bar}`);

  if (r.error) {
    console.log(`  THREW: ${r.error}`);
    return;
  }

  const s = r.scorecard;
  const money = (n) => (n === null || n === undefined ? '—' : '$' + Number(n).toLocaleString('en-US'));
  console.log(`  total ${money(s.total_closing_costs || s.total_borrower_charges)}`
    + `   flags ${s.flag_count}`
    + `   needs-docs ${s.needs_more_documents_count}`
    + `   cannot-benchmark ${s.cannot_benchmark_count}`
    + `   lines ${s.line_items_read}`);

  const shown = verbose ? r.findings : r.findings.filter((f) => FLAGGED.has(f.severity));
  if (!shown.length) {
    console.log('  no flagged findings');
  } else {
    for (const f of shown) {
      const impact = f.dollarImpact ? `  $${Number(f.dollarImpact).toLocaleString('en-US')}` : '';
      console.log(`  [${f.severity}]${impact}\n      ${f.title}`);
      if (verbose && f.basis) console.log(`      basis: ${f.basis.slice(0, 140)}`);
    }
  }

  if (r.skipped.length) console.log(`  skipped: ${r.skipped.join('; ')}`);

  // The checks most likely to be silently wrong, called out every run.
  const suspicious = [];
  if (s.flag_count === 0 && s.line_items_read === 0) suspicious.push('zero flags on zero line items — nothing was tested');
  if (s.total_closing_costs === null && s.total_borrower_charges === null) suspicious.push('no total could be established');
  const bigMath = r.findings.filter((f) => f.severity === 'confirmed_mathematical_error' && (f.dollarImpact || 0) > 10000);
  for (const f of bigMath) suspicious.push(`five-figure "confirmed" error — verify by hand: ${f.title}`);
  if (suspicious.length) console.log('  ATTENTION: ' + suspicious.join(' | '));
}

const fixtures = loadFixtures();
if (!fixtures.length) {
  console.error(`No fixtures found in ${FIXTURE_DIR}${filter ? ` matching "${filter}"` : ''}.`);
  process.exit(1);
}

const results = fixtures.map(runOne);

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  results.forEach(printOne);
  const threw = results.filter((r) => r.error).length;
  const flagged = results.reduce((a, r) => a + r.findings.filter((f) => FLAGGED.has(f.severity)).length, 0);
  console.log(`\n${'='.repeat(72)}`);
  console.log(`${results.length} fixtures, ${flagged} flagged findings, ${threw} threw`);
  if (threw) console.log('Run with --verbose for the full picture.');
}

process.exit(results.some((r) => r.error) ? 1 : 0);
