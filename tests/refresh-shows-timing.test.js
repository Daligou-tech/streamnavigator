// Run: node tests/refresh-shows-timing.test.js
//
// The daily job sends two emails that move money: "pause this" and "activate
// this". Both used to be sendable with no evidence behind them.
//
//   A paused subscription with no confirmed air date got reminder_type
//   'resume' 30 days later, and the job emailed "time to activate HBO Max —
//   it's been about a month since you paused it." TVmaze returns no next air
//   date for most shows between seasons, so that was the normal outcome of
//   pausing anything: the product undid its own saving on a 30-day loop.
//
//   A pause email could land the day after a subscription renewed, which
//   saves the customer nothing and costs them a month of access they have
//   already paid for. On an annual plan it is worse than nothing — it tells
//   them to forfeit what they prepaid.
//
// These assert both are fixed.
'use strict';

const assert = require('assert');
const {
  computeDesiredAction, computeCadenceAction, pauseIsActionable, rollRenewal,
} = require('../api/refresh-shows.js');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}\n    ${err.message.split('\n')[0]}`); }
}

const TODAY = '2026-09-12';
const row = (over) => Object.assign({
  id: 'r1', user_id: 'u1', service_name: 'HBO Max', status: 'active',
  monthly_price: 18.49, billing_period: 'monthly', next_renewal_date: null,
  next_reminder_date: null, reminder_type: null, reminder_source: null,
}, over);

// ------------------------------------------------- no blind restart

test('a paused row with no air date is never told to activate', () => {
  const r = row({
    status: 'paused', next_reminder_date: '2026-09-01',
    reminder_type: 'resume', reminder_source: 'cadence',
  });
  assert.strictEqual(
    computeCadenceAction(r, TODAY), null,
    'the calendar-only resume still fires — this is the email that tells customers to start paying with nothing airing',
  );
});

test('a paused row WITH a confirmed air date is told to activate', () => {
  const r = row({
    status: 'paused', next_reminder_date: '2026-09-10',
    reminder_type: 'resume', reminder_source: 'air_date',
  });
  const a = computeCadenceAction(r, TODAY);
  assert.ok(a, 'an air-date-backed resume was suppressed');
  assert.strictEqual(a.action, 'activate');
});

test('a favourite that is airing still wakes a paused subscription', () => {
  const favorites = [{ kind: 'show', title: 'The Last of Us', service_name: 'HBO Max', currently_airing: true }];
  const a = computeDesiredAction(row({ status: 'paused' }), favorites, TODAY);
  assert.ok(a && a.action === 'activate', 'a genuinely airing show no longer triggers activate');
  assert.ok(/The Last of Us/.test(a.reason), 'the reason does not name the show');
});

// ------------------------------------------------- renewal timing

test('pause advice waits for the renewal window', () => {
  assert.strictEqual(pauseIsActionable(row({ next_renewal_date: '2026-10-20' }), TODAY), false,
    'a pause email would fire 38 days before the charge, wasting a month of paid access');
  assert.strictEqual(pauseIsActionable(row({ next_renewal_date: '2026-09-16' }), TODAY), true,
    'a pause email is suppressed 4 days before the charge, which is exactly when it is useful');
});

test('a subscription with no renewal date still behaves as before', () => {
  assert.strictEqual(pauseIsActionable(row({ next_renewal_date: null }), TODAY), true,
    'rows without a renewal date went silent instead of degrading to the old behaviour');
});

test('annual plans are not told to cancel mid-term', () => {
  const annual = row({ billing_period: 'annual', next_renewal_date: '2027-03-01' });
  assert.strictEqual(pauseIsActionable(annual, TODAY), false,
    'an annual plan was told to cancel with months prepaid — that forfeits money rather than saving it');
  const annualDue = row({ billing_period: 'annual', next_renewal_date: '2026-09-20' });
  assert.strictEqual(pauseIsActionable(annualDue, TODAY), true,
    'an annual plan renewing in 8 days should be actionable');
});

test('the pause email says the renewal date out loud', () => {
  const r = row({ next_renewal_date: '2026-09-16' });
  const a = computeDesiredAction(r, [], TODAY);
  // no favourites tagged -> falls through to cadence, which needs a due date
  const withDue = row({
    next_renewal_date: '2026-09-16', next_reminder_date: '2026-09-01',
    reminder_type: 'pause', reminder_source: 'cadence',
  });
  const c = computeCadenceAction(withDue, TODAY);
  assert.ok(c, 'no pause prompt produced inside the renewal window');
  assert.ok(/renews in 4 days|2026-09-16/.test(c.reason),
    `the pause reason does not mention the renewal date: "${c.reason}"`);
  assert.strictEqual(a, null, 'an untagged row produced a favourite-driven action');
});

test('a favourite-driven pause also respects the renewal window', () => {
  const favorites = [{ kind: 'show', title: 'The Last of Us', service_name: 'HBO Max', currently_airing: false, next_air_date: null }];
  const far = row({ status: 'active', next_renewal_date: '2026-11-30' });
  assert.strictEqual(computeDesiredAction(far, favorites, TODAY), null,
    'a pause email fired 79 days before the charge');
  const near = row({ status: 'active', next_renewal_date: '2026-09-15' });
  const a = computeDesiredAction(near, favorites, TODAY);
  assert.ok(a && a.action === 'pause', 'no pause email inside the renewal window');
});

// ------------------------------------------------- renewal roll-forward

test('a passed renewal date rolls forward instead of going stale', () => {
  assert.strictEqual(rollRenewal(row({ next_renewal_date: '2026-08-20' }), TODAY), '2026-09-20');
  assert.strictEqual(rollRenewal(row({ next_renewal_date: '2026-03-05' }), TODAY), '2026-10-05',
    'a badly stale monthly date did not roll all the way to the future');
  assert.strictEqual(
    rollRenewal(row({ billing_period: 'annual', next_renewal_date: '2025-11-02' }), TODAY), '2026-11-02',
    'an annual renewal rolled by a month instead of a year',
  );
});

test('a future renewal date is left alone', () => {
  assert.strictEqual(rollRenewal(row({ next_renewal_date: '2026-10-01' }), TODAY), null);
  assert.strictEqual(rollRenewal(row({ next_renewal_date: null }), TODAY), null);
});

if (failures.length) {
  console.error(`\nrefresh-shows-timing: ${passed} passed, ${failures.length} FAILED\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`refresh-shows-timing: ${passed} passed`);
