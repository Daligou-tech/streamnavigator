// The checks that make Property Tax Navigator a comparison rather than an
// opinion.
//
// docs/PROPERTY-TAX-AUDIT.md is the reason this engine exists: the page
// promised "the specific comparable properties used as evidence" and "AI
// pulls comparable properties," while the prompt behind it said the exact
// opposite in its own words — no live MLS or assessor database exists here.
// Every test below pins a known answer computed by hand, using only
// arithmetic on figures a customer would actually supply.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../navigator-property-tax-engine');
const { Category } = E;

const find = (findings, id) => findings.filter((f) => f.checkId === id);
const one = (findings, id) => {
  const hits = find(findings, id);
  assert.equal(hits.length, 1, `expected exactly one ${id}, got ${hits.length}`);
  return hits[0];
};

// --- factual error always leads -----------------------------------------

test('a factual error leads the ranked findings ahead of a large dollar increase', () => {
  const { findings } = E.analyze({
    prior_assessed_value: 300000, new_assessed_value: 500000,
    physical_changes: false, factual_errors: true,
    factual_errors_notes: 'Notice lists 4 bedrooms; the house has 3.',
  });
  assert.equal(findings[0].checkId, 'FACTUAL_ERROR_ON_NOTICE');
  assert.equal(findings[0].category, Category.FACTUAL_ERROR);
  assert.match(findings[0].basis, /3 bedrooms|4 bedrooms/);
});

// --- year-over-year trend, with and without a reported justification -----

test('a material rise with no reported property change is worth appealing', () => {
  const { findings } = E.analyze({
    prior_assessed_value: 300000, new_assessed_value: 360000,
    physical_changes: false, factual_errors: false, tax_rate_pct: 1.2,
  });
  const f = one(findings, 'ASSESSMENT_ROSE_NO_CHANGE_REPORTED');
  assert.equal(f.category, Category.WORTH_APPEALING);
  assert.equal(f.dollarImpact, 720, '$60,000 increase at a 1.2% rate');
});

test('a material rise alongside a reported renovation is likely justified', () => {
  const { findings } = E.analyze({
    prior_assessed_value: 300000, new_assessed_value: 360000,
    physical_changes: true, physical_changes_notes: 'Added a 400 sq ft addition in 2025.',
    factual_errors: false,
  });
  const f = one(findings, 'ASSESSMENT_ROSE_WITH_IMPROVEMENT');
  assert.equal(f.category, Category.LIKELY_JUSTIFIED);
  assert.match(f.basis, /addition/);
});

test('a change under the materiality threshold is reported, not treated as worth acting on', () => {
  const { findings } = E.analyze({
    prior_assessed_value: 300000, new_assessed_value: 306000, // 2%
    physical_changes: false, factual_errors: false,
  });
  const f = one(findings, 'ASSESSMENT_CHANGE_IMMATERIAL');
  assert.equal(f.category, Category.WITHIN_NORMS);
});

test('an assessment that fell is reported as good news, not a finding to act on', () => {
  const { findings } = E.analyze({
    prior_assessed_value: 300000, new_assessed_value: 280000,
    physical_changes: false, factual_errors: false,
  });
  const f = one(findings, 'ASSESSMENT_FELL');
  assert.equal(f.category, Category.WITHIN_NORMS);
});

// --- comparables are arithmetic on the customer's OWN supplied figures ---

test('an assessment above the customer\'s own supplied comparables is worth appealing, citing them', () => {
  const { findings } = E.analyze({
    new_assessed_value: 400000,
    comparables: [
      { address: '12 Oak St', assessed_value: 340000 },
      { address: '14 Oak St', assessed_value: 350000 },
    ],
    physical_changes: false, factual_errors: false, tax_rate_pct: 1.2,
  });
  const f = one(findings, 'ABOVE_OWN_COMPARABLES');
  assert.equal(f.category, Category.WORTH_APPEALING);
  assert.match(f.basis, /2 comparable properties/);
  assert.match(f.basis, /\$345,000|345,000/, 'the average of the customer\'s own two comps must be cited');
  assert.equal(f.dollarImpact, 660, '$55,000 excess over the $345,000 average at a 1.2% rate');
});

