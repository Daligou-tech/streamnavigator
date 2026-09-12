// Closing out last year's findings.
//
// The audit graded Landlord Navigator 0 of 5 on confirming a result: it knew
// what it found and never learned what it was worth. This is the second visit.
//
// The failure mode the whole module is written against is flattery — a report
// that congratulates a landlord for problems that merely stopped being visible.
// Every test here is really a test of that.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runLandlordOutcomes, Outcome, RESOLVERS } = require('../api/_lib/landlord-outcomes');

const prior = (checkId, property, answers, title = 'a prior finding') =>
  ({ checkId, property, title, answers });

const only = (r) => r.outcomes[0];

// --- resolution requires evidence -------------------------------------------

test('a blank answer is not testable, and never a pass', () => {
  const r = runLandlordOutcomes(
    [prior('REGISTRATION_MISSING', 'Cedar St', { registered: 'no' })],
    [{ label: 'Cedar St', city: 'Kansas City', state: 'MO' }]   // registered left blank
  );
  assert.equal(only(r).outcome, Outcome.NOT_TESTABLE);
  assert.equal(r.resolved, 0);
  assert.match(only(r).note, /blank this time/,
    'the customer has to be told which answer would close it');
});

test('a property dropped from this year is named, not silently closed', () => {
  const r = runLandlordOutcomes(
    [prior('REGISTRATION_MISSING', 'Sold Place', { registered: 'no' })],
    [{ label: 'Cedar St', city: 'Denver', state: 'CO' }]
  );
  assert.equal(only(r).outcome, Outcome.NOT_TESTABLE);
  assert.match(only(r).note, /not in this year/);
  assert.equal(r.resolved, 0, 'a property that vanished is not a problem that was solved');
});

test('a finding with no resolver is reported, not dropped', () => {
  // A finding that disappears between two reports reads as solved, which is
  // the one thing this module exists to prevent.
  const r = runLandlordOutcomes(
    [prior('INSPECTION_PROGRAMME', 'Cedar St', {})],
    [{ label: 'Cedar St', city: 'Seattle', state: 'WA' }]
  );
  assert.equal(r.outcomes.length, 1);
  assert.equal(only(r).outcome, Outcome.NOT_TESTABLE);
});

// --- what genuinely closes ---------------------------------------------------

test('registration closes when the owner says it is now held', () => {
  const r = runLandlordOutcomes(
    [prior('REGISTRATION_MISSING', 'Cedar St', { registered: 'no' })],
    [{ label: 'Cedar St', registered: 'yes' }]
  );
  assert.equal(only(r).outcome, Outcome.RESOLVED);
  assert.match(only(r).note, /You told us/,
    'nothing here was checked with a city, and the wording has to say so');
});

test('still-no is still open, which is a different thing from unanswered', () => {
  const r = runLandlordOutcomes(
    [prior('REGISTRATION_MISSING', 'Cedar St', { registered: 'no' })],
    [{ label: 'Cedar St', registered: 'no' }]
  );
  assert.equal(only(r).outcome, Outcome.STILL_OPEN);
});

test('a renewal closes only when the expiry date actually moves', () => {
  const moved = runLandlordOutcomes(
    [prior('REGISTRATION_DUE_SOON', 'Cedar St', { registration_expires: '2026-10-10' })],
    [{ label: 'Cedar St', registration_expires: '2027-10-10' }]
  );
  assert.equal(only(moved).outcome, Outcome.RESOLVED);

  const same = runLandlordOutcomes(
    [prior('REGISTRATION_DUE_SOON', 'Cedar St', { registration_expires: '2026-10-10' })],
    [{ label: 'Cedar St', registration_expires: '2026-10-10' }]
  );
  assert.equal(only(same).outcome, Outcome.STILL_OPEN,
    're-entering the same date is not evidence of a renewal');
});

test('a deposit closes on separate, and on no longer holding one', () => {
  for (const [held, why] of [['separate', 'moved'], ['none', 'no deposit any more']]) {
    const r = runLandlordOutcomes(
      [prior('DEPOSIT_COMMINGLED', 'A', { deposit_held: 'commingled' })],
      [{ label: 'A', deposit_held: held }]
    );
    assert.equal(only(r).outcome, Outcome.RESOLVED, `should close on ${why}`);
  }
  const still = runLandlordOutcomes(
    [prior('DEPOSIT_COMMINGLED', 'A', { deposit_held: 'commingled' })],
    [{ label: 'A', deposit_held: 'commingled' }]
  );
  assert.equal(only(still).outcome, Outcome.STILL_OPEN);
});

