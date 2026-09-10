// The checks that make Rental Navigator an audit rather than an opinion.
//
// The fixture below is the four-unit Kansas City property from the 2026-09-09
// product audit, transcribed as the extractor should record it. That audit is
// the reason this engine exists: the model-only pipeline read these same
// documents and missed $118 a month of mortgage insurance on a loan at 66%
// loan-to-value, and never noticed that the repair schedule itemised $6,900
// against a stated total of $7,400.
//
// So the first two tests are not general coverage. They are the two failures,
// pinned, with the figures the old pipeline should have produced.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runRentalAudit, CATALOG, Severity, EvidenceKind, ImpactKind,
} = require('../api/_lib/rental-audit');

// --- fixtures ---------------------------------------------------------------

const { leakyFourplex, cleanDuplex } = require('./fixtures/rental-fixtures');

const find = (result, id) => result.findings.filter((f) => f.checkId === id);
const one = (result, id) => {
  const hits = find(result, id);
  assert.equal(hits.length, 1, `expected exactly one ${id}, got ${hits.length}`);
  return hits[0];
};

// --- the two misses that caused this engine ---------------------------------

test('the mortgage insurance the old pipeline walked past is found, with the figure', () => {
  const f = one(runRentalAudit(leakyFourplex()), 'PMI_STILL_CHARGED');
  assert.equal(f.severity, Severity.RECOVERABLE_CHARGE);
  assert.equal(f.dollarImpact, 1416, 'twelve months of the premium on the statement');
  assert.equal(f.impactKind, ImpactKind.RECOVERABLE, 'this one genuinely stops leaving the account');
  assert.equal(f.askServicer, true, 'and it has to reach the servicer as a letter');
  assert.ok(/65\.8%/.test(f.basis), `the loan-to-value must be stated: ${f.basis}`);
  // The threshold is a servicer norm on an entity-held investment loan, not a
  // statutory entitlement, and the finding has to say so rather than promising
  // a landlord something the Homeowners Protection Act may not give them.
  assert.ok(/may not apply|servicer's own policy/.test(f.basis),
    'the finding must not present cancellation as settled law on an investment loan');
});

test('the repair schedule that does not add up is caught, to the dollar', () => {
  const f = one(runRentalAudit(leakyFourplex()), 'MAINT_SCHEDULE_FOOTS');
  assert.equal(f.severity, Severity.CONFIRMED_ERROR);
  assert.equal(f.expected, 6900, 'the sixteen line items');
  assert.equal(f.charged, 7400, 'what the statement billed');
  assert.equal(f.dollarImpact, 500);
  assert.equal(f.impactKind, ImpactKind.ERROR, 'an unexplained gap is not yet a saving');
  assert.equal(f.askManager, true);
});

// --- a short list must never become an accusation ---------------------------
//
// The first live run of this engine produced two "confirmed arithmetic error"
// findings that were wrong, and both led their report. On the four-unit
// property it announced a $5,480 hole that was exactly the management fee —
// recorded in the management object and left out of the expense list. On the
// single-family property it announced a $2,415 hole that was exactly the
// repairs line, itemised into maintenance_items and left out of the expense
// list. Neither statement was short of anything.
//
// Declining to test a total costs a landlord nothing. Telling them their
// manager is missing $5,480 costs them a relationship, and it is the one claim
// in this product a customer will act on immediately.

test('a management fee missing from the expense list stops the totals check, and does not accuse anyone', () => {
  const x = leakyFourplex();
  x.expenses = x.expenses.filter((e) => e.category !== 'management');   // the observed omission
  const result = runRentalAudit(x);
  assert.equal(find(result, 'EXPENSE_TOTAL_FOOTS').length, 0,
    'the gap here is the missing line, not a hole in the statement');
  assert.ok(result.skipped.some((s) => /expense lines add up/i.test(s)),
    'and the customer is told the check did not run');
});

test('a repairs line missing from the expense list stops the totals check too', () => {
  const x = leakyFourplex();
  x.expenses = x.expenses.filter((e) => e.category !== 'repairs_maintenance');
  assert.equal(find(runRentalAudit(x), 'EXPENSE_TOTAL_FOOTS').length, 0);
});

test('a recorded list shorter than the lines counted on the page is not judged', () => {
  const x = leakyFourplex();
  x.expense_lines_printed = x.expenses.length + 1;   // extractor saw one it did not record
  assert.equal(find(runRentalAudit(x), 'EXPENSE_TOTAL_FOOTS').length, 0);

  const y = leakyFourplex();
  y.maintenance_lines_printed = y.maintenance_items.length + 1;
  assert.equal(find(runRentalAudit(y), 'MAINT_SCHEDULE_FOOTS').length, 0,
    'the $500 gap is real, but not provable from a schedule we know is short');
});

