// The contract subscriptions.html is held to.
//
// Every test here corresponds to a defect the 2026-09-19 audit found on the
// live page (docs/SUBSCRIPTIONS-AUDIT.md). The page passed the existing suite
// with all of them present, which is the point: tests/navigator-claims.test.js
// checks that a page does not sell a *year* it cannot grant and does not sell
// *reference data* nobody holds. It had nothing to say about a page selling
// cancellation links the prompt forbids, an intake that accepts a single
// character, or a $49 product with no engine behind it.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'subscriptions.html'), 'utf8');
const INTAKE_JS = fs.readFileSync(path.join(ROOT, 'subscriptions-intake.js'), 'utf8');
const ENGINE = require('../navigator-subscription-engine.js');

// Text a customer reads, minus the setup comments the page carries for whoever
// maintains it. Newlines are preserved so a reported line number is real.
function visible(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
}
const VISIBLE = visible(PAGE);

/* ----------------------------------------------- the money-safety guarantee */

test('the page cannot send anyone to checkout while the price and the link disagree', () => {
  // The price moved to $29 and the Stripe link for it does not exist yet. A
  // page displaying $29 against a button that charges $49 is precisely the
  // defect scripts/check-prices.js was written for after buying.html showed
  // $39 while its button pointed at the $19 link.
  const href = (PAGE.match(/id="pay-btn"[^>]*/) || [''])[0];
  const hrefAttr = (PAGE.match(/<a href="([^"]+)"[^>]*id="pay-btn"/) || [])[1]
    || (PAGE.match(/id="pay-btn"[^>]*href="([^"]+)"/) || [])[1];
  assert.ok(hrefAttr, `could not find the pay button's href (${href})`);

  if (hrefAttr.indexOf('REPLACE_WITH_') !== -1) {
    // Placeholder: the script MUST refuse to navigate.
    assert.match(INTAKE_JS, /REPLACE_WITH_/,
      'the button carries a placeholder link and nothing in the page refuses to follow it — '
      + 'a customer would be sent to a dead URL or, worse, the old price');
    assert.match(INTAKE_JS, /indexOf\('REPLACE_WITH_'\) !== -1[\s\S]{0,400}return;/,
      'the placeholder guard must return before any checkout call');
    assert.match(VISIBLE, /Checkout is being updated/,
      'a switched-off button must say so on the page, not just fail silently');
  } else {
    assert.match(hrefAttr, /^https:\/\/buy\.stripe\.com\//,
      'the pay button must point at a Stripe Payment Link or at nothing at all');
  }
});

test('the old $49 payment link is not linked from the page any more', () => {
  assert.ok(!PAGE.includes('buy.stripe.com/4gMaEXbsw2E49co5RKabK07')
    || /RETIRED/.test(PAGE),
  'subscriptions.html still links the $49 Payment Link while displaying $29');
});

test('the displayed price and prices.config.json agree about what this costs', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'prices.config.json'), 'utf8'));
  const listed = cfg.pages['subscriptions.html'];
  const skipped = cfg._skipped['subscriptions.html'];
  assert.ok(listed || skipped,
    'subscriptions.html appears in neither pages nor _skipped — its price is unchecked');
  if (listed) {
    const shown = (VISIBLE.match(/class="price-amount">\$(\d+)/) || [])[1];
    assert.equal(Number(shown) * 100, listed.expectedPriceCents,
      'the page and the config disagree about the price');
  } else {
    assert.match(skipped, /REPLACE_WITH_|not yet created|NOT YET CREATED/i,
      'a skipped price needs a reason naming what is missing');
  }
});

/* ------------------------------------------------- the claims that had none */

test('the page does not sell cancellation links the engine will not produce', () => {
  // C5 in the audit. The old page said "Direct links to cancel or downgrade
  // where available" twice, while the prompt behind it said "describe it in
  // general terms rather than fabricating a specific URL" and the engine did
  // not import the one table of real URLs in the repository.
  const stream = require('../navigator-streaming-engine.js');
  const held = Object.keys(stream.MANAGE_URLS).length;
  assert.ok(held > 0, 'the URL table is empty, so no link claim on the page can be true');

  // A claim of links for everything is false; a claim naming the limit is not.
  const overclaim = /direct (?:cancellation )?links? (?:to cancel|for (?:each|every))/i;
  VISIBLE.split('\n').forEach((lineText, i) => {
    if (!overclaim.test(lineText)) return;
    assert.fail(`subscriptions.html:${i + 1} promises a link for every service; `
      + `the engine holds ${held} checked ones and refuses to invent the rest: `
      + lineText.trim().replace(/<[^>]+>/g, '').slice(0, 90));
  });

  assert.match(VISIBLE, /we do not invent a URL|do not hold a checked cancellation link/i,
    'the page must say plainly that it does not hold a link for every service');
});

test('the page does not promise a figure the engine refuses to print', () => {
  // An unpriced line never gets an estimated amount — tests/subscription-
  // engine.test.js proves it over every input. The page must not sell one.
  const d = ENGINE.decide({
    name: 'Gym', price: null, period: 'monthly',
    lastUsed: 'never', wouldMiss: 'not-at-all', usedBy: 'just-me',
  }, '2026-06-15');
  assert.equal(d.saving.amount, 0);
  assert.match(VISIBLE, /No price, no figure|do not put a number on a line you did not price/i,
    'the engine will not price an unpriced line and the page has to say so');
});

test('the page does not use "rotate" as a synonym for cancel', () => {
  // The engine separates them on a per-service pause policy. If the page
  // conflates them it is selling a hold that mostly does not exist.
  assert.match(VISIBLE, /cannot be paused|no pause|genuine hold/i,
    'the page must explain that most services cannot actually be paused');
});

