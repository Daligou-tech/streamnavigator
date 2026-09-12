// Run: node tests/streaming-claims.test.js
//
// The streaming pages make promises; this asserts the code keeps them.
// Same idea as claims.test.js, pointed at the streaming surface.
//
// Three claims shipped with nothing behind them:
//
//   "Instant alerts before a price hike hits your card" — a paid feature with
//   no price monitoring anywhere in the codebase. dashboard.html said so
//   itself: "there's no live pricing feed for these services — this only
//   knows a price changed because the customer told us, by editing it here."
//
//   "Duplicate subscription detection" — a paid Family bullet with no
//   implementation, ruled out by the product's own privacy model.
//
//   "Early users save up to $300 or more per year" — a number with no
//   evidence behind it, on a page whose own analyzer routinely showed a
//   different one.
//
// All three are gone. These keep them gone.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}\n    ${err.message.split('\n')[0]}`); }
}

const root = path.join(__dirname, '..');
const ENGINE = require('../navigator-streaming-engine.js');
const SURFACE = ['streaming.html', 'dashboard.html'];
const pages = SURFACE.map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]);
const cron = fs.readFileSync(path.join(root, 'api', 'refresh-shows.js'), 'utf8');

function offenders(text, re) {
  return text.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => re.test(l)).map(([i]) => i);
}

const hasLivePriceFeed = /fetchServicePrice|PRICE_FEED|pricing[_-]?api/i.test(cron);

// ------------------------------------------------------------ unbacked claims

test('no page promises a price alert that arrives before the charge', () => {
  if (hasLivePriceFeed) return;
  const claim = /before (a|the) price (hike|increase).{0,30}(hits|lands)|before it silently hits|instant alerts before/i;
  for (const [name, page] of pages) {
    const lines = offenders(page, claim);
    assert.strictEqual(lines.length, 0,
      `${name} promises a pre-charge price alert on line(s) ${lines.join(', ')}, but price changes are self-reported`);
  }
});

test('no page sells "real-time" price-hike alerts', () => {
  if (hasLivePriceFeed) return;
  for (const [name, page] of pages) {
    const lines = offenders(page, /real-?time price-?(hike|increase|alert)/i);
    assert.strictEqual(lines.length, 0, `${name} sells real-time price alerts on line(s) ${lines.join(', ')}`);
  }
});

test('no page sells duplicate subscription detection', () => {
  const engine = fs.readFileSync(path.join(root, 'navigator-streaming-engine.js'), 'utf8');
  if (/overlap|availableOn|titleCatalog/i.test(engine)) return;
  for (const [name, page] of pages) {
    const lines = offenders(page, /duplicate subscription detection/i);
    assert.strictEqual(lines.length, 0, `${name} sells duplicate detection on line(s) ${lines.join(', ')}`);
  }
});

test('no page quotes a savings figure it cannot produce', () => {
  // "Early users save up to $300 or more per year" had no evidence behind it.
  // The analyzer computes a real number from the customer's own inputs; that
  // is the only savings figure the page is allowed to lead with.
  for (const [name, page] of pages) {
    const lines = offenders(page, /(early users|users) save up to \$\d+/i);
    assert.strictEqual(lines.length, 0, `${name} quotes an unevidenced savings claim on line(s) ${lines.join(', ')}`);
  }
});

test('the free analyzer never claims to be monitoring anything', () => {
  // streaming.html runs once, in the browser, when the button is pressed.
  // Daily monitoring is the paid product and only the pricing/upsell copy
  // may say so.
  const engine = fs.readFileSync(path.join(root, 'navigator-streaming-engine.js'), 'utf8');
  const lines = offenders(engine, /we check .{0,20}(daily|every day)/i);
  assert.strictEqual(lines.length, 0,
    `the engine claims daily monitoring on line(s) ${lines.join(', ')}; it is a pure function and watches nothing`);
});

// ---------------------------------------------------------------- the promise

test('a restart is backed by a real date, never a calendar nag', () => {
  assert.ok(/reminder_source !== 'air_date'\) return null/.test(cron),
    'refresh-shows.js can still send a resume that is not backed by an air date');
  assert.ok(!/it's been about a month since you paused it/.test(cron),
    'the blind 30-day resume reason is still in the cron');
});

