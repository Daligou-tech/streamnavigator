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

test('a page that sells a year is backed by an entitlement and a reminder', () => {
  // This started as a flat ban. rental.html sold "$149/year", "ongoing checks
  // across your properties for a year" and "a full year of monitoring" against
  // a Stripe link that charges once, a schema with no entitlement column and a
  // cron table with no rental job — so the words came off the page and this
  // test kept them off.
  //
  // The instruction left here was: when an entitlement a customer can spend and
  // something that comes back to the property both exist, replace this test —
  // do not weaken it. Both exist now, so the check inverts. The page may say
  // "year" exactly as long as all three halves of that promise are wired.
  //
  // The earlier draft stood down when vercel.json held any cron matching
  // /rental/, and api/generate-paid-rental.js — which only delivers a report
  // already paid for — would have switched it off. Hence naming the reminder
  // job specifically rather than pattern-matching.
  const claim = /a year|twelve months|12 months|per year|\/year|each year|annual/i;
  const sellsAYear = page.split('\n')
    .filter((line) => claim.test(line))
    .filter((line) => !/year_built|Year Built/i.test(line))
    .length > 0;
  if (!sellsAYear) return;

  const engine = fs.readFileSync(path.join(ROOT, 'api', '_lib', 'navigator-engine.js'), 'utf8');
  const intake = fs.readFileSync(path.join(ROOT, 'api', 'navigator-intake.js'), 'utf8');
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

  assert.ok(fs.existsSync(path.join(ROOT, 'api', '_lib', 'rental-entitlement.js')),
    'the page sells a year with no entitlement module behind it');
  assert.ok(/grantEntitlement\(/.test(engine),
    'nothing grants an entitlement when a rental report is delivered');
  assert.ok(/checkEntitlement\(/.test(intake) && /consumeEntitlement\(/.test(intake),
    'the intake cannot honour an entitlement, so a returning customer would be charged again');
  assert.ok((vercel.crons || []).some((c) => c.path === '/api/rental-reminders'),
    'nothing comes back to the property — a year the customer has to remember on their own '
    + 'is a year they will not use');
});

test('the entitlement the page describes is the one the code grants', () => {
  const { ENTITLEMENT_MONTHS, RUNS_ALLOWED } = require('../api/_lib/rental-entitlement');
  assert.equal(ENTITLEMENT_MONTHS, 12);
  assert.equal(RUNS_ALLOWED, 4);
  // A bound that can be stated is worth more than an "unlimited" that would
  // quietly need rationing later, so the number has to actually be on the page.
  const written = page.match(/\b(two|three|four|five|six)\s+(?:more\s+)?(?:full\s+)?(?:audits|reports)\b/i);
  assert.ok(written, 'the page does not say how many audits the year includes');
  assert.equal(written[1].toLowerCase(), 'four',
    `the page says "${written[0]}" but RUNS_ALLOWED is ${RUNS_ALLOWED}`);
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
