// The HOA Risk Score is computed, not chosen.
//
// It used to be a schema enum the model filled in. No scoring function existed
// anywhere in the engine, so two runs on the same package could disagree and
// nothing would notice — on the field the page sells first, the field the
// customer reads first, and the field somebody may waive a contingency on.
//
// Every threshold asserted below is one the rubric already stated to the model
// in prose. Computing it does not introduce a new opinion about HOAs; it makes
// the existing one executable, reproducible, and checkable by the customer.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scoreRisk, applyComputedRiskScore, RISK_LEVELS } = require('../api/_lib/hoa-engine');

const NO_SIGNALS = {
  unit_count: -1,
  delinquency_rate_pct: -1,
  annual_dues_per_unit: -1,
  special_assessment_announced: false,
  association_borrowing: false,
  material_litigation: false,
  insurance_red_flag: false,
  largest_component_due_months: -1,
  largest_component_cost: -1,
  reserve_study_year: -1,
  evidence_ids: [],
};

// A healthy association: 82% funded, funding its study in full.
function healthy(overrides = {}) {
  return Object.assign({
    risk_score: 'Moderate',
    headline_tag: 'Moderate risk',
    risk_signals: { ...NO_SIGNALS },
    reserve_health: {
      percent_funded: '82%',
      reserve_balance: '$1,500,000',
      fully_funded_balance: '$1,830,000',
      annual_contribution: '$198,000',
      recommended_contribution: '$198,000',
      assessment: '',
      citations: [],
    },
    short_term_risk: { likelihood: 'Unlikely' },
    mid_term_risk: { likelihood: 'Unlikely' },
  }, overrides);
}

const withSignals = (extra) => healthy({ risk_signals: { ...NO_SIGNALS, ...extra } });

const withReserves = (rh) => healthy({
  reserve_health: Object.assign({
    percent_funded: '', reserve_balance: '', fully_funded_balance: '',
    annual_contribution: '', recommended_contribution: '', assessment: '', citations: [],
  }, rh),
});

// --- the bands --------------------------------------------------------------

test('a well funded association fully funding its study scores Low', () => {
  const { score, computed, basis } = scoreRisk(healthy());
  assert.equal(score, 'Low');
  assert.equal(computed, true);
  assert.match(basis, /82% funded/);
  assert.match(basis, /recommendation in full/);
});

test('reserves at 45% funded score Moderate', () => {
  const { score } = scoreRisk(withReserves({
    reserve_balance: '$823,500', fully_funded_balance: '$1,830,000',
    annual_contribution: '$198,000', recommended_contribution: '$198,000',
  }));
  assert.equal(score, 'Moderate');
});

test('reserves below 30% funded score High', () => {
  const { score, basis } = scoreRisk(withReserves({
    reserve_balance: '$450,000', fully_funded_balance: '$1,830,000',
    annual_contribution: '$84,000', recommended_contribution: '$84,000',
  }));
  assert.equal(score, 'High');
  assert.match(basis, /widely treated as weak/);
});

test('reserves below 15% funded score Critical', () => {
  const { score } = scoreRisk(withReserves({
    reserve_balance: '$200,000', fully_funded_balance: '$1,830,000',
    annual_contribution: '$84,000', recommended_contribution: '$84,000',
  }));
  assert.equal(score, 'Critical');
});

// --- the hard signals -------------------------------------------------------

test('an announced special assessment is Critical regardless of how healthy the reserves look', () => {
  const { score, basis } = scoreRisk(withSignals({ special_assessment_announced: true }));
  assert.equal(score, 'Critical');
  assert.match(basis, /already been levied or formally announced/);
});