test('the cron and the dashboard decide with one shared engine', () => {
  assert.ok(/require\('\.\.\/navigator-streaming-engine\.js'\)/.test(cron), 'the cron no longer uses the shared engine');
  for (const [name, page] of pages) {
    assert.ok(!/const SERVICES\s*=\s*\{/.test(page), `${name} has its own inline catalog again`);
    assert.ok(page.includes('navigator-streaming-engine.js'), `${name} does not load the shared engine`);
  }
});

test('the customer can enter a renewal date on both surfaces', () => {
  const dash = pages.find(([f]) => f === 'dashboard.html')[1];
  assert.ok(/id="add-renewal"/.test(dash), 'no renewal-date field on the dashboard form');
  assert.ok(/id="add-billing"/.test(dash), 'no monthly/annual field on the dashboard form');
  assert.ok(/next_renewal_date: renewal/.test(dash), 'the renewal date is collected but never saved');
  const site = pages.find(([f]) => f === 'streaming.html')[1];
  assert.ok(/class="a-select renewal-input"|renewal-input/.test(site), 'no renewal-date field in the analyzer');
});

test('the analyzer asks for nothing it does not use', () => {
  const site = pages.find(([f]) => f === 'streaming.html')[1];
  // The watch-frequency dropdown was guesswork the engine leaned on harder
  // than the actual TV schedule. It is gone, and must not come back.
  assert.ok(!/freq-select/.test(site), 'the watch-frequency dropdown is back in the analyzer');
  assert.ok(!/id="budget"/.test(site), 'the monthly-budget field is back; nothing in the engine reads it');
  assert.ok(!/id="kids-important"/.test(site), 'the kid-friendly checkbox is back; nothing in the engine reads it');
});

// -------------------------------------------------------------------- pricing

test('one tier, at the recommended price, on every surface', () => {
  assert.strictEqual(ENGINE.PRICING.annualCents, 1999, 'the engine price is not $19.99');
  for (const [name, page] of pages) {
    assert.ok(/\$19\.99/.test(page), `${name} does not show the $19.99 price`);
    const retired = offenders(page, /\$4\.99\s*<span>\/mo|\$8\.99\s*<span>\/mo|Subscribe to (Pro|Family)/);
    assert.strictEqual(retired.length, 0, `${name} still sells a retired tier on line(s) ${retired.join(', ')}`);
  }
});

test('a price is never displayed against a checkout that would charge something else', () => {
  // The bug this guards: buying.html once displayed $39 while its button
  // still pointed at the $19 payment link. Until the $19.99/year Stripe link
  // exists, the button must stay an obvious placeholder that the click
  // handler intercepts — never a live link at the old price.
  const site = pages.find(([f]) => f === 'streaming.html')[1];
  const links = site.match(/data-stripe-link="[^"]*"[^>]*|href="[^"]*"[^>]*data-stripe-link/g) || [];
  const hasPlaceholder = /href="REPLACE_WITH_ANNUAL_PAYMENT_LINK"[^>]*data-stripe-link/.test(site);
  const hasRealLink = /href="https:\/\/buy\.stripe\.com\/[^"]+"[^>]*data-stripe-link/.test(site);
  assert.ok(hasPlaceholder || hasRealLink, 'the subscribe button has neither a placeholder nor a real Stripe link');
  assert.ok(links.length <= 2, 'more than one checkout link on a single-tier page');
  if (hasPlaceholder) {
    assert.ok(/REPLACE_WITH_/.test(site) && /e\.preventDefault\(\)/.test(site),
      'the placeholder link is not intercepted, so a customer could be sent to a dead checkout');
  }
});

test('the retired Stripe links are documented as needing deactivation', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'prices.config.json'), 'utf8'));
  const entries = Object.entries(cfg.unreferencedActiveLinks).filter(([k]) => k !== '_comment');
  assert.ok(entries.length >= 2, 'the old monthly links are no longer listed');
  for (const [id, reason] of entries) {
    assert.ok(/DEACTIVATED/.test(reason),
      `${id} is unreferenced but its note does not say it must be deactivated in Stripe`);
  }
});

// ------------------------------------------------------------- transparency

test('every dollar figure is shown with the date its prices were checked', () => {
  for (const [name, page] of pages) {
    assert.ok(/data-catalog-verified/.test(page), `${name} shows savings with no "prices checked on" date`);
  }
});

test('the data source is named where its dates are used', () => {
  const site = pages.find(([f]) => f === 'streaming.html')[1];
  assert.ok(/tvmaze\.com/i.test(site), 'TVmaze is used for every air date but never credited to the customer');
  assert.ok(/CC BY-SA/.test(site), 'the TVmaze licence attribution is missing');
});

test('the privacy promise still holds: no streaming credentials, anywhere', () => {
  for (const [name, page] of pages) {
    const lines = offenders(page, /(netflix|hulu|disney)[^<]{0,30}(password|log ?in with|credentials)/i);
    const bad = lines.filter((n) => !/never|don't|cannot|can't|no /i.test(page.split('\n')[n - 1]));
    assert.strictEqual(bad.length, 0, `${name} may be asking for streaming credentials on line(s) ${bad.join(', ')}`);
  }
});

if (failures.length) {
  console.error(`\nstreaming-claims: ${passed} passed, ${failures.length} FAILED\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`streaming-claims: ${passed} passed`);
