// Run: node tests/streaming-checkout.test.js
//
// Two ways the $19.99/yr checkout would have taken money and delivered less
// than the page promises, found on 2026-09-27 before the Payment Link existed:
//
//   1. api/stripe-webhook.js filed 1999 cents under the 'pro' fallback, and
//      household invites require 'family' -- so "Everyone in the house, one
//      price" was refused to the people who paid for it.
//   2. /streaming's Subscribe button went straight to Stripe with no
//      client_reference_id, which the webhook skips: charged, nothing unlocked.
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}\n    ${err.message.split('\n')[0]}`); }
}
function assert(ok, msg) { if (!ok) throw new Error(msg); }

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const { planFromSubscription } = require('../api/stripe-webhook.js');
const sub = (cents) => ({ items: { data: [{ price: { unit_amount: cents } }] } });

test('the $19.99/yr tier unlocks the household it promises', () => {
  assert(planFromSubscription(sub(1999)) === 'family', `1999 -> ${planFromSubscription(sub(1999))}`);
  assert(/plan !== 'family'/.test(read('api/invite-household-member.js')),
    'household invites no longer gate on family; revisit this test');
});

test('both pages still sell the tier as household-inclusive', () => {
  assert(/Everyone in the house, one price/.test(read('streaming.html')), 'streaming.html promise changed');
  assert(/Everyone in the household, one price/.test(read('dashboard.html')), 'dashboard.html promise changed');
});

test('/streaming sends a live Subscribe click through sign-in, not straight to Stripe', () => {
  const page = read('streaming.html');
  assert(/link\.dataset\.stripeLink === 'annual'[\s\S]{0,300}dashboard\.html#subscribe/.test(page),
    'the annual button no longer routes to dashboard.html#subscribe');
});

test('the dashboard forwards #subscribe to the Payment Link carrying the account', () => {
  const dash = read('dashboard.html');
  assert(/hash === '#subscribe'[\s\S]{0,600}window\.location\.href = a\.href/.test(dash), '#subscribe handoff missing');
  assert(/searchParams\.set\('client_reference_id', user\.id\)/.test(dash), 'upgrade link no longer carries client_reference_id');
  assert(dash.indexOf('wireUpgradeLinks(user);') < dash.indexOf("hash === '#subscribe'"),
    'the handoff runs before the link is tagged with the account');
});

console.log(`${passed}/${passed + failures.length} passed`);
if (failures.length) { failures.forEach((f) => console.log(`FAIL ${f}`)); process.exit(1); }