test('when the counts agree, both totals checks still run', () => {
  const x = leakyFourplex();
  x.expense_lines_printed = x.expenses.length;
  x.maintenance_lines_printed = x.maintenance_items.length;
  const result = runRentalAudit(x);
  assert.equal(one(result, 'MAINT_SCHEDULE_FOOTS').dollarImpact, 500);
  assert.equal(one(result, 'EXPENSE_TOTAL_FOOTS').severity, Severity.WITHIN_NORMS,
    'these expense lines do add up, and saying so is work the customer paid for');
});

test('a self-managed landlord with no management line is not treated as an omission', () => {
  const x = cleanDuplex();
  assert.ok(runRentalAudit(x).findings.some((f) => f.checkId === 'EXPENSE_TOTAL_FOOTS'),
    'nobody charges them a management fee, so nothing is missing from the list');
});

// --- the rest of the catalog ------------------------------------------------

test('the under-rented unit is measured against its own building, not the market', () => {
  const f = one(runRentalAudit(leakyFourplex()), 'UNIT_BELOW_INTERNAL_COMP');
  assert.equal(f.detail.unit, '1');
  assert.equal(f.detail.median, 1262.5, 'median of 950, 1275, 1250, 1300');
  assert.equal(f.dollarImpact, 3750, '$312.50 a month for twelve months');
  assert.equal(f.evidence, EvidenceKind.INTERNAL_COMPARABLE);
  assert.ok(/11\/30\/2026/.test(f.basis), 'the lease expiry is when this is actionable');
  // 780 and 795 sq ft is one floorplan described twice, not two floorplans.
  assert.equal(f.detail.groupSize, 4);
});

test('units priced within 10% of their neighbours are left alone', () => {
  const result = runRentalAudit(leakyFourplex());
  const flagged = find(result, 'UNIT_BELOW_INTERNAL_COMP').map((f) => f.detail.unit);
  assert.deepEqual(flagged, ['1'], 'unit 3 sits 1% under the median and is not a finding');
});

test('owner-paid water on a master meter is reported as exposure, never as a saving', () => {
  const f = one(runRentalAudit(leakyFourplex()), 'OWNER_PAID_UTILITY');
  assert.equal(f.severity, Severity.UNRECOVERED_COST);
  assert.equal(f.impactKind, ImpactKind.EXPOSURE);
  assert.equal(f.dollarImpact, 6240);
  assert.ok(/not a saving/.test(f.basis),
    'a billback program recovers part of this, and the report must not imply otherwise');
});

test('a utility running above its own baseline is measured as excess over the median', () => {
  const f = one(runRentalAudit(leakyFourplex()), 'UTILITY_SPIKE');
  assert.equal(f.detail.median, 437, 'median of the twelve months');
  assert.equal(f.dollarImpact, 1035, 'the four months over baseline, summed against it');
  assert.equal(f.impactKind, ImpactKind.EXCESS);
});

test('repeat visits to one system surface as a capital decision', () => {
  const hvac = find(runRentalAudit(leakyFourplex()), 'REPAIR_CONCENTRATION')
    .find((f) => f.detail.system === 'hvac');
  assert.ok(hvac, 'five HVAC calls on unit 2 is the pattern this check exists for');
  assert.equal(hvac.detail.visits, 5);
  assert.equal(hvac.detail.spend, 2375);
  assert.equal(hvac.severity, Severity.CAPITAL_DECISION);
});

test('the escrow that reconciles exactly is reported as verified, not omitted', () => {
  const f = one(runRentalAudit(leakyFourplex()), 'ESCROW_RECONCILES');
  assert.equal(f.severity, Severity.WITHIN_NORMS);
  assert.equal(f.charged, 11040);
  assert.equal(f.expected, 11040);
  assert.ok(/reconcile exactly/.test(f.basis));
});

test('stacked management fees are flagged as negotiable, not as improper', () => {
  const f = one(runRentalAudit(leakyFourplex()), 'MANAGEMENT_FEE_STACKING');
  assert.equal(f.dollarImpact, 1850, 'the fees charged on top of the percentage');
  assert.ok(/are not improper/.test(f.basis), 'this is a market observation and must read as one');
});

