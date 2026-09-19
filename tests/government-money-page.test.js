// The contract government-money.html is held to.
//
// Every test here corresponds to a defect the 2026-09-19 audit found on the
// live page (docs/GOVERNMENT-MONEY-AUDIT.md). The page passed the entire
// existing suite with all of them present, which is the point:
// tests/navigator-claims.test.js checks that a page does not sell a *year* it
// cannot grant and does not sell *reference data* nobody holds. It had nothing
// to say about a page selling "AI searches current programs" on top of a prompt
// whose own second paragraph reads "You do not have live access to current
// program databases", an intake that accepted a single character on the way to
// a $39 checkout, or a form that never asked which state the customer lives in
// while selling state and utility programs.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'government-money.html'), 'utf8');
const ENGINE = require('../navigator-government-money-engine.js');

// Text a customer reads, minus the setup comments the page carries for whoever
// maintains it. Newlines are preserved so a reported line number is real.
function visible(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
}
const VISIBLE = visible(PAGE);

// The page's own inline script — the half of the gate that runs in the browser.
const INLINE = (PAGE.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';

/* ----------------------------------------------- the money-safety guarantee */

test('the page cannot send anyone to checkout while the price and the link disagree', () => {
  // The price moved to $19 and the Stripe link for it does not exist yet. A
  // page displaying $19 against a button that charges $39 is precisely the
  // defect scripts/check-prices.js was written for after buying.html showed
  // $39 while its button pointed at the $19 link.
  const hrefAttr = (PAGE.match(/<a href="([^"]+)"[^>]*id="pay-btn"/) || [])[1]
    || (PAGE.match(/id="pay-btn"[^>]*href="([^"]+)"/) || [])[1];
  assert.ok(hrefAttr, "could not find the pay button's href");

  if (hrefAttr.indexOf('REPLACE_WITH_') !== -1) {
    assert.match(INLINE, /indexOf\('REPLACE_WITH_'\) !== -1[\s\S]{0,400}return;/,
      'the button carries a placeholder link and the script does not refuse to follow it '
      + 'before any checkout call — a customer would be sent to a dead URL or, worse, '
      + 'charged the old price');
    assert.match(VISIBLE, /Checkout is being updated/,
      'a switched-off button must say so on the page, not just fail silently');
  } else {
    assert.match(hrefAttr, /^https:\/\/buy\.stripe\.com\//,
      'the pay button must point at a Stripe Payment Link or at nothing at all');
  }
});

test('the old $39 payment link is not linked from the page any more', () => {
  assert.ok(!VISIBLE.includes('buy.stripe.com/00w14n0NS6UkdsEa80abK08'),
    'government-money.html still links the $39 Payment Link while displaying $19');
});

test('the displayed price and prices.config.json agree about what this costs', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'prices.config.json'), 'utf8'));
  const listed = cfg.pages['government-money.html'];
  const skipped = cfg._skipped['government-money.html'];
  assert.ok(listed || skipped,
    'government-money.html appears in neither pages nor _skipped — its price is unchecked');
  const shown = (VISIBLE.match(/class="price-amount">\$(\d+)/) || [])[1];
  assert.ok(shown, 'the page prints no price at all');
  if (listed) {
    assert.equal(Number(shown) * 100, listed.expectedPriceCents,
      'the page and the config disagree about the price');
  } else {
    assert.match(skipped, /REPLACE_WITH_|not yet created|NOT YET CREATED/i,
      'a skipped price needs a reason naming what is missing');
  }
});

/* ---------------------------------------------------------------- the gate */

test('the page and the server gate checkout on the same rules', () => {
  // Not "both have a gate" — the SAME gate. Two copies of this logic is the
  // drift that let a customer reach checkout with input the server rejected.
  assert.match(PAGE, /navigator-government-money-engine\.js/,
    'the page must load the engine rather than carrying its own copy of the rules');
  assert.match(INLINE, /GovernmentMoneyEngine\.checkSufficiency/,
    'the page must gate its button on the engine');

  const server = fs.readFileSync(path.join(ROOT, 'api', 'navigator-intake.js'), 'utf8');
  assert.match(server, /navigator-government-money-engine/,
    'the server must load the same engine the page does');
  assert.match(server, /checkGovernmentMoneySufficiency\(formData\)/,
    'the server must run the sufficiency check, not trust the page to have run it');
});