// The figures here are the real ones from the HOA report audited on 8 Sep: a
// $960,000 roof against a reserve fund that reaches $580,000 by the
// replacement year. Percent funded stays healthy on its own — the point of the
// rule is that a healthy percentage means nothing when one bill exceeds the
// whole fund.
const roofAhead = (cost) => healthy({
  risk_signals: { ...NO_SIGNALS, largest_component_due_months: 9, largest_component_cost: cost },
  reserve_health: {
    percent_funded: '83%',
    reserve_balance: '$580,000',
    fully_funded_balance: '$700,000',
    annual_contribution: '$84,000',
    recommended_contribution: '$84,000',
    assessment: '',
    citations: [],
  },
});

test('a major component due inside 12 months costing more than the whole reserve balance is Critical', () => {
  const { score, basis } = scoreRisk(roofAhead(960000));
  assert.equal(score, 'Critical');
  assert.match(basis, /above the entire reserve balance/);
});

test('the same component due inside 12 months but affordable from reserves is not Critical', () => {
  assert.equal(scoreRisk(roofAhead(250000)).score, 'Low');
});

test('borrowing raises to High', () => {
  assert.equal(scoreRisk(withSignals({ association_borrowing: true })).score, 'High');
});

test('material litigation raises to High', () => {
  assert.equal(scoreRisk(withSignals({ material_litigation: true })).score, 'High');
});

test('delinquency above 10% raises to Moderate', () => {
  const { score, basis } = scoreRisk(withSignals({ delinquency_rate_pct: 14 }));
  assert.equal(score, 'Moderate');
  assert.match(basis, /14%/);
});

test('an insurance red flag raises to Moderate', () => {
  assert.equal(scoreRisk(withSignals({ insurance_red_flag: true })).score, 'Moderate');
});

test('underfunding against the study raises to Moderate and names the shortfall', () => {
  const { score, basis } = scoreRisk(withReserves({
    reserve_balance: '$1,500,000', fully_funded_balance: '$1,830,000',
    annual_contribution: '$84,000', recommended_contribution: '$198,000',
  }));
  assert.equal(score, 'Moderate');
  assert.match(basis, /\$114,000 a year below/);
});

test('a likelihood of "Already announced" in the 12-month read is Critical', () => {
  const report = healthy({ short_term_risk: { likelihood: 'Already announced' } });
  assert.equal(scoreRisk(report).score, 'Critical');
});

test('the worst signal wins when several fire', () => {
  const report = healthy({
    risk_signals: { ...NO_SIGNALS, delinquency_rate_pct: 14, association_borrowing: true, special_assessment_announced: true },
  });
  const { score, basis } = scoreRisk(report);
  assert.equal(score, 'Critical');
  // and the basis still names every one of them, because the customer is owed
  // the whole picture, not just the rule that happened to top out.
  assert.match(basis, /delinquency/);
  assert.match(basis, /borrowing/);
});

// --- refusing to score on nothing -------------------------------------------

test('a package establishing nothing does not earn a Low score by default', () => {
  const bare = {
    risk_score: 'Moderate',
    risk_signals: null,
    reserve_health: {},
    short_term_risk: {},
    mid_term_risk: {},
  };
  const { score, computed, basis } = scoreRisk(bare);
  assert.equal(computed, false);
  assert.equal(score, 'Moderate', 'falls back to the analytical read rather than inventing a clean score');
  assert.match(basis, /do not establish/);
});

test('an unrecognised model score falls back to "Cannot assess", never to Low', () => {
  const bare = { risk_score: 'Excellent', risk_signals: null, reserve_health: {} };
  const { score } = scoreRisk(bare);
  assert.equal(score, 'Cannot assess');
  assert.ok(!RISK_LEVELS.includes(score));
});

// --- applying it ------------------------------------------------------------

test('the computed score overwrites the model’s and the badge follows it', () => {
  const report = healthy({ risk_score: 'Low', headline_tag: 'Low risk' });
  report.reserve_health.reserve_balance = '$450,000';
  report.reserve_health.fully_funded_balance = '$1,830,000';

  const result = applyComputedRiskScore(report);

  assert.equal(report.risk_score, 'High');
  assert.equal(report.headline_tag, 'High risk', 'the badge must not keep saying something the score no longer says');
  assert.equal(result.stated, 'Low');
  assert.equal(result.diverged, true, 'a divergence is recorded so it can be logged and reviewed');
  assert.equal(report.risk_score_computed, true);
  assert.match(report.risk_score_basis, /Scored High because/);
});

