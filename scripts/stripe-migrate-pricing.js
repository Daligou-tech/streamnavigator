#!/usr/bin/env node
'use strict';

/**
 * stripe-migrate-pricing.js — retire the monthly tiers, create the annual one.
 *
 * StreamNavigator moved from two monthly tiers ($4.99 Pro, $8.99 Family) to a
 * single $19.99/year plan on 2026-09-12. The pages already say $19.99. This
 * makes Stripe agree with them, in one command:
 *
 *   1. Creates (or reuses) the "StreamNavigator" product, a $19.99/year
 *      recurring price, and a Payment Link for it.
 *   2. Deactivates the two retired monthly Payment Links, so nobody holding
 *      an old URL can still subscribe at a price we no longer sell.
 *   3. Writes the new URL into streaming.html, dashboard.html and
 *      prices.config.json, replacing REPLACE_WITH_ANNUAL_PAYMENT_LINK.
 *   4. Reads everything back from Stripe and asserts it is actually so.
 *
 * Deactivating a Payment Link stops NEW sign-ups. It does not cancel anyone:
 * existing subscribers keep their subscription and keep being billed until
 * they cancel, which is the correct behaviour — this is a change to what we
 * sell, not a change to what people already bought.
 *
 * THE KEY IS NEVER STORED, PRINTED OR PASSED AS AN ARGUMENT.
 * It is read from STRIPE_SECRET_KEY if set, and otherwise typed at a hidden
 * prompt. It is not echoed to the terminal, not written to disk, and not
 * included in any output. Do not pass it on the command line — that would
 * put it in your shell history.
 *
 * Usage:
 *   node scripts/stripe-migrate-pricing.js              # dry run, changes nothing
 *   node scripts/stripe-migrate-pricing.js --apply      # do it
 *
 * Exit 0 = success (or a clean dry run). Exit 1 = something is wrong.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'prices.config.json');
const PLACEHOLDER = 'REPLACE_WITH_ANNUAL_PAYMENT_LINK';

// What we are migrating to. One tier. Read from the engine so this script and
// the product can never disagree about the price.
const { PRICING } = require(path.join(ROOT, 'navigator-streaming-engine.js'));
const TARGET_CENTS = PRICING.annualCents;      // 1999
const TARGET_INTERVAL = 'year';
const PRODUCT_NAME = 'StreamNavigator';
const PRODUCT_DESC = 'Daily streaming-schedule checks and renewal-timed pause and restart reminders. One household.';

const APPLY = process.argv.includes('--apply');

// ---------- tiny formatting ----------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);
const money = (cents) => (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

/** Read the secret key without ever showing it. */
function readKeyHidden() {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error(
        'STRIPE_SECRET_KEY is not set and there is no terminal to prompt on.\n'
        + '  Run this from an interactive terminal, or set STRIPE_SECRET_KEY for\n'
        + '  this one command only — e.g.  STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-migrate-pricing.js --apply\n'
        + '  (a leading space keeps it out of shell history in bash/zsh with HISTCONTROL=ignorespace).',
      ));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write('Stripe secret key (input hidden): ');
    const onData = (char) => {
      const s = String(char);
      if (s === '\n' || s === '\r' || s === '') return;
      // Erase whatever the terminal echoed.
      readline.moveCursor(process.stdout, -s.length, 0);
      readline.clearLine(process.stdout, 1);
    };
    process.stdin.on('data', onData);
    rl.question('', (answer) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(String(answer).trim());
    });
  });
}

function confirm(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { resolve(false); return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question + ' ', (a) => { rl.close(); resolve(/^y(es)?$/i.test(String(a).trim())); });
  });
}

/** Rewrite the placeholder in the repo, preserving each file's line endings. */
function writeUrlIntoRepo(url) {
  const touched = [];
  for (const file of ['streaming.html', 'dashboard.html']) {
    const p = path.join(ROOT, file);
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.includes(PLACEHOLDER)) continue;
    fs.writeFileSync(p, raw.split(PLACEHOLDER).join(url));
    touched.push(file);
  }
  return touched;
}