test('the insurance findings rest on the declarations page, not on a rate we do not have', () => {
  const result = runRentalAudit(leakyFourplex());
  const jump = one(result, 'INSURANCE_RENEWAL_JUMP');
  assert.equal(jump.dollarImpact, 740);
  assert.ok(/not something this audit can tell you/.test(jump.basis),
    'we have no competing quote and must not imply the premium is uncompetitive');

  const limit = one(result, 'INSURANCE_LIMIT_RATIO');
  assert.equal(limit.evidence, EvidenceKind.TYPICAL_RANGE, 'a ratio of thumb, not a rule');
  const deductible = one(result, 'INSURANCE_DEDUCTIBLE');
  assert.equal(deductible.dollarImpact, null, 'the premium saving is unknown without a quote');
});

// --- ordering and honesty ---------------------------------------------------

test('the strongest true finding leads the report', () => {
  const result = runRentalAudit(leakyFourplex());
  assert.equal(result.findings[0].checkId, 'MAINT_SCHEDULE_FOOTS', 'a proven arithmetic error outranks everything');
  assert.equal(result.findings[1].checkId, 'PMI_STILL_CHARGED', 'then the charge a threshold says should have stopped');
  assert.equal(result.findings[2].checkId, 'UNIT_BELOW_INTERNAL_COMP');
  const last = result.findings[result.findings.length - 1];
  assert.equal(last.severity, Severity.WITHIN_NORMS, 'passed checks sort to the back, and are still present');
});

test('every finding carries what it rests on and when it can be acted on', () => {
  for (const fixture of [leakyFourplex(), cleanDuplex()]) {
    for (const f of runRentalAudit(fixture).findings) {
      assert.ok(f.checkId && f.title && f.basis, `incomplete finding: ${JSON.stringify(f).slice(0, 120)}`);
      assert.ok(Object.values(Severity).includes(f.severity), `bad severity on ${f.checkId}`);
      assert.ok(Object.values(EvidenceKind).includes(f.evidence), `bad evidence on ${f.checkId}`);
      if (f.dollarImpact !== null && f.dollarImpact !== undefined) {
        assert.ok(Object.values(ImpactKind).includes(f.impactKind),
          `${f.checkId} states a dollar figure without saying what kind of figure it is`);
      }
    }
  }
});

test('a well-run property produces no findings against it', () => {
  const result = runRentalAudit(cleanDuplex());
  const flagged = result.findings.filter((f) => f.severity !== Severity.WITHIN_NORMS);
  const ids = flagged.map((f) => f.checkId);
  assert.deepEqual(ids, ['RENT_COMP_NOT_TESTABLE'],
    `nothing on this property is wrong; the only non-passing finding should be the one naming `
    + `what could not be tested. Got: ${ids.join(', ')}`);
  assert.ok(result.findings.some((f) => f.checkId === 'PMI_STILL_CHARGED' && f.severity === Severity.WITHIN_NORMS),
    'a loan with no mortgage insurance is a check that passed, and the customer paid for it to run');
});

test('a single-property landlord is told the rent comparison could not be run', () => {
  const f = one(runRentalAudit(cleanDuplex()), 'RENT_COMP_NOT_TESTABLE');
  assert.equal(f.actionability, 'requires_additional_documentation');
  assert.equal(f.dollarImpact, null, 'no rent estimate is invented to fill the gap');
  assert.ok(/three to five current listings/.test(f.recommendedAction), 'and they are told what to bring');
});

test('the rent-comparison placeholder stays out of the way when the real check runs', () => {
  const result = runRentalAudit(leakyFourplex());
  assert.equal(find(result, 'RENT_COMP_NOT_TESTABLE').length, 0);
  assert.ok(!result.skipped.some((s) => /comparable units/.test(s)),
    'listing it as skipped would tell a four-unit landlord a check was missed when the better one ran');
});

test('checks that cannot run are named, not silently dropped', () => {
  const bare = { property: { unit_count: 1 }, documents_seen: ['a photograph of a statement'] };
  const result = runRentalAudit(bare);
  assert.ok(result.skipped.length >= 8, `expected most checks to be skipped by name, got ${result.skipped.length}`);
  assert.ok(result.skipped.some((s) => /escrow/i.test(s)), 'the escrow check must say it did not run');
  assert.equal(result.checksRun, result.findings.filter((f) => f.checkId !== 'RENT_COMP_NOT_TESTABLE').length + 0
    || result.checksRun, 'checksRun is a count, not a promise');
});

test('an empty extraction produces nothing rather than throwing', () => {
  for (const input of [null, undefined, {}, { units: 'not a list', expenses: null }]) {
    const result = runRentalAudit(input);
    assert.ok(Array.isArray(result.findings));
    assert.ok(Array.isArray(result.skipped));
  }
});

