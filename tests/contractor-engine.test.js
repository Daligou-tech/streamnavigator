'use strict';

// api/_lib/contractor-engine.js end to end, with Supabase and the Anthropic API
// both faked, so this costs nothing and touches nothing.
//
// Three things are being asserted, and they are the three that decide whether a
// customer gets what they paid for:
//
//   1. The model never gets to invent a finding. It is handed the audit's
//      output and not the documents, and if it falls over the report still
//      ships with every finding, figure and email intact.
//   2. A report too thin to be worth $49 refunds itself, without the customer
//      having to notice or ask.
//   3. A provider outage parks the row at 'paid' rather than failing it and
//      refunding work the customer is still going to get — and 'paid' is a
//      state something now sweeps for this product.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const supabaseAdminPath = require.resolve('../api/_lib/supabaseAdmin');
const enginePath = require.resolve('../api/_lib/contractor-engine');
const alertsPath = require.resolve('../api/_lib/alerts');

const { pressuredHvac, unreadableScrap } = require('./fixtures/contractor-fixtures');

function makeFakeAdmin({ submission, reportInserts, submissionUpdates }) {
  return {
    from(table) {
      if (table === 'navigator_submissions') {
        return {
          select() {
            return { eq() { return { single: async () => ({ data: { ...submission }, error: null }) }; } };
          },
          update(patch) {
            submissionUpdates.push(patch);
            Object.assign(submission, patch);
            return { eq: async () => ({ data: null, error: null }) };
          },
        };
      }
      if (table === 'contractor_reports') {
        return {
          insert: async (row) => { reportInserts.push(row); return { data: row, error: null }; },
        };
      }
      throw new Error(`Unexpected table in test: ${table}`);
    },
    storage: {
      from() {
        return {
          download: async () => ({
            data: { arrayBuffer: async () => Buffer.from('%PDF-1.4 fake').buffer },
            error: null,
          }),
        };
      },
    },
  };
}

function install({ submission }) {
  const reportInserts = [];
  const submissionUpdates = [];
  const alerts = [];

  const fakeAdmin = new Module(supabaseAdminPath);
  fakeAdmin.exports = { getSupabaseAdmin: () => makeFakeAdmin({ submission, reportInserts, submissionUpdates }) };
  fakeAdmin.loaded = true;
  require.cache[supabaseAdminPath] = fakeAdmin;

  const fakeAlerts = new Module(alertsPath);
  fakeAlerts.exports = { sendFailureAlert: async (a) => { alerts.push(a); } };
  fakeAlerts.loaded = true;
  require.cache[alertsPath] = fakeAlerts;

  delete require.cache[enginePath];
  return { reportInserts, submissionUpdates, alerts };
}

function uninstall() {
  delete require.cache[supabaseAdminPath];
  delete require.cache[alertsPath];
  delete require.cache[enginePath];
}

function fakeSubmission(overrides) {
  return {
    id: 'sub-c1',
    product: 'contractor',
    status: 'paid',
    error: null,
    created_at: new Date().toISOString(),
    stripe_checkout_session_id: 'cs_test_123',
    file_paths: ['contractor/sub-c1/estimate.pdf'],
    form_data: { category: 'HVAC', state: 'CA', quoted_at_home: 'yes', home_sqft: 1850 },
    ...overrides,
  };
}

// One fake Anthropic endpoint serving both calls. `plan` decides what each
// returns, in order.
function installFetch(plan) {
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const toolName = body.tool_choice && body.tool_choice.name;
    calls.push({ toolName, system: body.system, messages: body.messages, max_tokens: body.max_tokens });
    const next = plan.shift();
    if (typeof next === 'function') return next(toolName, body);
    return {
      ok: true,
      json: async () => ({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: toolName, input: next }],
      }),
    };
  };
  return calls;
}

const EXTRACTION = pressuredHvac();
const OPENING = {
  headline: 'Four things to settle before you sign.',
  summary: 'Twenty-nine of thirty-two checks ran. The deposit is $3,000 over the California cap.',
  do_first: ['Pay no more than $1,000 at signing.', 'Ask which labour figure is right.'],
};

test.afterEach(() => { uninstall(); delete global.fetch; });

