// Loaded into every suite via --require (see run-all.js). Makes it
// impossible for a test to reach the network.
//
// This exists because of a real email. tests/hoa-engine.test.js drives a
// submission to permanent failure on purpose, to check that an
// undeliverable paid report queues a refund. That path ends in
// sendFailureAlert (api/_lib/alerts.js), which POSTs to Resend. Unlike
// most suites here, hoa-engine.test.js stubs the Anthropic SDK through
// Module._load rather than replacing global.fetch, so the Resend call was
// never intercepted by anything.
//
// On a laptop that is invisible: alerts.js returns early when
// RESEND_API_KEY is unset, so nothing happens and nothing looks wrong.
// The gate that runs this suite, though, is scripts/vercel-gate.sh, and it
// runs inside the Vercel build container, where the project's environment
// variables ARE set. So every single deploy sent hello@streamnavigator.ai
// an alert reading:
//
//     A "hoa" Navigator submission failed after exhausting every
//     retry/repair attempt — a customer paid and did not receive their
//     report.  Submission ID: sub-1
//
// sub-1 is the test fixture's id. Nobody paid and nothing failed. The cost
// is not the mail itself, it is that a real one now arrives looking
// identical to the noise, which is the same way an alert channel usually
// dies.
//
// Fixing alerts.js was the wrong place: nothing is wrong with it, and a
// product that checks whether it is under test is a product with a second,
// untested path through it. The right boundary is here. A test that wants
// to exercise HTTP replaces global.fetch itself — most suites in this
// folder already do — and that assignment simply wins over this one.
// Anything that did not mean to make a request gets a loud, named error
// instead of a real one going out.

'use strict';

const realFetch = global.fetch;

function blockedFetch(input) {
  const url = String((input && input.url) || input || '(unknown)');
  const err = new Error(
    `Blocked a real network request to ${url} from a test. ` +
    'Tests must not reach the network — see tests/no-network.js. ' +
    'If this suite means to exercise HTTP, assign global.fetch to a fake in the test itself.'
  );
  err.code = 'TEST_NETWORK_BLOCKED';
  return Promise.reject(err);
}

// Non-enumerable and writable, so `global.fetch = fake` in a suite still
// works exactly as before and this only covers what nothing replaced.
Object.defineProperty(global, 'fetch', {
  value: blockedFetch,
  writable: true,
  configurable: true,
  enumerable: false,
});

// Kept reachable for a suite that genuinely needs the real thing (none do
// today) so that reaching for it has to be deliberate and greppable.
global.__realFetch = realFetch;