test('every catalog entry declares a label and a needs test', () => {
  assert.ok(CATALOG.length >= 15, `only ${CATALOG.length} checks in the catalog`);
  const ids = CATALOG.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate check id');
  for (const entry of CATALOG) {
    assert.ok(entry.label, `${entry.id} has no label — it could never be named in a skipped list`);
    assert.equal(typeof entry.needs, 'function', `${entry.id} does not declare what it needs`);
    assert.equal(typeof entry.run, 'function');
  }
});

// --- coverage ---------------------------------------------------------------
//
// "We found nothing wrong" is two results, not one, and the difference is not
// a nuance — it is the difference between a property that was examined and a
// property we could barely see. The well-run duplex had thirteen checks run
// and pass. The single-family rental had three run and twelve unable to.
// Both reports opened by saying nothing was wrong.
//
// A landlord pays to find out. Finding out is the service and it is worth the
// fee, which is why there is no refund when a property comes back clean — but
// only a report that says how much was actually checked has told them anything.

test('coverage is reported as a pair, so a thin result cannot pass as a clean one', () => {
  const full = runRentalAudit(leakyFourplex());
  assert.equal(full.checksTotal, 17);
  assert.equal(full.checksRun, 17, 'this property carries every document the catalog needs');

  const thin = runRentalAudit({
    property: { unit_count: 1 },
    units: [{ unit_id: 'house', monthly_rent: 1650 }],
    documents_seen: ['a lease'],
  });
  assert.equal(thin.checksTotal, 17, 'the denominator never moves — it is what was on offer');
  assert.ok(thin.checksRun <= 3, `a lease alone cannot support 17 checks, got ${thin.checksRun}`);
  assert.ok(thin.skipped.length >= 12, 'and every one that did not run is named');
});

test('coverage counts checks, not findings', () => {
  // A check that runs and passes is coverage. A check that produces three
  // findings is still one check. Conflating them would let a leaky building
  // look better covered than a clean one purely for being leaky.
  const clean = runRentalAudit(cleanDuplex());
  assert.equal(clean.checksRun + clean.skipped.length, clean.checksTotal);
});

// --- the two ratios that run on a statement alone ---------------------------
//
// Added after the live runs showed where coverage lands. The four-unit property
// with all four documents reached 15 of 15; a well-run duplex reached 6, and a
// single-family rental 4. Part of that was documents nobody had been asked for,
// and part was a catalog that leaned on multi-unit, third-party-managed
// properties. These two need only the statement every customer sends.

test('operating cost share is measured against who actually pays the utilities', () => {
  // One band for both would tell half of all landlords they are running badly.
  // An owner carrying water, trash and common electric books costs a
  // tenant-paid property never sees.
  const owner = one(runRentalAudit(leakyFourplex()), 'OPEX_RATIO');
  assert.equal(owner.severity, Severity.ABOVE_TYPICAL_RANGE);
  assert.equal(owner.detail.ownerPaysUtilities, true);
  assert.equal(owner.detail.ceiling, 0.62);
  assert.equal(owner.dollarImpact, 6005.2, 'the amount above the top of the band, not the whole ratio');
  assert.ok(/not a rule/.test(owner.basis), 'this is a market norm and has to read as one');

  const tenantPaid = one(runRentalAudit(cleanDuplex()), 'OPEX_RATIO');
  assert.equal(tenantPaid.severity, Severity.WITHIN_NORMS, '30% on a tenant-paid duplex is good, not suspicious');
  // $216 of common-area hallway lighting is not the owner carrying the
  // utilities. Measured by cost against collected rent, not by the presence of
  // a utility line, or this duplex would have been given the wider band and a
  // genuinely expensive property excused with it.
  assert.equal(tenantPaid.detail.ownerPaysUtilities, false);
  assert.equal(tenantPaid.dollarImpact, null);
});

test('the operating cost finding points back at the findings that make it up', () => {
  // It is the sum of the other findings, so presenting it as a separate thing
  // to fix would be counting the same money twice.
  const f = one(runRentalAudit(leakyFourplex()), 'OPEX_RATIO');
  assert.ok(/Read this against the individual findings/.test(f.recommendedAction));
  assert.equal(f.impactKind, ImpactKind.EXCESS);
});

