// The same contract rental.html is held to, applied to all eleven products.
//
// The 2026-09-09 audit tested one page and found that "$149/year" and "a full
// year of monitoring" were sold against a one-time Stripe charge, no
// entitlement column and no job that ever looked at a property twice. Fixing
// only that page was the wrong scope: the copy was template boilerplate, and
// the same two sentences were sitting on landlord, home-maintenance,
// home-savings and subscriptions — landlord word for word, down to "One price.
// A full year of monitoring."
//
// Every one of those was a one-time payment link. Verified at checkout for
// rental and landlord: $149.00, a "Pay" button, no interval, no Subscribe.
//
// So the rule is line-wide now. A page may sell a year only if its product is
// one the code actually grants a year for.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { ENTITLED_PRODUCTS } = require('../api/_lib/rental-entitlement');
const prices = JSON.parse(fs.readFileSync(path.join(ROOT, 'prices.config.json'), 'utf8'));

// Every page that sells a Navigator, by the product it sells.
const PRODUCT_PAGES = Object.keys(prices.pages).map((file) => ({
  file,
  product: path.basename(file, '.html'),
  src: fs.readFileSync(path.join(ROOT, file), 'utf8'),
}));

// Plus the product pages sitting in `_skipped` while their Payment Link is
// rebuilt. A page whose price is temporarily unchecked is still a page a
// customer reads, and the claims below are about what it says, not what it
// charges. Two products are repriced and awaiting links right now
// (/subscriptions at $29, /government-money at $19) and both were outside
// every claim check in this file until this line existed.
//
// streaming.html is deliberately NOT included: it sells $19.99/year against a
// real annual subscription, which is the one thing the year check below is
// written to forbid everywhere else.
const REPRICED_PAGES = Object.keys(prices._skipped)
  .filter((file) => file !== 'streaming.html' && fs.existsSync(path.join(ROOT, file)))
  .map((file) => ({
    file,
    product: path.basename(file, '.html'),
    src: fs.readFileSync(path.join(ROOT, file), 'utf8'),
  }));

const ALL_PRODUCT_PAGES = PRODUCT_PAGES.concat(REPRICED_PAGES);

// Text a customer reads, minus the setup comment every page carries in its head.
function visible(src) {
  // Newlines are preserved so a reported line number points at the real file
  // rather than at the stripped copy.
  return src.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
}

test('every priced page is covered by this contract', () => {
  // Counted over ALL_PRODUCT_PAGES, not `pages` alone. Moving a repriced
  // product into `_skipped` while its Payment Link is rebuilt used to drop it
  // out of every claim check in this file — a page could be taken out of the
  // contract by a pricing change, which is the moment its copy is most likely
  // to be wrong.
  assert.ok(ALL_PRODUCT_PAGES.length >= 11,
    `only ${ALL_PRODUCT_PAGES.length} product pages found`);
});

