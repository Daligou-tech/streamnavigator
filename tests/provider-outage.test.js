// Which failures are the customer's problem, and which are ours.
//
// This module decides whether a paid submission is marked 'failed' with a
// refund on its way, or put back on the queue to be retried. Getting it
// backwards is expensive in both directions: too narrow and an outage refunds
// every customer who paid during it, too broad and a genuinely undeliverable
// report sits at 'paid' forever while the customer waits.
//
// The case that produced it: on 2026-09-10 the Anthropic account ran out of
// credit at roughly 19:32 UTC and every report attempted afterwards died with
// a 400. The automatic refund had been added hours earlier. Without this
// module, the next sweep would have refunded a queue of customers for a
// two-minute billing fix.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isProviderOutage, failurePatch } = require('../api/_lib/provider-outage');

// Verbatim from the row that failed in production. If this one ever stops
// matching, the defect is back.
const REAL_CREDIT_ERROR = 'Anthropic API error 400: {"type":"error","error":'
  + '{"type":"invalid_request_error","message":"Your credit balance is too low to access '
  + 'the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},'
  + '"request_id":"req_011CevY7Tw88j3RsNRVFF3wN"}';

test('the error that actually took production down is an outage', () => {
  assert.equal(isProviderOutage(new Error(REAL_CREDIT_ERROR)), true,
    'this exact string is what nine products died on; it is the reason this file exists');
});

test('a 400 is not automatically our fault', () => {
  // The trap. Out-of-credit arrives as a 400, and 400 normally means we sent a
  // bad request — so a classifier keyed on status code alone gets this exactly
  // wrong, and gets it wrong in the direction that spends money.
  assert.equal(isProviderOutage(new Error('Anthropic API error 400: invalid base64 in document block')), false);
  assert.equal(isProviderOutage(new Error(REAL_CREDIT_ERROR)), true);
});

test('rate limits, overload and 5xx are the provider, not the submission', () => {
  for (const message of [
    'Anthropic API error 429: rate_limit_error',
    'Anthropic API error 529: {"type":"overloaded_error"}',
    'Anthropic API error 500: internal server error',
    'Anthropic API error 503: service unavailable',
    'fetch failed',
    'request to api.anthropic.com failed, reason: ECONNRESET',
    'getaddrinfo EAI_AGAIN api.anthropic.com',
  ]) {
    assert.equal(isProviderOutage(new Error(message)), true, `should be an outage: ${message}`);
  }
});

test('a failure about this submission is still a failure', () => {
  for (const message of [
    'Could not read any of the attached documents for this submission.',
    'Failed to generate a valid report after retrying',
    'Model returned a report with no sections',
    'Report generation hit the output limit and was truncated — not saved.',
    'This closing submission has no stored extraction — the free scorecard step did not complete.',
    'Submission not found',
    'Missing ANTHROPIC_API_KEY env var',
  ]) {
    assert.equal(isProviderOutage(new Error(message)), false, `should NOT be an outage: ${message}`);
  }
});

// A missing API key deserves its own line of reasoning. It looks like an
// infrastructure problem and it is one — but retrying cannot fix it, and a row
// left at 'paid' would be swept every five minutes forever. It fails, alerts,
// and refunds, which is the outcome that gets a person to look at it.
test('a missing API key fails rather than looping on the queue', () => {
  const { outage, patch } = failurePatch(new Error('Missing ANTHROPIC_API_KEY env var'), { paidForReal: true });
  assert.equal(outage, false);
  assert.equal(patch.status, 'failed');
  assert.equal(patch.refund_state, 'due');
});

// --- what gets written onto the row -----------------------------------------

test('an outage goes back on the queue and refunds nobody', () => {
  const { outage, patch } = failurePatch(new Error(REAL_CREDIT_ERROR), { paidForReal: true });
  assert.equal(outage, true);
  assert.equal(patch.status, 'paid',
    "'paid' is the state api/generate-paid-navigator.js sweeps — the work resumes on its own");
  assert.equal(patch.refund_state, undefined,
    'refunding a customer whose report is still coming is the failure mode this prevents');
  assert.ok(patch.error.includes('credit balance'), 'the cause is still recorded for whoever looks');
});

test('a real failure on a paid submission returns the money', () => {
  const { outage, patch } = failurePatch(new Error('Model returned a report with no sections'), { paidForReal: true });
  assert.equal(outage, false);
  assert.equal(patch.status, 'failed');
  assert.equal(patch.refund_state, 'due');
});

test('a submission that never paid cannot queue a refund', () => {
  // Test rows and abandoned checkouts. process-refunds re-checks this, but the
  // guard belongs at both ends: money is the one thing not to be relaxed about.
  const { patch } = failurePatch(new Error('Model returned a report with no sections'), { paidForReal: false });
  assert.equal(patch.status, 'failed');
  assert.equal(patch.refund_state, undefined);
});

test('the error is always recorded, and always bounded', () => {
  const long = new Error('x'.repeat(4000));
  const { patch } = failurePatch(long, { paidForReal: false });
  assert.equal(patch.error.length, 500, 'the column is bounded and a silent truncation error helps nobody');
  const { patch: empty } = failurePatch(null, { paidForReal: false });
  assert.ok(empty.error, 'a failure with no message still has to say something');
});

// --- the engines agree on the definition ------------------------------------

test('every engine that can be billed uses the shared classifier', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const LIB = path.join(__dirname, '..', 'api', '_lib');
  const missing = [];
  for (const file of ['navigator-engine.js', 'contractor-engine.js', 'purchase-engine.js', 'hoa-engine.js']) {
    const src = fs.readFileSync(path.join(LIB, file), 'utf8');
    if (!/require\('\.\/provider-outage'\)/.test(src)) missing.push(file);
  }
  assert.deepEqual(missing, [],
    'these engines each call the Anthropic API and each can be caught by an outage. Four '
    + 'private definitions of "is this our fault" is how two of them went a month without '
    + `one at all:\n  ${missing.join('\n  ')}`);
});

test('no engine marks a paid submission failed without considering a refund', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const LIB = path.join(__dirname, '..', 'api', '_lib');
  const offenders = [];
  for (const file of ['navigator-engine.js', 'contractor-engine.js', 'purchase-engine.js', 'hoa-engine.js']) {
    const src = fs.readFileSync(path.join(LIB, file), 'utf8');
    // Either it builds the patch through the shared helper, or it sets
    // refund_state itself the way hoa-engine has always done.
    const viaHelper = /failurePatch\(/.test(src);
    const byHand = /refund_state\s*=\s*'due'/.test(src);
    if (!viaHelper && !byHand) offenders.push(file);
  }
  assert.deepEqual(offenders, [],
    'a customer who paid and received nothing is owed the money back without having to ask '
    + `for it:\n  ${offenders.join('\n  ')}`);
});
