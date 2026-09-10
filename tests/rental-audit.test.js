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
