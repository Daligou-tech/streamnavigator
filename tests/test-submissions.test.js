// Which submissions get marked as internal testing.
//
// The asymmetry here is the whole point, so the false-positive cases below
// matter more than the true-positive ones. Marking a test row as a customer
// costs one wrong number in a count. Marking a CUSTOMER as a test hides the
// event the flag exists to reveal -- the first real conversion -- and hides it
// silently, in the one direction nobody thinks to check. Every rule is
// therefore anchored on domains that cannot be delegated to a real person
// (RFC 2606 / RFC 6761) or on a tag the tester puts there deliberately.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isTestEmail } = require('../api/_lib/test-submissions');

// --- must never be treated as a customer ------------------------------------

test('reserved TLDs are test addresses', () => {
  for (const a of [
    'claude-verification-test@internal.invalid',
    'someone@foo.test',
    'someone@thing.example',
    'dev@app.localhost',
  ]) {
    assert.equal(isTestEmail(a), true, a);
  }
});

test('reserved example domains are test addresses', () => {
  for (const a of ['a@example.com', 'b@example.net', 'c@example.org']) {
    assert.equal(isTestEmail(a), true, a);
  }
});

test('a +test or +qa subaddress marks a run on a real mailbox', () => {
  for (const a of [
    'owner+test@gmail.com',
    'owner+qa@gmail.com',
    'owner+test1@gmail.com',
    'owner+qa3@gmail.com',
    'owner+test-closing@gmail.com',
    'owner+qa_hoa@gmail.com',
  ]) {
    assert.equal(isTestEmail(a), true, a);
  }
});

test('case and surrounding whitespace do not matter', () => {
  assert.equal(isTestEmail('  Owner+TEST@Gmail.com '), true);
  assert.equal(isTestEmail('CLAUDE@INTERNAL.INVALID'), true);
});

// --- the direction that actually costs something ----------------------------

test('a real customer is never marked as a test', () => {
  for (const a of [
    'ntarikm@yahoo.com',
    'jane.doe@gmail.com',
    'buyer@remax.com',
    'someone@test-drive-realty.com',   // "test" in the domain, not the TLD
    'protester@gmail.com',             // "test" inside a word
    'testa@gmail.com',                 // starts with "test", no + tag
    'contest@outlook.com',
    'quality@qa-partners.com',         // "qa" in the domain, not a tag
    'owner+newsletter@gmail.com',      // a tag, but not a test tag
    'owner+latest@gmail.com',          // "test" inside a longer tag
    'owner+testimonials@gmail.com',    // ditto, and a plausible real tag
    'owner+qatar@gmail.com',           // "qa" inside a longer word
  ]) {
    assert.equal(isTestEmail(a), false, a);
  }
});

// --- inputs that are not addresses ------------------------------------------

test('a missing or malformed address is not assumed to be a test', () => {
  // Submissions may carry no email at all. Defaulting those to "test" would
  // quietly delete real customers from every count.
  for (const a of [null, undefined, '', '   ', 'not-an-email', '@nodomain.com',
    'nolocal@', 42, {}, []]) {
    assert.equal(isTestEmail(a), false, String(a));
  }
});

test('an address with several @ signs is judged on the real domain', () => {
  assert.equal(isTestEmail('weird@name@example.com'), true);
  assert.equal(isTestEmail('weird@name@gmail.com'), false);
});
