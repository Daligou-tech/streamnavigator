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
  //
  // Usually on the page itself. Closing is the exception: closing.html sells a
  // FREE scorecard, and the customer only meets a Stripe button one step later,
  // on /closing-scorecard. spec.checkoutPage says where to look.
  //
  // Without it this check failed for closing on every run -- "No Stripe checkout
  // button found" -- and since the script ends in "Do not deploy", the honest
  // reading is that it was being ignored. A deploy gate nobody believes is worse
  // than no gate: the price on the page and the amount Stripe charges were going
  // unchecked on the one product where they sit furthest apart.
  const checkoutFile = spec.checkoutPage || file;
  const where = checkoutFile === file ? 'the page' : checkoutFile;
  let checkoutHtml = html;
  if (checkoutFile !== file) {
    const checkoutFull = path.join(ROOT, checkoutFile);
    checkoutHtml = fs.existsSync(checkoutFull)
      ? fs.readFileSync(checkoutFull, 'utf8')
      : null;
  }

  let links = [];
  if (checkoutHtml === null) {
    problems.push('Checkout page not found: ' + checkoutFile);
  } else {
    links = extractCheckoutLinkIds(checkoutHtml);
  }

  if (checkoutHtml !== null && links.length === 0) {
    problems.push('No Stripe checkout button found on ' + where + '.');
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

  // 2b. Any OTHER payment link in that page's markup, on a button or not.
  //
  // closing-scorecard.html carried data-link-basic pointing at the retired $29
  // document-only tier. Nothing read it, so the check above could not see it --
  // and it sat one edit away from charging $29 again for the audit whose whole
  // point is that a thinner upload finds less money. The config already says
  // "if $29 shows up on the page again, this check should fail"; it could not,
  // because it was only ever looking at hrefs on marked buttons.
  if (checkoutHtml !== null) {
    const strays = [...new Set(
      (checkoutHtml.match(/buy\.stripe\.com\/([A-Za-z0-9]+)/g) || [])
        .map((u) => u.split('/').pop())
    )].filter((id) => id !== spec.stripeLinkId);
    if (strays.length) {
      problems.push(
        checkoutFile + ' still references payment link(s) ' + strays.join(', ')
          + '. Remove them — an unused link is one edit away from being the live one.'
      );
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

// ---------- the live Stripe check ----------
//
// Everything above this line compares files to other files. That is exactly
// how a dead checkout survived: on 2026-09-07 the button on buying.html
// pointed at a payment link Stripe had deactivated six days earlier, and
// loading it returned "The link is no longer active." Purchase Navigator could
// not be bought at all. This script passed every run, because buying.html and
// prices.config.json carried the same stale link ID — they agreed with each
// other and disagreed with Stripe, and nothing here had ever asked Stripe.
//
// So this section asks. For each configured link it checks three things that
// file comparison cannot see:
//
//   1. the link still exists in this account
//   2. it is active
//   3. it charges the amount the page advertises
//
// STRICTLY READ-ONLY. It issues GETs and nothing else. A price checker must
// never be able to change a price.

const STRIPE_API = 'https://api.stripe.com/v1';

// The config stores the public URL suffix ("28E00jaosceEcoA93WabK0j"), not the
// API id ("plink_..."), because the suffix is what goes in the page's href.
// The API cannot look a link up by suffix, so the whole list is fetched and
// matched on the url field.
async function fetchAllPaymentLinks(key) {
  const links = [];
  let startingAfter = null;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ limit: '100' });
    qs.append('expand[]', 'data.line_items');
    if (startingAfter) qs.set('starting_after', startingAfter);

    const resp = await fetch(`${STRIPE_API}/payment_links?${qs}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Stripe API ${resp.status}: ${body.slice(0, 200)}`);
    }
    const body = await resp.json();
    links.push(...(body.data || []));
    if (!body.has_more || !body.data.length) return links;
    startingAfter = body.data[body.data.length - 1].id;
  }
  return links;
}

