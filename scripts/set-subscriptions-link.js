#!/usr/bin/env node
'use strict';

/**
 * set-subscriptions-link.js — finish the $29 repricing in one command.
 *
 * /subscriptions moved from $49 to $29 on 2026-09-19 (docs/SUBSCRIPTIONS-AUDIT.md,
 * Part II). Everything on this side of the line is done: the page shows $29, the
 * engine and the gate ship, and the checkout button carries the literal
 * placeholder REPLACE_WITH_29_ONE_TIME_LINK, which the page's own script refuses
 * to follow. Nobody can be shown $29 and charged $49.
 *
 * What is NOT done is the one thing that can only happen inside Stripe: the $29
 * price and its Payment Link do not exist yet. Creating them needs the account,
 * and this script does not touch Stripe at all.
 *
 * It exists so that the code half of the change is ONE atomic step instead of
 * three hand edits that can disagree with each other. Given the new URL it:
 *
 *   1. writes it into subscriptions.html's pay button,
 *   2. moves subscriptions.html out of `_skipped` and back into `pages` in
 *      prices.config.json, at 2900 cents, with the link id from that URL,
 *   3. leaves the retirement note on the old $49 link alone — deactivating that
 *      is a Stripe action, and check-prices.js will keep failing the deploy
 *      until it is done, which is the correct outcome.
 *
 * Then run:  npm run check-prices
 *
 * Usage:  node scripts/set-subscriptions-link.js https://buy.stripe.com/XXXXXXXX
 *         node scripts/set-subscriptions-link.js --check      (report only)
 *
 * Idempotent: running it twice with the same URL changes nothing the second time.
 * Nothing here is served to the web and nothing here can charge anybody.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'subscriptions.html');
const CONFIG = path.join(ROOT, 'prices.config.json');
const PLACEHOLDER = 'REPLACE_WITH_29_ONE_TIME_LINK';
const EXPECTED_CENTS = 2900;
const OLD_LINK_ID = 'plink_1U9r26H9DnCfGBIZb7nwd3OH';

function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

// Line endings are preserved on purpose: this repo's HTML is CRLF, and a
// rewrite that silently converts it turns a one-line change into a whole-file
// diff nobody can review.
function readKeepingEol(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return { raw, crlf: raw.includes('\r\n'), text: raw.split('\r\n').join('\n') };
}
function writeKeepingEol(file, text, crlf) {
  fs.writeFileSync(file, crlf ? text.split('\n').join('\r\n') : text);
}

function currentHref(pageText) {
  const m = pageText.match(/<a href="([^"]+)"[^>]*id="pay-btn"/)
    || pageText.match(/id="pay-btn"[^>]*href="([^"]+)"/);
  return m ? m[1] : null;
}

function report() {
  const page = readKeepingEol(PAGE);
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const href = currentHref(page.text);
  const listed = cfg.pages['subscriptions.html'];
  const skipped = cfg._skipped['subscriptions.html'];

  console.log('\n  subscriptions.html');
  console.log(`    pay button      ${href || '(not found)'}`);
  console.log(`    prices.config   ${listed ? `pages, ${listed.expectedPriceCents} cents, ${listed.stripeLinkId}` : skipped ? '_skipped' : '(absent)'}`);
  const retired = cfg.unreferencedActiveLinks[OLD_LINK_ID];
  console.log(`    old $49 link    ${retired ? 'recorded as retired — still needs deactivating in Stripe' : 'not recorded'}`);

  if (href && href.includes(PLACEHOLDER)) {
    console.log('\n  Waiting on Stripe. Create a $29 one-time price and a Payment Link for it,');
    console.log('  then re-run this with the https://buy.stripe.com/... URL.\n');
  } else {
    console.log('\n  Wired. Run: npm run check-prices\n');
  }
}

function apply(url) {
  if (!/^https:\/\/buy\.stripe\.com\/[A-Za-z0-9_]+$/.test(url)) {
    fail(`That does not look like a Stripe Payment Link: ${url}\n  `
      + '  Expected https://buy.stripe.com/<id> with no query string or trailing slash.');
  }
  const linkId = url.split('/').pop();

  const page = readKeepingEol(PAGE);
  const href = currentHref(page.text);
  if (!href) fail('Could not find the pay button in subscriptions.html.');
  if (href === url) {
    console.log('\n  Already wired to that link. Nothing to do.\n');
    return report();
  }
  if (!href.includes(PLACEHOLDER)) {
    fail(`The pay button already points at ${href}.\n  `
      + '  Refusing to overwrite a live checkout link. Change it by hand if that is really what you want.');
  }

  // The page. Replace only inside the href, never the setup comment that names
  // the placeholder in prose -- the same distinction stripe-migrate-pricing.js
  // draws, and for the same reason: rewriting the instructions leaves them
  // reading as if the job were still to do.
  const before = (page.text.match(new RegExp(`href="${PLACEHOLDER}"`, 'g')) || []).length;
  if (before !== 1) fail(`Expected exactly one placeholder href, found ${before}.`);
  const pageOut = page.text.replace(`href="${PLACEHOLDER}"`, () => `href="${url}"`);
  writeKeepingEol(PAGE, pageOut, page.crlf);

  // The config. Out of _skipped, into pages, at the price the page shows.
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  delete cfg._skipped['subscriptions.html'];
  const pages = {};
  // Reinserted in key order so the file stays alphabetical and the diff stays
  // readable.
  for (const k of Object.keys(cfg.pages).concat('subscriptions.html').sort()) {
    pages[k] = k === 'subscriptions.html'
      ? { label: 'Subscription Navigator', expectedPriceCents: EXPECTED_CENTS, stripeLinkId: linkId }
      : cfg.pages[k];
  }
  cfg.pages = pages;
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');

  console.log(`\n  subscriptions.html -> ${url}`);
  console.log(`  prices.config.json -> pages, ${EXPECTED_CENTS} cents, ${linkId}`);
  console.log('\n  Still to do in Stripe, and the deploy gate will keep failing until it is:');
  console.log(`    deactivate ${OLD_LINK_ID} — the old $49 link, still live and sellable.`);
  console.log('\n  Next: npm run check-prices\n');
}

const arg = process.argv[2];
if (!arg || arg === '--check') report();
else apply(arg.trim());
