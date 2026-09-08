// The live half of the price gate: does it actually catch a broken checkout?
//
// This exists because of a real one. On 2026-09-07 the button on buying.html
// pointed at a payment link Stripe had deactivated six days earlier — clicking
// checkout returned "The link is no longer active." and Purchase Navigator
// could not be bought at all. scripts/check-prices.js passed every single run,
// because it compared buying.html to prices.config.json and the two carried the
// same stale link ID. They agreed with each other and disagreed with Stripe.
//
// So the file-to-file checks are not enough on their own, and the tests for
// them cannot cover this. These cover the part that talks to Stripe, against a
// stubbed API rather than a live key — CI has no secret key, and a check nobody
// can run is a check that quietly rots.
//
// Each failure mode below is one a customer would meet at the moment of paying.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkStripeLinks, linkSuffix } = require('../scripts/check-prices.js');

const ENTRY = (file, label, cents, suffix) => [file, {
  label, expectedPriceCents: cents, stripeLinkId: suffix,
}];

function link(suffix, { active = true, cents = 2900, currency = 'usd', qty = 1, items } = {}) {
  return {
    id: 'plink_' + suffix,
    url: 'https://buy.stripe.com/' + suffix,
    active,
    line_items: {
      data: items || [{ quantity: qty, price: { unit_amount: cents, currency } }],
    },
  };
}

// Replaces global fetch with one that serves a fixed set of payment links,
// including Stripe's pagination shape.
function withStripe(links, run) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    return {
      ok: true,
      json: async () => ({ data: links, has_more: false }),
    };
  };
  process.env.STRIPE_SECRET_KEY = 'sk_test_stub';
  return run(calls).finally(() => {
    global.fetch = real;
    delete process.env.STRIPE_SECRET_KEY;
  });
}

const problemsFor = (res, file) =>
  (res.rows.find((r) => r.file === file) || { problems: [] }).problems;

// --- the failure that shipped -----------------------------------------------

test('a DEACTIVATED link fails, and says the customer cannot buy', async () => {
  await withStripe([link('DEAD', { active: false })], async () => {
    const res = await checkStripeLinks([ENTRY('buying.html', 'Purchase', 2900, 'DEAD')]);
    const p = problemsFor(res, 'buying.html');
    assert.equal(p.length >= 1, true, 'a deactivated link must fail');
    assert.match(p.join(' '), /DEACTIVATED/);
    assert.match(p.join(' '), /no longer active|cannot buy/i);
  });
});

test('a link that does not exist in the account fails', async () => {
  // What you get after creating a replacement link and forgetting the page.
  await withStripe([link('SOMETHINGELSE')], async () => {
    const res = await checkStripeLinks([ENTRY('buying.html', 'Purchase', 2900, 'GONE')]);
    assert.match(problemsFor(res, 'buying.html').join(' '), /does not exist/);
  });
});

test('a link that charges a different amount than the page fails', async () => {
  // The page says $29, Stripe takes $39.
  await withStripe([link('OK', { cents: 3900 })], async () => {
    const res = await checkStripeLinks([ENTRY('buying.html', 'Purchase', 2900, 'OK')]);
    const p = problemsFor(res, 'buying.html').join(' ');
    // money() drops the .00 on whole dollars, matching the table above it.
    assert.match(p, /\$39\b/);
    assert.match(p, /\$29\b/);
    assert.match(p, /sees one number and pays another/);
  });
});

test('quantity is counted, not ignored', async () => {
  // A $29 price at quantity 2 charges $58, however right the unit price looks.
  await withStripe([link('OK', { cents: 2900, qty: 2 })], async () => {
    const res = await checkStripeLinks([ENTRY('buying.html', 'Purchase', 2900, 'OK')]);
    assert.match(problemsFor(res, 'buying.html').join(' '), /\$58\b/);
  });
});

test('a multi-item link is reported rather than guessed at', async () => {
  await withStripe([link('OK', {
    items: [
      { quantity: 1, price: { unit_amount: 2900, currency: 'usd' } },
      { quantity: 1, price: { unit_amount: 500, currency: 'usd' } },
    ],
  })], async () => {
    const res = await checkStripeLinks([ENTRY('buying.html', 'Purchase', 2900, 'OK')]);
    assert.match(problemsFor(res, 'buying.html').join(' '), /exactly one line item, found 2/);
  });
});

test('a non-USD price fails', async () => {
  await withStripe([link('OK', { currency: 'eur' })], async () => {
    const res = await checkStripeLinks([ENTRY('buying.html', 'Purchase', 2900, 'OK')]);
    assert.match(problemsFor(res, 'buying.html').join(' '), /EUR/);
  });
});

// --- what must pass ---------------------------------------------------------

test('an active link charging the advertised amount passes', async () => {
  await withStripe([link('GOOD', { cents: 2900 })], async () => {
    const res = await checkStripeLinks([ENTRY('buying.html', 'Purchase', 2900, 'GOOD')]);
    assert.deepEqual(problemsFor(res, 'buying.html'), []);
  });
});

test('every configured page is checked, not just the first', async () => {
  await withStripe([link('A'), link('B', { active: false }), link('C')], async () => {
    const res = await checkStripeLinks([
      ENTRY('a.html', 'A', 2900, 'A'),
      ENTRY('b.html', 'B', 2900, 'B'),
      ENTRY('c.html', 'C', 2900, 'C'),
    ]);
    assert.equal(res.rows.length, 3);
    assert.deepEqual(problemsFor(res, 'a.html'), []);
    assert.equal(problemsFor(res, 'b.html').length >= 1, true);
    assert.deepEqual(problemsFor(res, 'c.html'), []);
  });
});

// --- the guard rails --------------------------------------------------------

test('it never issues anything but GETs', async () => {
  // A price checker that can change a price is a liability, not a check.
  await withStripe([link('GOOD')], async (calls) => {
    await checkStripeLinks([ENTRY('buying.html', 'Purchase', 2900, 'GOOD')]);
    assert.deepEqual([...new Set(calls.map((c) => c.method))], ['GET']);
    assert.equal(calls.every((c) => c.url.startsWith('https://api.stripe.com/v1/payment_links')), true);
  });
});

test('with no key it skips loudly rather than reporting a pass', async () => {
  const saved = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  try {
    const res = await checkStripeLinks([ENTRY('buying.html', 'Purchase', 2900, 'X')]);
    assert.ok(res.skipped, 'must report a skip, not an empty pass');
    assert.match(res.skipped, /STRIPE_SECRET_KEY/);
    assert.equal(res.rows, undefined, 'a skip must not look like zero problems');
  } finally {
    if (saved) process.env.STRIPE_SECRET_KEY = saved;
  }
});

test('the URL suffix is what gets matched, not the plink id', async () => {
  assert.equal(linkSuffix('https://buy.stripe.com/28E00jaosceEcoA93WabK0j'), '28E00jaosceEcoA93WabK0j');
  assert.equal(linkSuffix('https://buy.stripe.com/abc/'), 'abc');
});
