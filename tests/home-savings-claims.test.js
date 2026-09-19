// What /home-savings is allowed to say.
//
// The audit found this page selling two things nothing behind it could do:
// a market-rate comparison against a price database the footer admits does not
// exist, and "a refreshed check as your bills change through the year" against
// a one-time charge with no entitlement, contradicted by its own FAQ two
// screens further down. See docs/HOME-SAVINGS-AUDIT.md.
//
// The price stayed at $49. The audit's recommendation was $39 *for the unfixed
// product*, and it named the condition under which $49 stands: the page names
// a specific number of checks and a test asserts that the number sold is the
// number the catalog runs. This is that test — the same contract landlord.html
// is held to in navigator-claims.test.js, and the same reasoning that kept
// /landlord at $149.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'home-savings.html'), 'utf8');
const ENGINE = require('../navigator-home-savings-engine');

// Text a customer reads, minus the setup comments the page carries for us.
const visible = PAGE.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
const words = visible.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const NUMBER_WORDS = {
  three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

test('the number of checks the page sells is the number the catalog runs', () => {
  // Only the product-level claim, which lives above the sample report. The
  // sample itself says things like "Four checks ran on this bill", which is a
  // per-bill count and true of that example.
  const sellsFrom = visible.slice(0, visible.indexOf('id="sample"'));
  const sells = sellsFrom.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const spelled = sells.match(/\b(three|four|five|six|seven|eight|nine|ten)\s+checks\b/gi) || [];
  const digits = sells.match(/\b(\d+)\s+checks\b/gi) || [];
  assert.ok(spelled.length + digits.length > 0,
    'the page must state how many checks it runs — that claim is what the price rests on');

  for (const m of spelled) {
    const n = NUMBER_WORDS[m.split(/\s+/)[0].toLowerCase()];
    assert.equal(n, ENGINE.CHECK_COUNT,
      `the page sells "${m}" and the catalog holds ${ENGINE.CHECK_COUNT}`);
  }
  for (const m of digits) {
    assert.equal(Number(m.match(/\d+/)[0]), ENGINE.CHECK_COUNT,
      `the page sells "${m}" and the catalog holds ${ENGINE.CHECK_COUNT}`);
  }
});

test('every check in the catalog is listed on the page by its id', () => {
  const catalog = PAGE.match(/<div class="seven" id="check-catalog">[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(catalog, 'the check catalog section must exist');
  for (const c of ENGINE.CHECKS) {
    assert.ok(catalog[0].includes(`>${c.id}<`),
      `check ${c.id} (${c.label}) runs but is not listed on the page`);
  }
  const listed = (catalog[0].match(/class="cid">H\d+</g) || []).length;
  assert.equal(listed, ENGINE.CHECK_COUNT,
    'the page lists a different number of checks than the catalog holds');
});

test('the page never claims to know what anything costs on the market', () => {
  // The defect that mattered most. Each of these is a comparison this product
  // cannot make, and the footer says so in the same breath the body used to
  // contradict.
  const forbidden = [
    /priced above/i,
    /above (?:what )?(?:the )?market/i,
    /below market/i,
    /market rate/i,
    /(?:what|which) .{0,30}(?:usually|typically) costs?/i,
    /overpaying for (?:your|this) \w+/i,
    /compare(?:d)? .{0,20}to (?:typical|average|going) (?:rate|price)/i,
  ];
  const offenders = [];
  visible.split('\n').forEach((line, i) => {
    // A denial is the opposite of the claim, and the page makes several on
    // purpose ("we will never tell you a bill is above market").
    if (/\b(?:never|not|cannot|do not|does not|no)\b/i.test(line)) return;
    for (const rx of forbidden) {
      if (rx.test(line)) {
        offenders.push(`home-savings.html:${i + 1} ${line.trim().replace(/<[^>]+>/g, '').slice(0, 90)}`);
      }
    }
  });
  assert.deepEqual(offenders, [],
    'this product holds no price data and its own footer says so. These lines sell a '
    + `comparison nothing can perform:\n  ${offenders.join('\n  ')}`);
});

test('the page states plainly that it holds no price data', () => {
  assert.match(words, /do not hold a database of (?:what things cost|current prices)/i,
    'the limitation is a feature of this product and belongs in the body, not only the footer');
  assert.match(words, /never tell you a bill is above market/i);
});

test('the page does not sell a refresh, a re-check, or anything recurring', () => {
  const forbidden = /refreshed check|a refresh as|through the year|as your bills change|re-?checked automatically|we will check again|ongoing/i;
  const offenders = [];
  visible.split('\n').forEach((line, i) => {
    if (forbidden.test(line)) {
      offenders.push(`home-savings.html:${i + 1} ${line.trim().replace(/<[^>]+>/g, '').slice(0, 90)}`);
    }
  });
  assert.deepEqual(offenders, [],
    'home-savings is a one-time charge with no entitlement behind it. '
    + `These lines promise a second look nothing performs:\n  ${offenders.join('\n  ')}`);
});

test('the page and the FAQ agree about what happens when bills change later', () => {
  assert.match(words, /Each audit is its own \$49 report/,
    'the FAQ states the one-time model; nothing above it may contradict that');
  assert.match(words, /no recurring charge, nothing to cancel/i);
});

test('the no-credential model is sold, not buried', () => {
  // The single strongest thing about this product, and the old page never
  // mentioned it once.
  assert.match(words, /No bank login, ever/i);
  const heroEnd = visible.indexOf('<section id="how"');
  assert.ok(heroEnd > 0);
  assert.match(visible.slice(0, heroEnd), /No bank login, ever/i,
    'it belongs above the fold, where /subscriptions puts it');
});

test('the page shows a worked example and a sample report before asking for money', () => {
  const priceAt = visible.indexOf('id="price"');
  const sampleAt = visible.indexOf('id="sample"');
  const ledgerAt = visible.indexOf('class="ledger"');
  assert.ok(sampleAt > 0, 'a sample report section must exist');
  assert.ok(ledgerAt > 0, 'a worked example must appear in the hero');
  assert.ok(sampleAt < priceAt, 'the sample must come before the price');
  assert.ok(ledgerAt < priceAt, 'the example must come before the price');
  assert.match(PAGE, /<a href="#sample">Sample report<\/a>/, 'and it must be in the nav');
});

test('the free scorecard is offered before payment and runs the paid engine', () => {
  assert.match(PAGE, /<script src="\/navigator-home-savings-engine\.js"><\/script>/,
    'the page must load the same engine the server runs');
  assert.match(words, /free scorecard/i);
  assert.match(words, /If we find nothing, you will know before you pay/i);
});

test('the page carries the /closing design system, not the old shared one', () => {
  assert.match(PAGE, /<link rel="stylesheet" href="\/navigator-editorial\.css">/);
  // `visible`, not PAGE: the head comment names the old stylesheet on purpose,
  // to record why the page moved.
  assert.doesNotMatch(visible, /navigator-shared\.css/,
    'the violet gradient system is what made this page look like a different company');
  assert.match(PAGE, /Newsreader/, 'and the editorial typefaces with it');
});

test('the dead category-chip handler is gone', () => {
  // It queried `.category-chip`, which never existed in the page, so
  // selectedCategory was permanently null and was posted as null on every
  // submission.
  assert.doesNotMatch(PAGE, /category-chip/);
  const intake = fs.readFileSync(path.join(ROOT, 'home-savings-intake.js'), 'utf8');
  assert.doesNotMatch(intake, /category-chip/);
});

test('the page tells the customer how many bills to send', () => {
  assert.match(words, /four to eight/i,
    '"the more you upload, the more thorough" is not a number');
});

test('the page asks for last year&apos;s bill, which needs no outside data', () => {
  assert.match(words, /last year(?:&rsquo;|')s (?:bill|statement)/i);
});

test('the refund promise is stated where the customer decides', () => {
  assert.match(words, /If the report misses what it promised, we refund in full/i);
});