test('every action the page sells is one the engine can return', () => {
  const sold = ['keep', 'downgrade', 'pause', 'cancel', 'review'];
  const actions = Object.values(ENGINE.Action).join(' ');
  for (const verb of sold) {
    const ok = verb === 'pause'
      ? /rotate/.test(actions)      // "pause" is how the page says ROTATE
      : actions.includes(verb);
    assert.ok(ok, `the page sells "${verb}" and the engine has no action for it`);
  }
});

/* ---------------------------------------------------------------- the gate */

test('the page and the server gate checkout on the same rules', () => {
  // Not "both have a gate" — the SAME gate. Two copies of this logic is the
  // drift that let a customer reach checkout with input the server rejected.
  assert.match(INTAKE_JS, /checkSufficiency/,
    'the page must gate its button on the engine, not on its own copy of the rules');
  const server = fs.readFileSync(path.join(ROOT, 'api', 'navigator-intake.js'), 'utf8');
  assert.match(server, /navigator-subscription-engine/,
    'the server must load the same engine the page does');
  assert.match(server, /checkSufficiency/,
    'the server must run the sufficiency check, not trust the page to have run it');
});

test('a single character is still not a submission, on the page and on the server', () => {
  assert.equal(ENGINE.checkSufficiency({ lines: [{ name: 'a' }] }).sufficient, false);
  assert.equal(ENGINE.checkSufficiency({ lines: [] }).sufficient, false);
  assert.equal(ENGINE.checkSufficiency({}).sufficient, false);
});

/* ---------------------------------------------------------------- the trust */

test('the page states what happens to an uploaded statement, where it is uploaded', () => {
  // H8: the customer is invited to upload a bank statement and the old page
  // said nothing about retention at the point of upload. /closing does.
  const card = VISIBLE.slice(VISIBLE.indexOf('id="intake-card"'), VISIBLE.indexOf('</section>', VISIBLE.indexOf('id="intake-card"')));
  assert.match(card, /90\s*(?:&nbsp;)?days/,
    'the retention window is stated in the privacy policy and not where it matters');
  assert.match(card, /deleted immediately/,
    'the page must say the analysis copy is deleted');
});

test('the page carries a "what this does not do" section', () => {
  assert.match(VISIBLE, /What this does not do/i);
  for (const promise of [
    /do not connect to your bank/i,
    /do not cancel anything for you/i,
    /do not know what anything will cost if you come back/i,
  ]) {
    assert.match(VISIBLE, promise, `missing limit: ${promise}`);
  }
});

test('the page states a refund position', () => {
  assert.match(VISIBLE, /refund in full/i,
    'a product whose output is this hard to verify in advance needs a stated refund position');
});

test('the strongest trust claim is not buried in the FAQ', () => {
  const faqAt = VISIBLE.indexOf('id="faq"');
  const firstClaim = VISIBLE.search(/no bank login/i);
  assert.ok(firstClaim !== -1, 'the page does not make the no-bank-login claim at all');
  assert.ok(firstClaim < faqAt,
    'the one genuinely differentiating claim on this page appears first in the FAQ');
});

/* --------------------------------------------------------------- the design */

test('the page uses the /closing design system rather than a second one', () => {
  assert.match(PAGE, /navigator-editorial\.css/,
    'subscriptions.html must load the shared editorial system');
  // VISIBLE, not PAGE: the page's own comment explains which system it used to
  // carry and why it no longer does, and that sentence is worth keeping.
  assert.ok(!/<link[^>]+navigator-shared\.css/.test(VISIBLE),
    'subscriptions.html must not load both design systems');
});

test('the page chrome is the same chrome /closing uses', () => {
  const closing = fs.readFileSync(path.join(ROOT, 'closing.html'), 'utf8');
  for (const marker of ['<header class="nav">', 'class="wrap nav-in"', 'class="brand"',
    'hero-grid', 'class="steps"', 'class="sec-intro"']) {
    assert.ok(closing.includes(marker), `/closing no longer uses ${marker} — update this test`);
    assert.ok(PAGE.includes(marker),
      `subscriptions.html does not use ${marker}, so the two pages will not look alike`);
  }
});

test('no emoji in the body copy', () => {
  // The old page carried a paperclip, a padlock and twelve in the footer nav.
  // /closing has none, and on a page asking for money about money they read
  // as a different company.
  const emoji = VISIBLE.replace(/&[a-z]+;/g, '')
    .match(/[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}]/gu) || [];
  assert.deepEqual(emoji, [], `emoji left in the copy: ${emoji.join(' ')}`);
});

/* --------------------------------------------------------- the restart path */

test('the page offers a way to describe something already cancelled', () => {
  // H1 in the audit: the page sold "rotate (pause and resume)" while the only
  // question it asked was what you are subscribed TO, so the resume half had
  // no input path at all.
  assert.match(VISIBLE, /cancelled something/i,
    'nothing on the page lets a customer ask about restarting something');
  assert.match(INTAKE_JS, /status: 'cancelled'/,
    'the restart path is advertised and not wired');
  const d = ENGINE.decide({
    name: 'Disney+', price: 9.99, period: 'monthly', status: 'cancelled', wouldMiss: 'a-lot',
  }, '2026-06-15');
  assert.equal(d.action, ENGINE.Action.RESTART);
});

/* --------------------------------------------------------------- dead code */

test('no handler is bound to an element that does not exist', () => {
  // M4: the old page wired .category-chip listeners and had no chips, so
  // selectedCategory was always null and was posted as such.
  const selectors = [...INTAKE_JS.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(selectors)].filter((id) => !PAGE.includes(`id="${id}"`));
  assert.deepEqual(missing, [],
    `subscriptions-intake.js reaches for ids the page does not have: ${missing.join(', ')}`);
});
