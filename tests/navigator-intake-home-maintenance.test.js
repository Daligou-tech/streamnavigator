// Tests that Home Maintenance Navigator's structured sufficiency gate is
// enforced server-side in api/navigator-intake.js, not just by
// home-maintenance.html's form — i.e. that calling the API directly with the
// old free-text-only shape is rejected, closing the exact bypass a customer
// (or a script) could otherwise use to reach checkout with nothing the
// deterministic engine (navigator-home-maintenance-engine.js) can use.
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

test('the old free-text-only shape (the pre-fix behavior) is now rejected', async (t) => {
  const { inserted } = installFakeSupabaseAdmin();
  t.after(uninstallFakeSupabaseAdmin);

  const handler = require('../api/navigator-intake');
  const { req, res } = makeReqRes({
    product: 'home-maintenance',
    email: 'homeowner@example.com',
    formData: { category: 'Water Heater', description: '12-year-old water heater, started leaking' },
    files: [],
  });

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.ok(Array.isArray(res.body.missing) && res.body.missing.length > 0);
  assert.equal(inserted.length, 0, 'no row should be inserted for an insufficient submission');
});

test('a fully structured submission with both quotes is accepted', async (t) => {
  const { inserted } = installFakeSupabaseAdmin();
  t.after(uninstallFakeSupabaseAdmin);

  const handler = require('../api/navigator-intake');
  const { req, res } = makeReqRes({
    product: 'home-maintenance',
    email: 'homeowner@example.com',
    formData: {
      category: 'Water Heater', system_age_years: 14, symptoms: ['leaking_or_damage'],
      repair_quote: 1400, replacement_quote: 2600,
    },
    files: [],
  });

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].product, 'home-maintenance');
});

test('explicitly having no quotes yet is accepted — it is a valid, honestly-scoped answer', async (t) => {
  const { inserted } = installFakeSupabaseAdmin();
  t.after(uninstallFakeSupabaseAdmin);

  const handler = require('../api/navigator-intake');
  const { req, res } = makeReqRes({
    product: 'home-maintenance',
    email: 'homeowner@example.com',
    formData: {
      category: 'Roof', age_unknown: true, symptoms: ['comparing_before_failure'], no_quotes_yet: true,
    },
    files: [],
  });

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(inserted.length, 1);
});

test('missing symptoms alone is enough to reject, even with quotes and age given', async (t) => {
  const { inserted } = installFakeSupabaseAdmin();
  t.after(uninstallFakeSupabaseAdmin);

  const handler = require('../api/navigator-intake');
  const { req, res } = makeReqRes({
    product: 'home-maintenance',
    email: 'homeowner@example.com',
    formData: { category: 'HVAC', system_age_years: 10, repair_quote: 500, replacement_quote: 6000 },
    files: [],
  });

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(inserted.length, 0);
});

test('other products are unaffected: a bare description still passes for e.g. property-tax', async (t) => {
  const { inserted } = installFakeSupabaseAdmin();
  t.after(uninstallFakeSupabaseAdmin);

  const handler = require('../api/navigator-intake');
  const { req, res } = makeReqRes({
    product: 'property-tax',
    email: 'homeowner@example.com',
    formData: { description: '123 Main St, assessment went up 40% this year' },
    files: [],
  });

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(inserted.length, 1);
});