const linkSuffix = (url) => String(url || '').split('/').filter(Boolean).pop();

async function checkStripeLinks(entries, allowedUnreferenced) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return {
      skipped:
        'STRIPE_SECRET_KEY is not set, so the live check did not run. The '
        + 'checks above compare the page to prices.config.json only — they '
        + 'cannot tell whether the link works or what it charges.',
    };
  }

  const links = await fetchAllPaymentLinks(key);
  const bySuffix = new Map(links.map((l) => [linkSuffix(l.url), l]));
  const rows = [];

  for (const [file, spec] of entries) {
    if (!spec.stripeLinkId) continue;
    const link = bySuffix.get(spec.stripeLinkId);
    const row = { file, spec, problems: [] };

    if (!link) {
      row.problems.push(
        `no payment link in this Stripe account has the URL buy.stripe.com/${spec.stripeLinkId}. `
        + 'The button points at a link that does not exist here.'
      );
      rows.push(row);
      continue;
    }

    row.link = link;
    if (!link.active) {
      row.problems.push(
        `payment link ${link.id} is DEACTIVATED in Stripe. A customer clicking `
        + 'checkout gets "The link is no longer active." and cannot buy.'
      );
    }

    // A link can carry several line items; the page advertises one price, so
    // anything other than a single item is reported rather than guessed at.
    const items = (link.line_items && link.line_items.data) || [];
    if (items.length !== 1) {
      row.problems.push(
        `expected exactly one line item, found ${items.length}. The page shows a `
        + 'single price, so what Stripe would charge is not what the page says.'
      );
    } else {
      const price = items[0].price || {};
      const qty = items[0].quantity == null ? 1 : items[0].quantity;
      const charged = (price.unit_amount || 0) * qty;
      if (charged !== spec.expectedPriceCents) {
        row.problems.push(
          `Stripe charges ${money(charged)} but the page advertises `
          + `${money(spec.expectedPriceCents)}. The customer sees one number and pays another.`
        );
      }
      if (price.currency && price.currency !== 'usd') {
        row.problems.push(`price is in ${price.currency.toUpperCase()}, not USD.`);
      }
      row.charged = charged;
    }
    rows.push(row);
  }

  // ---- the other direction: anything sellable that nothing advertises ------
  //
  // The loop above walks from the config outwards and can only see links a page
  // points at. It is blind to the opposite failure: a link that is ACTIVE in
  // Stripe and referenced by nothing.
  //
  // That is not hypothetical either. A retired $29 Closing tier sat active for
  // six days after the product moved to $59. No page linked it, so nothing here
  // looked at it, and anyone holding the URL could have bought a $59 report for
  // $29. It was found by reading the Stripe dashboard by hand.
  //
  // Legitimate cases exist — the streaming subscriptions are sold from a page
  // this config deliberately skips — so they are allow-listed by id WITH A
  // REASON rather than pattern-matched away. Writing the reason down is the
  // point: an unexplained sellable link is the thing being hunted.
  // Underscore keys are documentation, not entries. Counting _comment as an
  // allow-listed link reported "4 active link(s) deliberately unreferenced"
  // against three real ones — a number that invites you to go looking for a
  // fourth that does not exist.
  const allowed = Object.fromEntries(
    Object.entries(allowedUnreferenced || {}).filter(([k]) => !k.startsWith('_'))
  );
  const referenced = new Set(
    entries.map(([, spec]) => spec.stripeLinkId).filter(Boolean)
  );
  const orphans = links
    .filter((l) => l.active)
    .filter((l) => !referenced.has(linkSuffix(l.url)))
    .filter((l) => !allowed[l.id])
    .map((l) => {
      const items = (l.line_items && l.line_items.data) || [];
      const price = (items[0] && items[0].price) || {};
      return {
        id: l.id,
        url: l.url,
        amount: price.unit_amount == null ? null : price.unit_amount,
        recurring: Boolean(price.recurring),
      };
    });

  return { rows, orphans, allowedCount: Object.keys(allowed).length };
}

