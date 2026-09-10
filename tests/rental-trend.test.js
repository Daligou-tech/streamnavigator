// Year-over-year: which costs rose faster than the rest.
//
// This is the one comparison in the product that does not appeal to what is
// typical — it measures the building against itself twelve months earlier. That
// makes it the strongest kind of finding here and the easiest to get wrong in a
// way nobody notices, because two plausible-looking numbers subtract cleanly
// whether or not they describe the same thing.
//
// So most of this file is about refusing to compare: different lengths of time,
// overlapping periods, undated statements, and a different building belonging
// to the same landlord.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runRentalTrend, sameProperty, _internal } = require('../api/_lib/rental-trend');
const { Severity, ImpactKind } = require('../api/_lib/rental-audit');

const CURRENT = {
  property: { address: '1428 Garfield Ave, Kansas City, MO 64127' },
  income: {
    period_start: '09/01/2025', period_end: '08/31/2026',
    gross_scheduled_rent: 57300, total_collected: 55940, net_operating_income: 15252,
  },
  expenses: [
    { label: 'Management fee', category: 'management', annual_amount: 5480 },
    { label: 'Repairs & maintenance', category: 'repairs_maintenance', annual_amount: 7400 },
    { label: 'Water & sewer', category: 'water_sewer', annual_amount: 6240 },
    { label: 'Property insurance', category: 'insurance', annual_amount: 4860 },
    { label: 'Property taxes', category: 'taxes', annual_amount: 6180 },
    { label: 'Trash service', category: 'trash', annual_amount: 1140 },
  ],
};

function priorPeriod(overrides) {
  return Object.assign({
    source: 'prior_period_in_documents',
    address: '1428 Garfield Ave, Kansas City, MO 64127',
    income: {
      period_start: '09/01/2024', period_end: '08/31/2025',
      gross_scheduled_rent: 56100, total_collected: 55200, net_operating_income: 21400,
    },
    expenses: [
      { label: 'Management fee', category: 'management', annual_amount: 5310 },
      { label: 'Repairs & maintenance', category: 'repairs_maintenance', annual_amount: 4100 },
      { label: 'Water & sewer', category: 'water_sewer', annual_amount: 4180 },
      { label: 'Property insurance', category: 'insurance', annual_amount: 4120 },
      { label: 'Property taxes', category: 'taxes', annual_amount: 6050 },
      { label: 'Trash service', category: 'trash', annual_amount: 1100 },
    ],
  }, overrides || {});
}

const byId = (result, id) => result.findings.find((f) => f.checkId === id);

// --- what it finds ----------------------------------------------------------

test('a cost that jumped is reported with the dollar increase and the percentage', () => {
  const result = runRentalTrend(CURRENT, priorPeriod());
  const repairs = byId(result, 'TREND_REPAIRS_MAINTENANCE');
  assert.ok(repairs, 'repairs went from $4,100 to $7,400 — that is the headline of any variance report');
  assert.equal(repairs.severity, Severity.COST_ROSE);
  assert.equal(repairs.expected, 4100);
  assert.equal(repairs.charged, 7400);
  assert.equal(repairs.dollarImpact, 3300);
  assert.equal(repairs.impactKind, ImpactKind.EXCESS, 'the rise above their own baseline, not a saving');
  assert.ok(/80\.5%/.test(repairs.title), `the percentage belongs in the title: ${repairs.title}`);
});

test('findings are ordered by how many dollars the line moved', () => {
  const result = runRentalTrend(CURRENT, priorPeriod());
  const rises = result.findings
    .filter((f) => f.severity === Severity.COST_ROSE && f.checkId.startsWith('TREND_') && f.dollarImpact)
    .map((f) => f.dollarImpact);
  assert.deepEqual(rises.slice(), rises.slice().sort((a, b) => b - a),
    'a landlord reads the top of the list, so the biggest movement goes there');
});

test('a line that rose faster than the building says so, and one that kept pace says that instead', () => {
  const result = runRentalTrend(CURRENT, priorPeriod());
  const water = byId(result, 'TREND_WATER_SEWER');
  assert.ok(/rose faster than the rest of the building/.test(water.basis),
    'water rose 49% against overall costs rising far less');
  const taxes = byId(result, 'TREND_TAXES');
  assert.equal(taxes, undefined, 'taxes moved $130 on $6,050 — not worth a landlord\'s attention');
});

test('a small percentage on a small line is not a finding', () => {
  const result = runRentalTrend(CURRENT, priorPeriod());
  assert.equal(byId(result, 'TREND_TRASH'), undefined,
    '$40 on trash is 3.6% and $40 — it fails both thresholds and would crowd out the real findings');
});

test('costs outrunning rent is called out as its own finding', () => {
  const result = runRentalTrend(CURRENT, priorPeriod());
  const lag = byId(result, 'TREND_RENT_LAGGING_COSTS');
  assert.ok(lag, 'costs rose sharply while scheduled rent moved about 2%');
  assert.ok(/own statements/.test(lag.basis));
  assert.equal(lag.actionability, 'actionable_at_renewal');
});

