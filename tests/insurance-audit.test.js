// The checks that make Insurance Navigator a comparison rather than an
// opinion.
//
// docs/INSURANCE-AUDIT.md is the reason this engine exists: the product ran
// on a single model call asked to judge whether a renewal "looks typical",
// with no rate data anywhere in this codebase to back that judgement — the
// same unverifiable claim this codebase's own audits had already found and
// banned on Home Savings and Government Money. Every test below pins a known
// answer computed by hand from the fixture, the same discipline
// rental-audit.test.js and landlord's tests already apply.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runInsuranceAudit, Category, EvidenceKind, Actionability, MATERIAL_CHANGE_THRESHOLD,
} = require('../api/_lib/insurance-audit');

const {
  homeCoverageCutBehindTheRise,
  autoMoreCoverageBehindTheRise,
  premiumRoseUnexplained,
  premiumFlat,
  renewalOnlyNoBaseline,
  renewalOnlyWithStatedPriorPremium,
} = require('./fixtures/insurance-fixtures');

const find = (result, id) => result.findings.filter((f) => f.checkId === id);
const one = (result, id) => {
  const hits = find(result, id);
  assert.equal(hits.length, 1, `expected exactly one ${id}, got ${hits.length}`);
  return hits[0];
};

// --- no ungrounded "typical" claim exists anywhere in the vocabulary --------

test('the engine has no market or "typical" evidence kind to reach for', () => {
  const values = Object.values(EvidenceKind);
  assert.ok(!values.some((v) => /typical|market/i.test(v)),
    `EvidenceKind must never carry a market-comparison kind, found: ${values.join(', ')}`);
});

// --- coverage cut behind a premium rise: every coverage-gap path fires -----

test('a reduced dwelling limit behind a premium rise is the coverage-gap headline, not a savings finding', () => {
  const result = runInsuranceAudit(homeCoverageCutBehindTheRise());
  const headline = one(result, 'PREMIUM_ROSE_COVERAGE_DECREASED');
  assert.equal(headline.category, Category.WORTH_CHALLENGING);
  assert.equal(headline.dollarImpact, 300, '$2,300 renewal minus $2,000 prior');

  const reduced = one(result, 'COVERAGE_LIMIT_REDUCED');
  assert.equal(reduced.category, Category.COVERAGE_GAP);
  assert.equal(reduced.dollarImpact, -30000, '$310,000 minus $340,000');
  assert.equal(reduced.evidence, EvidenceKind.INTERNAL_ARITHMETIC);

  // Coverage gaps rank ahead of the premium finding, however large the dollar
  // figure on the premium finding is — a lapsed limit is a protection risk,
  // not a savings opportunity, and the ranking has to say so.
  assert.equal(result.findings[0].checkId, 'COVERAGE_LIMIT_REDUCED');
});

test('a deductible that rose with no offsetting premium drop is worth challenging on its own', () => {
  const result = runInsuranceAudit(homeCoverageCutBehindTheRise());
  const f = one(result, 'DEDUCTIBLE_INCREASED');
  assert.equal(f.category, Category.WORTH_CHALLENGING);
  assert.equal(f.dollarImpact, 1000, '$2,500 minus $1,500');
  assert.equal(f.actionability, Actionability.ASK_INSURER);
});

test('a discount present last term and absent this term is named, not silently dropped', () => {
  const result = runInsuranceAudit(homeCoverageCutBehindTheRise());
  const f = one(result, 'DISCOUNT_DROPPED');
  assert.equal(f.category, Category.WORTH_CHALLENGING);
  assert.match(f.basis, /Multi-Policy Discount/);
  // The discount that survived on both documents must not be reported as
  // dropped.
  assert.doesNotMatch(f.basis, /Autopay Discount/);
});

test('a new exclusion on the renewal is a coverage gap regardless of which way the premium moved', () => {
  const result = runInsuranceAudit(homeCoverageCutBehindTheRise());
  const f = one(result, 'NEW_EXCLUSION_ADDED');
  assert.equal(f.category, Category.COVERAGE_GAP);
  assert.match(f.title, /Water Backup/);
  // An endorsement present on both documents must never be reported dropped.
  assert.equal(find(result, 'ENDORSEMENT_DROPPED').length, 0);
});

// --- a premium rise the documents actually explain is likely justified -----

