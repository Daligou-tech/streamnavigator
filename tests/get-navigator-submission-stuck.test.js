// Regression tests for the "stuck processing" recovery path in
// api/get-navigator-submission.js — added after a real production incident
// where Vercel's 60s Hobby-plan function limit killed a Purchase Navigator
// generation attempt mid-flight, leaving the row at status:'processing'
// forever (the platform kills the function outside purchase-engine.js's own
// try/catch, so its normal failure handling never ran). The customer's page
// polled the same non-answer indefinitely.
//
// These tests mock api/_lib/purchase-engine.js directly (via the same
// require-cache trick used elsewhere in this suite) rather than exercising
// its real Anthropic-calling logic — that logic has its own coverage in
// tests/purchase-engine.test.js. Here we only care whether this handler
// decides to call it again.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const supabaseAdminPath = require.resolve('../api/_lib/supabaseAdmin');
const purchaseEnginePath = require.resolve('../api/_lib/purchase-engine');
const handlerPath = require.resolve('../api/get-navigator-submission');

function installFakes({ submission, generateShouldThrow = false }) {
  const generateCalls = [];

  const fakeAdmin = {
    from(table) {
      if (table === 'navigator_submissions') {
        return {
          select() {
            return {
              eq() {
                return { maybeSingle: async () => ({ data: submission, error: null }), single: async () => ({ data: submission, error: null }) };
              },
            };
          },
        };
      }
      if (table === 'navigator_reports' || table === 'contractor_reports') {
        return {
          select() {
            return {
              eq() {
                return {
                  order() {
                    return { limit() { return { maybeSingle: async () => ({ data: null, error: null }) }; } };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`Unexpected table in test: ${table}`);
    },
  };

  const fakeSupabaseModule = new Module(supabaseAdminPath);
  fakeSupabaseModule.exports = { getSupabaseAdmin: () => fakeAdmin };
  fakeSupabaseModule.loaded = true;
  require.cache[supabaseAdminPath] = fakeSupabaseModule;

  const fakePurchaseEngineModule = new Module(purchaseEnginePath);
  fakePurchaseEngineModule.exports = {
    generatePurchaseReport: async (id) => {
      generateCalls.push(id);
      if (generateShouldThrow) throw new Error('simulated failure');
      return null;
    },
  };
  fakePurchaseEngineModule.loaded = true;
  require.cache[purchaseEnginePath] = fakePurchaseEngineModule;

  delete require.cache[handlerPath];

  return { generateCalls };
}

function uninstallFakes() {
  delete require.cache[supabaseAdminPath];
  delete require.cache[purchaseEnginePath];
  delete require.cache[handlerPath];
}

function makeReqRes(body) {
  const req = { method: 'POST', body };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
  return { req, res };
}

function isoSecondsAgo(seconds) {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

test('a buying submission stuck at "processing" for over 70s triggers another generation attempt', async (t) => {
  const submission = {
    id: 'sub-stuck', product: 'buying', status: 'processing', access_token: 'tok',
    error: null, created_at: isoSecondsAgo(200), updated_at: isoSecondsAgo(90), generation_attempts: 1,
  };
  const { generateCalls } = installFakes({ submission });
  t.after(uninstallFakes);

  const handler = require('../api/get-navigator-submission');
  const { req, res } = makeReqRes({ id: 'sub-stuck', token: 'tok' });
  await handler(req, res);

  assert.equal(generateCalls.length, 1, 'a genuinely stuck submission must get another attempt');
  assert.equal(res.statusCode, 200);
});

test('a buying submission still recently "processing" (under 70s) is NOT re-triggered — it may just be an in-flight attempt', async (t) => {
  const submission = {
    id: 'sub-fresh', product: 'buying', status: 'processing', access_token: 'tok',
    error: null, created_at: isoSecondsAgo(10), updated_at: isoSecondsAgo(10), generation_attempts: 1,
  };
  const { generateCalls } = installFakes({ submission });
  t.after(uninstallFakes);

  const handler = require('../api/get-navigator-submission');
  const { req, res } = makeReqRes({ id: 'sub-fresh', token: 'tok' });
  await handler(req, res);

  assert.equal(generateCalls.length, 0, 'must not race an attempt that may still legitimately be in flight');
});

test('a buying submission at "paid" still triggers generation as before (unaffected by the stuck-processing check)', async (t) => {
  const submission = {
    id: 'sub-paid', product: 'buying', status: 'paid', access_token: 'tok',
    error: null, created_at: isoSecondsAgo(5), updated_at: isoSecondsAgo(5), generation_attempts: 0,
  };
  const { generateCalls } = installFakes({ submission });
  t.after(uninstallFakes);

  const handler = require('../api/get-navigator-submission');
  const { req, res } = makeReqRes({ id: 'sub-paid', token: 'tok' });
  await handler(req, res);

  assert.equal(generateCalls.length, 1);
});

test('a non-buying product stuck at "processing" is left alone by this check (scoped to buying only)', async (t) => {
  const submission = {
    id: 'sub-other', product: 'insurance', status: 'processing', access_token: 'tok',
    error: null, created_at: isoSecondsAgo(300), updated_at: isoSecondsAgo(300), generation_attempts: 0,
  };
  const { generateCalls } = installFakes({ submission });
  t.after(uninstallFakes);

  const handler = require('../api/get-navigator-submission');
  const { req, res } = makeReqRes({ id: 'sub-other', token: 'tok' });
  await handler(req, res);

  assert.equal(generateCalls.length, 0, 'the buying-specific stuck check must not affect other products');
});

test('the handler responds 200 even when the recovered generation attempt itself throws (error already recorded by purchase-engine)', async (t) => {
  const submission = {
    id: 'sub-stuck-2', product: 'buying', status: 'processing', access_token: 'tok',
    error: null, created_at: isoSecondsAgo(200), updated_at: isoSecondsAgo(90), generation_attempts: 2,
  };
  const { generateCalls } = installFakes({ submission, generateShouldThrow: true });
  t.after(uninstallFakes);

  const handler = require('../api/get-navigator-submission');
  const { req, res } = makeReqRes({ id: 'sub-stuck-2', token: 'tok' });
  await handler(req, res);

  assert.equal(generateCalls.length, 1);
  assert.equal(res.statusCode, 200, 'a thrown error from generation must be swallowed, not surfaced as a 500');
});
