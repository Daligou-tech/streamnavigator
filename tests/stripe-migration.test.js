// Run: node tests/stripe-migration.test.js
//
// scripts/stripe-migrate-pricing.js rewrites live customer-facing HTML and
// deactivates real payment links. The Stripe calls need a key and cannot be
// exercised here, but the file rewriting can be — and that is the part that
// can quietly corrupt a page nobody looks at until a customer does.
//
// It also holds the script to the two rules that make it safe to run:
// the secret key is never written down, and a dry run changes nothing.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}\n    ${err.message.split('\n')[0]}`); }
}

const root = path.join(__dirname, '..');
const SCRIPT = path.join(root, 'scripts', 'stripe-migrate-pricing.js');
const src = fs.readFileSync(SCRIPT, 'utf8');
const M = require('../scripts/stripe-migrate-pricing.js');

// ---------------------------------------------------------------- the price

test('the script migrates to the price the product actually charges', () => {
  const { PRICING } = require('../navigator-streaming-engine.js');
  assert.strictEqual(M.TARGET_CENTS, PRICING.annualCents,
    'the migration price and the engine price have drifted apart');
  assert.strictEqual(M.TARGET_CENTS, 1999);
  assert.strictEqual(M.TARGET_INTERVAL, 'year');
});

test('the price is read from the engine, not typed in twice', () => {
  assert.ok(/PRICING\.annualCents/.test(src),
    'the script hardcodes its own price, so it can disagree with the pages');
});

// ------------------------------------------------------------- key handling

