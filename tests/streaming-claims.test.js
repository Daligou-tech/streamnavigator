// Run: node tests/streaming-claims.test.js
//
// The streaming pages make promises; this asserts the code keeps them.
// Same idea as claims.test.js, pointed at the streaming surface.
//
// Two claims shipped and sat there:
//
//   "Instant alerts before a price hike hits your card" — sold as a paid
//   feature, with no price monitoring anywhere in the codebase. dashboard.html
//   said so itself: "there's no live pricing feed for these services — this
//   only knows a price changed because the customer told us, by editing it
//   here." A feature that learns of a hike only when the customer types it in
//   cannot, even in principle, fire BEFORE the charge lands.
//
//   "Duplicate subscription detection" — a paid Family bullet with no
//   implementation, and ruled out by the product's own privacy model, which
//   tells Family owners that members' subscriptions are mutually invisible.
//
// Both are gone. These tests keep them gone.
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
const SURFACE = ['streaming.html', 'dashboard.html'];
const pages = SURFACE.map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]);
const cron = fs.readFileSync(path.join(root, 'api', '_lib', '..', 'refresh-shows.js'), 'utf8');

function offenders(text, re) {
  return text.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => re.test(line))
    .map(([i]) => i);
}

// Does anything actually watch service prices? If a real feed is ever wired
// in, these assertions should stop applying — so check for one rather than
// hardcoding "this claim is always false".
const hasLivePriceFeed = /fetchServicePrice|PRICE_FEED|pricing[_-]?api/i.test(cron);

test('no page promises a price alert that arrives before the charge', () => {
  if (hasLivePriceFeed) return; // a real feed makes the claim fair game
  const claim = /before (a|the) price (hike|increase).{0,30}(hits|lands)|before it silently hits|instant alerts before/i;
  for (const [name, page] of pages) {
    const lines = offenders(page, claim);
    assert.strictEqual(
      lines.length, 0,
      `${name} promises a pre-charge price alert on line(s) ${lines.join(', ')}, but price changes are self-reported`,
    );
  }
});

test('no page sells "real-time" price-hike alerts', () => {
  if (hasLivePriceFeed) return;
  const claim = /real-?time price-?(hike|increase|alert)/i;
  for (const [name, page] of pages) {
    const lines = offenders(page, claim);
    assert.strictEqual(
      lines.length, 0,
      `${name} sells real-time price alerts on line(s) ${lines.join(', ')} with no pricing feed behind them`,
    );
  }
});

test('no page sells duplicate subscription detection', () => {
  // Would need a title-to-service availability model. There isn't one, and
  // nothing in the engine reasons about content overlap between services.
  const engine = fs.readFileSync(path.join(root, 'navigator-streaming-engine.js'), 'utf8');
  const hasOverlapModel = /overlap|availableOn|titleCatalog/i.test(engine);
  if (hasOverlapModel) return;
  for (const [name, page] of pages) {
    const lines = offenders(page, /duplicate subscription detection/i);
    assert.strictEqual(
      lines.length, 0,
      `${name} sells duplicate detection on line(s) ${lines.join(', ')} with no content-overlap model behind it`,
    );
  }
});

test('the resume promise is backed by a real date, never a calendar nag', () => {
  // "a reminder to bring it back, timed to what's worth watching" is only
  // honest if a resume requires a confirmed air date. The old cadence
  // fallback emailed "activate — it's been about a month since you paused
  // it", which is an instruction to start paying again backed by nothing.
  assert.ok(
    /reminder_source !== 'air_date'\) return null/.test(cron),
    'refresh-shows.js can still send a resume that is not backed by an air date',
  );
  const dash = pages.find(([f]) => f === 'dashboard.html')[1];
  assert.ok(
    /reminder_source !== 'air_date'\) return null/.test(dash),
    'dashboard.html can still show an activate prompt that is not backed by an air date',
  );
  assert.ok(
    !/it's been about a month since you paused it/.test(cron),
    'the blind 30-day resume reason is still in the cron',
  );
});

test('pause advice is timed to the renewal date, not fired whenever', () => {
  assert.ok(
    /pauseIsActionable\(/.test(cron),
    'refresh-shows.js no longer gates pause emails on the renewal window',
  );
  const dash = pages.find(([f]) => f === 'dashboard.html')[1];
  assert.ok(/pauseIsActionable\(/.test(dash), 'dashboard.html no longer gates pause prompts on the renewal window');
  assert.ok(
    /billing_period === 'annual'/.test(cron),
    'the cron does not special-case annual plans, so it can tell customers to forfeit prepaid months',
  );
});

test('the customer can actually enter a renewal date', () => {
  const dash = pages.find(([f]) => f === 'dashboard.html')[1];
  assert.ok(/id="add-renewal"/.test(dash), 'no renewal-date field on the add-subscription form');
  assert.ok(/id="add-billing"/.test(dash), 'no monthly/annual field on the add-subscription form');
  assert.ok(/next_renewal_date: renewal/.test(dash), 'the renewal date is collected but never saved');
  assert.ok(/billing_period: billing/.test(dash), 'the billing period is collected but never saved');
});

test('the migration for those columns exists', () => {
  const p = path.join(root, 'data', 'migrations', '2026-09-12-renewal-dates.sql');
  assert.ok(fs.existsSync(p), 'renewal-date migration is missing');
  const sql = fs.readFileSync(p, 'utf8');
  assert.ok(/next_renewal_date/.test(sql) && /billing_period/.test(sql), 'migration does not add both columns');
});

test('the savings headline is never presented without its date', () => {
  for (const [name, page] of pages) {
    assert.ok(
      /data-catalog-verified/.test(page),
      `${name} shows savings figures with no "prices checked on" date`,
    );
  }
});

if (failures.length) {
  console.error(`\nstreaming-claims: ${passed} passed, ${failures.length} FAILED\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`streaming-claims: ${passed} passed`);
