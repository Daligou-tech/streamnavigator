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
const INTAKE_JS = fs.readFileSync(path.join(ROOT, 'government-money-intake.js'), 'utf8');
const E = require('../navigator-government-money-engine.js');
const CAT = require('../data/government-programs.json');

// Text a customer reads, minus the setup comments the page carries for whoever
// maintains it. Newlines are preserved so a reported line number is real.
function visible(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
}
const VISIBLE = visible(PAGE);

/* ----------------------------------------------- the money-safety guarantee */

test('the page cannot send anyone to checkout while the price and the link disagree', () => {
  const hrefAttr = (PAGE.match(/<a href="([^"]+)"[^>]*id="pay-btn"/) || [])[1]
    || (PAGE.match(/id="pay-btn"[^>]*href="([^"]+)"/) || [])[1];
  assert.ok(hrefAttr, "could not find the pay button's href");

  if (hrefAttr.indexOf('REPLACE_WITH_') !== -1) {
    assert.match(INTAKE_JS, /indexOf\('REPLACE_WITH_'\) !== -1[\s\S]{0,400}return;/,
      'the button carries a placeholder link and the script does not refuse to follow it '
      + 'before any checkout call');
    assert.match(VISIBLE, /Checkout is being updated/,
      'a switched-off button must say so on the page, not just fail silently');
  } else {
    assert.match(hrefAttr, /^https:\/\/buy\.stripe\.com\//,
      'the pay button must point at a Stripe Payment Link or at nothing at all');
    // The guard stays in the script even when there is a real link. Both of
    // this product's price moves went through a placeholder, and the runtime
    // half of check-prices.js is what stops a page showing one number while
    // its button charges another.
    assert.match(INTAKE_JS, /REPLACE_WITH_/,
      'the placeholder guard was deleted along with the placeholder');
  }
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
  assert.match(INTAKE_JS, /E\.checkSufficiency/,
    'the page must gate its button on the engine');

  const server = fs.readFileSync(path.join(ROOT, 'api', 'navigator-intake.js'), 'utf8');
  assert.match(server, /navigator-government-money-engine/,
    'the server must load the same engine the page does');
  assert.match(server, /checkGovernmentMoneySufficiency\(formData\)/,
    'the server must run the sufficiency check, not trust the page to have run it');
});

test('a single character is still not a submission, on the page and on the server', () => {
  assert.equal(E.checkSufficiency({ description: 'x' }).sufficient, false);
  assert.equal(E.checkSufficiency({}).sufficient, false);
});

test('the checkout gate does not depend on the catalogue fetch', () => {
  // The free scorecard needs data/government-programs.json; the gate must not,
  // or a failed fetch becomes either a customer who cannot buy or a customer
  // who can buy anything.
  assert.match(INTAKE_JS, /The gate does NOT need this/,
    'the separation is undocumented, which is how it gets undone');
  const gateOnly = E.checkSufficiency({
    state: 'OH', tenure: 'own', householdSize: 2, incomeBand: '75-100k',
    taxLiability: 'yes', actionsDone: [], events: [],
  });
  assert.equal(gateOnly.sufficient, true);
});

test('every question the engine requires is a control on the page', () => {
  for (const id of ['q-state', 'q-tenure', 'q-size', 'q-income', 'q-liability', 'q-done', 'q-events']) {
    assert.ok(PAGE.includes(`id="${id}"`), `the engine requires an answer the page has no control for: ${id}`);
  }
  // And the one that decides whether half the shortlist is worth anything is
  // asked in so many words, not implied.
  assert.match(VISIBLE, /expect to owe federal income tax/i);
});

/* ------------------------------------------- the claims that had none behind */

test('the page does not sell a live lookup nothing performs', () => {
  // A DENIAL of the lookup uses the same words and must not fail a test whose
  // purpose is to keep that denial on the page.
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
  for (const re of [
    /estimated dollar value/i,
    /deadlines? or windows? you shouldn'?t miss/i,
    /already owes you/i,
  ]) {
    assert.equal(re.test(VISIBLE), false,
      `government-money.html sells something the engine will not produce: ${re}`);
  }
});

test('the page names no program the catalogue does not hold', () => {
  // The landlord-jurisdictions rule, applied to this product. A program named
  // in the sales copy and absent from the catalogue is exactly the finding the
  // customer was promised and will not get.
  //
  // Matched on the distinctive noun phrases the catalogue uses, not on every
  // word: the page is allowed to talk about "rebates" in general.
  const held = CAT.programs.map((p) => p.label.toLowerCase());
  const namedOnPage = VISIBLE.replace(/<[^>]+>/g, ' ').toLowerCase();
  const suspicious = [
    'federal efficiency credit', 'residential clean energy', 'clean vehicle credit',
    'property tax relief', 'weatherization', 'earned income credit',
    'child and dependent care', 'premium assistance', 'net metering',
  ];
  for (const phrase of suspicious) {
    if (namedOnPage.indexOf(phrase) === -1) continue;
    assert.ok(held.some((l) => l.indexOf(phrase.split(' ')[0]) !== -1
      || phrase.split(' ').every((w) => l.indexOf(w) !== -1)
      || l.indexOf(phrase) !== -1),
    `the page names "${phrase}" and the catalogue holds no such program`);
  }
});

