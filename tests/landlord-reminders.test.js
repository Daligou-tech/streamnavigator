// The half of the promise the report cannot keep on its own.
//
// "Never miss a rental compliance deadline again" sat on this page over a
// product that looked at a property once and never again. The audit of
// 2026-09-10 graded it 0 of 5 on confirming a result and rated the headline
// false. The deterministic engine fixed what the report says; the reminder is
// what makes the deadline part true, and these are the rules it has to keep.
//
// The one that matters most: a reminder must never print a figure the report
// itself refuses to print. A wrong notice period in an email a landlord acts on
// immediately is worse than the silence this replaced.

'use strict';

const test = require('node:test');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Source-matching tests compare against literal text that spans lines, and
// this repo checks out CRLF on Windows — so a matcher written with a bare
// newline finds nothing, and the assertion fails for a reason that has
// nothing to do with the code. Normalising here keeps the suite honest on
// both checkouts.
const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
function readSource(name) {
  return fs.readFileSync(path.join(ROOT, 'api', name), 'utf8').split(CRLF).join('\n');
}
const { __internal: I } = require('../api/landlord-reminders.js');
const { ENTITLED_PRODUCTS } = require('../api/_lib/rental-entitlement');

const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// --- what falls due ---------------------------------------------------------

test('a renewal inside the window fires, one further out does not', () => {
  const soon = I.dueFor({ label: 'Cedar St', registration_expires: inDays(30) }, 0);
  assert.equal(soon.length, 1);
  assert.equal(soon[0].kind, 'registration');
  assert.equal(soon[0].days, 30);

  assert.deepEqual(I.dueFor({ label: 'Cedar St', registration_expires: inDays(200) }, 0), []);
});

test('a lease inside the decision window fires', () => {
  const due = I.dueFor({ label: 'Ashwood', lease_ends: inDays(60) }, 0);
  assert.equal(due.length, 1);
  assert.equal(due[0].kind, 'lease');
});

test('a property with no dates produces nothing — we never invent one', () => {
  assert.deepEqual(I.dueFor({ city: 'Austin', state: 'TX' }, 0), [],
    'this product does not guess a renewal date, so it must not remind against one');
});

test('a date already past produces nothing', () => {
  assert.deepEqual(I.dueFor({ label: 'Lapsed', registration_expires: inDays(-10) }, 0), [],
    'the report covers what has already lapsed; a reminder is about what is still ahead, '
    + 'and we cannot tell whether they have since renewed');
});

test('one property can hold both kinds without either blocking the other', () => {
  const due = I.dueFor({ label: 'Cedar St', registration_expires: inDays(30), lease_ends: inDays(60) }, 0);
  assert.equal(due.length, 2);
  const keys = due.map((d) => d.key);
  assert.equal(new Set(keys).size, 2, 'the claim keys must differ or the second reminder is swallowed');
  assert.ok(keys.every((k) => /:(registration|lease)$/.test(k)));
});

test('properties are keyed distinctly even when the landlord names none of them', () => {
  const a = I.propertyKey({ city: 'Denver', state: 'CO' }, 0);
  const b = I.propertyKey({ city: 'Seattle', state: 'WA' }, 1);
  const c = I.propertyKey({}, 2);
  assert.equal(new Set([a, b, c]).size, 3,
    'two properties sharing a claim key means one of them silently never gets reminded');
});

// --- what the mail may say --------------------------------------------------

test('no reminder states a notice period, a fee, or a citation', () => {
  // The engine holds none of these and neither does this. The countdown on the
  // customer's own date is the one number either is allowed to print.
  const items = [
    I.dueFor({ label: 'A', registration_expires: inDays(30) }, 0)[0],
    I.dueFor({ label: 'A', lease_ends: inDays(70) }, 0)[0],
  ];
  const MONEY = /\$\s?\d/;
  const CITATION = /§|\b(?:ordinance|statute|code section|chapter)\s+[\d.-]+/i;
  // A specific, actionable period presented as theirs — as opposed to the
  // hedged "commonly runs from thirty to ninety days", which is spelled out in
  // words and explicitly disclaimed in the same sentence.
  const PERIOD = /\b(?:you (?:must|have to) give|your notice period is|requires? \d+ days)\b/i;

  for (const item of items) {
    const { subject, text } = I.buildEmail({ item, link: 'https://example.test/r', runsLeft: 2 });
    assert.equal(MONEY.test(text + subject), false, `a dollar figure leaked into a ${item.kind} reminder`);
    assert.equal(CITATION.test(text + subject), false, `a citation leaked into a ${item.kind} reminder`);
    assert.equal(PERIOD.test(text), false, `a ${item.kind} reminder states a notice period as settled`);
  }
});