test('a complete estimate produces a stored report and a complete submission', async () => {
  const submission = fakeSubmission();
  const { reportInserts, submissionUpdates } = install({ submission });
  installFetch([EXTRACTION, OPENING]);
  process.env.ANTHROPIC_API_KEY = 'test-key';

  const { generateContractorReport } = require('../api/_lib/contractor-engine');
  const report = await generateContractorReport('sub-c1');

  assert.equal(reportInserts.length, 1);
  assert.equal(submissionUpdates[0].status, 'processing', 'the row must be claimed before any work starts');
  assert.equal(submissionUpdates[submissionUpdates.length - 1].status, 'complete');
  assert.equal(submissionUpdates[submissionUpdates.length - 1].refund_state, undefined,
    'a good report queued a refund');

  assert.equal(report.category, 'HVAC');
  assert.equal(report.headline, OPENING.headline);
  assert.ok(report.findings.length > 20, 'the deterministic findings did not reach the stored report');
  assert.ok(report.emails.length === 1 && report.emails[0].body.includes('Hello Comfort Kings'));
  assert.equal(report.coverage.below_floor, false);
  assert.equal(report.refund.issued, false);
});

test('the write-up model is shown the findings, never the documents', async () => {
  const submission = fakeSubmission();
  install({ submission });
  const calls = installFetch([EXTRACTION, OPENING]);
  process.env.ANTHROPIC_API_KEY = 'test-key';

  const { generateContractorReport } = require('../api/_lib/contractor-engine');
  await generateContractorReport('sub-c1');

  assert.equal(calls.length, 2);
  const [extract, writeup] = calls;

  // The extraction pass gets the documents.
  assert.equal(extract.toolName, 'record_contractor_estimates');
  assert.ok(extract.messages[0].content.some((b) => b.type === 'document' || b.type === 'image'),
    'the extraction pass was not shown the uploaded files');

  // The write-up pass gets text only, and that text is the audit's output.
  assert.equal(writeup.toolName, 'write_contractor_report_opening');
  assert.deepEqual(writeup.messages[0].content.map((b) => b.type), ['text'],
    'the write-up pass was handed a document — it can only write up findings if findings are all it has');
  const prompt = writeup.messages[0].content[0].text;
  assert.match(prompt, /Do not add to them/);
  assert.match(prompt, /COVERAGE: 29 of 32/);
  assert.match(prompt, /DEPOSIT_WITHIN_STATE_CAP/);
});

test('a truncated extraction is retried rather than stored half-read', async () => {
  const submission = fakeSubmission();
  install({ submission });
  installFetch([
    () => ({ ok: true, json: async () => ({ stop_reason: 'max_tokens', content: [] }) }),
    EXTRACTION,
    OPENING,
  ]);
  process.env.ANTHROPIC_API_KEY = 'test-key';

  const { generateContractorReport } = require('../api/_lib/contractor-engine');
  const report = await generateContractorReport('sub-c1');
  assert.ok(report.findings.length > 20,
    'a truncated tool call was accepted — its later fields would be missing and the checks that need them '
    + 'would be silently skipped');
});

test('a failed write-up costs the opening, never the findings', async () => {
  const submission = fakeSubmission();
  const { reportInserts } = install({ submission });
  installFetch([
    EXTRACTION,
    () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'nope' }] }) }),
    () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'nope again' }] }) }),
  ]);
  process.env.ANTHROPIC_API_KEY = 'test-key';

  const { generateContractorReport } = require('../api/_lib/contractor-engine');
  const report = await generateContractorReport('sub-c1');

  assert.equal(reportInserts.length, 1, 'the report was not stored when only the opening failed');
  assert.ok(report.headline.length > 0);
  assert.ok(report.findings.length > 20);
  assert.ok(report.emails.length === 1);
  assert.match(report.summary, /29 of 32/, 'the fallback opening dropped the coverage figure');
});

test('a leaked formatting artifact in the opening is retried, not shipped', async () => {
  const submission = fakeSubmission();
  install({ submission });
  installFetch([
    EXTRACTION,
    { headline: 'Fine</summary><parameter name="x">', summary: 'x', do_first: [] },
    OPENING,
  ]);
  process.env.ANTHROPIC_API_KEY = 'test-key';

  const { generateContractorReport } = require('../api/_lib/contractor-engine');
  const report = await generateContractorReport('sub-c1');
  assert.equal(report.headline, OPENING.headline);
});

