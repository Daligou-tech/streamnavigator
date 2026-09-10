// Did the money actually arrive?
//
// The audit graded this 0 out of 5 and it was the last thing missing: the
// product knew what it found and never learned what it was worth. Closing a
// finding out asks the customer nothing — it reads last year's findings against
// this year's documents, because a landlord who meant to call the servicer and
// never did will tick a box either way.
//
// Two rules carry this whole file, and both are about not flattering ourselves:
//
//   1. Absence of evidence is never resolution. No mortgage statement this year
//      means the mortgage insurance finding is UNTESTABLE, never fixed.
//   2. A condition ending is not the same as money arriving. Only findings that
//      can be tied to a measurable change carry a recovered figure.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runRentalOutcomes, Outcome, RESOLVERS } = require('../api/_lib/rental-outcomes');

const LAST_YEAR_FINDINGS = [
  {
    checkId: 'PMI_STILL_CHARGED',
    title: 'Mortgage insurance of $118/month is still being charged at 65.8% loan-to-value',
    severity: 'recoverable_charge',
    dollarImpact: 1416,
    impactKind: 'recoverable',
    detail: { ltv: 0.658, monthly: 118 },
  },
  {
    checkId: 'UNIT_BELOW_INTERNAL_COMP',
    title: 'Unit 1 rents for $950 against $1,262.50 for identical units in the same building',
    severity: 'below_internal_comparable',
    dollarImpact: 3750,
    detail: { unit: '1', rent: 950, median: 1262.5, groupSize: 4 },
  },
  {
    checkId: 'WARRANTY_OVERLAP',
    title: 'You paid $1,788 for a warranty plan and $4,990 for repairs it nominally covers',
    severity: 'unrecovered_owner_cost',
    dollarImpact: 1788,
    charged: 1788,
    detail: { cost: 1788 },
  },
  {
    checkId: 'MAINT_SCHEDULE_FOOTS',
    title: 'The repairs you were billed exceed the repairs itemised on the same statement',
    severity: 'confirmed_arithmetic_error',
    dollarImpact: 500,
    charged: 7400,
    expected: 6900,
    detail: {},
  },
  {
    checkId: 'ESCROW_RECONCILES',
    title: 'Your escrow payment matches the taxes and insurance it is collected to pay',
    severity: 'within_norms',
    dollarImpact: null,
    detail: {},
  },
];

// A year later, on a landlord who acted: the servicer cancelled, Unit 1 was
// renewed at the median, the warranty was not renewed, and the manager's
// schedule adds up this time.
function actedOn() {
  return {
    property: { address: '1428 Garfield Ave, Kansas City, MO 64127', unit_count: 4 },
    units: [
      { unit_id: '1', bedrooms: 2, bathrooms: 1, sqft: 780, monthly_rent: 1275 },
      { unit_id: '2', bedrooms: 2, bathrooms: 1, sqft: 780, monthly_rent: 1300 },
      { unit_id: '3', bedrooms: 2, bathrooms: 1, sqft: 780, monthly_rent: 1295 },
      { unit_id: '4', bedrooms: 2, bathrooms: 1, sqft: 795, monthly_rent: 1325 },
    ],
    expenses: [
      { label: 'Management fee', category: 'management', annual_amount: 5600 },
      { label: 'Repairs & maintenance', category: 'repairs_maintenance', annual_amount: 5200 },
      { label: 'Property taxes', category: 'taxes', annual_amount: 6300 },
    ],
    expense_total_stated: 17100,
    maintenance_items: [
      { date: '10/02/26', description: 'Gutter cleaning', amount: 2600, system: 'exterior' },
      { date: '03/14/27', description: 'Furnace service', amount: 2600, system: 'hvac' },
    ],
    maintenance_total_stated: 5200,
    loan: { current_balance: 244100, mortgage_insurance_monthly: 0 },
  };
}

const findByCheck = (result, id) => result.outcomes.find((o) => o.checkId === id);

// --- the loop closing -------------------------------------------------------

test('mortgage insurance gone from the statement is confirmed recovered', () => {
  const f = findByCheck(runRentalOutcomes(LAST_YEAR_FINDINGS, actedOn()), 'PMI_STILL_CHARGED');
  assert.equal(f.outcome, Outcome.RESOLVED);
  assert.equal(f.recovered, 1416, 'money a document proves stopped leaving the account');
  assert.ok(/rather than reported/.test(f.note), 'and the report should say it was read, not asked');
});

test('a unit taken to the median is confirmed at the rent it actually gained', () => {
  const f = findByCheck(runRentalOutcomes(LAST_YEAR_FINDINGS, actedOn()), 'UNIT_BELOW_INTERNAL_COMP');
  assert.equal(f.outcome, Outcome.RESOLVED);
  assert.equal(f.recovered, 3900, '$950 to $1,275 is $325 a month — the rent gained, not the gap we estimated');
});

test('a unit moved part of the way is improved, and counts only what it moved', () => {
  const partial = actedOn();
  partial.units[0].monthly_rent = 1100;
  const f = findByCheck(runRentalOutcomes(LAST_YEAR_FINDINGS, partial), 'UNIT_BELOW_INTERNAL_COMP');
  assert.equal(f.outcome, Outcome.IMPROVED);
  assert.equal(f.recovered, 1800, '$150 a month, not the $3,750 originally on the table');
  assert.ok(/still\s+below/.test(f.note));
});

