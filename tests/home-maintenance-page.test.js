// The contract home-maintenance.html is held to.
//
// Every test here corresponds to a defect docs/HOME-MAINTENANCE-ENGINE-AUDIT-
// REPORT.md found on the live page: a category selector that silently
// defaulted to "Roof" with no chip ever shown as active, a $59 price sitting
// above mechanically simpler siblings, and a "no quotes yet" outcome that
// took full payment for a report with no verdict in it and no way to get the
// money back automatically. tests/home-maintenance-engine.test.js covers the
// engine-side fixes (material ranges, the repeat-repair caution); this file
// covers the page and the wiring around it.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'home-maintenance.html'), 'utf8');
const ENGINE = require('../navigator-home-maintenance-engine.js');

// Text a customer reads, minus the setup comments the page carries for whoever
// maintains it. Newlines are preserved so a reported line number is real.
function visible(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
}
const VISIBLE = visible(PAGE);
const INLINE_SCRIPT = (PAGE.match(/<script>\s*\(function\(\)\{[\s\S]*?\}\)\(\);\s*<\/script>/) || [''])[0];

/* ----------------------------------------------- the category-default bug */

test('the category selector has no default value baked into the script — a customer must click one', () => {
  // The exact live bug: `let selectedCategory = "Roof";` silently supplied a
  // category the sufficiency gate could never flag as missing, because
  // "Roof" is a valid category value. Confirmed live this audit: no chip
  // carried the "active" class on a fresh page load.
  assert.match(INLINE_SCRIPT, /let selectedCategory = null;/,
    'selectedCategory must start as null, not a category string, or a customer who never clicks a chip is silently charged for the wrong system');
  assert.ok(!/let selectedCategory = ["'](Roof|HVAC|Water Heater|Windows|Generator|Other)["']/.test(INLINE_SCRIPT),
    'the script still defaults selectedCategory to a real category string');
});

test('no category chip carries the "active" class in the page markup — the page must not fake a visual default either', () => {
  const chipRow = PAGE.slice(PAGE.indexOf('id="category-chips"'), PAGE.indexOf('</div>', PAGE.indexOf('id="category-chips"')));
  assert.ok(!/category-chip active|active category-chip/.test(chipRow),
    'a chip is marked active in markup while the script also has no default — pick one source of truth');
});

test('a null category is something checkSufficiency actually rejects', () => {
  const s = ENGINE.checkSufficiency({ category: null, system_age_years: 10, symptoms: ['comparing_before_failure'], repair_quote: 1 });
  assert.equal(s.sufficient, false);
  assert.ok(s.missing.some((m) => m.key === 'category'));
});

/* ------------------------------------------------- the money-safety guarantee */

test('the page cannot send anyone to checkout while the price and the link disagree', () => {
  // The price moved to $39 and the Stripe link for it does not exist yet. A
  // page displaying $39 against a button that charges $59 is precisely the
  // defect scripts/check-prices.js was written for.
  const hrefAttr = (PAGE.match(/<a href="([^"]+)"[^>]*id="pay-btn"/) || [])[1];
  assert.ok(hrefAttr, "could not find the pay button's href");

  if (hrefAttr.indexOf('REPLACE_WITH_') !== -1) {
    assert.match(INLINE_SCRIPT, /href\.indexOf\('REPLACE_WITH_'\) !== -1/,
      'the button carries a placeholder link and nothing in the page refuses to follow it — '
      + 'a customer would be sent to a dead URL or, worse, the old price');
    // The guard must run, and fail out, before a submission is ever created —
    // not after, and not merely somewhere in the same function.
    const guardAt = INLINE_SCRIPT.indexOf("href.indexOf('REPLACE_WITH_')");
    const submitAt = INLINE_SCRIPT.indexOf('submitNavigatorIntake(');
    assert.ok(guardAt !== -1 && submitAt !== -1 && guardAt < submitAt,
      'the placeholder guard must return before any submission is created or any checkout call is made');
    assert.match(VISIBLE, /switched off|Checkout is being updated/i,
      'a switched-off button must say so somewhere reachable, not just fail silently');
  } else {
    assert.match(hrefAttr, /^https:\/\/buy\.stripe\.com\//,
      'the pay button must point at a Stripe Payment Link or at nothing at all');
  }
});

test('the old $59 payment link is not linked from the page any more', () => {
  assert.ok(!PAGE.includes('buy.stripe.com/28EeVd9ko3I80FS1BuabK09') || /RETIRED/.test(PAGE),
    'home-maintenance.html still links the $59 Payment Link while displaying $39');
});

test('the displayed price and prices.config.json agree about what this costs', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'prices.config.json'), 'utf8'));
  const listed = cfg.pages['home-maintenance.html'];
  const skipped = cfg._skipped['home-maintenance.html'];
  assert.ok(listed || skipped,
    'home-maintenance.html appears in neither pages nor _skipped — its price is unchecked');
  if (listed) {
    const shown = (VISIBLE.match(/class="price-amount">\$(\d+)/) || [])[1];
    assert.equal(Number(shown) * 100, listed.expectedPriceCents,
      'the page and the config disagree about the price');
  } else {
    assert.match(skipped, /REPLACE_WITH_|not yet created|NOT YET CREATED/i,
      'a skipped price needs a reason naming what is missing');
    assert.match(skipped, /3900|\$39/,
      'the skip note should name the price it is waiting on, so a stale note is easy to spot');
  }
});

