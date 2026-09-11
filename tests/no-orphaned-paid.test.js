// Every paid submission has something that will pick it up.
//
// 'paid' means a customer's money has been taken and no report exists yet. It
// is a queue, and a queue only works if something reads it. For nine products
// that is api/generate-paid-navigator.js; for buying it is
// api/retry-failed-buying.js; for HOA it is api/hoa-job.js.
//
// Two real customers sat outside all three from 2026-08-30 to 2026-09-10.
// Their buying submissions had a Stripe session, status 'paid',
// auto_recovery_attempted false, generation_attempts 0 and no error — and the
// retry job named exactly two shapes, (failed, not in recovery) and (paid,
// already in recovery). Paid-and-not-in-recovery matched neither. Eleven days,
// no report, no refund, no alert, and nothing that was ever going to change
// that.
//
// It was found from the other direction: the failure path had just been changed
// to park a provider outage at 'paid' instead of failing it, and asking "where
// does that row go next, for each product?" turned up the same hole already
// occupied.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const vercel = JSON.parse(read('vercel.json'));
const cronPaths = (vercel.crons || []).map((c) => c.path);

// Products that can reach 'paid' — anything with a price on its page.
const PRICED = Object.keys(JSON.parse(read('prices.config.json')).pages)
  .map((f) => path.basename(f, '.html'));

// The one product with no background pickup, recorded rather than hidden.
//
// Contractor generates only when the customer's browser polls
// api/get-navigator-submission.js, so paying and closing the tab leaves a row
// nothing will ever look at again. It is listed here instead of fixed because
// it has had zero submissions in the lifetime of the table, so the gap has
// never cost anyone anything — and closing it means either teaching the sweep
// a second engine or adding a cron, neither of which is worth doing blind.
//
// If contractor ever takes a payment, this is the line to delete, and the fix
// is the same shape as the other nine.
const KNOWN_UNSWEPT = ['contractor'];

test('a scheduled job exists for each way a paid submission is picked up', () => {
  for (const p of ['/api/generate-paid-navigator', '/api/retry-failed-buying', '/api/hoa-job']) {
    assert.ok(cronPaths.includes(p), `${p} is not on a cron — the queue it reads is never read`);
  }
});

test('every priced product has something that reads its paid rows', () => {
  const sweep = read('api/generate-paid-navigator.js');
  const swept = sweep.slice(sweep.indexOf('SWEPT_PRODUCTS'), sweep.indexOf('];', sweep.indexOf('SWEPT_PRODUCTS')));

  const orphaned = [];
  for (const product of PRICED) {
    if (KNOWN_UNSWEPT.includes(product)) continue;
    if (swept.includes(`'${product}'`)) continue;
    // Not in the generic sweep, so it must have a job of its own that names it.
    const ownJob = ['api/retry-failed-buying.js', 'api/hoa-job.js']
      .some((f) => fs.existsSync(path.join(ROOT, f)) && read(f).includes(`'${product}'`));
    if (!ownJob) orphaned.push(product);
  }

  assert.deepEqual(orphaned, [],
    "these products can reach 'paid' with nothing scheduled to look at them again. A customer "
    + `who pays and closes the tab gets nothing, indefinitely:\n  ${orphaned.join('\n  ')}`);
});

test('the buying job picks up every paid row, not two specific shapes of one', () => {
  const src = read('api/retry-failed-buying.js');
  // The filter is one quoted argument containing its own brackets, so take the
  // string literal rather than slicing to the first closing paren.
  const query = (src.match(/\.or\('([^']*)'\)/) || [])[1] || '';
  assert.ok(query, 'no .or(...) filter found in the buying retry job');

  assert.ok(/(^|,)status\.eq\.paid(,|$)/.test(query.replace(/\s/g, '')),
    'the query still requires a second condition alongside paid, which is what left two '
    + `customers unreachable for eleven days: ${query}`);
  assert.ok(/status\.eq\.failed/.test(query),
    'a failed row not yet in recovery still has to be given its one free attempt budget');
});

test('the buying job waits before touching a row the customer may be generating', () => {
  // Generation sets 'processing' as its first act, so a row still reading
  // 'paid' minutes later is one nobody is working on. Without the wait,
  // widening the query above would start a second generation alongside the
  // customer's own browser and bill the same report twice.
  const src = read('api/retry-failed-buying.js');
  assert.ok(/GRACE_MINUTES/.test(src) && /\.lt\('updated_at'/.test(src),
    'the widened query has no grace period — it can race a generation already in flight');
});

test('a row abandoned mid-generation is picked up too, not just one waiting to start', () => {
  // 'processing' is written as the first act of generation, so a row in that
  // state was claimed by some process. When that process is killed — a Vercel
  // function hitting maxDuration is the ordinary way — no catch block runs,
  // nothing writes 'failed', and the row says 'processing' forever. The sweep
  // read 'paid' only, process-refunds needs 'failed', and the inline stuck-
  // processing recovery in get-navigator-submission.js is written for buying
  // alone: for the other nine, a paid report just stopped existing.
  const sweep = read('api/generate-paid-navigator.js');
  assert.ok(/status',\s*'processing'/.test(sweep) || /status\.eq\.processing/.test(sweep),
    'the sweep never looks at a row abandoned mid-generation');

  // And it must wait long enough to be sure nothing still holds the row.
  // Anything shorter than the longest function that can own one is a race that
  // generates and bills the same report twice.
  const m = sweep.match(/ABANDONED_MINUTES\s*=\s*(\d+)/);
  assert.ok(m, 'the wait before reclaiming an abandoned row is not named');
  const longestOwnerMinutes = Math.max(
    ...Object.values(JSON.parse(read('vercel.json')).functions || {})
      .map((f) => (f.maxDuration || 0) / 60)
  );
  assert.ok(Number(m[1]) > longestOwnerMinutes,
    `reclaiming after ${m[1]} minutes can race a function that runs for up to `
    + `${longestOwnerMinutes.toFixed(1)} — the same report would generate and bill twice`);
});

test('an outage parks a buying row where its own job will find it', () => {
  // 'paid' does not mean the same thing in every product. For the nine on the
  // generic sweep it is the queue; for buying the queue is defined by
  // retry-failed-buying's query, so the outage branch has to leave the row in a
  // shape that query matches.
  const src = read('api/_lib/purchase-engine.js');
  const branch = src.slice(src.indexOf('if (outage) {'), src.indexOf('await admin.from', src.indexOf('if (outage) {')));
  assert.ok(/auto_recovery_attempted\s*=\s*true/.test(branch),
    'an outage row left with auto_recovery_attempted false matched neither shape of the old query');
  assert.ok(/generation_attempts/.test(branch),
    'an outage must not spend the retry budget — the attempt was incremented before it began');
});