test('a unit that did not move is still open and recovers nothing', () => {
  const unchanged = actedOn();
  unchanged.units[0].monthly_rent = 950;
  const f = findByCheck(runRentalOutcomes(LAST_YEAR_FINDINGS, unchanged), 'UNIT_BELOW_INTERNAL_COMP');
  assert.equal(f.outcome, Outcome.STILL_OPEN);
  assert.equal(f.recovered, null);
});

test('the confirmed total is only what documents prove', () => {
  const result = runRentalOutcomes(LAST_YEAR_FINDINGS, actedOn());
  // PMI 1416 + rent 3900 + warranty 1788. The statement that now foots adds
  // nothing, deliberately.
  assert.equal(result.confirmedRecovered, 7104);
  const footing = findByCheck(result, 'MAINT_SCHEDULE_FOOTS');
  assert.equal(footing.outcome, Outcome.RESOLVED);
  assert.equal(footing.recovered, null,
    'a schedule that adds up this year does not mean last year\'s $500 was refunded');
  assert.ok(/not something these documents show/.test(footing.note));
});

// --- the rule that matters most ---------------------------------------------

test('a missing document is untestable, never resolved', () => {
  // The failure mode this whole module has to avoid: a landlord who uploads
  // less next year being congratulated for problems that never went away.
  const noMortgageStatement = actedOn();
  delete noMortgageStatement.loan;

  const f = findByCheck(runRentalOutcomes(LAST_YEAR_FINDINGS, noMortgageStatement), 'PMI_STILL_CHARGED');
  assert.equal(f.outcome, Outcome.NOT_TESTABLE);
  assert.equal(f.recovered, null);
  assert.ok(/no mortgage statement/.test(f.note), `it must name the document: ${f.note}`);
});

test('an upload with nothing in it resolves nothing at all', () => {
  const result = runRentalOutcomes(LAST_YEAR_FINDINGS, { property: { address: '1428 Garfield Ave' } });
  assert.equal(result.confirmedRecovered, 0);
  assert.equal(result.resolved, 0);
  assert.ok(result.notTestable >= 3, 'every finding needing a document nobody sent is untestable');
  for (const o of result.outcomes) {
    assert.equal(o.recovered, null);
  }
});

test('passed checks from last year are not outcomes', () => {
  const result = runRentalOutcomes(LAST_YEAR_FINDINGS, actedOn());
  assert.equal(findByCheck(result, 'ESCROW_RECONCILES'), undefined,
    '"your escrow still reconciles" is this year\'s verified list, not last year\'s result');
});

test('a resolver that cannot compute an answer says so instead of throwing', () => {
  const nonsense = { units: 'not a list', expenses: null, loan: { mortgage_insurance_monthly: 0 } };
  const result = runRentalOutcomes(LAST_YEAR_FINDINGS, nonsense);
  assert.ok(Array.isArray(result.outcomes));
  assert.ok(result.outcomes.every((o) => Object.values(Outcome).includes(o.outcome)));
});

test('no prior findings produces nothing rather than an empty section', () => {
  for (const nothing of [null, undefined, [], 'not a list']) {
    const result = runRentalOutcomes(nothing, actedOn());
    assert.deepEqual(result.outcomes, []);
    assert.equal(result.confirmedRecovered, 0);
  }
});

// --- the shape of a claim ---------------------------------------------------

test('every resolver declares the evidence it needs and what is missing without it', () => {
  for (const [checkId, resolver] of Object.entries(RESOLVERS)) {
    assert.equal(typeof resolver.needs, 'function', `${checkId} does not declare its evidence`);
    assert.equal(typeof resolver.run, 'function');
    assert.ok(resolver.label, `${checkId} has no label`);
    assert.ok(resolver.missing && /this year/.test(resolver.missing),
      `${checkId} cannot explain what document would close it`);
  }
});

test('a still-open or untestable outcome can never carry a recovered figure', () => {
  // Enforced at the runner rather than trusted to each resolver, because this
  // is the number the report leads with when it is not zero.
  const mixed = actedOn();
  mixed.units[0].monthly_rent = 950;          // still open
  delete mixed.loan;                           // untestable
  const result = runRentalOutcomes(LAST_YEAR_FINDINGS, mixed);
  for (const o of result.outcomes) {
    if (o.outcome === Outcome.STILL_OPEN || o.outcome === Outcome.NOT_TESTABLE) {
      assert.equal(o.recovered, null, `${o.checkId} claims money on a ${o.outcome} outcome`);
    }
  }
  assert.equal(result.confirmedRecovered, 1788, 'only the warranty, which was genuinely not renewed');
});

test('sub-metering resolves the utility finding without claiming a figure for it', () => {
  const finding = [{
    checkId: 'OWNER_PAID_UTILITY',
    severity: 'unrecovered_owner_cost',
    title: 'You pay $6,240 a year for water and sewer across 4 units',
    dollarImpact: 6240,
    charged: 6240,
    detail: { utility: 'water and sewer', annual: 6240 },
  }];
  const x = actedOn();
  x.utilities_owner_paid = [{ utility: 'water and sewer', annual_amount: 6100, submetered: true }];
  const f = findByCheck(runRentalOutcomes(finding, x), 'OWNER_PAID_UTILITY');
  assert.equal(f.outcome, Outcome.RESOLVED);
  assert.equal(f.recovered, null,
    'sub-metering shifts a cost; how much reaches the tenants depends on leases we have not seen');
});