test('every reminder carries the countdown, the date, and the way back to the report', () => {
  const item = I.dueFor({ label: 'Cedar St', registration_expires: inDays(45) }, 0)[0];
  const { subject, text } = I.buildEmail({ item, link: 'https://example.test/r?id=1&t=2', runsLeft: 3 });
  assert.match(subject, /Cedar St/, 'a landlord with six properties needs to know which one this is');
  assert.match(text, /45 days/);
  assert.match(text, /https:\/\/example\.test\/r\?id=1&t=2/,
    'the report is where the office to call is named — a reminder without it is a worry, not a task');
});

test('the lease reminder says plainly that it will not print your period', () => {
  const item = I.dueFor({ label: 'A', lease_ends: inDays(70) }, 0)[0];
  const { text } = I.buildEmail({ item, link: 'x', runsLeft: 0 });
  assert.match(text, /we do not print your\s+exact period/i,
    'refusing to print it is only honest if the customer is told that is what happened');
});

test('re-runs are offered when they exist and not claimed when they do not', () => {
  const item = I.dueFor({ label: 'A', registration_expires: inDays(30) }, 0)[0];
  assert.match(I.buildEmail({ item, link: 'x', runsLeft: 2 }).text, /2 re-runs left/);
  assert.equal(/re-run/.test(I.buildEmail({ item, link: 'x', runsLeft: 0 }).text), false,
    'offering a re-run that does not exist is the kind of small lie this whole audit was about');
});

test('every reminder tells the customer how to stop receiving them', () => {
  for (const kind of ['registration_expires', 'lease_ends']) {
    const item = I.dueFor({ label: 'A', [kind]: inDays(40) }, 0)[0];
    assert.match(I.buildEmail({ item, link: 'x', runsLeft: 1 }).text, /STOP/,
      'unsolicited mail with no way out is a complaint, not a product');
  }
});

// --- wiring -----------------------------------------------------------------

test('landlord is entitled, and the job is actually scheduled', () => {
  assert.ok(ENTITLED_PRODUCTS.includes('landlord'),
    'the reminder can only mail a product the page is allowed to sell a year for');
  const crons = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).crons || [];
  assert.ok(crons.some((c) => c.path === '/api/landlord-reminders'),
    'an unscheduled reminder is the exact defect this replaced — code that exists and never runs');
});

test('the job refuses to run unauthenticated', () => {
  const src = readSource('landlord-reminders.js');
  assert.ok(/CRON_SECRET/.test(src) && /401/.test(src),
    'a public endpoint that sends mail on demand is a spam relay');
});

test('the claim is taken before the send, and released only on a rejection', () => {
  const src = readSource('landlord-reminders.js');
  const claimAt = src.indexOf("from('rental_reminders')\n          .insert(");
  const sendAt = src.indexOf('api.resend.com');
  assert.ok(claimAt !== -1 && claimAt < sendAt,
    'sending first and recording after costs a customer the same email every morning');
  assert.ok(/\.delete\(\)/.test(src) && /send_rejected_claim_released/.test(src),
    'a rejected send must give its claim back, or one bad afternoon costs the reminder entirely');
  assert.ok(/send_error_claim_kept/.test(src),
    'an ambiguous failure must keep its claim — repeating is the worse of the two risks');
});

test('a rental entitlement is not mailed by the landlord job', () => {
  // Both products share rental_entitlements. Reading a rental row here would
  // mail a landlord reminder to somebody who bought a cash-flow audit.
  const src = readSource('landlord-reminders.js');
  assert.ok(/submission\.product !== 'landlord'/.test(src),
    'the job must check the product before mailing a row from a shared table');
});
