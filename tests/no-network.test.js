// The suite must not be able to send anything to anyone.
//
// Written after hello@streamnavigator.ai received this on 2026-09-08, and
// on every deploy before it:
//
//     StreamNavigator: a "hoa" submission failed
//     A "hoa" Navigator submission failed after exhausting every
//     retry/repair attempt — a customer paid and did not receive their
//     report.  Submission ID: sub-1  Product: hoa  Error: overloaded_error
//
// Nobody paid. sub-1 is the fixture id in hoa-engine.test.js, whose test
// "exhausting every attempt on a PAID submission queues a refund" drives a
// submission to permanent failure on purpose. That path ends in
// sendFailureAlert, which POSTs to Resend. hoa-engine.test.js stubs the
// Anthropic SDK through Module._load and never replaces global.fetch, so
// the Resend call was intercepted by nothing.
//
// It stayed invisible locally because alerts.js returns early with no
// RESEND_API_KEY set. But the suite's real home is scripts/vercel-gate.sh,
// which runs it inside the Vercel build container with the project's
// environment variables present — so the deploy gate emailed a false
// customer-lost-their-report alert every time it ran.
//
// The damage is not the mail. It is that a genuine alert now arrives
// looking exactly like the noise, which is how an alert channel dies.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Idempotent: run-all.js already loads this via --require, and requiring it
// again is a cache hit. Present so this file also works run on its own.
require('./no-network.js');

test('an unfaked fetch is blocked, by name, rather than going out', async () => {
  await assert.rejects(
    () => global.fetch('https://api.resend.com/emails', { method: 'POST' }),
    (err) => {
      assert.equal(err.code, 'TEST_NETWORK_BLOCKED');
      assert.match(err.message, /api\.resend\.com/, 'the error must name where it was going');
      assert.match(err.message, /no-network/, 'and where to read about why it did not');
      return true;
    }
  );
});

test('a suite that fakes fetch itself still wins', async () => {
  // Most suites here do exactly this. The guard must only cover what
  // nothing replaced, or it breaks every test that exercises HTTP.
  const blocked = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, json: async () => ({ mine: true }) });
    const body = await (await global.fetch('https://example.invalid')).json();
    assert.equal(body.mine, true);
  } finally {
    global.fetch = blocked;
  }
});

test('sendFailureAlert cannot email anyone from a test, even fully configured', async () => {
  // The exact conditions inside the Vercel build container: every Resend
  // variable set, and a submission that has just been marked failed.
  const blocked = global.fetch;
  const saved = {
    key: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM_EMAIL,
    to: process.env.ALERT_EMAIL_TO,
  };
  let attempts = 0;
  try {
    process.env.RESEND_API_KEY = 're_test_stub';
    process.env.RESEND_FROM_EMAIL = 'reports@send.streamnavigator.ai';
    process.env.ALERT_EMAIL_TO = 'hello@streamnavigator.ai';
    global.fetch = (...args) => { attempts++; return blocked(...args); };

    const { sendFailureAlert } = require('../api/_lib/alerts.js');
    // alerts.js swallows its own errors on purpose — a broken alert must
    // never turn a handled failure into an unhandled one — so the guard
    // showing up as a rejected fetch changes nothing about the caller.
    await sendFailureAlert({ submissionId: 'sub-1', product: 'hoa', error: 'overloaded_error', refundQueued: true });
    assert.equal(attempts, 1, 'it should still try — the guard is what stops it, not a check inside the product');
  } finally {
    global.fetch = blocked;
    if (saved.key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved.key;
    if (saved.from === undefined) delete process.env.RESEND_FROM_EMAIL; else process.env.RESEND_FROM_EMAIL = saved.from;
    if (saved.to === undefined) delete process.env.ALERT_EMAIL_TO; else process.env.ALERT_EMAIL_TO = saved.to;
  }
});

test('run-all.js loads the guard into every suite it spawns', () => {
  // Suites run as separate node processes, so the guard has to arrive on
  // the child's command line. Deleting that one flag silently restores the
  // deploy-time emails, and nothing else in the suite would notice — which
  // is exactly why it is asserted here.
  const runner = fs.readFileSync(path.join(__dirname, 'run-all.js'), 'utf8');
  assert.match(runner, /--require/, 'the runner must preload something into each child');
  assert.match(runner, /no-network\.js/, 'and that something must be the network guard');
  // The last execFileSync mention is the call; the first is the import.
  const spawnLine = runner.split('\n').filter((l) => l.includes('execFileSync(')).pop();
  assert.match(spawnLine, /--require/, 'the flag has to be on the spawn call itself, not just mentioned in a comment');
});