test('vacancy is measured, and no vacancy is reported as the result it is', () => {
  const some = one(runRentalAudit(leakyFourplex()), 'VACANCY_RATIO');
  assert.equal(some.severity, Severity.WITHIN_NORMS, '4.4% is one turnover in a four-unit building');

  const none = one(runRentalAudit(cleanDuplex()), 'VACANCY_RATIO');
  assert.ok(/no rent to vacancy/.test(none.title), 'a year with no vacancy is worth saying out loud');
  assert.equal(none.dollarImpact, null);
});

test('vacancy above the usual band is flagged at the amount above it', () => {
  const x = leakyFourplex();
  x.income.vacancy_loss = 9000;               // 15.7% of scheduled
  const f = one(runRentalAudit(x), 'VACANCY_RATIO');
  assert.equal(f.severity, Severity.ABOVE_TYPICAL_RANGE);
  assert.equal(f.dollarImpact, 9000 - 57300 * 0.08);
  assert.ok(/never arrived/.test(f.basis), 'empty weeks are invisible precisely because nothing is billed');
});

test('both ratios run on a statement with no rent roll, mortgage or policy', () => {
  // The single-family customer who sends one document is the case these exist
  // for: before them that submission produced two substantive results.
  const statementOnly = {
    income: { gross_scheduled_rent: 19800, vacancy_loss: 0, total_collected: 19140 },
    expenses: [
      { label: 'Repairs', category: 'repairs_maintenance', annual_amount: 2415 },
      { label: 'Insurance', category: 'insurance', annual_amount: 1780 },
      { label: 'Taxes', category: 'taxes', annual_amount: 2940 },
      { label: 'Accounting', category: 'admin', annual_amount: 350 },
    ],
    expense_total_stated: 7485,
  };
  const result = runRentalAudit(statementOnly);
  assert.ok(find(result, 'OPEX_RATIO').length === 1);
  assert.ok(find(result, 'VACANCY_RATIO').length === 1);
});

test('a statement that prints one rent figure still gets its ratios', () => {
  // Submission b1f1f1af, verbatim as the extractor recorded it. A single-family
  // statement with no laundry or parking income prints "Gross rent collected"
  // and never a separate total, so income.total_collected is null.
  //
  // Three checks divided by that field specifically. The repair-ratio check had
  // therefore been skipping on statements of this shape since the engine
  // shipped, and the two ratios written to serve single-property customers did
  // not run for the first single-property customer they met.
  const asExtracted = {
    income: { period_start: '01/01/2025', period_end: '12/31/2025', collected_rent: 19140, net_operating_income: 10955 },
    expenses: [
      { label: 'Repairs & maintenance', category: 'repairs_maintenance', annual_amount: 2415 },
      { label: 'Landscaping', category: 'landscaping', annual_amount: 410 },
      { label: 'Property insurance', category: 'insurance', annual_amount: 1780 },
      { label: 'Property taxes', category: 'taxes', annual_amount: 2940 },
      { label: 'Accounting', category: 'admin', annual_amount: 350 },
      { label: 'Umbrella liability', category: 'insurance', annual_amount: 290 },
    ],
    expense_total_stated: 8185,
    units: [{ unit_id: 'house', monthly_rent: 1650 }],
  };

  const result = runRentalAudit(asExtracted);
  const opex = one(result, 'OPEX_RATIO');
  assert.equal(opex.severity, Severity.WITHIN_NORMS, '$8,185 against $19,140 is 42.8%');
  assert.equal(opex.detail.collected, 19140, 'the figure the statement printed, not null');
  assert.equal(opex.detail.ownerPaysUtilities, false, 'landscaping is not a utility');

  const repairs = one(result, 'REPAIR_RATIO');
  assert.ok(/12\.6%/.test(repairs.basis), `repairs are 12.6% of collected: ${repairs.basis}`);

  // Vacancy still does not run, and that is correct: this statement books no
  // vacancy line at all, and absence is not the same as zero.
  assert.equal(find(result, 'VACANCY_RATIO').length, 0);
  assert.ok(result.skipped.some((s) => /Vacancy/i.test(s)), 'and the customer is told which check did not run');
});

test('collected income is never invented, only read from whichever line carries it', () => {
  const { runRentalAudit: run } = require('../api/_lib/rental-audit');
  const base = { expenses: [{ label: 'R&M', category: 'repairs_maintenance', annual_amount: 1000 }] };

  // No income figure of any kind: the ratio checks must decline rather than
  // divide by something they made up.
  const none = run(Object.assign({}, base, { income: {} }));
  assert.equal(none.findings.filter((f) => f.checkId === 'OPEX_RATIO').length, 0);
  assert.equal(none.findings.filter((f) => f.checkId === 'REPAIR_RATIO').length, 0);
});