test('no page sells a year the code does not grant', () => {
  // The "refresh" family was added after this test PASSED over a real offence.
  //
  // /home-savings sold "a refreshed check as your bills change through the
  // year" in its how-it-works step and "with a refresh as your bills change"
  // on its price card, against a one-time $49 charge, no entitlement, and its
  // own FAQ two screens further down saying "Each audit is its own $49 report
  // ... that is a fresh upload and a fresh report". This test was written for
  // exactly that defect and did not catch it, because the wording reached
  // "through the year" rather than "a full year". A guard that only matches
  // the phrasing of the last offence is not a guard.
  // See docs/HOME-SAVINGS-AUDIT.md, Critical 3.
  const claim = new RegExp([
    /\$\d+\s*\/\s*year/, /per year/, /a full year/, /full year of/,
    /ongoing monitoring/, /ongoing checks/, /billed once per year/,
    /refreshed check/, /a refresh as/, /through the year/,
    /as your bills change/, /re-?checked? automatically/,
  ].map((r) => r.source).join('|'), 'i');
  const offenders = [];
  for (const { file, product, src } of PRODUCT_PAGES) {
    if (ENTITLED_PRODUCTS.includes(product)) continue;
    visible(src).split('\n').forEach((line, i) => {
      if (claim.test(line) && !/year_built|Year Built/i.test(line)) {
        offenders.push(`${file}:${i + 1} ${line.trim().replace(/<[^>]+>/g, '').slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'these pages sell something recurring for a product with no entitlement behind it. '
    + 'Every Navigator payment link is a one-time charge, and only '
    + `${ENTITLED_PRODUCTS.join(', ')} has an entitlement the customer can spend:\n  `
    + offenders.join('\n  '));
});

test('no page sells reference data that does not exist', () => {
  const corpus = fs.readdirSync(path.join(ROOT, 'data')).filter((f) => f !== '.gitkeep');

  // Per product, not per repository.
  //
  // This used to return early the moment data/ held anything at all — "a corpus
  // arrived: these claims become fair game". Landlord Navigator's jurisdiction
  // set arriving on 2026-09-10 would have switched the guard off for all twelve
  // pages at once, including the eleven it says nothing about. A reference set
  // for one product licenses a reference-data claim on that product's page and
  // nowhere else.
  const hasCorpus = (product) => corpus.some((f) => f.startsWith(`${product}-`));

  // Narrow on purpose. "What that kind of service typically costs" is what the
  // engines actually do — reason from general knowledge and say when unsure.
  // These phrases promise a lookup against data nobody holds.
  const claim = /benchmarks? every|market rate data|rate table|published rates?|live comps?|comparable sales|current market data|against market data/i;
  const offenders = [];
  for (const { file, product, src } of PRODUCT_PAGES) {
    if (hasCorpus(product)) continue;
    visible(src).split('\n').forEach((line, i) => {
      if (claim.test(line)) offenders.push(`${file}:${i + 1} ${line.trim().replace(/<[^>]+>/g, '').slice(0, 80)}`);
    });
  }
  assert.deepEqual(offenders, [],
    'data/ holds no corpus for these products, so nothing on their pages can be compared '
    + `against reference data:\n  ${offenders.join('\n  ')}`);
});

// --- /landlord: the claims that had nothing behind them ----------------------
//
// The audit of 2026-09-10 found four sentences on landlord.html selling a thing
// that did not exist in any form: "AI tracks relevant rules", "get action items
// as things change", "turns regulatory changes into specific action items" and
// "a specific action item for every relevant change". None of the seven crons in
// vercel.json touched landlord; nothing stored a baseline of rules; nothing ever
// looked at a submission twice. The page was also selling "required tenant
// notice periods and formats for your area" on top of a system prompt that
// explicitly forbade the model from stating one.
//
// The fix was to build the deterministic engine the page was describing and
// rewrite the copy to what it actually does. These keep the two in step.

test('landlord.html does not sell monitoring that nothing performs', () => {
  const page = visible(fs.readFileSync(path.join(ROOT, 'landlord.html'), 'utf8'));
  const crons = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).crons || [];
  const watched = crons.some((c) => /landlord/i.test(c.path));
  if (watched) return;   // a job arrived: the claim becomes fair game

  const claim = /tracks? (?:relevant |the )?rules|as things change|regulatory changes|every relevant change|we(?:'ll| will) notify you|notified of changes/i;
  const offenders = [];
  page.split('\n').forEach((line, i) => {
    if (claim.test(line)) offenders.push(`landlord.html:${i + 1} ${line.trim().replace(/<[^>]+>/g, '').slice(0, 90)}`);
  });
  assert.deepEqual(offenders, [],
    'nothing in vercel.json looks at a landlord submission twice, so the page cannot say it '
    + `does:\n  ${offenders.join('\n  ')}`);
});

test('landlord.html never promises a figure the engine refuses to print', () => {
  // The engine holds no fee, no penalty and no statutory notice period, and
  // tests/landlord-audit.test.js enforces that none appears in a finding. The
  // page must not sell one either, or the customer buys the one thing the
  // report is built never to give them.
  const page = visible(fs.readFileSync(path.join(ROOT, 'landlord.html'), 'utf8'));
  const forbidden = [
    /required (?:tenant )?notice periods? (?:and formats? )?for your area/i,
    /exact notice period/i,
    /what (?:registration|the licen[cs]e) costs?\b(?!\?)/i,
    /registration fees?/i,
  ];
  for (const re of forbidden) {
    // The FAQ answers the question by refusing it, which is the opposite of
    // selling it, so a match is only a failure outside that answer.
    const hit = page.match(re);
    if (!hit) continue;
    const around = page.slice(Math.max(0, page.indexOf(hit[0]) - 400), page.indexOf(hit[0]) + 400);
    assert.ok(/we do not hold them|we never print one|No, and that is deliberate/i.test(around),
      `landlord.html sells a figure the engine will not print: ${re}`);
  }
});

test('the number of checks landlord.html sells is the number the catalog runs', () => {
  const page = fs.readFileSync(path.join(ROOT, 'landlord.html'), 'utf8');
  const { CATALOG } = require('../api/_lib/landlord-audit');
  const WORDS = { 9: 'Nine', 10: 'Ten', 11: 'Eleven', 12: 'Twelve' };
  const word = WORDS[CATALOG.length];
  assert.ok(word, `${CATALOG.length} checks — add the word to this test's map`);
  assert.ok(new RegExp(`${word} checks`, 'i').test(page),
    `the catalog runs ${CATALOG.length} checks and the page does not say "${word.toLowerCase()} checks" — `
    + 'a page that oversells the count by one is the same defect as any other overclaim');
});

test('every jurisdiction landlord.html lists is one the reference set holds', () => {
  // The coverage panel is the page's most checkable claim: a customer reads it,
  // pays, and expects their city to be matched. A city named there and missing
  // from data/ produces exactly the coverage-gap finding the panel promised
  // would not happen for them.
  const page = fs.readFileSync(path.join(ROOT, 'landlord.html'), 'utf8');
  const panel = page.slice(page.indexOf('<div class="cov-list">'), page.indexOf('</div>', page.indexOf('<div class="cov-list">')));
  assert.ok(panel.length > 100, 'the coverage panel is gone from landlord.html');

  const held = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'landlord-jurisdictions.json'), 'utf8'));
  const cities = new Set(Object.values(held.cities).map((c) => c.city.toLowerCase()));
  const listed = panel
    .replace(/<[^>]+>/g, ' ')
    .split('·')[0] === panel ? [] : panel.replace(/<[^>]+>/g, ' ').split('·');

  const missing = listed
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter((s) => s && !/plus statewide|federal|^and\b/i.test(s))
    .map((s) => s.replace(/^Washington DC$/i, 'Washington'))
    .filter((s) => /^[A-Za-z .'-]+$/.test(s))
    .filter((s) => !cities.has(s.toLowerCase()));

  assert.deepEqual(missing, [],
    `landlord.html lists jurisdictions data/landlord-jurisdictions.json does not hold: ${missing.join(', ')}`);
});

test('a page that says the report arrives on its own is swept by a job', () => {
  // "Delivered automatically" is only true if something generates the report
  // when the customer is not sitting on the status page. Generation is
  // triggered by the browser polling; without a sweep, paying and closing the
  // tab produces nothing, and process-refunds never sees it either because
  // that only considers rows that reached "failed".
  const sweep = fs.readFileSync(path.join(ROOT, 'api', 'generate-paid-navigator.js'), 'utf8');
  const swept = (sweep.match(/'[a-z-]+'/g) || []).map((s) => s.replace(/'/g, ''));
  const ownJob = ['buying', 'hoa'];   // each has its own cron

  const offenders = [];
  for (const { file, product, src } of PRODUCT_PAGES) {
    if (!/delivered automatically/i.test(visible(src))) continue;
    if (ownJob.includes(product) || swept.includes(product)) continue;
    offenders.push(`${file} promises automatic delivery but nothing sweeps ${product}`);
  }
  assert.deepEqual(offenders, [], offenders.join('\n  '));
});

test('the sweep does not race a product that already has its own job', () => {
  const sweep = fs.readFileSync(path.join(ROOT, 'api', 'generate-paid-navigator.js'), 'utf8');
  const list = sweep.slice(sweep.indexOf('SWEPT_PRODUCTS'), sweep.indexOf('];', sweep.indexOf('SWEPT_PRODUCTS')));
  // Two products, not three. Contractor was listed here on the grounds that it
  // had "its own path" — which was the customer's browser polling the status
  // page, and nothing else. That is not a job: close the tab and the row stayed
  // at 'paid' forever, unreported and unrefunded. It is swept now, through its
  // own engine, and the race this test guards against does not apply because
  // the sweep waits two minutes and selects only 'paid' while every engine
  // writes 'processing' as its first act.
  for (const product of ['buying', 'hoa']) {
    assert.ok(!list.includes(`'${product}'`),
      `${product} has its own job; sweeping it too would generate and bill the same report twice`);
  }
});

test('a swept product is generated by its own engine, not assumed to be the generic one', () => {
  // Contractor is the first product in the sweep that does not use
  // api/_lib/navigator-engine.js. Handing its row to the generic engine would
  // not throw: it would write a report of the wrong shape into the wrong table
  // and the customer would open a blank page. So the sweep looks the engine up.
  const sweep = fs.readFileSync(path.join(ROOT, 'api', 'generate-paid-navigator.js'), 'utf8');
  const list = sweep.slice(sweep.indexOf('SWEPT_PRODUCTS'), sweep.indexOf('];', sweep.indexOf('SWEPT_PRODUCTS')));
  if (!list.includes("'contractor'")) return;
  assert.ok(/generateContractorReport/.test(sweep),
    'contractor is swept but the sweep never calls its engine');
  assert.ok(/generatorFor\(row\.product\)/.test(sweep),
    'the sweep calls one generator for every row; a contractor row would get the generic engine');
});

test('every page still names a price, and it is the one Stripe charges', () => {
  // check-prices.js enforces the exact figure at deploy time; this is the part
  // that must not silently disappear when copy is rewritten.
  for (const { file, src } of PRODUCT_PAGES) {
    const expected = prices.pages[file].expectedPriceCents / 100;
    const shown = new RegExp(`\\$${expected}\\b`).test(visible(src));
    const onCheckoutPage = !!prices.pages[file].checkoutPage;
    assert.ok(shown || onCheckoutPage, `${file} no longer shows $${expected}`);
  }
});

// --- /buying: the feature that is not sold ----------------------------------
//
// Purchase Navigator's claim sheet audited clean on 2026-09-10 — the
// sufficiency gate holds server-side, all six promised parts appear, the TCO
// arithmetic foots, and the Stripe link charges $29 once. The problem there was
// never honesty. It was that the page led with total cost of ownership, which
// Edmunds and Kelley Blue Book both do for free and with better data for
// vehicles, while the one output nothing free produces — checking a buyer's
// stated deal-breakers against the real specification — appeared nowhere in the
// selling copy at all.
//
// On a live report that check caught two of two deal-breakers on a $2,400
// refrigerator (roughly 36 inches wide against a 33-inch opening, and a
// through-door rather than internal dispenser) and turned the verdict to
// RECONSIDER. It is the most valuable thing the product does.

test('the deal-breaker check is sold, not just implemented', () => {
  const page = fs.readFileSync(path.join(ROOT, 'buying.html'), 'utf8');
  const rules = fs.readFileSync(path.join(ROOT, 'navigator-buying-rules.js'), 'utf8');

  assert.ok(/must_have_features/.test(rules), 'the field that drives it still exists');
  assert.ok(/deal-breaker/i.test(page),
    'buying.html never mentions the deal-breaker check — the one output no free '
    + 'calculator produces, driven by an optional field nobody is told the value of');

  // And the field has to explain what actually happens to what you type in it.
  const why = rules.slice(rules.indexOf("key: 'must_have_features'"), rules.indexOf("key: 'must_have_features'") + 900);
  assert.ok(/checked against the actual specification/i.test(why),
    'the field explains only that it helps pick an alternative, which undersells it: '
    + 'what is typed there is verified, and a failed deal-breaker changes the recommendation');
});

/* --- the three claims /government-money was making, checked line-wide -------
 *
 * The audit of 2026-09-19 found government-money.html selling "AI searches
 * current programs" and "generated fresh using current program information at
 * the time of purchase" on top of a prompt whose own second paragraph reads
 * "You do not have live access to current program databases", and whose shared
 * HONESTY_RULES forbid by name "the name and current dollar amount of a
 * specific government program".
 *
 * This file already existed to catch exactly that shape of defect and did not,
 * because its regexes were written for market-rate and comparable-sales
 * phrasings. These three are line-wide rather than page-specific for the same
 * reason the year check is: the copy on these pages is template boilerplate,
 * and a claim found on one page is usually sitting on four others.
 */

test('no page sells a lookup against live program or incentive data', () => {
  const corpus = fs.readdirSync(path.join(ROOT, 'data')).filter((f) => f !== '.gitkeep');

  // A corpus existing is NOT enough to license this claim, and that is the
  // difference between this guard and the reference-data one below.
  //
  // data/government-programs.json arrived on 2026-09-19 and holds gates and
  // administering authorities and deliberately no amounts, caps, thresholds or
  // deadlines — because those are the facts that go stale silently, which is
  // the whole finding the audit made about the prompt. A file that holds none
  // of them does not license a page to say it checks current amounts. Only a
  // corpus that declares `holdsCurrentAmounts: true` does, and nothing here
  // does yet.
  const hasCorpus = (product) => corpus.some((f) => {
    if (!f.startsWith(`${product}-`) || !f.endsWith('.json')) return false;
    try {
      const held = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));
      return held.holdsCurrentAmounts === true;
    } catch (err) {
      return false;
    }
  });

  // A page DENYING the lookup uses the same words and must not fail a test
  // that exists to keep that denial there.
  const claim = /searches current|current program information|live (?:program|incentive|rebate) (?:database|data)|checks? (?:today'?s|current) (?:amounts?|rules)/ig;
  const NEGATED = /\b(?:no|not|never|without|cannot|don't|doesn't)\b[^.]{0,40}$/i;

  const offenders = [];
  for (const { file, product, src } of ALL_PRODUCT_PAGES) {
    if (hasCorpus(product)) continue;
    visible(src).split('\n').forEach((line, i) => {
      claim.lastIndex = 0;
      let m;
      while ((m = claim.exec(line)) !== null) {
        if (NEGATED.test(line.slice(0, m.index))) continue;
        offenders.push(`${file}:${i + 1} ${line.trim().replace(/<[^>]+>/g, '').slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'these pages sell a lookup against data nobody holds. No engine here has live '
    + `internet or database access, and data/ holds only: ${corpus.join(', ') || '(nothing)'}:\n  `
    + offenders.join('\n  '));
});

test('no page promises a dollar value for a government or utility program', () => {
  // api/_lib/navigator-engine.js HONESTY_RULES forbids the model from stating
  // "the name and current dollar amount of a specific government program"
  // unless it is confident the figure is real and currently accurate — which,
  // with a training cutoff and no lookup, it cannot be about a program amount.
  // A page selling that figure sells the one thing the engine is built to
  // refuse.
  const claim = /estimated dollar value|dollar value (?:of|per) each|how much (?:each|every) program is worth/i;
  const offenders = [];
  for (const { file, src } of ALL_PRODUCT_PAGES) {
    visible(src).split('\n').forEach((line, i) => {
      if (claim.test(line)) offenders.push(`${file}:${i + 1} ${line.trim().replace(/<[^>]+>/g, '').slice(0, 80)}`);
    });
  }
  assert.deepEqual(offenders, [],
    'these pages promise a program dollar figure the engines are instructed never to state:\n  '
    + offenders.join('\n  '));
});

test('no page claims what share of households qualify for someone else\'s program', () => {
  // "most households qualify for at least one program they didn't know about"
  // is a quantified claim about the world, with no source, no internal data
  // and no completed-report history behind it.
  //
  // Narrow on purpose. A page saying what ITS OWN engine typically finds is
  // making a claim it could in principle support from its own runs. A page
  // saying what proportion of the population qualifies for a third party's
  // program is not — nobody here has ever been in a position to know that.
  const claim = /most (?:households|people|customers|homeowners|families|renters)[^.]{0,60}\bqualif/i;
  const offenders = [];
  for (const { file, src } of ALL_PRODUCT_PAGES) {
    visible(src).split('\n').forEach((line, i) => {
      if (claim.test(line)) offenders.push(`${file}:${i + 1} ${line.trim().replace(/<[^>]+>/g, '').slice(0, 80)}`);
    });
  }
  assert.deepEqual(offenders, [],
    'these pages state what share of households qualify for a program we do not administer '
    + `and have no data about:\n  ${offenders.join('\n  ')}`);
});