test('the price shown matches what the audit report recommended', () => {
  assert.match(VISIBLE, /class="price-amount">\$39</, 'the page must show $39, not the old $59');
});

/* ---------------------------------------------------------- the thin-result refund */

test('a "no quotes yet" submission is queued for an automatic refund, on the exact condition the engine computes', () => {
  const engineSrc = fs.readFileSync(path.join(ROOT, 'api', '_lib', 'navigator-engine.js'), 'utf8');
  assert.match(engineSrc, /homeMaintenanceAnalysis\.verdict === homeMaintenanceEngine\.Verdict\.NEED_BOTH_QUOTES/,
    'nothing queues the refund on the exact verdict that means no financial verdict was given, or it checks the wrong thing');
  assert.match(engineSrc, /refund_state: 'due_thin_result'/,
    'the refund is not put on the queue process-refunds.js reads');

  const refunds = fs.readFileSync(path.join(ROOT, 'api', 'process-refunds.js'), 'utf8');
  assert.match(refunds, /REFUND_STATE_THIN = 'due_thin_result'/,
    'the queue the engine writes to is not the one the sweep reads');
});

test('the page and the FAQ tell the customer about the automatic refund before they pay', () => {
  assert.match(VISIBLE, /refunded? (the charge )?automatically/i,
    'the page must state the refund position, the same way the field hint promises it');
});

/* ------------------------------------------------------------- material/type */

test('material options are only offered for categories the engine actually holds a material-specific range for', () => {
  const engineCategories = Object.keys(ENGINE.MATERIAL_RANGES);
  assert.deepEqual(engineCategories.sort(), ['Roof', 'Water Heater'],
    'this test names the categories the engine covers — update both together if that ever changes');
  assert.match(INLINE_SCRIPT, /HomeMaintenanceEngine\.MATERIAL_OPTIONS\[category\]/,
    'the page must read material options from the engine, not keep its own separate copy that can drift');
});

test('the material field is optional — it is not part of the sufficiency gate', () => {
  const s = ENGINE.checkSufficiency({
    category: 'Roof', system_age_years: 10, symptoms: ['comparing_before_failure'], repair_quote: 500,
  });
  assert.equal(s.sufficient, true, 'a submission with no material given must still be payable');
});

/* ---------------------------------------------------------------- dead code */

test('no handler is bound to an element that does not exist', () => {
  const selectors = [...INLINE_SCRIPT.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(selectors)].filter((id) => !PAGE.includes(`id="${id}"`));
  assert.deepEqual(missing, [],
    `home-maintenance.html's inline script reaches for ids the page does not have: ${missing.join(', ')}`);
});

/* --------------------------------------------------------------- the design */

test('the header carries no colored logo-mark icon or pill sub-brand badge, matching /closing', () => {
  // VISIBLE, not PAGE: the setup comment explaining this fix names the very
  // classes it removed, and matching against raw PAGE would fail on its own
  // explanation rather than on any markup.
  const header = VISIBLE.slice(VISIBLE.indexOf('<header'), VISIBLE.indexOf('</header>'));
  assert.ok(!/class="logo-mark"/.test(header), 'the colored logo-mark icon should have been dropped to match /closing');
  assert.ok(!/class="nav-subbrand"/.test(header), 'the pill sub-brand badge should have been dropped to match /closing');
});

test('the page loads only the fonts its own theme actually uses', () => {
  assert.ok(!/family=Inter|family=Sora/.test(PAGE),
    'the unused Inter/Sora font link should have been removed once navigator-closing-theme.css overrides those rules away');
  assert.match(PAGE, /family=Newsreader/, 'the closing theme\'s own fonts must still load');
});