test('the key is never written to disk or printed', () => {
  // What matters is whether the key VARIABLE is ever interpolated into
  // output or a file — not whether the word "key" appears in a message
  // about it, which it should.
  const interpolated = /\$\{\s*key\s*\}|['"`]\s*\+\s*key\b|\bkey\s*\+\s*['"`]|console\.\w+\(\s*key\s*[,)]/;
  assert.ok(!interpolated.test(src), 'the script interpolates the key into output');
  assert.ok(!/writeFileSync\([^)]*\bkey\b/.test(src), 'the script writes the key to a file');
  assert.ok(!/\.env\b/.test(src.replace(/process\.env/g, '')), 'the script touches a .env file');
});

test('the key is not accepted as a command-line argument', () => {
  // An argv key lands in shell history and in the process list.
  assert.ok(!/argv.*sk_|--key/.test(src), 'the script takes the key on the command line');
  assert.ok(/process\.env\.STRIPE_SECRET_KEY/.test(src), 'the script does not read the key from the environment');
  assert.ok(/readKeyHidden/.test(src), 'there is no hidden prompt fallback');
});

test('a Stripe error can never leak the key into the output', () => {
  assert.ok(/key redacted/.test(src), 'the error handler does not redact key-shaped strings');
  const redact = (s) => s.replace(/(sk|rk)_(live|test)_[A-Za-z0-9]+/g, '[key redacted]');
  assert.strictEqual(redact('bad key sk_live_ABC123xyz supplied'), 'bad key [key redacted] supplied');
  assert.strictEqual(redact('rk_test_deadbeef99'), '[key redacted]');
});

test('the key is checked for shape before anything is called', () => {
  assert.ok(/\^\(sk\|rk\)_\(live\|test\)_/.test(src), 'no key-format check');
  assert.ok(/LIVE|TEST/.test(src), 'the script does not tell the operator which mode it is in');
});

// ------------------------------------------------------------- dry run first

test('nothing happens without --apply', () => {
  assert.ok(/const APPLY = process\.argv\.includes\('--apply'\)/.test(src), 'no --apply gate');
  // Every mutating call must sit behind the gate.
  for (const call of ['paymentLinks.update', 'paymentLinks.create', 'prices.create', 'products.create']) {
    const i = src.indexOf(call);
    assert.ok(i > 0, `${call} is missing`);
    const before = src.slice(Math.max(0, i - 900), i);
    assert.ok(/APPLY/.test(before), `${call} is not guarded by --apply`);
  }
});

test('deactivating a LIVE link asks first', () => {
  assert.ok(/mode === 'LIVE'[\s\S]{0,120}confirm\(/.test(src),
    'live payment links can be deactivated with no confirmation');
});

// --------------------------------------------------- the file rewriting

test('only link targets are rewritten, never the placeholder named in prose', () => {
  // The setup comment above the pricing section says "paste that URL over
  // REPLACE_WITH_ANNUAL_PAYMENT_LINK". Substituting there turns the
  // instructions into nonsense that reads as if the job were still to do.
  const site = fs.readFileSync(path.join(root, 'streaming.html'), 'utf8');
  const total = site.split(M.PLACEHOLDER).length - 1;
  const hrefs = M.countHrefs(site);
  assert.ok(total > hrefs,
    'this test is pointless unless streaming.html mentions the placeholder outside an href');
  assert.strictEqual(hrefs, 1, `expected exactly one placeholder link, found ${hrefs}`);
});

test('the placeholder is replaced in every link, and nowhere else', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-mig-'));
  const before = {};
  const files = ['streaming.html', 'dashboard.html'];
  for (const f of files) {
    before[f] = fs.readFileSync(path.join(root, f), 'utf8');
    fs.writeFileSync(path.join(tmp, f), before[f]);
  }
  try {
    const url = 'https://buy.stripe.com/test_ANNUAL1999';
    const touched = M.writeUrlIntoRepo(url);
    for (const f of files) {
      const after = fs.readFileSync(path.join(root, f), 'utf8');
      const n = M.countHrefs(before[f]);
      if (n > 0) {
        assert.ok(touched.includes(f), `${f} contained a placeholder link but was not reported as touched`);
        assert.strictEqual(M.countHrefs(after), 0, `${f} still has a placeholder link`);
        assert.ok(after.includes(`href="${url}"`), `${f} does not contain the new URL as a link target`);
        // Prose mentions in comments must survive untouched.
        const proseBefore = (before[f].split(M.PLACEHOLDER).length - 1) - n;
        const proseAfter = after.split(M.PLACEHOLDER).length - 1;
        assert.strictEqual(proseAfter, proseBefore,
          `${f}: ${proseBefore - proseAfter} comment mention(s) of the placeholder were rewritten`);
        // Nothing else may change: same length delta as the substitution alone.
        assert.strictEqual(after.length, before[f].length + n * (url.length - M.PLACEHOLDER.length),
          `${f} changed by more than the URL substitution`);
        // Line endings must survive.
        assert.strictEqual((after.match(/\r\n/g) || []).length, (before[f].match(/\r\n/g) || []).length,
          `${f} line endings were rewritten`);
      }
    }
  } finally {
    for (const f of files) fs.writeFileSync(path.join(root, f), before[f]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the config rewrite keeps the checker honest', () => {
  const p = path.join(root, 'prices.config.json');
  const before = fs.readFileSync(p, 'utf8');
  try {
    M.updateConfig('plink_NEW123', ['plink_OLD_A', 'plink_OLD_B']);
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.ok(cfg._skipped['streaming.html'].includes('plink_NEW123'), 'the new link id is not recorded');
    const ids = Object.keys(cfg.unreferencedActiveLinks).filter((k) => k !== '_comment');
    assert.deepStrictEqual(ids.sort(), ['plink_OLD_A', 'plink_OLD_B']);
    for (const id of ids) {
      assert.ok(/DEACTIVATED/.test(cfg.unreferencedActiveLinks[id]),
        `${id} is not recorded as deactivated`);
    }
    assert.ok(cfg.unreferencedActiveLinks._comment, 'the explanatory comment was dropped');
    assert.ok(cfg.pages && Object.keys(cfg.pages).length >= 12, 'the other products were clobbered');
  } finally {
    fs.writeFileSync(p, before);
  }
});

test('the repo is left exactly as it was by these tests', () => {
  const site = fs.readFileSync(path.join(root, 'streaming.html'), 'utf8');
  assert.ok(site.includes(M.PLACEHOLDER) || /buy\.stripe\.com/.test(site),
    'streaming.html has neither a placeholder nor a real link — a test left it broken');
  assert.ok(!site.includes('test_ANNUAL1999'), 'a test URL was left in streaming.html');
});

// -------------------------------------------------------------- wired up

test('the script is runnable as an npm command', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['stripe-pricing'], 'no npm script for the migration');
  assert.ok(/stripe-migrate-pricing/.test(pkg.scripts['stripe-pricing']));
});

if (failures.length) {
  console.error(`\nstripe-migration: ${passed} passed, ${failures.length} FAILED\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`stripe-migration: ${passed} passed`);
