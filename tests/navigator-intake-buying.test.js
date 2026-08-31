// Tests that the sufficiency gate is enforced server-side in
// api/navigator-intake.js, not just in buying.html's UI — i.e. that calling
// the API directly with an insufficient 'buying' submission is rejected,
// closing the exact bypass a customer (or a script) could otherwise use.
//
// Mocks Supabase by pre-seeding require()'s module cache for
// api/_lib/supabaseAdmin before requiring the handler, so these tests never
// touch the network or a real database.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const supabaseAdminPath = require.resolve('../api/_lib/supabaseAdmin');

function installFakeSupabaseAdmin({ insertShouldFail = false } = {}) {
  const inserted = [];
  const fakeAdmin = {
    from(table) {
      return {
        insert(row) {
          return {
            select() {
              return {
                single: async () => {
                  if (insertShouldFail) return { data: null, error: new Error('insert failed') };
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
    storage: {
      from() {
        return {
          upload: async () => ({ error: null }),
        };
      },
    },
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

test('POST /api/navigator-intake rejects an insufficient buying submission with 400 and lists what is missing', async (t) => {
  const { inserted } = installFakeSupabaseAdmin();
  t.after(uninstallFakeSupabaseAdmin);

  const handler = require('../api/navigator-intake');
  const { req, res } = makeReqRes({
    product: 'buying',
    email: 'shopper@example.com',
    formData: { category: 'appliance', item_description: 'fridge purchase 33 inch' },
    files: [],
  });

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.ok(Array.isArray(res.body.missing) && res.body.missing.length > 0);
  assert.ok(res.body.missing.some((m) => m.key === 'price_value'));
  assert.equal(inserted.length, 0, 'no row should be inserted for an insufficient buying submission');
});

test('POST /api/navigator-intake accepts a sufficient buying submission and creates a row', async (t) => {
  const { inserted } = installFakeSupabaseAdmin();
  t.after(uninstallFakeSupabaseAdmin);

  const handler = require('../api/navigator-intake');
  const { req, res } = makeReqRes({
    product: 'buying',
    email: 'shopper@example.com',
    formData: {
      category: 'appliance',
      item_description: 'LG 33-inch French door refrigerator',
      price_value: '2400',
      financing: 'cash',
      ownership_years: '8',
      location: '30301',
      timeline: 'this_month',
      size_constraints: '33-inch opening',
      configuration: 'French door',
    },
    files: [],
  });

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.id, 'test-submission-id');
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].product, 'buying');
});

test('a raw description with no structured fields (the pre-fix behavior) is now rejected for buying, closing the direct-API bypass', async (t) => {
  const { inserted } = installFakeSupabaseAdmin();
  t.after(uninstallFakeSupabaseAdmin);

  const handler = require('../api/navigator-intake');
  const { req, res } = makeReqRes({
    product: 'buying',
    email: 'shopper@example.com',
    formData: { description: 'fridge purchase 33 inch' }, // old shape, no category, calling the API directly
    files: [],
  });

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(inserted.length, 0);
});

test('other products are unaffected: a bare non-empty description still passes for e.g. property-tax', async (t) => {
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
  assert.equal(res.body.ok, true);
  assert.equal(inserted.length, 1);
});

test('other products still reject a truly empty submission (D-04 behavior preserved)', async (t) => {
  const { inserted } = installFakeSupabaseAdmin();
  t.after(uninstallFakeSupabaseAdmin);

  const handler = require('../api/navigator-intake');
  const { req, res } = makeReqRes({
    product: 'insurance',
    email: 'customer@example.com',
    formData: {},
    files: [],
  });

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(inserted.length, 0);
});