// ---------- main ----------

async function main() {
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

  // ---- live Stripe verification -------------------------------------------
  console.log(bold('\nLive Stripe check\n'));
  let stripe;
  try {
    stripe = await checkStripeLinks(entries, config.unreferencedActiveLinks);
  } catch (err) {
    // A network failure or a bad key must not be reported as "prices are fine".
    // It is not a price mismatch either, so it is its own outcome.
    console.log(`  ${red('ERROR')}  could not reach Stripe: ${err.message}`);
    console.log(red(bold('\nThe live check could not run. Not safe to call this a pass.\n')));
    process.exit(1);
  }

  if (stripe.skipped) {
    console.log(`  ${yellow('SKIPPED')}  ${stripe.skipped}`);
  } else {
    for (const r of stripe.rows) {
      const ok = r.problems.length === 0;
      const mark = ok ? green('PASS') : red('FAIL');
      const charged = r.charged == null ? '—' : money(r.charged);
      const state = !r.link ? red('missing') : r.link.active ? green('active') : red('DEACTIVATED');
      console.log(
        `  ${mark}  ${r.spec.label.padEnd(w)} ${String(charged).padStart(7)}   ${state}`
      );
    }
    // Fold Stripe problems into the same list the page checks use, so one
    // failure anywhere is one non-zero exit.
    for (const r of stripe.rows) {
      if (!r.problems.length) continue;
      const existing = results.find((x) => x.file === r.file);
      if (existing) existing.problems.push(...r.problems);
      else results.push({ file: r.file, spec: r.spec, problems: r.problems, notes: [] });
    }

    // Active links nothing advertises. Reported as its own failure rather than
    // hung off a page, because by definition there is no page to hang it on.
    if (stripe.orphans && stripe.orphans.length) {
      results.push({
        file: '(Stripe account)',
        spec: { label: 'Unreferenced links' },
        notes: [],
        problems: stripe.orphans.map((o) =>
          `${o.id} is ACTIVE and charges ${o.amount == null ? 'an unknown amount' : money(o.amount)}`
          + `${o.recurring ? ' recurring' : ''}, but no page in prices.config.json points at it. `
          + `Anyone holding ${o.url} can buy it. Deactivate it, or add it to `
          + 'unreferencedActiveLinks with a reason.'),
      });
    }
    if (stripe.allowedCount) {
      console.log(dim(
        `  ${stripe.allowedCount} active link(s) deliberately unreferenced — see `
        + 'unreferencedActiveLinks in prices.config.json'
      ));
    }
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
  if (stripe.skipped) {
    // Deliberately not a silent pass. Reporting "all consistent" when the only
    // check that can see a dead checkout never ran is how the last one shipped.
    console.log(green(bold(`\nAll ${results.length} pages consistent with prices.config.json.`)));
    console.log(yellow(bold('Stripe was NOT checked — see SKIPPED above.\n')));
    process.exit(0);
  }

  console.log(green(bold(
    `\nAll ${results.length} pages consistent, and all ${stripe.rows.length} `
    + 'Stripe links are active and charge what their page advertises.\n'
  )));
  process.exit(0);
}

// Only run the CLI when invoked directly. Without this guard, requiring the
// file from a test executes main() and calls process.exit, killing the runner.
if (require.main === module) {
  main().catch((err) => {
    console.error(red(`\ncheck-prices crashed: ${err && err.stack ? err.stack : err}\n`));
    process.exit(1);
  });
}

// Exported for tests. The live Stripe path cannot be exercised in CI without a
// secret key, so the logic is tested against a stubbed fetch instead — which is
// the part that has to be right: a dead link, a missing link and a wrong amount
// must each fail, and a healthy one must pass.
module.exports = { checkStripeLinks, fetchAllPaymentLinks, linkSuffix };
