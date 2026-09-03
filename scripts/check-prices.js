#!/usr/bin/env node
'use strict';

/**
 * check-prices.js — catches page/checkout price mismatches before they ship.
 *
 * Reads prices.config.json (what each page SHOULD say), then reads the actual
 * HTML files and compares. Reports:
 *
 *   1. Displayed price  !=  expected price
 *   2. Stripe link on the button  !=  expected link
 *   3. Any stale price left in the meta description or visible body copy
 *
 * This is the bug it exists to catch: on 2026-09-01 buying.html displayed $39
 * while its checkout button still pointed at the $19 payment link. Customers
 * saw one number and would have been charged another. A run of this script
 * would have flagged it in under a second.
 *
 * Nothing here is served to the web. It reads files and prints a table.
 * It cannot affect the live site.
 *
 * Usage:  node scripts/check-prices.js
 * Exit code 0 = everything matches. 1 = something is wrong.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'prices.config.json');

// ---------- tiny formatting helpers ----------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);

const money = (cents) =>
  cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;

/** "$4.99" / "$149" -> cents. Returns null if unparseable. */
function parseMoney(text) {
  const m = String(text).match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return null;
  return Math.round(parseFloat(m[1].replace(/,/g, '')) * 100);
}

// ---------- extraction ----------

/** Every <div class="price-amount">$N ...</div> on the page. */
function extractDisplayedPrices(html) {
  const out = [];
  const re = /class="price-amount"\s*>\s*([^<]*)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const cents = parseMoney(m[1]);
    if (cents !== null) out.push(cents);
  }
  return out;
}

/** The Stripe link IDs on real checkout buttons (data-stripe-link marks them). */
function extractCheckoutLinkIds(html) {
  const out = [];
  const re =
    /href="https:\/\/buy\.stripe\.com\/([A-Za-z0-9]+)"[^>]*data-stripe-link="([a-z-]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push({ id: m[1], product: m[2] });
  return out;
}

function extractMetaDescription(html) {
  const m = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
  return m ? m[1] : null;
}

/**
 * Visible body copy only — strips <head>, <script>, <style> and HTML comments
 * so a price mentioned in a developer note doesn't raise a false alarm.
 */
function visibleBodyText(html) {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/[\s\S]*?<body[^>]*>/i, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  return s;
}

/** Prices in body copy that aren't the expected one. */
function findStalePricesInCopy(html, expectedCents) {
  const text = visibleBodyText(html);
  const found = new Set();
  const re = /\$\s*([\d,]+(?:\.\d{1,2})?)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const cents = Math.round(parseFloat(m[1].replace(/,/g, '')) * 100);
    // Ignore the expected price, and ignore large figures — those are
    // illustrative ("a $2,000 surprise", "$5,000+ home repair"), not our price.
    if (cents !== expectedCents && cents < 100000) found.add(cents);
  }
  return [...found].sort((a, b) => a - b);
}

// ---------- checking ----------

function checkPage(file, spec) {
  const full = path.join(ROOT, file);
  const problems = [];
  const notes = [];

  if (!fs.existsSync(full)) {
    return { file, spec, problems: [`File not found: ${file}`], notes };
  }
  const html = fs.readFileSync(full, 'utf8');

  // 1. displayed price
  const displayed = extractDisplayedPrices(html);
  // A page may price more than one tier. Closing prices a $29 document-only
  // audit and a $59 audit that adds tolerance testing, and both are correct on
  // the page at once. `alsoAllowedPriceCents` lists the additional tiers so a
  // real second price does not read as a stale one — while anything NOT listed
  // still fails, which is the point of the check.
  const allowed = new Set(
    [spec.expectedPriceCents].concat(spec.alsoAllowedPriceCents || [])
  );
  if (displayed.length === 0) {
    problems.push('No price-amount element found on the page.');
  } else {
    const wrong = displayed.filter((cts) => !allowed.has(cts));
    if (wrong.length) {
      problems.push(
        `Page displays ${wrong.map(money).join(', ')} but config allows ${[...allowed]
          .map(money)
          .join(', ')}.`
      );
    }
  }

  // 2. checkout link
  const links = extractCheckoutLinkIds(html);
  if (links.length === 0) {
    problems.push('No Stripe checkout button found on the page.');
  } else {
    for (const l of links) {
      if (l.id !== spec.stripeLinkId) {
        problems.push(
          `Checkout button points at ${l.id} but config expects ${spec.stripeLinkId}. ` +
            `THIS IS THE DANGEROUS ONE — the page and the charge disagree.`
        );
      }
    }
  }

  // 3. stale prices in meta description
  if (spec.alsoCheckMetaDescription) {
    const meta = extractMetaDescription(html);
    if (meta) {
      const metaCents = parseMoney(meta);
      if (metaCents !== null && metaCents !== spec.expectedPriceCents) {
        problems.push(
          `Meta description says ${money(metaCents)} — Google will show the old price.`
        );
      }
    }
  }

  // 4. stale prices left in visible copy (warning, not failure)
  const stale = findStalePricesInCopy(html, spec.expectedPriceCents);
  if (stale.length) {
    notes.push(
      `Other prices in body copy: ${stale
        .map(money)
        .join(', ')} ${dim('(fine if intentional — check they are not leftovers)')}`
    );
  }

  return { file, spec, problems, notes, displayed, links };
}

// ---------- main ----------

function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(red(`Missing ${path.relative(ROOT, CONFIG_PATH)}`));
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const entries = Object.entries(config.pages);

  console.log(bold('\nPrice consistency check\n'));

  const results = entries.map(([file, spec]) => checkPage(file, spec));

  // table
  const w = Math.max(...results.map((r) => r.spec.label.length)) + 2;
  for (const r of results) {
    const ok = r.problems.length === 0;
    const mark = ok ? green('PASS') : red('FAIL');
    const shown = r.displayed && r.displayed.length ? money(r.displayed[0]) : '—';
    const linkOk =
      r.links && r.links.length && r.links[0].id === r.spec.stripeLinkId;
    const linkCell = linkOk ? green('link ok') : red('link MISMATCH');
    console.log(
      `  ${mark}  ${r.spec.label.padEnd(w)} ${String(shown).padStart(7)}   ${linkCell}`
    );
  }

  // detail
  const failed = results.filter((r) => r.problems.length);
  const noted = results.filter((r) => r.notes.length);

  if (noted.length) {
    console.log(bold('\nNotes\n'));
    for (const r of noted) {
      for (const n of r.notes) console.log(`  ${yellow('·')} ${r.spec.label}: ${n}`);
    }
  }

  if (failed.length) {
    console.log(bold(red('\nProblems\n')));
    for (const r of failed) {
      console.log(`  ${bold(r.spec.label)} ${dim('(' + r.file + ')')}`);
      for (const p of r.problems) console.log(`    ${red('✗')} ${p}`);
      console.log('');
    }
    console.log(
      red(bold(`${failed.length} page(s) have problems. Do not deploy.\n`))
    );
    process.exit(1);
  }

  const skipped = Object.keys(config._skipped || {});
  if (skipped.length) {
    console.log(dim(`\nSkipped: ${skipped.join(', ')}`));
  }
  console.log(green(bold(`\nAll ${results.length} pages consistent.\n`)));
  process.exit(0);
}

main();
