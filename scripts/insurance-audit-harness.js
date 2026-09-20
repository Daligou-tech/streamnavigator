#!/usr/bin/env node
// Offline audit harness for Insurance Navigator.
//
// Runs api/_lib/insurance-audit.js over known-answer fixtures and prints
// every finding. No API key, no network, no deploy — under a second. Same
// role scripts/audit-harness.js plays for Closing: this is what should exist
// before the work it guards, not after a customer-facing run finds the bug.
//
// What it catches:      wiring, empty results, a finding that changes
//                       category or dollar figure unexpectedly, and — with
//                       --compare — an extraction that drifts from what the
//                       source documents actually say.
// What it cannot catch: a misunderstanding of the documents themselves. The
//                       default fixtures are hand-authored extractions, so if
//                       the audit misreads what a field means, the fixture
//                       agrees with it by construction. Only a real
//                       extraction, run through --compare, tests that half —
//                       and that needs a live model call (see
//                       scripts/live-test-insurance.js).
//
// Usage:
//   node scripts/insurance-audit-harness.js                    every named fixture
//   node scripts/insurance-audit-harness.js coverageCut         one, by name (substring)
//   node scripts/insurance-audit-harness.js --verbose            every finding, not just flags
//   node scripts/insurance-audit-harness.js --json                machine-readable
//   node scripts/insurance-audit-harness.js --compare <file.json> a captured extraction
//     ({renewal, prior_policy}, the shape api/_lib/insurance-extract.js
//     returns) diffed field-by-field against the ground truth in
//     tests/fixtures/insurance-fixtures.js's homeCoverageCutBehindTheRise(),
//     the same scenario scripts/make-test-documents.js prints onto the two
//     insurance PDFs. Run scripts/live-test-insurance.js first to produce one.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { runInsuranceAudit, rankFindings, Category } = require('../api/_lib/insurance-audit');
const FIXTURES = require('../tests/fixtures/insurance-fixtures');

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const asJson = args.includes('--json');
const compareIdx = args.indexOf('--compare');
const comparePath = compareIdx !== -1 ? args[compareIdx + 1] : null;
const filter = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--compare');

function loadNamedFixtures() {
  return Object.entries(FIXTURES)
    .filter(([name]) => !filter || name.toLowerCase().includes(filter.toLowerCase()))
    .map(([name, build]) => ({ name, ...build() }));
}

function runOne(fx) {
  const started = Date.now();
  let result, error = null;
  try {
    result = runInsuranceAudit(fx);
  } catch (err) {
    error = err;
    result = { findings: [], skipped: [], checksRun: 0, checksTotal: 0, comparisonAvailable: false };
  }
  return {
    name: fx.name,
    ms: Date.now() - started,
    error: error ? `${error.message}\n${(error.stack || '').split('\n')[1] || ''}` : null,
    findings: rankFindings(result.findings),
    skipped: result.skipped,
    checksRun: result.checksRun,
    checksTotal: result.checksTotal,
    comparisonAvailable: result.comparisonAvailable,
  };
}

function printOne(r) {
  const bar = '='.repeat(72);
  console.log(`\n${bar}\n${r.name}\n${bar}`);

  if (r.error) {
    console.log(`  THREW: ${r.error}`);
    return;
  }

  console.log(`  comparison ${r.comparisonAvailable ? 'ran' : 'DID NOT RUN'}`
    + `   checks ${r.checksRun}/${r.checksTotal}`
    + `   findings ${r.findings.length}`);

  const flagged = r.findings.filter((f) => f.category !== Category.WITHIN_NORMS);
  const shown = verbose ? r.findings : flagged;
  if (!shown.length) {
    console.log('  no flagged findings');
  } else {
    for (const f of shown) {
      const impact = f.dollarImpact !== null && f.dollarImpact !== undefined
        ? `  $${Number(f.dollarImpact).toLocaleString('en-US')}` : '';
      console.log(`  [${f.category}]${impact}  ${f.checkId}\n      ${f.title}`);
      if (verbose && f.basis) console.log(`      basis: ${f.basis.slice(0, 160)}`);
    }
  }

  if (r.skipped.length) console.log(`  skipped: ${r.skipped.join('; ')}`);

  // The check most likely to be silently wrong, called out every run: a
  // coverage-gap finding buried behind a savings-shaped one would defeat the
  // whole reason coverage_gap outranks everything else.
  const ranks = r.findings.map((f) => f.category);
  const firstGap = ranks.indexOf(Category.COVERAGE_GAP);
  const firstChallenge = ranks.indexOf(Category.WORTH_CHALLENGING);
  if (firstGap !== -1 && firstChallenge !== -1 && firstGap > firstChallenge) {
    console.log('  ATTENTION: a coverage_gap finding sorted BEHIND a worth_challenging one');
  }
}

// --- diff mode ---------------------------------------------------------

const DIFF_FIELDS = {
  scalar: ['carrier_name', 'policy_period_start', 'policy_period_end', 'premium_total', 'renewal_prior_premium_stated'],
  coverages: ['category', 'limit'],
  deductibles: ['applies_to', 'amount'],
  discounts_applied: null, // plain string array, compared as a set
  exclusions_endorsements: ['label', 'kind'],
};

function byKey(list, keyFields) {
  const map = new Map();
  for (const item of list || []) {
    const key = keyFields.map((k) => item && item[k]).join('|');
    map.set(key, item);
  }
  return map;
}

