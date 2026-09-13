// The /buying customer journey, end to end, offline.
//
// Run: node tests/buying-journey.test.js
//
// Every other suite here tests a part. This one walks the path a paying
// customer actually takes — the pre-payment sufficiency gate, what reaches the
// must-have grader, the arithmetic, the partial-verification path, and what
// finally gets rendered — and checks the figures the customer would see.
//
// Nothing here calls Anthropic. Live report runs spend real credits and are
// closed, so the model's side is fixtures whose answers are worked out by hand
// in the comments and compared against independently. That independence is the
// point: BUYING-ENGINE-AUDIT.md records three defects that shipped clean-looking,
// fully-passing reports, two of which were only ever caught by reading the text
// of a real one. A check that asks the engine to confirm its own arithmetic
// would have passed on every one of them.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const rules = require('../navigator-buying-rules.js');
const { __internal: I } = require('../api/_lib/purchase-engine.js');

// A financed vehicle with two must-haves: the heaviest shape the engine
// handles, and the one the audit's open finding is about.
function vehicleForm() {
  return {
    category: 'vehicle',
    item_description: '2023 Ford F-150 XLT SuperCrew 2.7L EcoBoost',
    price_value: 47500,
    financing: 'financing',
    financing_term_months: 60,
    ownership_years: 6,
    location: '30301',
    timeline: 'this_month',
    must_have_features: 'must tow at least 7,000 lbs, and must have adaptive cruise control',
    condition: 'used',
    annual_mileage: 14000,
  };
}

// --- 1. nobody pays for a report that cannot be written ---------------------

test('the sufficiency gate accepts a complete submission and refuses a thin one', () => {
  assert.equal(rules.checkBuyingSufficiency('vehicle', vehicleForm()).sufficient, true);

  const noPrice = vehicleForm();
  delete noPrice.price_value;
  const refused = rules.checkBuyingSufficiency('vehicle', noPrice);
  assert.equal(refused.sufficient, false, 'a price is the one number everything else is built on');
  assert.ok(refused.missing.some((m) => m.key === 'price_value'), 'and the customer is told which field');

  assert.equal(rules.checkBuyingSufficiency('spaceship', vehicleForm()).sufficient, false,
    'an unknown category cannot be priced or compared');
});

test('the gate asks for a loan term only when there is a loan', () => {
  const cash = { ...vehicleForm(), financing: 'cash' };
  delete cash.financing_term_months;
  assert.equal(rules.checkBuyingSufficiency('vehicle', cash).sufficient, true);

  const financed = vehicleForm();
  delete financed.financing_term_months;
  assert.equal(rules.checkBuyingSufficiency('vehicle', financed).sufficient, false,
    'a price without a term cannot become an interest figure');
});

// --- 2. the requirement reaches the grader as the buyer wrote it ------------

test('a requirement survives intact on its way to the grader', () => {
  const frags = I.mustHaveFragments({ form_data: vehicleForm() });
  assert.deepEqual(frags, ['must tow at least 7,000 lbs', 'must have adaptive cruise control']);
  assert.ok(frags.every((f) => !/^\d{3}\b/.test(f)), 'no fragment is the tail of a split number');

  assert.deepEqual(
    I.mustHaveFragments({ form_data: { must_have_features: 'under $1,200 and at least 12,000 BTU' } }),
    ['under $1,200', 'at least 12,000 BTU'],
    'a comma inside a figure is not a list separator'
  );
  assert.equal(
    I.mustHaveFragments({ form_data: { must_have_features: 'internal ice maker, no external dispenser' } }).length,
    2,
    'a comma between requirements still is one'
  );
});

// --- 3. the arithmetic, re-derived by hand ---------------------------------
//
//   purchase      47,000 – 47,500
//   interest       9,600 – 11,700
//   running/yr     4,680 –  5,900   -> x6 = 28,080 – 35,400
//   resale       -17,000 – -13,000  (money back at the end)
//
//   low  = 47,000 +  9,600 + 28,080 - 17,000 = 67,680
//   high = 47,500 + 11,700 + 35,400 - 13,000 = 81,600

function costedReport() {
  return {
    total_cost_of_ownership: {
      time_horizon_years: 6,
      cost_breakdown: [
        { label: 'Purchase price', kind: 'purchase', low: 47000, high: 47500, per_year_low: 0, per_year_high: 0, basis: 'the quoted price' },
        { label: 'Interest over 60 months', kind: 'financing', low: 9600, high: 11700, per_year_low: 0, per_year_high: 0, basis: '7.5-9% APR on $47,500' },
        { label: 'Running costs', kind: 'running', low: 0, high: 0, per_year_low: 4680, per_year_high: 5900, basis: 'fuel, insurance and maintenance' },
        { label: 'Resale at year 6', kind: 'resale_recovery', low: -17000, high: -13000, per_year_low: 0, per_year_high: 0, basis: 'typical retained value' },
      ],
      explanation: 'Purchase plus interest and running costs, less what it is worth at the end.',
    },
    maintenance_running_costs: { annual_low: 4680, annual_high: 5900, explanation: 'Fuel, insurance and maintenance for a full-size crew cab.' },
    depreciation_resale: { resale_low: 13000, resale_high: 17000, expected_resale_note: 'roughly a third after six years', explanation: 'Full-size trucks hold value comparatively well.' },
  };
}

