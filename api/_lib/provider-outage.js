'use strict';

// Telling "this submission cannot be analysed" apart from "the model provider
// is unavailable right now".
//
// Found on 2026-09-10, immediately after the failure path started queueing
// refunds automatically. The Anthropic account ran out of credit at roughly
// 19:32 UTC, and every report attempted after that — across nine products —
// died with a 400 saying so. Before the refund path existed, that produced
// silence. After it, it would have produced something worse: every customer
// who paid during the outage refunded in full for a problem that takes two
// minutes to fix at the billing page, their submission marked 'failed' and
// their documents left behind, with nothing to generate once the balance was
// topped up.
//
// A refund is money leaving the account, so the test for one has to be "we
// could not produce this report", not "an attempt threw". These errors say
// nothing about the submission:
//
//   - the account is out of credit, or over its spend limit
//   - the provider is rate-limiting us
//   - the provider is overloaded, or returned a 5xx
//   - the request never reached the provider at all
//
// A submission that hits one of these goes back to 'paid' rather than to
// 'failed', which is precisely the state api/generate-paid-navigator.js sweeps
// every five minutes. The work resumes on its own when the outage clears, and
// nobody is refunded for a report they are still going to get.
//
// Everything else — a document that cannot be read, a model that will not
// return a valid report after retrying, a missing extraction — is about this
// customer's submission and still fails, alerts, and refunds.

// Deliberately matched on the provider's own words rather than on status code
// alone. A 400 is normally a bad request and normally OUR fault, but the
// out-of-credit response is a 400 too, and treating it as a permanent failure
// is the exact mistake this module exists to prevent.
const OUTAGE_PATTERNS = [
  /credit balance is too low/i,
  /\bbilling\b.*\b(limit|hard limit|spend)\b/i,
  /quota (?:exceeded|exhausted)/i,
  /insufficient (?:quota|credit|funds)/i,
  /rate[_ -]?limit/i,
  /\boverloaded\b/i,
  /\bapi error 429\b/i,
  /\bapi error 5\d\d\b/i,
  /\b(?:ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED)\b/,
  /fetch failed/i,
  /network (?:error|timeout)/i,
];

function isProviderOutage(err) {
  const text = typeof err === 'string' ? err : String((err && err.message) || err || '');
  if (!text) return false;
  return OUTAGE_PATTERNS.some((re) => re.test(text));
}

// What to write onto the submission, given the error. Kept here rather than
// duplicated into each engine's catch block, because three engines had three
// different failure behaviours and that is how the hole stayed open in two of
// them for as long as it did.
//
// `paidForReal` gates the refund on a Stripe session existing, so a test row or
// a submission abandoned at checkout can never queue money it never took.
// process-refunds re-checks that and three other conditions before a cent
// moves, including that no report was ever delivered.
function failurePatch(err, { paidForReal }) {
  const error = String((err && err.message) || err || 'Unknown error').slice(0, 500);
  const now = new Date().toISOString();

  if (isProviderOutage(err)) {
    return {
      outage: true,
      // Back to the queue, not to the grave.
      patch: { status: 'paid', error, updated_at: now },
    };
  }

  const patch = { status: 'failed', error, updated_at: now };
  if (paidForReal) patch.refund_state = 'due';
  return { outage: false, patch };
}

module.exports = { isProviderOutage, failurePatch, OUTAGE_PATTERNS };