function diffSnapshot(label, truth, actual, out) {
  if (!actual) {
    out.push(`${label}: MISSING ENTIRELY from the extraction`);
    return;
  }
  for (const field of DIFF_FIELDS.scalar) {
    const t = truth[field];
    const a = actual[field];
    if (t === undefined) continue;
    if (String(t) !== String(a === undefined ? null : a)) {
      out.push(`${label}.${field}: expected ${JSON.stringify(t)}, got ${JSON.stringify(a)}`);
    }
  }
  if (Array.isArray(truth.coverages)) {
    const truthMap = byKey(truth.coverages, ['category']);
    const actualMap = byKey(actual.coverages, ['category']);
    for (const [key, t] of truthMap) {
      const a = actualMap.get(key);
      if (!a) { out.push(`${label}.coverages[${key}]: missing from extraction (expected limit ${t.limit})`); continue; }
      if (Number(a.limit) !== Number(t.limit)) {
        out.push(`${label}.coverages[${key}].limit: expected ${t.limit}, got ${a.limit}`);
      }
    }
  }
  if (Array.isArray(truth.deductibles)) {
    const truthMap = byKey(truth.deductibles, ['applies_to']);
    const actualMap = byKey(actual.deductibles, ['applies_to']);
    for (const [key, t] of truthMap) {
      const a = actualMap.get(key);
      if (!a) { out.push(`${label}.deductibles[${key}]: missing from extraction (expected ${t.amount})`); continue; }
      if (Number(a.amount) !== Number(t.amount)) {
        out.push(`${label}.deductibles[${key}].amount: expected ${t.amount}, got ${a.amount}`);
      }
    }
  }
  if (Array.isArray(truth.discounts_applied)) {
    const norm = (s) => String(s).toLowerCase().trim();
    const truthSet = new Set(truth.discounts_applied.map(norm));
    const actualSet = new Set((actual.discounts_applied || []).map(norm));
    for (const d of truthSet) if (!actualSet.has(d)) out.push(`${label}.discounts_applied: missing "${d}"`);
    for (const d of actualSet) if (!truthSet.has(d)) out.push(`${label}.discounts_applied: unexpected "${d}"`);
  }
  if (Array.isArray(truth.exclusions_endorsements)) {
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const truthMap = new Map(truth.exclusions_endorsements.map((e) => [norm(e.label), e]));
    const actualMap = new Map((actual.exclusions_endorsements || []).map((e) => [norm(e.label), e]));
    for (const [key, t] of truthMap) {
      const a = actualMap.get(key);
      if (!a) { out.push(`${label}.exclusions_endorsements: missing "${t.label}" (${t.kind})`); continue; }
      if (a.kind !== t.kind) out.push(`${label}.exclusions_endorsements["${t.label}"].kind: expected ${t.kind}, got ${a.kind}`);
    }
    for (const [key, a] of actualMap) {
      if (!truthMap.has(key)) out.push(`${label}.exclusions_endorsements: unexpected "${a.label}" (not on the source document)`);
    }
  }
}

function runCompare(capturedPath) {
  const truth = FIXTURES.homeCoverageCutBehindTheRise();
  let captured;
  try {
    captured = JSON.parse(fs.readFileSync(path.resolve(capturedPath), 'utf8'));
  } catch (err) {
    console.error(`Could not read/parse ${capturedPath}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Comparing ${capturedPath} against homeCoverageCutBehindTheRise() — the ground truth`);
  console.log(`printed onto tmp-test-docs/insurance-renewal-notice.pdf and insurance-prior-policy.pdf.\n`);

  const diffs = [];
  diffSnapshot('renewal', truth.renewal, captured.renewal, diffs);
  diffSnapshot('prior_policy', truth.prior_policy, captured.prior_policy, diffs);

  if (!diffs.length) {
    console.log('EXTRACTION MATCHES GROUND TRUTH FIELD FOR FIELD.');
  } else {
    console.log(`${diffs.length} field(s) differ from ground truth:\n`);
    diffs.forEach((d) => console.log(`  · ${d}`));
  }

  console.log('\n--- what the deterministic audit makes of the captured extraction ---');
  printOne(runOne({ name: '(captured extraction)', ...captured }));

  console.log('\n--- what it should have made of it (ground truth) ---');
  printOne(runOne({ name: '(ground truth)', ...truth }));
}

// --- entry ---------------------------------------------------------------

if (comparePath) {
  runCompare(comparePath);
} else {
  const fixtures = loadNamedFixtures();
  if (!fixtures.length) {
    console.error(`No fixtures in tests/fixtures/insurance-fixtures.js matching "${filter}".`);
    process.exit(1);
  }
  const results = fixtures.map(runOne);
  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    results.forEach(printOne);
    const threw = results.filter((r) => r.error).length;
    const flagged = results.reduce(
      (a, r) => a + r.findings.filter((f) => f.category !== Category.WITHIN_NORMS).length, 0,
    );
    console.log(`\n${'='.repeat(72)}`);
    console.log(`${results.length} fixtures, ${flagged} flagged findings, ${threw} threw`);
    if (threw) console.log('Run with --verbose for the full picture.');
  }
  process.exitCode = results.some((r) => r.error) ? 1 : 0;
}