test('what held steady is named too, so the rises can be read in context', () => {
  const steady = byId(runRentalTrend(CURRENT, priorPeriod()), 'TREND_HELD_STEADY');
  assert.ok(steady);
  assert.equal(steady.severity, Severity.WITHIN_NORMS);
  assert.ok(/taxes/.test(steady.basis) && /trash/.test(steady.basis));
});

test('the comparison names the period it is against and where it came from', () => {
  const result = runRentalTrend(CURRENT, priorPeriod());
  assert.equal(result.comparedTo.label, '09/01/2024 to 08/31/2025');
  assert.equal(result.comparedTo.source, 'prior_period_in_documents');
});

// --- what it refuses to compare ---------------------------------------------

test('two periods of different lengths are not compared', () => {
  const prior = priorPeriod();
  prior.income.period_start = '03/01/2025';   // six months, not twelve
  const result = runRentalTrend(CURRENT, prior);
  assert.deepEqual(result.findings, []);
  assert.equal(result.comparedTo, null);
  assert.ok(/different lengths of time/.test(result.skipped[0]),
    `the customer is told why: ${result.skipped[0]}`);
  assert.ok(/will not/.test(result.skipped[0]), 'and that pro-rating is a choice we declined, not an oversight');
});

test('overlapping periods are not compared', () => {
  const prior = priorPeriod();
  prior.income.period_start = '03/01/2025';
  prior.income.period_end = '02/28/2026';
  const result = runRentalTrend(CURRENT, prior);
  assert.equal(result.comparedTo, null);
  assert.ok(result.skipped.length === 1);
});

test('an undated statement is not compared', () => {
  const prior = priorPeriod();
  delete prior.income.period_start;
  const result = runRentalTrend(CURRENT, prior);
  assert.equal(result.comparedTo, null);
  assert.ok(/does not print the period/.test(result.skipped[0]));
});

test('the earlier period must actually be the earlier one', () => {
  const swapped = runRentalTrend(
    Object.assign({}, CURRENT, { income: priorPeriod().income }),
    priorPeriod({ income: CURRENT.income }),
  );
  assert.equal(swapped.comparedTo, null);
});

test('a different property under the same email is not compared', () => {
  const other = priorPeriod({
    source: 'earlier_submission',
    address: '77 Ridgeline Road, Overland Park, KS 66210',
  });
  const result = runRentalTrend(CURRENT, other);
  assert.deepEqual(result.findings, []);
  assert.ok(/could not be matched/.test(result.skipped[0]),
    'a landlord with three properties has three histories, and comparing the wrong two '
    + 'would report every difference between two buildings as a year-over-year change');
});

test('a prior period lifted from the same document needs no address match', () => {
  // It came out of the customer's own statement, so it is the same building by
  // construction. Requiring an address there would refuse the most reliable case.
  const noAddress = priorPeriod({ address: null });
  assert.ok(runRentalTrend(CURRENT, noAddress).comparedTo);
});

test('no prior period at all is silence, not a skipped-check message', () => {
  for (const nothing of [null, undefined, {}, { income: {}, expenses: [] }]) {
    const result = runRentalTrend(CURRENT, nothing);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.skipped, [], 'a first-time customer has nothing to be told about');
  }
});

// --- address matching -------------------------------------------------------

test('the same address written two ways still matches', () => {
  assert.ok(sameProperty('1428 Garfield Ave, Kansas City, MO 64127', '1428 Garfield Avenue'));
  assert.ok(sameProperty('1428 Garfield Ave.', '1428  garfield   ave, KANSAS CITY MO 64127'));
  assert.ok(sameProperty('2211 N Ashland Court', '2211 North Ashland Ct'));
});

test('addresses that differ in the ways that matter do not match', () => {
  assert.ok(!sameProperty('1428 Garfield Ave', '1430 Garfield Ave'), 'different number');
  assert.ok(!sameProperty('1428 Garfield Ave', '1428 Pennsylvania Ave'), 'different street');
  assert.ok(!sameProperty('1428 Garfield Ave, KC MO 64127', '1428 Garfield Ave, KC MO 64111'),
    'same street in a different ZIP is a different building');
  assert.ok(!sameProperty('Garfield Ave', '1428 Garfield Ave'), 'no street number is not enough to match on');
  assert.ok(!sameProperty(null, '1428 Garfield Ave'));
  assert.ok(!sameProperty('', ''));
});

test('dates are parsed in the formats these documents actually print, and no others', () => {
  const { parseDate } = _internal;
  assert.equal(parseDate('09/01/2025').toISOString().slice(0, 10), '2025-09-01');
  assert.equal(parseDate('2025-09-01').toISOString().slice(0, 10), '2025-09-01');
  assert.equal(parseDate('Sep 2025').toISOString().slice(0, 10), '2025-09-01');
  assert.equal(parseDate('September 2025').toISOString().slice(0, 10), '2025-09-01');
  assert.equal(parseDate('last year'), null, 'a date we cannot read is null, never a guess');
  assert.equal(parseDate(''), null);
  assert.equal(parseDate('13/45/2025').toISOString().slice(0, 4), '2026',
    'JS date rollover is accepted rather than special-cased — a nonsense date fails the period checks anyway');
});
