// One payment buys a year of audits on one property.
//
// The page sold exactly that for months against nothing at all — no entitlement
// column, no re-run path, no job that ever looked at a property twice. The
// claim came off on 2026-09-09. These are the rules it goes back on under, and
// the two that matter most are the ones that stop it being given away: a year
// cannot extend itself, and it cannot be claimed by anyone who merely knows the
// customer's email address.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  grantEntitlement, checkEntitlement, consumeEntitlement,
  ENTITLEMENT_MONTHS, RUNS_ALLOWED, _internal,
} = require('../api/_lib/rental-entitlement');

const reminders = require('../api/rental-reminders')._internal;

// --- a tiny stand-in for the two tables these functions touch ---------------

function fakeAdmin({ submissions = [], entitlements = [] } = {}) {
  const state = { submissions, entitlements, inserted: [], updates: [] };

  function table(name) {
    const rows = name === 'navigator_submissions' ? state.submissions : state.entitlements;
    const q = {
      _filters: [],
      _payload: null,
      _mode: null,
      select() { return q; },
      eq(col, val) { q._filters.push([col, val]); return q; },
      gt() { return q; },
      order() { return q; },
      limit() { return q; },
      upsert(payload, opts) { q._mode = 'upsert'; q._payload = payload; q._opts = opts; return q; },
      update(payload) { q._mode = 'update'; q._payload = payload; return q; },
      insert(payload) { q._mode = 'insert'; q._payload = payload; return q; },
      _match() {
        return rows.filter((r) => q._filters.every(([c, v]) => r[c] === v));
      },
      then(resolve) { return Promise.resolve(q._run()).then(resolve); },
      maybeSingle() { return Promise.resolve(q._run(true)); },
      single() { return Promise.resolve(q._run(true)); },
      _run(single) {
        if (q._mode === 'upsert') {
          const existing = rows.find((r) => r.source_submission_id === q._payload.source_submission_id);
          if (existing) return { data: null, error: null };      // ignoreDuplicates
          const row = Object.assign({ id: `ent_${rows.length + 1}` }, q._payload);
          rows.push(row);
          state.inserted.push(row);
          return { data: row, error: null };
        }
        if (q._mode === 'update') {
          const hits = q._match();
          hits.forEach((r) => Object.assign(r, q._payload));
          state.updates.push({ filters: q._filters, payload: q._payload, changed: hits.length });
          return { data: hits.length ? hits[0] : null, error: null };
        }
        const hits = q._match();
        return { data: single ? (hits[0] || null) : hits, error: null };
      },
    };
    return q;
  }

  return { from: table, _state: state };
}

const PAID_SUBMISSION = {
  id: 'sub_1',
  product: 'rental',
  email: 'landlord@example.com',
  access_token: 'tok_1',
  price_cents: 14900,
  is_test: true,
};

const EXTRACTION = { property: { address: '1428 Garfield Ave, Kansas City, MO 64127' } };

// --- granting ---------------------------------------------------------------

test('a delivered report grants twelve months and counts itself as the first audit', async () => {
  const admin = fakeAdmin();
  const granted = await grantEntitlement(admin, PAID_SUBMISSION, EXTRACTION);
  assert.ok(granted);
  assert.equal(granted.runs_allowed, RUNS_ALLOWED);
  assert.equal(granted.runs_used, 1, 'the report they just read is one of the four');

  const months = (new Date(granted.expires_at).getUTCFullYear() - new Date().getUTCFullYear()) * 12
    + (new Date(granted.expires_at).getUTCMonth() - new Date().getUTCMonth());
  assert.equal(months, ENTITLEMENT_MONTHS);
  assert.equal(admin._state.entitlements[0].property_address, '1428 Garfield Ave, Kansas City, MO 64127');
});

test('a re-audit spent from an entitlement never grants another one', async () => {
  // Otherwise the first $149 buys a year, the free re-run inside it buys
  // another year, and the product is free forever after one purchase.
  const admin = fakeAdmin();
  const free = Object.assign({}, PAID_SUBMISSION, { id: 'sub_2', price_cents: 0 });
  assert.equal(await grantEntitlement(admin, free, EXTRACTION), null);
  assert.equal(admin._state.entitlements.length, 0);
});