test('a badge that never named a level is left alone', () => {
  const report = healthy({ headline_tag: 'Reserves are thin' });
  applyComputedRiskScore(report);
  assert.equal(report.headline_tag, 'Reserves are thin');
});

test('when nothing can be computed the badge is not rewritten', () => {
  const report = { risk_score: 'Moderate', headline_tag: 'Moderate risk', risk_signals: null, reserve_health: {} };
  applyComputedRiskScore(report);
  assert.equal(report.risk_score, 'Moderate');
  assert.equal(report.risk_score_computed, false);
});

// --- caveats the engine knows and the write-up may not have said ------------
//
// missing_or_uncertain is required by the schema, and a reassuring write-up is
// exactly the kind of thing to leave it empty. These are limits the engine can
// establish from signals it already collected.

const { hoaCaveats } = require('../api/_lib/hoa-engine');
const NOW = new Date(Date.UTC(2026, 8, 13));

const withRestrictions = (rx, signals = {}) => ({
  risk_signals: { ...NO_SIGNALS, unit_count: 84, reserve_study_year: 2025, ...signals },
  restrictions: Object.assign({
    leasing: { restricted: 'No restriction found' },
    fees_at_closing: [{ label: 'Capital contribution', amount: '$1,200' }],
    use_restrictions: [],
    financeability: {},
  }, rx),
});

test('a reserve study older than three years is called out by name and age', () => {
  const caveats = hoaCaveats(withRestrictions({}, { reserve_study_year: 2019 }), NOW);
  const stale = caveats.find((c) => /reserve study is from/.test(c));
  assert.ok(stale, 'a stale study must be flagged — every reserve figure is drawn from it');
  assert.match(stale, /2019/);
  assert.match(stale, /about 7 years old/);
  assert.match(stale, /Replacement costs/);
});

test('a recent reserve study raises no caveat', () => {
  const caveats = hoaCaveats(withRestrictions({}, { reserve_study_year: 2025 }), NOW);
  assert.ok(!caveats.some((c) => /reserve study is from/.test(c)));
});

test('three years old is not yet stale', () => {
  // The boundary matters: flagging a study that is still current would train
  // the reader to discount the caveat when it is real.
  assert.ok(!hoaCaveats(withRestrictions({}, { reserve_study_year: 2023 }), NOW)
    .some((c) => /reserve study is from/.test(c)));
  assert.ok(hoaCaveats(withRestrictions({}, { reserve_study_year: 2022 }), NOW)
    .some((c) => /reserve study is from/.test(c)));
});

test('leasing that could not be checked is a gap in the package, stated as one', () => {
  const caveats = hoaCaveats(withRestrictions({
    leasing: { restricted: 'Not addressed in the documents provided' },
  }), NOW);
  const leasing = caveats.find((c) => /leasing restrictions could not be checked/.test(c));
  assert.ok(leasing);
  assert.match(leasing, /declaration, the bylaws or the resale certificate/);
});

test('no fees found is not reported as an assurance there are none', () => {
  const caveats = hoaCaveats(withRestrictions({ fees_at_closing: [] }), NOW);
  const fees = caveats.find((c) => /capital contribution, transfer fee/i.test(c));
  assert.ok(fees);
  assert.match(fees, /not the same as an assurance/);
});

test('an unknown unit count undermines every per-unit figure, and says so', () => {
  const caveats = hoaCaveats(withRestrictions({}, { unit_count: -1 }), NOW);
  assert.ok(caveats.some((c) => /unit count could not be established/.test(c)));
});

test('a complete package with a current study raises only the fee caveat', () => {
  const caveats = hoaCaveats(withRestrictions({}), NOW);
  assert.deepEqual(caveats, [], 'nothing to flag when every signal is present and current');
});
