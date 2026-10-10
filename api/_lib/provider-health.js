'use strict';

// Can the model provider take paid work right now?
//
// provider-outage.js makes a paid report survive a short outage and refunds it
// after 24 hours. That is the right answer for an outage that starts after the
// customer paid. It is the wrong answer for one that was already under way:
// from 2026-09-13 the Anthropic account was out of credit, and every customer
// who paid in that state would have waited a day for a refund of a report we
// knew we could not write. Checking before checkout turns that into a clear
// "not available right now, you have not been charged".
//
// Only billing-type refusals close the gate. Rate limits, overloads and network
// errors are what the retry queue exists for, so they let the sale through, as
// does anything this check does not understand: a broken health check must not
// be able to stop the business taking orders.

const BILLING_PATTERNS = [
  /credit balance is too low/i,
  /\bbilling\b.*\b(limit|hard limit|spend)\b/i,
  /quota (?:exceeded|exhausted)/i,
  /insufficient (?:quota|credit|funds)/i,
];

const HEALTHY_TTL_MS = 10 * 60 * 1000;
const UNHEALTHY_TTL_MS = 2 * 60 * 1000;
const PROBE_MODEL = 'claude-sonnet-5'; // the model the engines use

let cache = null;
let fetchImpl = (...args) => fetch(...args);

// For tests.
function _setFetch(fn) { fetchImpl = fn; cache = null; }

async function probe() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: true, unverified: true };
  try {
    const r = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: PROBE_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) return { ok: true };
    const text = await r.text().catch(() => '');
    if (BILLING_PATTERNS.some((re) => re.test(text))) return { ok: false, reason: 'provider_billing' };
    return { ok: true, unverified: true };
  } catch (err) {
    return { ok: true, unverified: true };
  }
}

async function canTakePaidWork() {
  if (cache && Date.now() < cache.until) return cache.result;
  const result = await probe();
  cache = { result, until: Date.now() + (result.ok ? HEALTHY_TTL_MS : UNHEALTHY_TTL_MS) };
  return result;
}

module.exports = { canTakePaidWork, _setFetch, BILLING_PATTERNS };