test('a premium rise behind genuinely more coverage is likely justified, never worth-challenging', () => {
  const result = runInsuranceAudit(autoMoreCoverageBehindTheRise());
  const f = one(result, 'PREMIUM_ROSE_COVERAGE_INCREASED');
  assert.equal(f.category, Category.LIKELY_JUSTIFIED);
  assert.equal(f.dollarImpact, 240, '$1,380 minus $1,140');
  assert.match(f.basis, /100,000.*250,000|250,000.*100,000/,
    'the raised bodily injury limit must be cited by figure');
  // No coverage-gap or worth-challenging finding should appear alongside it —
  // this scenario has nothing to challenge.
  assert.equal(result.findings.filter((x) => x.category === Category.COVERAGE_GAP).length, 0);
  assert.equal(result.findings.filter((x) => x.category === Category.WORTH_CHALLENGING).length, 0);
});

// --- a rise with nothing on the documents to explain it ---------------------

test('a material premium rise with no coverage or deductible change is the plain "ask why" case', () => {
  const result = runInsuranceAudit(premiumRoseUnexplained());
  const f = one(result, 'PREMIUM_ROSE_NO_COVERAGE_CHANGE');
  assert.equal(f.category, Category.WORTH_CHALLENGING);
  assert.equal(f.dollarImpact, 150, '$1,650 minus $1,500');
  assert.equal(result.findings.length, 1, 'nothing else changed, so nothing else should be reported');
});

// --- materiality floor is a disclosed threshold, not a market claim --------

test('a premium change under the materiality floor is reported, not treated as a finding worth acting on', () => {
  const result = runInsuranceAudit(premiumFlat());
  const f = one(result, 'PREMIUM_CHANGE_IMMATERIAL');
  assert.equal(f.category, Category.WITHIN_NORMS);
  assert.equal(f.dollarImpact, 20);
  assert.match(f.basis, new RegExp(`${MATERIAL_CHANGE_THRESHOLD * 100}%`));
  assert.equal(f.actionability, Actionability.NONE);
});

// --- no baseline, no comparison — the core promise cannot run ---------------

test('with no prior policy and no stated prior premium, the comparison is refused rather than guessed at', () => {
  const result = runInsuranceAudit(renewalOnlyNoBaseline());
  assert.equal(result.comparisonAvailable, false);
  const f = one(result, 'COMPARISON_NOT_POSSIBLE');
  assert.equal(f.category, Category.REQUIRES_DOCUMENTATION);
  assert.equal(result.checksRun, 0);
  assert.equal(result.skipped.length, 5, 'every check is named as skipped, not silently omitted');
  assert.equal(result.findings.length, 1, 'no other finding may be produced without a baseline');
});

test('a renewal notice that states its own prior premium lets the premium check run alone', () => {
  const result = runInsuranceAudit(renewalOnlyWithStatedPriorPremium());
  assert.equal(result.comparisonAvailable, true);
  assert.equal(result.priorPremiumSource, 'renewal_notice_stated');
  assert.equal(result.checksRun, 1, 'only the premium comparison could run without a prior-policy document');

  const f = one(result, 'PREMIUM_ROSE_NO_COVERAGE_CHANGE');
  assert.equal(f.dollarImpact, 322, '$1,932 minus $1,610');
  assert.match(f.basis, /renewal notice itself states/,
    'the customer must be told this baseline came from the renewal notice, not a second document');

  // Coverage, deductible, discount and exclusion checks could not run and
  // must say so by name rather than being silently absent.
  assert.ok(result.skipped.some((s) => /no prior policy was provided/.test(s)));
  assert.equal(result.findings.length, 1);
});

// --- ranking puts protection risk ahead of everything else -----------------

test('rankFindings via runInsuranceAudit already orders coverage gaps before worth-challenging before within-norms', () => {
  const { rankFindings } = require('../api/_lib/insurance-audit');
  const result = runInsuranceAudit(homeCoverageCutBehindTheRise());
  const ranked = rankFindings(result.findings);
  const categories = ranked.map((f) => f.category);
  const firstWorthChallenging = categories.indexOf(Category.WORTH_CHALLENGING);
  const firstCoverageGap = categories.indexOf(Category.COVERAGE_GAP);
  assert.ok(firstCoverageGap < firstWorthChallenging,
    'coverage-gap findings must sort ahead of worth-challenging findings');
});