test('a single character is still not a submission, on the page and on the server', () => {
  // Verified live on 2026-09-19: description "x" created a submission and
  // handed the browser to a $39 checkout.
  assert.equal(ENGINE.checkSufficiency({ description: 'x' }).sufficient, false);
  assert.equal(ENGINE.checkSufficiency({ description: '' }).sufficient, false);
  assert.equal(ENGINE.checkSufficiency({}).sufficient, false);
});

test('a description with no place in it cannot buy a report', () => {
  // The one fact without which the report is silently federal-only.
  const d = ENGINE.checkSufficiency({
    description: 'We own our home and had a heat pump installed last year. Household of four.',
  });
  assert.equal(d.sufficient, false);
  assert.deepEqual(d.missing, ['state']);
  assert.match(d.message, /state|ZIP/i, 'the refusal must name what is missing');
});

test('a state name, a postal code or a ZIP all satisfy the gate', () => {
  for (const said of [
    'We own our home in Columbus, Ohio and had a heat pump installed.',
    'Homeowner, OH, heat pump installed last spring.',
    'We rent, 43215, household of two.',
    'Live in Puerto Rico, own the house.',
  ]) {
    assert.equal(ENGINE.checkSufficiency({ description: said }).sufficient, true,
      `the gate rejected a description that names a place: ${said}`);
  }
});

test('lowercase postal codes are not mistaken for states', () => {
  // Half the codes are ordinary English words. A case-insensitive match on
  // them passes every sentence ever written, which is a gate that is not one.
  assert.equal(ENGINE.namesAPlace('we live in a house and would or may qualify'), false);
  assert.equal(ENGINE.namesAPlace('ok so I am a homeowner and I rent out a room'), false);
});

/* ------------------------------------------------- the claims that had none */

test('the page does not sell a live lookup nothing performs', () => {
  // C1. data/ holds no program corpus, nothing in vercel.json refreshes one,
  // and PRODUCT_CONFIGS['government-money'] opens by saying so.
  const corpus = fs.readdirSync(path.join(ROOT, 'data')).filter((f) => f !== '.gitkeep');
  if (corpus.some((f) => f.startsWith('government-'))) return;  // a corpus arrived

  // A DENIAL of the lookup is the thing this page is supposed to say, and it
  // uses the same words. "We hold no live program database" must not fail a
  // test whose whole purpose is to keep that sentence on the page — so a match
  // counts as a claim only when nothing negates it in the run-up to it.
  const claim = /searches current|current program information|live (?:program|incentive) (?:database|data)/ig;
  const NEGATED = /\b(?:no|not|never|without|cannot|don't|doesn't)\b[^.]{0,40}$/i;
  VISIBLE.split('\n').forEach((line, i) => {
    claim.lastIndex = 0;
    let m;
    while ((m = claim.exec(line)) !== null) {
      if (NEGATED.test(line.slice(0, m.index))) continue;
      assert.fail(`government-money.html:${i + 1} sells a lookup nothing performs: `
        + line.trim().replace(/<[^>]+>/g, '').slice(0, 90));
    }
  });
});

test('the page does not promise a figure the engine refuses to print', () => {
  // HONESTY_RULES forbids by name "the name and current dollar amount of a
  // specific government program", and the task prompt forbids putting a
  // program figure in key_numbers. The page sold "estimated dollar value of
  // each program" twice and "deadlines or windows you shouldn't miss" once.
  for (const re of [
    /estimated dollar value/i,
    /deadlines? or windows? you shouldn'?t miss/i,
    /already owes you/i,
  ]) {
    assert.equal(re.test(VISIBLE), false,
      `government-money.html sells something the engine will not produce: ${re}`);
  }
});

test('the page states the limit its whole method rests on', () => {
  assert.match(VISIBLE, /do not hold a live program database|hold no live program database/i,
    'the page must say plainly that there is no live database behind it');
  assert.match(VISIBLE, /confirm|check/i);
});

