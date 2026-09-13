'use strict';

// What /contractor sells must be what the catalogue runs.
//
// This file exists because of what the page used to say. Step 5 of "how it
// works" read: "AI researches the context — typical price ranges and what's
// normal for this category are factored in." Nothing researched anything. One
// model call read the estimate and wrote a verdict, and the range behind that
// verdict was whatever it recalled that run. The page also promised "which
// quote is strongest, and why" and a check on "what could turn into a costly
// change order", neither of which anything was working through a list to find.
//
// A page describing work the engine does not do is not a copy bug. It is the
// thing the customer paid for, missing from the report.
//
// These assertions are deliberately mechanical and few, for the reason
// tests/promises.test.js gives: a test that fails on ordinary copy edits gets
// deleted, and then nothing is checking anything.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const page = read('contractor.html');
const reportPage = read('contractor-report.html');
const engineSrc = read('api/_lib/contractor-engine.js');

const { CATALOG, checkCountFor } = require('../api/_lib/contractor-audit');
const { COVERAGE_FLOOR } = require('../api/_lib/contractor-engine');
const ref = require('../api/_lib/contractor-reference');
const prices = JSON.parse(read('prices.config.json'));

function decode(s) {
  return s
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&middot;/g, '·')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}

// The text of every check the page names, taken out of the markup the page
// actually renders rather than out of a prose paragraph.
const pageChecks = Array.from(page.matchAll(/<div class="chk"><span class="n">[^<]*<\/span><span>([^<]+)<\/span><\/div>/g))
  .map((m) => decode(m[1]).trim());

// --- the checks the page names ---------------------------------------------

test('every check in the catalogue is named on the page', () => {
  const paired = CATALOG.filter((c) => c.pair);
  const singles = CATALOG.filter((c) => !c.pair);

  const missing = singles.filter((c) => !pageChecks.includes(c.label)).map((c) => c.label);
  assert.deepEqual(missing, [],
    'the catalogue runs checks the page never mentions, so the customer is not told what they are buying:\n  '
    + missing.join('\n  '));

  // The two deposit checks are complements — exactly one runs, decided by the
  // state — so the page advertises them as one line rather than as two the
  // customer will never both receive.
  assert.equal(paired.length, 2, 'the deposit pair changed shape; this assertion needs rewriting, not deleting');
  const pairLine = pageChecks.find((t) => /statutory limit/.test(t) && /customary practice/.test(t));
  assert.ok(pairLine, 'the page no longer names the deposit check in either of its two forms');
});

test('the page does not name a check the catalogue cannot run', () => {
  const labels = new Set(CATALOG.map((c) => c.label));
  const invented = pageChecks.filter(
    (t) => !labels.has(t) && !(/statutory limit/.test(t) && /customary practice/.test(t))
  );
  assert.deepEqual(invented, [],
    'the page sells checks nothing performs:\n  ' + invented.join('\n  '));
});

test('the per-trade counts the page prints are the counts the catalogue runs', () => {
  // Printed in the section headings, in the FAQ, and set into the intake form
  // by JavaScript as the customer picks a trade. All three come from here.
  const expected = {
    HVAC: checkCountFor('HVAC'),
    Roofing: checkCountFor('Roofing'),
    Windows: checkCountFor('Windows'),
    Plumbing: checkCountFor('Plumbing'),
    Electrical: checkCountFor('Electrical'),
    Other: checkCountFor('Other'),
  };

  const inScript = page.match(/var counts = \{([^}]+)\}/);
  assert.ok(inScript, 'the intake form no longer sets a per-trade count');
  for (const [trade, count] of Object.entries(expected)) {
    assert.match(inScript[1], new RegExp(`${trade}:\\s*${count}\\b`),
      `the form tells a ${trade} customer a number the catalogue does not run`);
  }

  // And the prose. Spelled out, so these are the words rather than the digits.
  const words = { 26: 'twenty-six', 28: 'twenty-eight', 29: 'twenty-nine', 32: 'thirty-two' };
  for (const count of new Set(Object.values(expected))) {
    assert.ok(words[count], `no spelled-out form recorded for ${count}; add one rather than dropping the check`);
    assert.match(decode(page), new RegExp(words[count], 'i'),
      `the page never says "${words[count]}", so a count changed without the prose changing`);
  }
});

// --- the claims that used to be false --------------------------------------