test('a child moving out improves the lead finding without resolving it', () => {
  // The duty attaches to the unit, not to the family in it. Calling this
  // resolved would tell a landlord their pre-1978 paint stopped mattering.
  const r = runLandlordOutcomes(
    [prior('LEAD_CHILD_STATE_REGIME', 'Ashwood', { child_under_six: 'yes' })],
    [{ label: 'Ashwood', child_under_six: 'no' }]
  );
  assert.equal(only(r).outcome, Outcome.IMPROVED);
  assert.notEqual(only(r).outcome, Outcome.RESOLVED);
  assert.match(only(r).note, /comes back/, 'the landlord has to know why it is not closed');
});

test('a lease closes when it has actually been renewed past the old end', () => {
  const renewed = runLandlordOutcomes(
    [prior('LEASE_NOTICE_WINDOW', 'A', { lease_ends: '2026-12-01' })],
    [{ label: 'A', lease_ends: '2027-12-01' }]
  );
  assert.equal(only(renewed).outcome, Outcome.RESOLVED);
});

// --- matching and totals -----------------------------------------------------

test('a property the landlord never named is still matched by where it is', () => {
  const r = runLandlordOutcomes(
    [prior('REGISTRATION_MISSING', 'Denver, CO', { registered: 'no' })],
    [{ city: 'Denver', state: 'CO', registered: 'yes' }]
  );
  assert.equal(only(r).outcome, Outcome.RESOLVED);
});

test('the totals add up to the outcomes, so a summary cannot overstate progress', () => {
  const r = runLandlordOutcomes([
    prior('REGISTRATION_MISSING', 'A', { registered: 'no' }),
    prior('DEPOSIT_COMMINGLED', 'A', { deposit_held: 'commingled' }),
    prior('LEAD_DISCLOSURE_MISSING', 'A', { lead_disclosure_on_file: 'no' }),
    prior('LEAD_CHILD_STATE_REGIME', 'A', { child_under_six: 'yes' }),
    prior('REGISTRATION_MISSING', 'Gone', { registered: 'no' }),
  ], [{ label: 'A', registered: 'yes', deposit_held: 'commingled', child_under_six: 'no' }]);

  assert.equal(r.resolved + r.improved + r.stillOpen + r.notTestable, r.outcomes.length);
  assert.equal(r.resolved, 1);
  assert.equal(r.improved, 1);
  assert.equal(r.stillOpen, 1);
  assert.equal(r.notTestable, 2, 'the unanswered disclosure and the dropped property');
});

test('no prior findings and no properties produce nothing rather than an error', () => {
  assert.deepEqual(runLandlordOutcomes([], []).outcomes, []);
  assert.deepEqual(runLandlordOutcomes(null, null).outcomes, []);
  assert.deepEqual(runLandlordOutcomes([{ nonsense: true }], []).outcomes, []);
});

// --- the contract every resolver keeps ---------------------------------------

test('every resolver declares the field it needs, in words a customer can act on', () => {
  const bad = Object.entries(RESOLVERS)
    .filter(([, r]) => !r.needs || typeof r.run !== 'function')
    .map(([id]) => id);
  assert.deepEqual(bad, [],
    'a resolver with no `needs` cannot tell the customer what would close the row, which is '
    + `the whole point of reporting it as not testable:\n  ${bad.join('\n  ')}`);
});

test('a resolver that throws costs its own row, not the whole comparison', () => {
  const r = runLandlordOutcomes([
    prior('REGISTRATION_EXPIRED', 'A', { registration_expires: { not: 'a date' } }),
    prior('REGISTRATION_MISSING', 'A', { registered: 'no' }),
  ], [{ label: 'A', registered: 'yes', registration_expires: 'nonsense' }]);
  assert.equal(r.outcomes.length, 2);
  assert.equal(r.resolved, 1, 'the sound row still resolves');
});