test('a comparables finding carries no dollar impact when no tax rate was supplied', () => {
  const { findings } = E.analyze({
    new_assessed_value: 400000,
    comparables: [{ address: '12 Oak St', assessed_value: 340000 }],
    physical_changes: false, factual_errors: false,
  });
  const f = one(findings, 'ABOVE_OWN_COMPARABLES');
  assert.equal(f.dollarImpact, null);
});

test('no comparable finding is produced when the assessment is in line with the customer\'s own comps', () => {
  const { findings } = E.analyze({
    new_assessed_value: 350000,
    comparables: [{ address: '12 Oak St', assessed_value: 345000 }],
    physical_changes: false, factual_errors: false,
  });
  assert.equal(find(findings, 'ABOVE_OWN_COMPARABLES').length, 0);
});

// --- no baseline, no comparison -----------------------------------------

test('with no prior value, no comparables, and no factual error, the comparison is refused rather than guessed at', () => {
  const { findings, hasBaseline } = E.analyze({
    new_assessed_value: 400000, physical_changes: false, factual_errors: false,
  });
  assert.equal(hasBaseline, false);
  const f = one(findings, 'COMPARISON_NOT_POSSIBLE');
  assert.equal(f.category, Category.REQUIRES_DOCUMENTATION);
});

test('a factual error alone counts as a baseline, even with no prior value or comparables', () => {
  const { hasBaseline } = E.analyze({
    new_assessed_value: 400000, physical_changes: false, factual_errors: true,
  });
  assert.equal(hasBaseline, true);
});

// --- the vocabulary itself never reaches for an invented comparable ------

test('no finding, in any scenario, ever states a comparable property this engine did not receive', () => {
  const scenarios = [
    { prior_assessed_value: 300000, new_assessed_value: 360000, physical_changes: false, factual_errors: false },
    { new_assessed_value: 400000, comparables: [{ address: '1 Elm St', assessed_value: 340000 }], physical_changes: false, factual_errors: false },
    { new_assessed_value: 400000, physical_changes: false, factual_errors: true, factual_errors_notes: 'wrong lot size' },
  ];
  for (const s of scenarios) {
    const { findings } = E.analyze(s);
    for (const f of findings) {
      const text = [f.title, f.basis, f.recommendedAction].join(' ');
      assert.doesNotMatch(text, /typical|comparable sale|MLS|market data/i);
    }
  }
});

// --- sufficiency gate ----------------------------------------------------

test('a completely empty submission is insufficient on every required field', () => {
  const s = E.checkSufficiency({});
  assert.equal(s.sufficient, false);
  assert.deepEqual(
    s.missing.map((m) => m.key).sort(),
    ['baseline', 'factual_errors', 'new_assessed_value', 'physical_changes'],
  );
});

test('current value plus a prior value plus both booleans answered is NOT sufficient without a tax rate', () => {
  const s = E.checkSufficiency({
    new_assessed_value: 360000, prior_assessed_value: 300000,
    physical_changes: false, factual_errors: false,
  });
  assert.equal(s.sufficient, false);
  assert.deepEqual(s.missing.map((m) => m.key), ['tax_rate_pct']);
});

test('current value plus a prior value plus both booleans plus a tax rate is sufficient', () => {
  const s = E.checkSufficiency({
    new_assessed_value: 360000, prior_assessed_value: 300000,
    physical_changes: false, factual_errors: false, tax_rate_pct: 1.2,
  });
  assert.equal(s.sufficient, true);
});

test('comparables count as a numeric baseline that also requires a tax rate', () => {
  const s = E.checkSufficiency({
    new_assessed_value: 400000,
    comparables: [{ address: '12 Oak St', assessed_value: 340000 }],
    physical_changes: false, factual_errors: false,
  });
  assert.equal(s.sufficient, false);
  assert.deepEqual(s.missing.map((m) => m.key), ['tax_rate_pct']);
});

test('current value plus a factual-error flag is sufficient, with no prior value or tax rate needed', () => {
  const s = E.checkSufficiency({
    new_assessed_value: 360000, physical_changes: false, factual_errors: true,
  });
  assert.equal(s.sufficient, true);
});
