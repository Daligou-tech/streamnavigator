// What rental.html sells must be what rental-audit.js runs.
//
// This page has drifted from its product once already, and expensively. It sold
// "$149/year", "one price covers ongoing checks across your properties for a
// year" and "a full year of monitoring" against a Stripe link that charges once,
// a schema with no entitlement column, and a cron table with no rental entry.
// It sold "AI benchmarks every line" against an empty data directory. It offered
// spreadsheet uploads against an endpoint that returns 400 for .xlsx and .csv.
//
// None of those were lies anyone told on purpose. They were true of a plan and
// then the plan changed, and nothing failed when the words stopped matching the
// code. That is what this file is for.
//
// Deliberately mechanical and few — a test that fails on ordinary copy edits
// gets deleted, and then the page drifts again.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'rental.html'), 'utf8');
const prices = JSON.parse(fs.readFileSync(path.join(ROOT, 'prices.config.json'), 'utf8'));

const { CATALOG } = require('../api/_lib/rental-audit');
const { PRODUCT_CONFIGS } = require('../api/_lib/navigator-engine');

const NUMBER_WORDS = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

test('the number of checks the page advertises is the number the catalog runs', () => {
  // silentSkip entries are complements of another check — they run only when
  // their sibling cannot, so they are not a check the customer is promised.
  const runnable = CATALOG.filter((c) => !c.silentSkip).length;

  const written = page.match(/\b(ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(deterministic\s+)?checks?\b/i);
  assert.ok(written, 'the page no longer states how many checks run — say the number or this promise is unauditable');
  assert.equal(NUMBER_WORDS[written[1].toLowerCase()], runnable,
    `the page says "${written[0]}" but the catalog runs ${runnable}`);
});

test('the page does not sell monitoring while nothing monitors', () => {
  // There is deliberately no escape hatch here. An earlier draft of this test
  // stood down as soon as vercel.json contained any cron matching /rental/,
  // and then a cron was added — api/generate-paid-rental.js, which exists to
  // generate a report the customer already paid for when they close the tab.
  // That is delivery, not monitoring, and it would have quietly switched this
  // guard off while the claim it guards was still false.
  //
  // Selling a year means an entitlement the customer can spend and something
  // that comes back to the property without being asked. When both exist,
  // delete this test — do not weaken it.
  const claim = /monitoring|ongoing checks|per year|\/year|each year|annual subscription|every year/i;
  const offenders = page.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => claim.test(line))
    // year_built and similar structural words are not promises.
    .filter(([, line]) => !/year_built|yearly rate of/i.test(line));
  assert.deepEqual(offenders.map(([i]) => i), [],
    'rental.html promises something recurring on line(s) '
    + `${offenders.map(([i]) => i).join(', ')}, but navigator_submissions carries no entitlement `
    + 'column and no job re-audits a property. One payment buys one report.');
});

test('the price on the page is charged once, and says so', () => {
  assert.equal(prices.pages['rental.html'].expectedPriceCents, 14900);
  assert.ok(/one-time|once/i.test(page), 'the page must say the charge is one-time');
  assert.ok(!/billed once per year/i.test(page));
});

test('the page does not sell reference data the product does not hold', () => {
  const dataDir = fs.readdirSync(path.join(ROOT, 'data')).filter((f) => f !== '.gitkeep');
  if (dataDir.length) return;   // a corpus arrived: the claim becomes fair game
  const claim = /benchmarks? every|market rate data|rate table|published rates?|live comps?|comparable sales/i;
  const offenders = page.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => claim.test(line));
  assert.deepEqual(offenders.map(([i]) => i), [],
    `rental.html sells reference data on line(s) ${offenders.map(([i]) => i).join(', ')} `
    + 'while data/ is empty — every comparison the engine makes is against the property itself.');
});

test('the rent claim is scoped to the comparison the engine can actually prove', () => {
  // The unit-to-unit check needs three like units. A page that promises market
  // comparables to a single-family landlord is promising the one thing this
  // product deliberately refuses to guess at.
  const rentCopy = page.match(/[^<>]*rent[^<>]*(?:comparable|market)[^<>]*/gi) || [];
  for (const line of rentCopy) {
    if (!/\b(below|comparable|market)\b/i.test(line)) continue;
    const scoped = /own building|same floorplan|three or more|identical units|your rent roll|against itself|cannot|could not|no live|will not|do not guess|does not/i.test(line);
    assert.ok(scoped, `unscoped rent claim: "${line.trim().slice(0, 160)}"`);
  }
});

test('the writer prompt forbids originating a number', () => {
  const task = PRODUCT_CONFIGS.rental.task;
  assert.ok(/Never state a dollar figure[^.]*not present in the findings/i.test(task),
    'the rental writer must be told the findings are the report');
  assert.ok(/NOT SO YOU CAN AUDIT THEM/i.test(task),
    'the documents are attached for quoting, not for the model to re-audit');
  assert.ok(/exposure/i.test(task) && /never/i.test(task),
    'the writer must be told an exposure figure is not a saving');
});
