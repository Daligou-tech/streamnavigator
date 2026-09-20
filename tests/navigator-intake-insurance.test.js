// Tests that Insurance Navigator's two-document requirement is enforced
// server-side in api/navigator-intake.js, not just by insurance.html's two
// upload zones — i.e. that calling the API directly with only a renewal
// notice (or nothing) is rejected, closing the exact bypass a customer (or a
// script) could otherwise use to reach checkout with a submission whose core
// comparison, api/_lib/insurance-audit.js, could never run.
//
// Before this gate, a single file satisfied the generic D-04 check (a
// description OR one attachment), so a customer who uploaded only their
// renewal notice reached checkout, paid $79, and only then learned the
// report could not compare anything — see docs/INSURANCE-AUDIT.md,
// Critical 3.
//
// Mocks Supabase the same way tests/navigator-intake-buying.test.js does, so
// this never touches the network or a real database.

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

// A minimal, valid-looking PDF attachment — small enough to clear every size
// check, with the one field the malformed-upload check requires.
function fakeFile(name) {
  return { name, type: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4 fake').toString('base64') };
}

test('a renewal notice with no prior policy is rejected — the bypass this gate closes', async (t) => {
  const { inserted } = installFakeSupabaseAdmin();
  t.after(uninstallFakeSupabaseAdmin);

  const handler = require('../api/navigator-intake');
  const { req, res } = makeReqRes({
    product: 'insurance',
    email: 'customer@example.com',
    formData: { category: 'Auto' },
    files: [fakeFile('renewal-notice.pdf')],
  });

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /prior policy/);
  assert.equal(inserted.length, 0, 'no row should be inserted for a renewal-only insurance submission');
});

test('a completely empty insurance submission is still rejected', async (t) => {
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

test('both the renewal notice and the prior policy together are accepted', async (t) => {
  const { inserted } = installFakeSupabaseAdmin();
  t.after(uninstallFakeSupabaseAdmin);

  const handler = require('../api/navigator-intake');
  const { req, res } = makeReqRes({
    product: 'insurance',
    email: 'customer@example.com',
    formData: { category: 'Home' },
    files: [fakeFile('renewal-notice.pdf'), fakeFile('prior-policy.pdf')],
  });

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].product, 'insurance');
});

test('other products are unaffected: a single file still passes for e.g. rental', async (t) => {
  const { inserted } = installFakeSupabaseAdmin();
  t.after(uninstallFakeSupabaseAdmin);

  const handler = require('../api/navigator-intake');
  const { req, res } = makeReqRes({
    product: 'rental',
    email: 'landlord@example.com',
    formData: {},
    files: [fakeFile('rent-roll.pdf')],
  });

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(inserted.length, 1);
});