test('a report too thin to be worth the price refunds itself', async () => {
  const submission = fakeSubmission({ form_data: { category: 'Plumbing', state: 'OH', quoted_at_home: 'no' } });
  const { reportInserts, submissionUpdates, alerts } = install({ submission });
  installFetch([unreadableScrap(), OPENING]);
  process.env.ANTHROPIC_API_KEY = 'test-key';

  const { generateContractorReport, REFUND_STATE_THIN } = require('../api/_lib/contractor-engine');
  const report = await generateContractorReport('sub-c1');

  const last = submissionUpdates[submissionUpdates.length - 1];
  assert.equal(last.status, 'complete', 'the customer must keep the report they were refunded for');
  assert.equal(last.refund_state, REFUND_STATE_THIN);
  assert.equal(reportInserts.length, 1);
  assert.equal(report.refund.issued, true);
  assert.match(report.refund.reason, /60%/);
  assert.equal(alerts.length, 1, 'nobody was told a paying customer got a thin result');
  assert.equal(alerts[0].refundQueued, true);
});

test('a thin result on an unpaid row refunds nothing', async () => {
  // An admin regeneration or a test submission has no Stripe session. Queuing a
  // refund against a payment that never happened is how a batch job ends up
  // trying to refund a charge that does not exist.
  const submission = fakeSubmission({
    stripe_checkout_session_id: null,
    form_data: { category: 'Plumbing', state: 'OH', quoted_at_home: 'no' },
  });
  const { submissionUpdates, alerts } = install({ submission });
  installFetch([unreadableScrap(), OPENING]);
  process.env.ANTHROPIC_API_KEY = 'test-key';

  const { generateContractorReport } = require('../api/_lib/contractor-engine');
  await generateContractorReport('sub-c1');

  const last = submissionUpdates[submissionUpdates.length - 1];
  assert.equal(last.status, 'complete');
  assert.equal(last.refund_state, undefined);
  assert.equal(alerts.length, 0);
});

test('a provider outage parks the row at paid instead of failing and refunding it', async () => {
  const submission = fakeSubmission();
  const { submissionUpdates, alerts } = install({ submission });
  installFetch([
    () => ({ ok: false, status: 400, text: async () => 'Your credit balance is too low to access the API' }),
  ]);
  process.env.ANTHROPIC_API_KEY = 'test-key';

  const { generateContractorReport } = require('../api/_lib/contractor-engine');
  await assert.rejects(() => generateContractorReport('sub-c1'));

  const last = submissionUpdates[submissionUpdates.length - 1];
  assert.equal(last.status, 'paid',
    'an outage failed the submission — the customer is refunded for a report they were still going to get, and '
    + 'their documents are left behind with nothing to generate from once the balance is topped up');
  assert.equal(last.refund_state, undefined);
  assert.equal(alerts[0].paused, true);
});

test('a failure that is about this submission fails it, alerts, and queues the refund', async () => {
  const submission = fakeSubmission({ file_paths: [] });
  const { submissionUpdates, alerts } = install({ submission });
  installFetch([]);
  process.env.ANTHROPIC_API_KEY = 'test-key';

  const { generateContractorReport } = require('../api/_lib/contractor-engine');
  await assert.rejects(() => generateContractorReport('sub-c1'));

  const last = submissionUpdates[submissionUpdates.length - 1];
  assert.equal(last.status, 'failed');
  assert.equal(last.refund_state, 'due');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].refundQueued, true);
  assert.equal(alerts[0].product, 'contractor');
});

test('the answers the intake form collects reach the audit', async () => {
  // The state, the home size and the in-home answer each switch a check on, and
  // each has to survive the trip from form_data into runContractorAudit. The
  // engine that this replaced read a `zip` the form never collected.
  const submission = fakeSubmission({
    form_data: { category: 'HVAC', state: 'NY', quoted_at_home: 'no', home_sqft: 3000 },
  });
  install({ submission });
  installFetch([EXTRACTION, OPENING]);
  process.env.ANTHROPIC_API_KEY = 'test-key';

  const { generateContractorReport } = require('../api/_lib/contractor-engine');
  const report = await generateContractorReport('sub-c1');

  const byId = (id) => report.findings.find((f) => f.checkId === id);
  // New York, so no statutory cap — the escrow rule is cited instead.
  assert.ok(byId('DEPOSIT_AGAINST_NORM'), 'the state never reached the deposit check');
  assert.equal(byId('DEPOSIT_WITHIN_STATE_CAP'), undefined);
  // 3,000 sq ft on 3 tons is 1,000 sq ft per ton — undersized.
  assert.match(byId('HVAC_SIZED_TO_THE_HOUSE').title, /undersized/);
  // Not quoted at home, so the cancellation right is explained rather than asserted.
  assert.match(byId('RIGHT_TO_CANCEL_NOTICE').title, /does not attach/);
});
