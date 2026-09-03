// Run: node test/section-benchmark.test.js
'use strict';

const assert = require('assert');
const { checkSectionTotals } = require('../api/_lib/section-benchmark');
const { makeGetBenchmark } = require('../api/_lib/benchmark-corpus');
const { Severity } = require('../api/_lib/closing-audit');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push(`${name}\n    ${err.message.split('\n')[0]}`); }
}

const ROWS = [{
  id: 'hmda-2025-md-baltimore-city-300k-500k-origination',
  fee_category: 'origination_charges_total',
  kind: 'range',
  low: 3168, high: 4122, sample_size: 150,
  loan_band: '300k-500k', loan_band_label: '$300,000–$500,000',
  jurisdiction_type: 'county', state: 'MD', county: 'Baltimore City',
  evidence: 'market_norm:comparable_transactions',
  source_name: 'HMDA loan-level data, 2025, origination charges.',
  source_url: 'https://ffiec.cfpb.gov/data-browser/',
  effective_date: '2025-01-01', verified_at: '2026-09-02', stale_after_days: 760,
  exemption_note: 'Smaller lenders are partially exempt from reporting these fields.',
}];

const g = makeGetBenchmark(ROWS, { now: () => new Date('2026-09-02') });
const CTX = { state: 'MD', county: 'Baltimore City', loanAmount: 400000 };

const run = (A, ctx = CTX, gb = g) =>
  checkSectionTotals({ sectionTotals: { A }, getBenchmark: gb, ctx });

test('a total inside the spread is reported as in line, not as a finding', () => {
  const { findings } = run(3900);
  const f = findings.find((x) => x.checkId === 'SECTION_TOTAL_ORIGINATION');
  assert.strictEqual(f.severity, Severity.WITHIN_NORMS);
});

test('a total below the spread never produces a finding', () => {
  const { findings } = run(500);
  const f = findings.find((x) => x.checkId === 'SECTION_TOTAL_ORIGINATION');
  assert.strictEqual(f.severity, Severity.WITHIN_NORMS);
});

test('a total above the spread is flagged and priced against the 90th percentile', () => {
  const { findings } = run(6000);
  const f = findings.find((x) => x.checkId === 'SECTION_TOTAL_ORIGINATION');
  assert.strictEqual(f.severity, Severity.ABOVE_BENCHMARK);
  assert.strictEqual(f.dollarImpact, 6000 - 4122);
});

test('the finding never claims the charge is wrong, an error or an overcharge', () => {
  const { findings } = run(6000);
  // Strip the disclaimers before testing. "unusual, not an error" is exactly
  // the wording we want, so a blanket search for "error" would fail the very
  // sentence that makes the finding safe. What must not appear is an ASSERTION.
  const text = JSON.stringify(findings).toLowerCase()
    .replace(/not an error/g, '')
    .replace(/not proof of an error/g, '');
  for (const re of [/\bovercharge/, /\btoo high\b/, /\bshould be\b/, /\bwrong\b/,
    /\berror\b/, /\bviolation\b/, /\billegal\b/, /\bentitled\b/, /\bjunk fee\b/]) {
    assert.ok(!re.test(text), `distribution finding uses forbidden language: ${re}`);
  }
  // And the disclaimer must actually be present.
  assert.ok(/not an error/.test(JSON.stringify(findings)), 'the caveat is missing');
});

test('the finding states the sample size and that it is a section total', () => {
  const { findings } = run(6000);
  const f = findings.find((x) => x.checkId === 'SECTION_TOTAL_ORIGINATION');
  assert.ok(/150 comparable loans/.test(f.basis), 'sample size not stated');
  assert.ok(/not any single fee/.test(f.whyItMatters), 'does not say it is a total');
  assert.ok(/not a rate anyone is\s+required to charge|not an error/.test(f.whyItMatters),
    'does not caveat that a spread is not a rule');
  assert.strictEqual(f.detail.sectionTotalOnly, true);
});

test('its severity can never exceed ABOVE_BENCHMARK', () => {
  for (const amount of [4123, 10000, 100000]) {
    const { findings } = run(amount);
    for (const f of findings) {
      assert.notStrictEqual(f.severity, Severity.CONFIRMED_MATH_ERROR);
      assert.notStrictEqual(f.severity, Severity.POTENTIAL_TRID_VIOLATION);
      assert.notStrictEqual(f.severity, Severity.POTENTIAL_OVERCHARGE);
    }
  }
});

test('a loan outside the band gets no comparison, and the skip names the total', () => {
  const { findings, skipped } = run(6000, { ...CTX, loanAmount: 200000 });
  assert.deepStrictEqual(findings, []);
  assert.ok(skipped.some((s) => /Origination charges/.test(s)), 'skip does not name it');
});

test('an ambiguous county gets no comparison rather than the wrong one', () => {
  const { findings } = run(6000, { ...CTX, county: 'Baltimore' });
  assert.deepStrictEqual(findings, []);
});

test('with no corpus at all it skips cleanly and names what it skipped', () => {
  const { findings, skipped } = run(6000, CTX, () => null);
  assert.deepStrictEqual(findings, []);
  assert.ok(skipped.length >= 1);
  assert.ok(skipped.every((s) => /Origination charges|Total loan costs/.test(s)));
});

test('an unreadable section total is skipped by name, not silently', () => {
  const { skipped } = checkSectionTotals({
    sectionTotals: {}, getBenchmark: g, ctx: CTX,
  });
  assert.ok(skipped.some((s) => /not readable/.test(s)));
});

test('a stale distribution stops answering', () => {
  const later = makeGetBenchmark(ROWS, { now: () => new Date('2029-01-01') });
  const { findings } = run(6000, CTX, later);
  assert.deepStrictEqual(findings, []);
});

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n${failures.length} of ${total} failed:\n`);
  failures.forEach((f) => console.error('  x ' + f + '\n'));
  process.exit(1);
}
console.log(`${passed}/${total} passed`);