test('the number of programs the page sells is the number the catalogue holds', () => {
  // The landlord "nine checks" rule. A page that oversells the count by one is
  // the same defect as any other overclaim.
  const WORDS = {
    24: 'Twenty-four', 25: 'Twenty-five', 26: 'Twenty-six', 27: 'Twenty-seven',
    28: 'Twenty-eight', 29: 'Twenty-nine', 30: 'Thirty',
  };
  const word = WORDS[CAT.programs.length];
  assert.ok(word, `${CAT.programs.length} programs — add the word to this test's map`);
  assert.ok(new RegExp(`${word} (?:rebate|program)`, 'i').test(VISIBLE)
    || new RegExp(`${word} programs`, 'i').test(VISIBLE),
  `the catalogue holds ${CAT.programs.length} programs and the page does not say `
    + `"${word.toLowerCase()}"`);
});

test('the page states the limit its whole method rests on', () => {
  assert.match(VISIBLE, /hold no current dollar amounts|holds no amounts|no dollar amounts/i,
    'the page must say plainly that no amounts are held');
  assert.match(VISIBLE, /do not hold a live program database/i);
});

test('every promise on the page is one the prompt requires', () => {
  const engine = fs.readFileSync(path.join(ROOT, 'api', '_lib', 'navigator-engine.js'), 'utf8');
  const start = engine.indexOf("'government-money': {");
  const task = engine.slice(start, engine.indexOf("'home-maintenance': {", start));
  assert.ok(task.length > 500, 'the government-money product config is gone or empty');

  assert.match(task, /NEVER STATE A DOLLAR AMOUNT/,
    'the page sells "we never state an amount" and the prompt does not forbid one');
  assert.match(task, /NEVER CHANGE A VERDICT/,
    'the engine decides and the prompt does not say so');
  assert.match(task, /NAME THE AUTHORITY ON EVERY LINE/,
    'the page promises the office that can confirm each line');
  assert.match(task, /RULED OUT/,
    'the page sells a ruled-out section and the prompt does not require one');
  assert.match(task, /key_numbers takes these and nothing else|COUNTS ONLY/,
    'key_numbers renders as a total at the top of the report — a program figure there '
    + 'reads as money the customer is going to receive');
});

test('the four rules the page sells are the four the engine runs', () => {
  // Sold on the page as D1, D3, D4, D5. If a rule is renamed or removed, the
  // page is selling something that no longer exists.
  for (const code of ['D1', 'D3', 'D4', 'D5']) {
    assert.ok(VISIBLE.indexOf(`>${code}<`) !== -1, `the page no longer names rule ${code}`);
  }
  const src = fs.readFileSync(path.join(ROOT, 'navigator-government-money-engine.js'), 'utf8');
  for (const code of ['D1', 'D3', 'D4', 'D5']) {
    assert.ok(new RegExp(`code: '${code}`).test(src),
      `the page sells rule ${code} and the engine does not emit it`);
  }
});

test('the page states a refund position', () => {
  assert.match(VISIBLE, /refund it in full|refund in full/i,
    'a product whose output is this hard to verify in advance needs a stated refund position');
});

test('the automatic refund the page promises is one the code actually queues', () => {
  // The page says a report that comes back with nothing is refunded without
  // the customer asking. That is only true if something sets the flag, and the
  // condition on the page has to be the condition in the code — "nothing at
  // all", not "no shortlist", because a report with no claims but eight lines
  // worth confirming is a report that did its job.
  assert.match(VISIBLE, /refunded automatically/i,
    'the page no longer promises the automatic refund');
  assert.match(VISIBLE, /you do not have to ask|do not have to ask/i);

  const engine = fs.readFileSync(path.join(ROOT, 'api', '_lib', 'navigator-engine.js'), 'utf8');
  assert.match(engine, /governmentMoneyAnalysis\.totals\.shortlist === 0\s*\n?\s*&& governmentMoneyAnalysis\.totals\.toConfirm === 0/,
    'nothing queues the refund the page promises, or it triggers on the wrong condition');
  assert.match(engine, /refund_state: 'due_thin_result'/,
    'the refund is not put on a queue process-refunds.js reads');

  const refunds = fs.readFileSync(path.join(ROOT, 'api', 'process-refunds.js'), 'utf8');
  assert.match(refunds, /REFUND_STATE_THIN = 'due_thin_result'/,
    'the queue the engine writes to is not the one the sweep reads');
});

test('the page carries a "what this does not do" section', () => {
  assert.match(VISIBLE, /What this does not do/i);
  for (const promise of [
    /do not file anything for you|does not file, submit or apply/i,
    /no login|do not ask for a login/i,
    /cannot know whether a program still has funding/i,
  ]) {
    assert.match(VISIBLE, promise, `missing limit: ${promise}`);
  }
});

test('the page says plainly that a utility is not the government', () => {
  // I7 in the audit: utility rebates sold under a "Government Money" name.
  assert.match(VISIBLE, /Utility rebates are not government money/i);
});

/* --------------------------------------------------------------- dead code */

test('no handler is bound to an element that does not exist', () => {
  // I2: the old page wired .category-chip listeners and had no chips, so
  // selectedCategory was always null and was posted as such on every
  // submission for as long as the page existed.
  assert.equal(/category-chip/.test(PAGE), false, 'the dead category-chip handler is back');
  const ids = [...INTAKE_JS.matchAll(/el\('([^']+)'\)/g)].map((m) => m[1])
    .concat([...INTAKE_JS.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]));
  const missing = [...new Set(ids)].filter((id) => !PAGE.includes(`id="${id}"`));
  assert.deepEqual(missing, [],
    `government-money-intake.js reaches for ids the page does not have: ${missing.join(', ')}`);
});

test('the upload copy names the file types the input accepts', () => {
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
  const emoji = VISIBLE.replace(/&[a-z]+;/g, '').replace(/&#\d+;/g, '')
    .match(/[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}]/gu) || [];
  assert.deepEqual(emoji, [], `emoji left in the copy: ${emoji.join(' ')}`);
});
