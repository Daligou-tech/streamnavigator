// Reopening a free scorecard, and the link that gets you back to it.
//
// The scorecard used to live in one browser tab and nowhere else. Closing it —
// to think, or to show a spouse on a phone — meant re-uploading the largest
// document the customer will sign this decade, at exactly the moment they were
// deciding whether to pay. That is the most expensive friction in the product.
//
// What makes the way back safe is that it needs the submission's access token.
// A submission id alone must get nothing, because ids travel: in a URL a
// customer pastes into a chat, in a screenshot, in a support email. These tests
// are mostly about that.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scorecardLink, __internal } = require('../api/_lib/scorecard-link');

// --- the link ---------------------------------------------------------------

test('the link carries both the id and the access token', () => {
  const link = scorecardLink({ id: 'sub-123', access_token: 'tok-abc' });
  assert.match(link, /\/closing-scorecard\?/);
  assert.match(link, /id=sub-123/);
  assert.match(link, /t=tok-abc/);
});

test('the email says plainly that nothing has been charged', () => {
  // It is an unsolicited email about a free thing, arriving from a brand the
  // customer has not paid. Leading them to wonder whether they have been
  // billed is the fastest way to make it read as spam.
  const body = __internal.body('https://streamnavigator.ai/closing-scorecard?id=x&t=y');
  assert.match(body, /nothing has been charged/i);
  assert.match(body, /still free|is yours either way|free scorecard/i);
});

test('the email tells them to treat the link like the document', () => {
  const body = __internal.body('https://example.test/x');
  assert.match(body, /private/i);
});

// --- the endpoint -----------------------------------------------------------

function makeAdmin(row) {
  const calls = [];
  return {
    calls,
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        single() {
          calls.push('select');
          return Promise.resolve(row ? { data: row, error: null } : { data: null, error: new Error('not found') });
        },
      };
    },
  };
}

function makeRes() {
  return {
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

// The handler reaches for the real Supabase client, so it is loaded with the
// module cache primed the way the other API tests do it.
function loadHandler(row) {
  const adminPath = require.resolve('../api/_lib/supabaseAdmin');
  const handlerPath = require.resolve('../api/closing-scorecard-resume');
  delete require.cache[handlerPath];
  const previous = require.cache[adminPath];
  require.cache[adminPath] = {
    id: adminPath, filename: adminPath, loaded: true, exports: { getSupabaseAdmin: () => makeAdmin(row) },
  };
  const handler = require(handlerPath);
  if (previous) require.cache[adminPath] = previous; else delete require.cache[adminPath];
  return handler;
}

const ROW = {
  id: 'sub-1',
  access_token: 'tok-1',
  product: 'closing',
  status: 'scorecard',
  form_data: {
    scorecard: { flag_count: 0, checks_run: 18 },
    answers: { property_type: 'condo' },
  },
};

const call = async (handler, body) => {
  const res = makeRes();
  await handler({ method: 'POST', body }, res);
  return res;
};

test('the right id and token reopen the scorecard', async () => {
  const res = await call(loadHandler(ROW), { id: 'sub-1', token: 'tok-1' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.scorecard.checks_run, 18);
  assert.deepEqual(res.payload.answers, { property_type: 'condo' });
});

test('a correct id with the wrong token gets nothing', async () => {
  const res = await call(loadHandler(ROW), { id: 'sub-1', token: 'not-the-token' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.payload.ok, false);
});

test('a missing token is refused rather than treated as absent', async () => {
  const res = await call(loadHandler(ROW), { id: 'sub-1' });
  assert.equal(res.statusCode, 400);
});

test('the wrong token and a missing submission give the same message', async () => {
  // Distinguishing them tells someone probing ids which half they got right.
  const wrongToken = await call(loadHandler(ROW), { id: 'sub-1', token: 'nope' });
  const noRow = await call(loadHandler(null), { id: 'sub-9', token: 'nope' });
  assert.equal(wrongToken.payload.error, noRow.payload.error);
});

test('a submission from another product cannot be reopened here', async () => {
  const hoaRow = { ...ROW, product: 'hoa' };
  const res = await call(loadHandler(hoaRow), { id: 'sub-1', token: 'tok-1' });
  assert.equal(res.statusCode, 404);
});

test('a row whose check never finished says so instead of returning an empty scorecard', async () => {
  const unfinished = { ...ROW, form_data: {} };
  const res = await call(loadHandler(unfinished), { id: 'sub-1', token: 'tok-1' });
  assert.equal(res.statusCode, 404);
  assert.match(res.payload.error, /did not finish/i);
});

test('an already-paid submission is flagged so the page does not sell it twice', async () => {
  const paid = { ...ROW, status: 'complete' };
  const res = await call(loadHandler(paid), { id: 'sub-1', token: 'tok-1' });
  assert.equal(res.payload.already_paid, true);
});

test('GET is refused', async () => {
  const res = makeRes();
  await loadHandler(ROW)({ method: 'GET' }, res);
  assert.equal(res.statusCode, 405);
});