function updateConfig(newLinkId, oldIds) {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  cfg._skipped['streaming.html'] =
    'Two-tier page: a free analyzer ($0, no checkout) and one paid subscription at '
    + `${money(TARGET_CENTS)}/year (Stripe payment link ${newLinkId}). The free tier has no `
    + 'checkout button to compare against, so the single-price checker does not fit this '
    + 'page shape; the $19.99 figure and the link are asserted by tests/streaming-claims.test.js instead.';
  const kept = { _comment: cfg.unreferencedActiveLinks._comment };
  for (const id of oldIds) {
    kept[id] = 'RETIRED and DEACTIVATED in Stripe on ' + new Date().toISOString().slice(0, 10)
      + ' by scripts/stripe-migrate-pricing.js. Was a monthly tier ($4.99 Pro / $8.99 Family) '
      + 'before the move to a single $19.99/year plan. Kept listed here so the checker knows '
      + 'it is deliberate; an inactive link cannot be used to subscribe.';
  }
  cfg.unreferencedActiveLinks = kept;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

async function main() {
  console.log(bold('\nStripe pricing migration') + dim('  ·  two monthly tiers out, one annual tier in\n'));

  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const oldIds = Object.keys(cfg.unreferencedActiveLinks).filter((k) => k !== '_comment');
  if (!oldIds.length) {
    console.log(yellow('No retired links listed in prices.config.json — nothing to deactivate.'));
  }

  const key = process.env.STRIPE_SECRET_KEY || (await readKeyHidden());
  if (!key) { console.error(red('No key given. Nothing done.')); process.exit(1); }
  if (!/^(sk|rk)_(live|test)_/.test(key)) {
    console.error(red('That does not look like a Stripe secret or restricted key (expected sk_live_/sk_test_/rk_...). Nothing done.'));
    process.exit(1);
  }
  const mode = key.includes('_live_') ? 'LIVE' : 'TEST';
  console.log(`Mode: ${mode === 'LIVE' ? bold(red('LIVE')) : yellow('TEST')}  ${dim('(from the key prefix; the key itself is never printed or stored)')}`);
  if (!APPLY) console.log(yellow('Dry run — nothing will be changed. Re-run with --apply to execute.\n'));
  else console.log('');

  const stripe = require('stripe')(key);

  // ---------- 1. look at what is there now ----------
  console.log(bold('Existing payment links'));
  const links = await stripe.paymentLinks.list({ limit: 100 });
  const byId = new Map(links.data.map((l) => [l.id, l]));
  const toDeactivate = [];
  for (const id of oldIds) {
    const link = byId.get(id);
    if (!link) { console.log(`  ${dim(id)} ${yellow('not found')} ${dim('(already deleted, or a different account)')}`); continue; }
    console.log(`  ${id}  ${link.active ? red('ACTIVE') : green('inactive')}  ${dim(link.url)}`);
    if (link.active) toDeactivate.push(link);
  }
  if (!toDeactivate.length) console.log(green('  Nothing active to retire.'));

  // ---------- 2. find or create the annual price ----------
  console.log(bold('\nAnnual plan'));
  const prices = await stripe.prices.list({ limit: 100, active: true, expand: ['data.product'] });
  let price = prices.data.find((p) => p.unit_amount === TARGET_CENTS
    && p.currency === 'usd'
    && p.recurring && p.recurring.interval === TARGET_INTERVAL);

  if (price) {
    console.log(`  price   ${green('exists')}  ${price.id}  ${money(price.unit_amount)}/${price.recurring.interval}`);
  } else if (!APPLY) {
    console.log(`  price   ${yellow('would create')}  ${money(TARGET_CENTS)}/${TARGET_INTERVAL} under product "${PRODUCT_NAME}"`);
  } else {
    const products = await stripe.products.list({ limit: 100, active: true });
    let product = products.data.find((p) => p.name === PRODUCT_NAME);
    if (!product) {
      product = await stripe.products.create({ name: PRODUCT_NAME, description: PRODUCT_DESC });
      console.log(`  product ${green('created')}  ${product.id}`);
    } else {
      console.log(`  product ${green('exists')}   ${product.id}`);
    }
    price = await stripe.prices.create({
      product: product.id,
      unit_amount: TARGET_CENTS,
      currency: 'usd',
      recurring: { interval: TARGET_INTERVAL },
    });
    console.log(`  price   ${green('created')}  ${price.id}  ${money(price.unit_amount)}/${price.recurring.interval}`);
  }

  // ---------- 3. find or create its payment link ----------
  // list() does not expand line_items, so ask per candidate link which price
  // it sells. This is what makes the script idempotent: run it twice and it
  // finds the link it made the first time instead of creating a second one.
  let annualLink = null;
  if (price) {
    for (const l of links.data) {
      if (!l.active) continue;
      const items = await stripe.paymentLinks.listLineItems(l.id, { limit: 5 });
      if (items.data.some((li) => li.price && li.price.id === price.id)) { annualLink = l; break; }
    }
  }

  if (annualLink) {
    console.log(`  link    ${green('exists')}   ${annualLink.id}  ${annualLink.url}`);
  } else if (!APPLY) {
    console.log(`  link    ${yellow('would create')}  a payment link for that price`);
  } else {
    annualLink = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      allow_promotion_codes: true,
    });
    console.log(`  link    ${green('created')}  ${annualLink.id}  ${annualLink.url}`);
  }

  // ---------- 4. retire the old links ----------
  console.log(bold('\nRetiring the monthly links'));
  if (!toDeactivate.length) {
    console.log(green('  Already done.'));
  } else if (!APPLY) {
    toDeactivate.forEach((l) => console.log(`  ${yellow('would deactivate')}  ${l.id}  ${dim(l.url)}`));
    console.log(dim('  Existing subscribers are unaffected — deactivating a link only stops new sign-ups.'));
  } else {
    if (mode === 'LIVE' && process.stdin.isTTY && !process.argv.includes('--yes')) {
      const ok = await confirm(`  Deactivate ${toDeactivate.length} LIVE payment link(s)? [y/N]`);
      if (!ok) { console.log(red('  Aborted. Nothing was deactivated.')); process.exit(1); }
    }
    for (const l of toDeactivate) {
      await stripe.paymentLinks.update(l.id, { active: false });
      console.log(`  ${green('deactivated')}  ${l.id}`);
    }
  }

  // ---------- 5. put the URL in the pages ----------
  console.log(bold('\nWiring the URL into the site'));
  if (!APPLY || !annualLink) {
    const files = ['streaming.html', 'dashboard.html'].filter((f) =>
      fs.readFileSync(path.join(ROOT, f), 'utf8').includes(PLACEHOLDER));
    console.log(files.length
      ? `  ${yellow('would replace')} ${PLACEHOLDER} in ${files.join(', ')}`
      : green('  Already wired.'));
  } else {
    const touched = writeUrlIntoRepo(annualLink.url);
    console.log(touched.length ? `  ${green('updated')}  ${touched.join(', ')}` : green('  Already wired.'));
    updateConfig(annualLink.id, oldIds);
    console.log(`  ${green('updated')}  prices.config.json`);
  }

  // ---------- 6. read it back ----------
  if (APPLY) {
    console.log(bold('\nVerifying against Stripe'));
    const after = await stripe.paymentLinks.list({ limit: 100 });
    let bad = 0;
    for (const id of oldIds) {
      const l = after.data.find((x) => x.id === id);
      if (l && l.active) { console.log(`  ${red('STILL ACTIVE')}  ${id}`); bad++; }
      else console.log(`  ${green('inactive')}      ${id}`);
    }
    const live = after.data.find((x) => x.id === (annualLink && annualLink.id));
    if (!live || !live.active) { console.log(`  ${red('annual link is not active')}`); bad++; }
    else console.log(`  ${green('active')}        ${live.id}  ${live.url}`);
    const p = await stripe.prices.retrieve(price.id);
    if (p.unit_amount !== TARGET_CENTS || !p.recurring || p.recurring.interval !== TARGET_INTERVAL) {
      console.log(`  ${red('price mismatch')}  ${money(p.unit_amount)}/${p.recurring && p.recurring.interval}`);
      bad++;
    } else {
      console.log(`  ${green('price')}         ${money(p.unit_amount)}/${p.recurring.interval}`);
    }
    if (bad) { console.error(red(`\n${bad} problem(s). Fix before shipping.`)); process.exit(1); }
    console.log(green('\nDone. Commit the changed files and push to deploy.\n'));
  } else {
    console.log(dim('\nDry run complete. Re-run with --apply to make these changes.\n'));
  }
}

// Exported for tests/stripe-migration.test.js. This script rewrites live
// customer-facing HTML, so the rewriting is worth asserting on rather than
// finding out about in production.
module.exports = { writeUrlIntoRepo, updateConfig, PLACEHOLDER, TARGET_CENTS, TARGET_INTERVAL, money };

if (require.main !== module) return;

main().catch((err) => {
  // Never let a Stripe error object carry the key into the output.
  const msg = (err && err.message ? err.message : String(err)).replace(/(sk|rk)_(live|test)_[A-Za-z0-9]+/g, '[key redacted]');
  console.error(red('\nFailed: ') + msg + '\n');
  process.exit(1);
});
