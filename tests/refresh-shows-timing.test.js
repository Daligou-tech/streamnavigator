// Run: node tests/refresh-shows-timing.test.js
//
// The daily job sends two emails that move money: "switch this off" and
// "switch it back on". Both used to be sendable with no evidence behind them.
//
//   A paused subscription with no confirmed air date got reminder_type
//   'resume' 30 days later, and the job emailed "time to activate HBO Max —
//   it's been about a month since you paused it." TVmaze returns no next air
//   date for most shows between seasons, so that was the normal outcome of
//   pausing anything: the product undid its own saving on a 30-day loop.
//
//   A pause email could land the day after a subscription renewed, which
//   saves nothing and costs a month of access already paid for. On an annual
//   plan it is worse than nothing — it tells someone to forfeit what they
//   prepaid.
//
// The cron no longer decides any of this itself: it calls the same decide()
// the dashboard renders from, so an email can never disagree with the page.
'use strict';

const assert = require('assert');
const CRON = require('../api/refresh-shows.js');
const ENGINE = require('../navigator-streaming-engine.js');
const { computeDesiredAction, computeCadenceAction, rollRenewal, MIN_DAYS_BETWEEN_EMAILS } = CRON;

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
const fav = (over) => Object.assign({
  kind: 'show', title: 'The Last of Us', service_name: 'HBO Max',
  next_air_date: null, currently_airing: false,
}, over);

// ------------------------------------------------- no restart without a date

test('a paused subscription with no air date is never emailed to restart', () => {
  const r = row({ status: 'paused' });
  assert.strictEqual(computeDesiredAction(r, [fav()], TODAY), null,
    'an email told someone to start paying again with nothing scheduled');
});

test('a paused subscription IS restarted against a confirmed date', () => {
  const r = row({ status: 'paused' });
  const a = computeDesiredAction(r, [fav({ next_air_date: '2026-09-13' })], TODAY);
  assert.ok(a && a.action === 'activate', 'a confirmed, imminent return did not trigger a restart');
  assert.ok(/September 13/.test(a.reason), `the email does not name the date: "${a.reason}"`);
});

test('a paused subscription whose show is airing now is restarted', () => {
  const a = computeDesiredAction(row({ status: 'paused' }), [fav({ currently_airing: true })], TODAY);
  assert.ok(a && a.action === 'activate');
  assert.ok(/The Last of Us/.test(a.reason), 'the reason does not name the show');
});

test('the legacy calendar-only resume can no longer fire', () => {
  const stale = row({ status: 'paused', next_reminder_date: '2026-09-01', reminder_type: 'resume', reminder_source: 'cadence' });
  assert.strictEqual(computeCadenceAction(stale, TODAY), null,
    'a resume reminder left in the table from before the fix still fires');
});

// ------------------------------------------------------------ renewal timing

test('a pause email waits for the renewal window', () => {
  const far = row({ next_renewal_date: '2026-10-20' });
  assert.strictEqual(computeDesiredAction(far, [fav()], TODAY), null,
    'a pause email fired 38 days before the charge, wasting a month already paid for');
  const near = row({ next_renewal_date: '2026-09-16' });
  const a = computeDesiredAction(near, [fav()], TODAY);
  assert.ok(a && a.action === 'pause', 'no pause email inside the renewal window');
});

test('the pause email names the date and what it saves', () => {
  const a = computeDesiredAction(row({ next_renewal_date: '2026-09-16' }), [fav()], TODAY);
  assert.ok(/September 16/.test(a.reason), `the email does not name the renewal: "${a.reason}"`);
  assert.ok(a.decision && a.decision.savings > 0, 'the email carries no saving figure');
});

test('an annual plan is never emailed to cancel mid-term', () => {
  const annual = row({ billing_period: 'annual', monthly_price: 199, next_renewal_date: '2027-03-01' });
  assert.strictEqual(computeDesiredAction(annual, [fav()], TODAY), null,
    'an annual plan was told to cancel with months prepaid — that forfeits money');
  const due = row({ billing_period: 'annual', monthly_price: 199, next_renewal_date: '2026-09-20' });
  const a = computeDesiredAction(due, [fav()], TODAY);
  assert.ok(a && a.action === 'pause', 'an annual plan renewing in 8 days should be actionable');
});

test('a subscription with nothing tagged is never emailed about', () => {
  assert.strictEqual(computeDesiredAction(row({ next_renewal_date: '2026-09-16' }), [], TODAY), null,
    'the job emailed about a service the customer never told us anything about');
});

test('a service with something airing is never emailed about', () => {
  assert.strictEqual(computeDesiredAction(row({ next_renewal_date: '2026-09-16' }), [fav({ currently_airing: true })], TODAY), null,
    'the job emailed a pause for a service actively showing something they watch');
});

// ------------------------------------------------------- one email per month

test('there is a hard floor of one email per service per 30 days', () => {
  assert.strictEqual(MIN_DAYS_BETWEEN_EMAILS, 30, 'the email floor is not 30 days');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'api', 'refresh-shows.js'), 'utf8');
  assert.ok(/since < MIN_DAYS_BETWEEN_EMAILS\) continue/.test(src),
    'the 30-day floor is defined but never enforced at the send site');
});

// ------------------------------------------------- one engine, not two

test('the cron decides with the same engine the dashboard renders', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'api', 'refresh-shows.js'), 'utf8');
  assert.ok(/require\('\.\.\/navigator-streaming-engine\.js'\)/.test(src),
    'the cron has stopped using the shared engine and will drift from the dashboard again');
  // And the answers actually match.
  const r = row({ next_renewal_date: '2026-09-16' });
  const direct = ENGINE.decide(ENGINE.rowToSubscription(r), [fav()].map(ENGINE.favoriteToItem), TODAY);
  const viaCron = computeDesiredAction(r, [fav()], TODAY);
  assert.strictEqual(direct.action, 'suspend');
  assert.strictEqual(viaCron.reason, direct.why, 'the email text and the dashboard text have diverged');
});

// ------------------------------------------------------- renewal roll-forward

test('a passed renewal date rolls forward instead of going stale', () => {
  assert.strictEqual(rollRenewal(row({ next_renewal_date: '2026-08-20' }), TODAY), '2026-09-20');
  assert.strictEqual(rollRenewal(row({ next_renewal_date: '2026-03-05' }), TODAY), '2026-10-05',
    'a badly stale monthly date did not roll all the way to the future');
  assert.strictEqual(rollRenewal(row({ billing_period: 'annual', next_renewal_date: '2025-11-02' }), TODAY), '2026-11-02',
    'an annual renewal rolled by a month instead of a year');
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