test('granting twice for one submission does not hand out two years', async () => {
  const admin = fakeAdmin();
  await grantEntitlement(admin, PAID_SUBMISSION, EXTRACTION);
  await grantEntitlement(admin, PAID_SUBMISSION, EXTRACTION);
  assert.equal(admin._state.entitlements.length, 1, 'a regenerated report is not a second purchase');
});

test('nothing is granted for another product, or without an email to reach', async () => {
  const admin = fakeAdmin();
  assert.equal(await grantEntitlement(admin, Object.assign({}, PAID_SUBMISSION, { product: 'hoa' }), EXTRACTION), null);
  assert.equal(await grantEntitlement(admin, Object.assign({}, PAID_SUBMISSION, { email: null }), EXTRACTION), null);
  assert.equal(await grantEntitlement(admin, null, EXTRACTION), null);
});

// --- claiming ---------------------------------------------------------------

test('an entitlement is claimed with the report token, not with an email address', async () => {
  const admin = fakeAdmin({ submissions: [PAID_SUBMISSION] });
  await grantEntitlement(admin, PAID_SUBMISSION, EXTRACTION);

  const good = await checkEntitlement(admin, 'sub_1', 'tok_1');
  assert.equal(good.active, true);
  assert.equal(good.runsLeft, RUNS_ALLOWED - 1);

  const guessed = await checkEntitlement(admin, 'sub_1', 'not-the-token');
  assert.equal(guessed.active, false);
  assert.equal(guessed.reason, 'bad_token',
    'knowing a customer\'s email must not be enough to spend their audits');
});

test('an expired or fully spent year is refused, and says which', async () => {
  const admin = fakeAdmin({ submissions: [PAID_SUBMISSION] });
  await grantEntitlement(admin, PAID_SUBMISSION, EXTRACTION);
  const row = admin._state.entitlements[0];

  row.expires_at = new Date(Date.now() - 86400000).toISOString();
  assert.equal((await checkEntitlement(admin, 'sub_1', 'tok_1')).reason, 'expired');

  row.expires_at = new Date(Date.now() + 86400000).toISOString();
  row.runs_used = row.runs_allowed;
  const spent = await checkEntitlement(admin, 'sub_1', 'tok_1');
  assert.equal(spent.reason, 'spent');
  assert.equal(spent.runsLeft, 0);
});

test('a submission with no entitlement answers plainly rather than erroring', async () => {
  const admin = fakeAdmin({ submissions: [PAID_SUBMISSION] });
  const none = await checkEntitlement(admin, 'sub_1', 'tok_1');
  assert.deepEqual(none, { active: false, reason: 'none' });
  assert.equal((await checkEntitlement(admin, 'nope', 'tok_1')).reason, 'not_found');
  assert.equal((await checkEntitlement(admin, '', '')).reason, 'missing_credentials');
});

// --- spending ---------------------------------------------------------------

test('spending a run is conditional, so two tabs cannot both take the last one', async () => {
  const admin = fakeAdmin({ submissions: [PAID_SUBMISSION] });
  await grantEntitlement(admin, PAID_SUBMISSION, EXTRACTION);
  const row = admin._state.entitlements[0];
  row.runs_used = RUNS_ALLOWED - 1;                      // one left

  assert.equal(await consumeEntitlement(admin, row.id), true);
  assert.equal(row.runs_used, RUNS_ALLOWED);
  assert.equal(await consumeEntitlement(admin, row.id), false, 'the second attempt gets nothing');

  const update = admin._state.updates[admin._state.updates.length - 1];
  assert.ok(update === undefined || update.filters.some(([c]) => c === 'runs_used'),
    'the update must be conditional on the count it read');
});

test('an expired year cannot be spent even by id', async () => {
  const admin = fakeAdmin({ submissions: [PAID_SUBMISSION] });
  await grantEntitlement(admin, PAID_SUBMISSION, EXTRACTION);
  const row = admin._state.entitlements[0];
  row.expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal(await consumeEntitlement(admin, row.id), false);
});

