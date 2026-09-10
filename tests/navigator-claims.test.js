// The same contract rental.html is held to, applied to all eleven products.
//
// The 2026-09-09 audit tested one page and found that "$149/year" and "a full
// year of monitoring" were sold against a one-time Stripe charge, no
// entitlement column and no job that ever looked at a property twice. Fixing
// only that page was the wrong scope: the copy was template boilerplate, and
// the same two sentences were sitting on landlord, home-maintenance,
// home-savings and subscriptions — landlord word for word, down to "One price.
// A full year of monitoring."
//
// Every one of those was a one-time payment link. Verified at checkout for
// rental and landlord: $149.00, a "Pay" button, no interval, no Subscribe.
//
// So the rule is line-wide now. A page may sell a year only if its product is
// one the code actually grants a year for.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { ENTITLED_PRODUCTS } = require('../api/_lib/rental-entitlement');
const prices = JSON.parse(fs.readFileSync(path.join(ROOT, 'prices.config.json'), 'utf8'));

// Every page that sells a Navigator, by the product it sells.
const PRODUCT_PAGES = Object.keys(prices.pages).map((file) => ({
  file,
  product: path.basename(file, '.html'),
  src: fs.readFileSync(path.join(ROOT, file), 'utf8'),
}));

// Text a customer reads, minus the setup comment every page carries in its head.
function visible(src) {
  // Newlines are preserved so a reported line number points at the real file
  // rather than at the stripped copy.
  return src.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
}

test('every priced page is covered by this contract', () => {
  assert.ok(PRODUCT_PAGES.length >= 11, `only ${PRODUCT_PAGES.length} product pages found`);
});

test('no page sells a year the code does not grant', () => {
  const claim = /\$\d+\s*\/\s*year|per year|a full year|full year of|ongoing monitoring|ongoing checks|billed once per year/i;
  const offenders = [];
  for (const { file, product, src } of PRODUCT_PAGES) {
    if (ENTITLED_PRODUCTS.includes(product)) continue;
    visible(src).split('\n').forEach((line, i) => {
      if (claim.test(line) && !/year_built|Year Built/i.test(line)) {
        offenders.push(`${file}:${i + 1} ${line.trim().replace(/<[^>]+>/g, '').slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'these pages sell something recurring for a product with no entitlement behind it. '
    + 'Every Navigator payment link is a one-time charge, and only '
    + `${ENTITLED_PRODUCTS.join(', ')} has an entitlement the customer can spend:\n  `
    + offenders.join('\n  '));
});

test('no page sells reference data that does not exist', () => {
  const corpus = fs.readdirSync(path.join(ROOT, 'data')).filter((f) => f !== '.gitkeep');
  if (corpus.length) return;   // a corpus arrived: these claims become fair game

  // Narrow on purpose. "What that kind of service typically costs" is what the
  // engines actually do — reason from general knowledge and say when unsure.
  // These phrases promise a lookup against data nobody holds.
  const claim = /benchmarks? every|market rate data|rate table|published rates?|live comps?|comparable sales|current market data|against market data/i;
  const offenders = [];
  for (const { file, src } of PRODUCT_PAGES) {
    visible(src).split('\n').forEach((line, i) => {
      if (claim.test(line)) offenders.push(`${file}:${i + 1} ${line.trim().replace(/<[^>]+>/g, '').slice(0, 80)}`);
    });
  }
  assert.deepEqual(offenders, [],
    `data/ holds no corpus, so nothing can be compared against reference data:\n  ${offenders.join('\n  ')}`);
});

test('a page that says the report arrives on its own is swept by a job', () => {
  // "Delivered automatically" is only true if something generates the report
  // when the customer is not sitting on the status page. Generation is
  // triggered by the browser polling; without a sweep, paying and closing the
  // tab produces nothing, and process-refunds never sees it either because
  // that only considers rows that reached "failed".
  const sweep = fs.readFileSync(path.join(ROOT, 'api', 'generate-paid-navigator.js'), 'utf8');
  const swept = (sweep.match(/'[a-z-]+'/g) || []).map((s) => s.replace(/'/g, ''));
  const ownJob = ['buying', 'hoa', 'contractor'];   // each has its own cron or path

  const offenders = [];
  for (const { file, product, src } of PRODUCT_PAGES) {
    if (!/delivered automatically/i.test(visible(src))) continue;
    if (ownJob.includes(product) || swept.includes(product)) continue;
    offenders.push(`${file} promises automatic delivery but nothing sweeps ${product}`);
  }
  assert.deepEqual(offenders, [], offenders.join('\n  '));
});

test('the sweep does not race a product that already has its own job', () => {
  const sweep = fs.readFileSync(path.join(ROOT, 'api', 'generate-paid-navigator.js'), 'utf8');
  const list = sweep.slice(sweep.indexOf('SWEPT_PRODUCTS'), sweep.indexOf('];', sweep.indexOf('SWEPT_PRODUCTS')));
  for (const product of ['buying', 'hoa', 'contractor']) {
    assert.ok(!list.includes(`'${product}'`),
      `${product} has its own job; sweeping it too would generate and bill the same report twice`);
  }
});

test('every page still names a price, and it is the one Stripe charges', () => {
  // check-prices.js enforces the exact figure at deploy time; this is the part
  // that must not silently disappear when copy is rewritten.
  for (const { file, src } of PRODUCT_PAGES) {
    const expected = prices.pages[file].expectedPriceCents / 100;
    const shown = new RegExp(`\\$${expected}\\b`).test(visible(src));
    const onCheckoutPage = !!prices.pages[file].checkoutPage;
    assert.ok(shown || onCheckoutPage, `${file} no longer shows $${expected}`);
  }
});