test('the page does not claim to research anything', () => {
  // The retired sentence, and its family. The product consults a checked-in
  // table of published ranges with the sources named; it does not research, and
  // "we looked it up for you" is the claim a sceptical customer tests first.
  const banned = [
    /AI researches/i,
    /researches the (context|market)/i,
    /real[- ]time (pricing|price)/i,
    /local (comps?|comparables?) (for|in) your/i,
    /we (check|verify|confirm) (your )?contractor'?s? licen[cs]e/i,
  ];
  const visible = decode(page);
  for (const pattern of banned) {
    assert.equal(pattern.test(visible), false,
      `contractor.html makes a claim nothing performs: ${pattern}`);
  }
});

test('the page says a published range is not a local quote, in both directions', () => {
  const visible = decode(page);
  assert.match(visible, /national/i);
  assert.match(visible, /not a quote for your house|not a local quote|is not a quote/i,
    'the page sells a price range without saying what kind of range it is — the one claim on this page most '
    + 'likely to be repeated to a contractor and lost');
});

test('the states the page names as capping deposits are the states with a cap', () => {
  const visible = decode(page);
  const named = ['California', 'Nevada', 'Maryland', 'Massachusetts', 'Pennsylvania'];
  const haveCaps = Object.keys(ref.DEPOSIT_CAPS).map((c) => ref.stateName(c)).sort();
  assert.deepEqual(named.slice().sort(), haveCaps,
    'the page names a different set of states than contractor-reference.js holds a statute for');
  for (const state of named) {
    assert.ok(visible.includes(state), `the page stopped naming ${state}, which it tests against a statute`);
  }
});

// --- the refund promise -----------------------------------------------------

test('the refund floor the page promises is the floor the engine applies', () => {
  const percent = Math.round(COVERAGE_FLOOR * 100);
  const visible = decode(page);
  assert.match(visible, new RegExp(`${percent}%`),
    `the page never prints ${percent}%, so the refund promise and the engine have drifted apart`);
  assert.match(visible, /refund/i);

  // And the report page has to be able to say it happened, or the customer sees
  // a charge reversed with no explanation attached to anything.
  assert.match(reportPage, /refund/i, 'the report page cannot tell a refunded customer that they were refunded');
});

test('the engine really does queue the refund it promises', () => {
  assert.match(engineSrc, /COVERAGE_FLOOR/);
  assert.match(engineSrc, /refund_state/,
    'the engine computes a coverage floor and never writes a refund state — the promise is decorative');
  const refunder = read('api/process-refunds.js');
  assert.match(refunder, /due_thin_result/,
    'nothing turns a thin-result refund into money actually returned');
  assert.match(refunder, /contractor_reports/,
    'the refunder cannot see a delivered contractor report, so it would refund one');
});

// --- price ------------------------------------------------------------------

test('the price on the page is the price in the config and the price Stripe charges', () => {
  const expected = prices.pages['contractor.html'].expectedPriceCents / 100;
  assert.match(decode(page), new RegExp(`\\$${expected}\\b`), `contractor.html no longer prints $${expected}`);
  assert.match(page, new RegExp(prices.pages['contractor.html'].stripeLinkId),
    'the pay button no longer points at the configured Stripe link');
});

// --- what the intake collects the audit actually uses ------------------------

test('every answer the form demands is an answer a check consumes', () => {
  // Asking for something and not using it is a tax on the customer at the exact
  // moment they are deciding whether to bother. The old form asked for a job
  // description and nothing else; the engine read a `zip` the form never
  // collected, so the one field that could have placed the price regionally was
  // dead code on both sides.
  const audit = read('api/_lib/contractor-audit.js');
  const engine = engineSrc;
  for (const field of ['state', 'quoted_at_home', 'home_sqft', 'category']) {
    assert.match(page, new RegExp(field.replace(/_/g, '[_-]?')),
      `the form no longer collects ${field}`);
    assert.match(engine, new RegExp(field), `the engine ignores ${field}, which the form makes the customer answer`);
  }
  assert.match(audit, /x\.signedAtHome/, 'nothing reads the in-home answer the form requires');
  assert.match(audit, /x\.homeSqft/, 'nothing reads the home size the form asks for');
  assert.match(audit, /x\.state/, 'nothing reads the state the form requires');
});

test('the trade is chosen by the customer, never defaulted', () => {
  // The old page set `selectedCategory = "HVAC"` in JavaScript while no chip
  // rendered as selected, so a roofer who never touched the row had their roof
  // quote analysed as an HVAC job — silently, and after paying.
  assert.equal(/selectedTrade\s*=\s*['"]/.test(page), false,
    'the trade is pre-set in JavaScript again; nothing on screen says so');
  assert.match(page, /selectedTrade\s*=\s*null/);
  assert.match(page, /if \(!selectedTrade\)/, 'nothing stops a submission with no trade chosen');
});