test('twelve months from the end of a month lands in the same month', () => {
  const { addMonths } = _internal;
  assert.equal(addMonths(new Date(Date.UTC(2026, 0, 31)), 12).toISOString().slice(0, 10), '2027-01-31');
  // 29 Feb 2028 + 12 months has no 29 Feb to land on; clamp rather than roll
  // into March, so an entitlement never quietly gains a day.
  assert.equal(addMonths(new Date(Date.UTC(2028, 1, 29)), 12).toISOString().slice(0, 10), '2029-02-28');
});

// --- the reminder -----------------------------------------------------------

test('a reminder fires in the window where a renewal can still be acted on', () => {
  const { daysUntil, parseLeaseEnd, LEAD_DAYS_MIN, LEAD_DAYS_MAX } = reminders;
  const inWindow = new Date(Date.now() + 30 * 86400000);
  assert.ok(daysUntil(inWindow) <= LEAD_DAYS_MAX && daysUntil(inWindow) >= LEAD_DAYS_MIN);
  assert.ok(daysUntil(new Date(Date.now() + 200 * 86400000)) > LEAD_DAYS_MAX, 'too far out to be useful');
  assert.ok(daysUntil(new Date(Date.now() + 5 * 86400000)) < LEAD_DAYS_MIN,
    'too late — a notice period will not fit');
  assert.equal(parseLeaseEnd('11/30/2026').toISOString().slice(0, 10), '2026-11-30');
  assert.equal(parseLeaseEnd('2026-11-30').toISOString().slice(0, 10), '2026-11-30');
  assert.equal(parseLeaseEnd('sometime in November'), null);
});

test('the reminder carries the finding that unit was flagged for', () => {
  const report = {
    sections: [
      { title: 'Top findings', items: [
        'Repair schedule does not foot: $500 unexplained.',
        'Unit 1 rents for $950 against a $1,262.50 median for identical units in the same building.',
      ] },
    ],
  };
  const found = reminders.rentFindingForUnit(report, '1');
  assert.ok(found && /1,262\.50/.test(found),
    'without this the email is a calendar alert; with it, it is the reason they bought the report');
  assert.equal(reminders.rentFindingForUnit(report, '4'), null, 'no finding for that unit, no claim about it');
  assert.equal(reminders.rentFindingForUnit(null, '1'), null);
});

test('the reminder email says what was found, what is included, and how to stop it', () => {
  const { subject, text } = reminders.buildEmail({
    unitId: '1',
    leaseEnd: '11/30/2026',
    days: 31,
    address: '1428 Garfield Ave',
    finding: 'Unit 1 rents for $950 against a $1,262.50 median for identical units in the same building.',
    runsLeft: 3,
    expiresAt: new Date(Date.UTC(2027, 8, 9)).toISOString(),
    unsubscribeUrl: 'https://streamnavigator.ai/unsubscribe',
  });
  assert.ok(/Unit 1/.test(subject) && /11\/30\/2026/.test(subject));
  assert.ok(/1,262\.50/.test(text), 'the finding itself, not a summary of it');
  assert.ok(/3 more reports/.test(text), 'and what they already have');
  assert.ok(/notice period/.test(text), 'with the caveat that stops this being legal advice');
  assert.ok(/unsubscribe/i.test(text), 'this is a mail we send, not one they asked for');
});

test('a reminder for a landlord with no findings on that unit still reads honestly', () => {
  const { text } = reminders.buildEmail({
    unitId: 'B', leaseEnd: '01/31/2027', days: 40, address: null, finding: null,
    runsLeft: 0, expiresAt: new Date().toISOString(), unsubscribeUrl: 'https://streamnavigator.ai/unsubscribe',
  });
  assert.ok(!/flagged this unit/.test(text), 'no finding must not be dressed up as one');
  assert.ok(/used all the audits/.test(text), 'and a spent entitlement is not offered as available');
});