test('the printed total is the sum of its own line items', () => {
  const derived = I.deriveNumbers(costedReport());
  assert.equal(derived.total.low, 67680);
  assert.equal(derived.total.high, 81600);
  assert.deepEqual([derived.financingCost.low, derived.financingCost.high], [9600, 11700]);
  assert.deepEqual([derived.annual.low, derived.annual.high], [4680, 5900]);
  assert.equal(I.tcoArithmeticProblem(costedReport()), null);
});

test('a figure that disagrees with its own line item is caught', () => {
  const running = costedReport();
  running.maintenance_running_costs.annual_low = 999;
  assert.ok(I.tcoArithmeticProblem(running), 'per-year against the running line');

  const resale = costedReport();
  resale.depreciation_resale.resale_low = 3000;
  assert.ok(
    I.resaleProblem(resale, I.validBreakdown(resale.total_cost_of_ownership)),
    'resale against the recovery line'
  );
});

// --- 4. a graded requirement is never discarded ----------------------------

test('a partly graded verification reaches the report as what it is', () => {
  const submission = { id: 'journey', form_data: vehicleForm() };
  const frags = I.mustHaveFragments(submission);
  const graded = [{
    requirement: 'must tow at least 7,000 lbs',
    verdict: 'confirmed',
    finding: 'Rated 7,600 lbs without the towing package.',
    published_value: '7,600 lbs',
    source: 'manufacturer towing guide',
    measurement: { value: 7600, limit: 7000, unit: 'lbs', comparison: 'at_least' },
  }];

  const outstanding = I.pendingFragments(frags, { checks: graded });
  assert.deepEqual(outstanding, ['must have adaptive cruise control']);

  const checks = graded.concat(
    I.unverifiedChecks(submission).filter((c) => outstanding.includes(c.requirement))
  );
  assert.equal(checks.length, 2, 'the graded one and an honest placeholder');
  assert.equal(I.mustHaveProblem({ must_have_checks: checks }, submission), null,
    'and the coverage rule accepts that, so one unlookupable spec cannot cost the whole report');
});

test('the figures decide a spec verdict, not the model word for it', () => {
  const base = {
    requirement: 'must tow at least 7,000 lbs',
    finding: 'Rated 7,600 lbs.',
    published_value: '7,600 lbs',
    source: 'manufacturer towing guide',
  };

  const understated = [{ ...base, verdict: 'contradicted', measurement: { value: 7600, limit: 7000, unit: 'lbs', comparison: 'at_least' } }];
  assert.equal(I.applyMeasuredVerdicts(understated, 'journey')[0].verdict, 'confirmed',
    '7,600 clears a 7,000 minimum whatever the model said');

  const overstated = [{ ...base, verdict: 'confirmed', measurement: { value: 5000, limit: 7000, unit: 'lbs', comparison: 'at_least' } }];
  assert.equal(I.applyMeasuredVerdicts(overstated, 'journey')[0].verdict, 'contradicted',
    'and 5,000 does not — this is the one that costs someone a truck');
});

// --- 5. what the customer actually reads -----------------------------------

test('the rendered report shows the customer figures that reconcile', () => {
  const submission = { id: 'journey', form_data: vehicleForm() };
  const report = {
    ...costedReport(),
    headline: 'Financed over six years this truck costs about $67,700-$81,600 all in',
    summary: 'The price is in range, but financing and running costs nearly double it.',
    financing_impact: { applicable: true, explanation: 'Interest adds $9,600-$11,700 across the 60-month term.' },
    alternative_comparison: {
      alternative_name: 'A 2021 F-150 XLT with the same 2.7L engine',
      alternative_price_low: 38000,
      alternative_price_high: 41000,
      alternative_total_low: 58000,
      alternative_total_high: 70000,
      explanation: 'Two years older, materially cheaper, and rated to tow the same load.',
    },
    recommendation: { verdict: 'wait', reasoning: 'A 2021 saves five figures for the same capability.' },
    assumptions: ['Gasoline at $2.90-$3.20/gal', 'An APR of 7.5-9% for this credit tier', 'Insurance typical for 30301'],
    missing_or_uncertain: ['Whether this specific truck carries the towing package'],
    must_have_checks: [
      { requirement: 'must tow at least 7,000 lbs', verdict: 'confirmed', finding: 'Rated 7,600 lbs.', published_value: '7,600 lbs', source: 'manufacturer towing guide' },
      { requirement: 'must have adaptive cruise control', verdict: 'unverified', finding: 'Optional on this trim; the listing does not say.', source: 'not checked' },
    ],
  };

  const generic = I.mapToGenericReport(report, submission);

  const total = generic.key_numbers.find((n) => /total cost/i.test(n.label));
  assert.match(total.value, /67,680/, 'the printed total is the derived one');
  assert.match(total.value, /81,600/);
  assert.match(total.label, /\(6yr\)/, 'over the period the customer gave, not one the model invented');

  const mustHaves = generic.key_numbers.find((n) => /must-have/i.test(n.label));
  assert.match(mustHaves.value, /1 of 2/, 'and the count is what was actually graded');

  assert.ok(generic.sections.length >= 6, 'every promised section is present');
  assert.match(JSON.stringify(generic).toLowerCase(), /adaptive cruise/,
    'the requirement that could not be checked is put in front of the customer, not hidden');
});
