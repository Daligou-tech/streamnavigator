// Tests that Property Tax Navigator's structured sufficiency gate is
// enforced server-side in api/navigator-intake.js, not just by
// property-tax.html's form — i.e. that calling the API directly with the
// old free-text-address-only shape is rejected, closing the exact bypass a
// customer (or a script) could otherwise use to reach checkout with nothing
// the deterministic engine (navigator-property-tax-engine.js) can use.
//
// Mocks Supabase the same way tests/navigator-intake-insurance.test.js does.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const supabaseAdminPath = require.resolve('../api/_lib/supabaseAdmin');

function installFakeSupabaseAdmin() {
  const inserted = [];
  const fakeAdmin = {
    from(table) {
      return {
        insert(row) {
          return {
            select() {
              return {
                single: async () => {
                  const record = { id: 'test-submission-id', access_token: 'test-token', table, ...row };
                  inserted.push(record);
                  return { data: { id: record.id, access_token: record.access_token }, error: null };
                },
              };
            },
          };
        },
        update() {
          return { eq: async () => ({ data: null, error: null }) };
        },
      };
    },
    storage: { from() { return { upload: async () => ({ error: null }) }; } },
  };

  const fakeModule = new Module(supabaseAdminPath);
  fakeModule.exports = {
    getSupabaseAdmin: () => fakeAdmin,
    ALLOWED_PRODUCTS: [
      'contractor', 'property-tax', 'home-savings', 'rental',
      'subscriptions', 'government-money', 'home-maintenance',
      'landlord', 'insurance', 'buying', 'hoa', 'closing',
    ],
  };
  fakeModule.loaded = true;
  require.cache[supabaseAdminPath] = fakeModule;

  return { inserted };
}

function uninstallFakeSupabaseAdmin() {
  delete require.cache[supabaseAdminPath];
  delete require.cache[require.resolve('../api/navigator-intake')];
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

test('the old free-text-address-only shape (the pre-fix behavior) is now rejected', async (t) => {
  const { inserted } = installFakeSupabaseAdmin();
  t.after(uninstallFakeSupabaseAdmin);

  const handler = require('../api/navigator-intake');
  const { req, res } = makeReqRes({
    product: 'property-tax',
    email: 'homeowner@example.com',
    formData: { description: '123 Main St, Springfield, IL, assessment went up' },
    files: [],
  });

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.ok(Array.isArray(res.body.missing) && res.body.missing.length > 0);
  assert.equal(inserted.length, 0, 'no row should be inserted for an insufficient submission');
});

test('current value plus a prior value plus both booleans answered is accepted, with a tax rate', async (t) => {
  const { inserted } = installFakeSupabaseAdmin();
  t.after(uninstallFakeSupabaseAdmin);

  const handler = require('../api/navigator-intake');
  const { req, res } = makeReqRes({
    product: 'property-tax',
    email: 'homeowner@example.com',
    formData: {
      address: '123 Main St, Springfield, IL',
      new_assessed_value: 360000, prior_assessed_value: 300000,
      physical_changes: false, factual_errors: false, tax_rate_pct: 1.2,
    },
    files: [],
  });

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].product, 'property-tax');
});

test('a prior value with no tax rate is rejected, so a report can never ship with no dollar figure', async (t) => {
  const { inserted } = installFakeSupabaseAdmin();
  t.after(uninstallFakeSupabaseAdmin);

  const handler = require('../api/navigator-intake');
  const { req, res } = makeReqRes({
    product: 'property-tax',
    email: 'homeowner@example.com',
    formData: {
      new_assessed_value: 360000, prior_assessed_value: 300000,
      physical_changes: false, factual_errors: false,
    },
    files: [],
  });

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(inserted.length, 0);
});

test('a factual error flag alone, with no prior value, is accepted', async (t) => {
  const { inserted } = installFakeSupabaseAdmin();
  t.after(uninstallFakeSupabaseAdmin);

  const handler = require('../api/navigator-intake');
  const { req, res } = makeReqRes({
    product: 'property-tax',
    email: 'homeowner@example.com',
    formData: { new_assessed_value: 360000, physical_changes: false, factual_errors: true, factual_errors_notes: 'wrong lot size' },
    files: [],
  });

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(inserted.length, 1);
});

test('missing both physical_changes and factual_errors answers is rejected even with a current value given', async (t) => {
  const { inserted } = installFakeSupabaseAdmin();
  t.after(uninstallFakeSupabaseAdmin);

  const handler = require('../api/navigator-intake');
  const { req, res } = makeReqRes({
    product: 'property-tax',
    email: 'homeowner@example.com',
    formData: { new_assessed_value: 360000, prior_assessed_value: 300000 },
    files: [],
  });

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(inserted.length, 0);
});

test('other products are unaffected: a bare description still passes for e.g. rental', async (t) => {
  const { inserted } = installFakeSupabaseAdmin();
  t.after(uninstallFakeSupabaseAdmin);

  const handler = require('../api/navigator-intake');
  const { req, res } = makeReqRes({
    product: 'rental',
    email: 'landlord@example.com',
    formData: { description: 'Four-unit building, checking the numbers' },
    files: [],
  });

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(inserted.length, 1);
});