test('every promise on the page is one the prompt requires', () => {
  // The other half of the bargain. The page sells a source on every line and a
  // ruled-out section; if the prompt does not require them the copy is a
  // promise again rather than a description.
  const engine = fs.readFileSync(path.join(ROOT, 'api', '_lib', 'navigator-engine.js'), 'utf8');
  const start = engine.indexOf("'government-money': {");
  const task = engine.slice(start, engine.indexOf("'home-maintenance': {", start));
  assert.ok(task.length > 500, 'the government-money product config is gone or empty');

  assert.match(task, /EVERY LINE CARRIES ITS AUTHORITY/,
    'the page promises the office that can confirm each line and the prompt does not require one');
  assert.match(task, /RULE THINGS OUT, OUT LOUD/,
    'the page sells a ruled-out section and the prompt does not require one');
  assert.match(task, /NEVER PUT A PROGRAM'S DOLLAR FIGURE IN key_numbers/,
    'key_numbers renders as a total at the top of the report — a program figure there '
    + 'reads as money the customer is going to receive');
  assert.match(task, /worth nothing in a year they owe nothing/,
    'the first DON\'T-COUNT rule is missing: a credit against tax you do not owe');
});

test('the page states a refund position', () => {
  assert.match(VISIBLE, /refund it in full|refund in full/i,
    'a product whose output is this hard to verify in advance needs a stated refund position');
});

test('the page carries a "what this does not do" section', () => {
  assert.match(VISIBLE, /What this does not do/i);
  for (const promise of [
    /do not file anything for you|do not file, submit or apply|does not file, submit or apply/i,
    /do not ask for a login|no logins/i,
    /federal-only|federal side/i,
  ]) {
    assert.match(VISIBLE, promise, `missing limit: ${promise}`);
  }
});

/* --------------------------------------------------------------- dead code */

test('no handler is bound to an element that does not exist', () => {
  // I2: the old page wired .category-chip listeners and had no chips, so
  // selectedCategory was always null and was posted as such on every
  // submission for as long as the page existed.
  assert.equal(/category-chip/.test(PAGE), false,
    'the dead category-chip handler is back');
  const ids = [...INLINE.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(ids)].filter((id) => !PAGE.includes(`id="${id}"`));
  assert.deepEqual(missing, [],
    `the page script reaches for ids the page does not have: ${missing.join(', ')}`);
});

test('the upload copy names the file types the input accepts', () => {
  // I8: the copy said "PDF, JPG or PNG" while accept= also took .webp.
  const accept = (PAGE.match(/id="upload-input"[^>]*accept="([^"]+)"/) || [])[1] || '';
  const exts = accept.split(',').map((e) => e.trim().replace('.', '').toUpperCase())
    .filter((e) => e && e !== 'JPEG');
  const copy = (VISIBLE.match(/class="upload-sub">([^<]+)/) || [])[1] || '';
  const unlisted = exts.filter((e) => copy.toUpperCase().indexOf(e) === -1);
  assert.deepEqual(unlisted, [],
    `the input accepts ${unlisted.join(', ')} and the copy beside it does not say so`);
});

/* --------------------------------------------------------------- the design */

test('the page uses the /closing design system rather than a second one', () => {
  assert.match(PAGE, /navigator-editorial\.css/,
    'government-money.html must load the shared editorial system');
  assert.ok(!/<link[^>]+navigator-shared\.css/.test(VISIBLE),
    'government-money.html must not load both design systems');
});

test('the page chrome is the same chrome /closing uses', () => {
  const closing = fs.readFileSync(path.join(ROOT, 'closing.html'), 'utf8');
  for (const marker of ['<header class="nav">', 'class="wrap nav-in"', 'class="brand"',
    'hero-grid', 'class="steps"', 'class="sec-intro"']) {
    assert.ok(closing.includes(marker), `/closing no longer uses ${marker} — update this test`);
    assert.ok(PAGE.includes(marker),
      `government-money.html does not use ${marker}, so the two pages will not look alike`);
  }
});

test('no emoji in the body copy', () => {
  // /closing has none, and on a page asking for money about tax credits they
  // read as a different company.
  const emoji = VISIBLE.replace(/&[a-z]+;/g, '').replace(/&#\d+;/g, '')
    .match(/[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}]/gu) || [];
  assert.deepEqual(emoji, [], `emoji left in the copy: ${emoji.join(' ')}`);
});
