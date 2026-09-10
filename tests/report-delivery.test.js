// Getting a paid report to the customer who is not watching.
//
// Ten pages promise "Delivered automatically" and the only thing that sent an
// email was JavaScript on the status page. Pay, close the tab — which is the
// ordinary thing to do — and api/generate-paid-navigator.js produced a
// complete report into a row nobody was told about, reachable only through
// localStorage in the browser the purchase was made from.
//
// These are the invariants that keep the fix honest: it sends once, it never
// turns a delivered report into a failed one, and the link it sends works on a
// device that has never seen this customer before.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  deliverReportByEmail, __internal: { statusLink, body, MARKER },
} = require('../api/_lib/report-delivery');

const ROOT = path.join(__dirname, '..');

// A Supabase stand-in. Records what was written so the ordering of the claim
// against the send can be asserted, which is the part that matters.
function fakeAdmin({ submission, report }) {
  const writes = [];
  const row = { ...submission };
  return {
    writes,
    row,
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        order() { return this; },
        limit() { return this; },
        maybeSingle() {
          if (table === 'navigator_submissions') return Promise.resolve({ data: row, error: null });
          return Promise.resolve({ data: report ? { report_json: report } : null, error: null });
        },
        update(patch) {
          writes.push({ table, patch });
          Object.assign(row, patch);
          return { eq: () => Promise.resolve({ data: null, error: null }) };
        },
      };
    },
  };
}

const SUBMISSION = {
  id: 'sub-1',
  product: 'landlord',
  status: 'complete',
  email: 'landlord@example.com',
  access_token: 'tok-abc',
  form_data: {},
  stripe_checkout_session_id: 'cs_test_1',
};

const REPORT = { headline: 'Three things to fix', summary: 'x', sections: [], missing_or_uncertain: [] };

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  return Promise.resolve(fn()).finally(() => {
    for (const [k] of Object.entries(vars)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });
}

// --- the link ---------------------------------------------------------------

test('the link carries both halves of the credential and works anywhere', () => {
  const link = statusLink(SUBMISSION);
  assert.match(link, /^https:\/\/streamnavigator\.ai\/navigator-status\?/);
  const params = new URLSearchParams(link.split('?')[1]);
  assert.equal(params.get('id'), 'sub-1');
  assert.equal(params.get('t'), 'tok-abc',
    'an id on its own is not a credential — the poll endpoint refuses it');
  assert.equal(params.get('p'), 'landlord');
});

test('the page actually reads that link, and prefers it to localStorage', () => {
  // The email is worth nothing if navigator-shared.js still looks only at
  // localStorage, which is exactly the state that made a paid report reachable
  // from one browser on one device.
  const shared = fs.readFileSync(path.join(ROOT, 'navigator-shared.js'), 'utf8');
  const fn = shared.slice(shared.indexOf('function getStoredSubmission'));
  assert.ok(/URLSearchParams/.test(fn), 'getStoredSubmission never looks at the URL');
  assert.ok(/params\.get\('t'\)/.test(fn), 'it does not read the token the emailed link carries');
  assert.ok(fn.indexOf('return fromUrl') < fn.indexOf('return stored'),
    'localStorage must not win over an explicit link — that is the case the link exists for');
});

test('the email tells them the link is the way back', () => {
  const text = body(SUBMISSION, 'https://example.test/x');
  assert.match(text, /https:\/\/example\.test\/x/);
  assert.match(text, /Keep this link/i,
    'a customer who does not know the link matters will not keep it');
});

// --- sending once -----------------------------------------------------------

test('it claims the send before making it, so a slow sweep cannot double-send', async () => {
  const admin = fakeAdmin({ submission: { ...SUBMISSION, form_data: {} }, report: REPORT });
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => { calls.push(String(url)); return { ok: true, text: async () => '' }; };
  try {
    await withEnv({ RESEND_API_KEY: 'k', RESEND_FROM_EMAIL: 'a@b.c' },
      () => deliverReportByEmail(admin, 'sub-1'));
  } finally { global.fetch = realFetch; }

  assert.equal(calls.length, 1, 'exactly one email');
  assert.ok(admin.writes.length >= 1);
  assert.ok(admin.writes[0].patch.form_data[MARKER],
    'the marker is written first — between one missed email and the same report every '
    + 'five minutes forever, only the first is recoverable');
});

test('a submission already sent is not sent again', async () => {
  const admin = fakeAdmin({
    submission: { ...SUBMISSION, form_data: { [MARKER]: '2026-09-10T00:00:00Z' } },
    report: REPORT,
  });
  const realFetch = global.fetch;
  let called = 0;
  global.fetch = async () => { called += 1; return { ok: true, text: async () => '' }; };
  try {
    const result = await withEnv({ RESEND_API_KEY: 'k', RESEND_FROM_EMAIL: 'a@b.c' },
      () => deliverReportByEmail(admin, 'sub-1'));
    assert.equal(result, 'already_sent');
  } finally { global.fetch = realFetch; }
  assert.equal(called, 0);
});

// --- refusing, rather than sending the wrong thing --------------------------

test('nothing is sent for a report that is not finished, or has no report row', async () => {
  const notDone = fakeAdmin({ submission: { ...SUBMISSION, status: 'paid' }, report: REPORT });
  assert.equal(await deliverReportByEmail(notDone, 'sub-1'), 'not_complete');

  const noReport = fakeAdmin({ submission: { ...SUBMISSION }, report: null });
  assert.equal(
    await withEnv({ RESEND_API_KEY: 'k', RESEND_FROM_EMAIL: 'a@b.c' },
      () => deliverReportByEmail(noReport, 'sub-1')),
    'no_report_row');
});

test('no email address means no send, and no claim burned', async () => {
  const admin = fakeAdmin({ submission: { ...SUBMISSION, email: null }, report: REPORT });
  assert.equal(await deliverReportByEmail(admin, 'sub-1'), 'no_email_on_file');
  assert.deepEqual(admin.writes, [], 'a row we cannot deliver must stay deliverable later');
});

test('an unconfigured mail provider is reported, not treated as delivered', async () => {
  const admin = fakeAdmin({ submission: { ...SUBMISSION }, report: REPORT });
  const result = await withEnv({ RESEND_API_KEY: '', RESEND_FROM_EMAIL: '' },
    () => deliverReportByEmail(admin, 'sub-1'));
  assert.equal(result, 'email_not_configured');
  assert.deepEqual(admin.writes, [],
    'marking it sent when nothing was configured would lose the report permanently');
});

// --- the sweep --------------------------------------------------------------

test('the sweep delivers what it generates, and delivery cannot fail the report', () => {
  const sweep = fs.readFileSync(path.join(ROOT, 'api', 'generate-paid-navigator.js'), 'utf8');
  assert.ok(/deliverReportByEmail/.test(sweep),
    'this sweep exists for the customer who is not watching — it is the one path that '
    + 'must deliver, and the only one that was not delivering');

  const loop = sweep.slice(sweep.indexOf('for (const row of waiting'), sweep.indexOf('res.status(200)'));
  const deliveryAt = loop.indexOf('deliverReportByEmail');
  const tryAt = loop.lastIndexOf('try {', deliveryAt);
  assert.ok(tryAt !== -1 && deliveryAt !== -1,
    'the delivery call is not wrapped — a mail provider outage would mark a produced '
    + 'report failed and queue a refund for work that was actually done');
});
