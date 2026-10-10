'use strict';
// The pre-checkout gate: only a billing refusal closes it; anything else lets the sale through.
const test = require('node:test');
const assert = require('node:assert');
const health = require('../api/_lib/provider-health');

const reply = (status, body) => async () => ({ ok: status < 300, status, text: async () => body });

test('closes on an out-of-credit refusal', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  health._setFetch(reply(400, '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}'));
  assert.deepStrictEqual(await health.canTakePaidWork(), { ok: false, reason: 'provider_billing' });
});

test('stays open when the provider answers', async () => {
  health._setFetch(reply(200, '{}'));
  assert.strictEqual((await health.canTakePaidWork()).ok, true);
});

test('stays open on overload, rate limit or network failure', async () => {
  for (const f of [reply(529, 'overloaded'), reply(429, 'rate_limit_error'), async () => { throw new Error('fetch failed'); }]) {
    health._setFetch(f);
    assert.strictEqual((await health.canTakePaidWork()).ok, true);
  }
});

test('stays open without an API key', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  health._setFetch(async () => { throw new Error('should not be called'); });
  assert.strictEqual((await health.canTakePaidWork()).ok, true);
});
