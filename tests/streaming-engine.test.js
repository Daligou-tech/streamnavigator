// Run: node tests/streaming-engine.test.js
//
// The streaming product makes three promises this suite holds it to.
//
//   1. Timing. It claims to tell you when to pause and when to come back.
//      The analyzer used to contain no reference to the current date at all,
//      so on 12 September 2026 — five days into the NFL season — it told NFL
//      households to pause their NFL services.
//
//   2. Pausing, for everyone. The only `action:'pause'` in the engine sat
//      behind a sports gate, so a household that followed no sport could
//      never be told to pause anything — and naming a favourite show
//      actively suppressed the one pause path that existed.
//
//   3. Numbers that survive inspection. savingsYearly was computed as
//      (currentTotal - recommendedMonthly) * 12, which let the engine bank
//      savings from changes it never surfaced: a household on ESPN Unlimited
//      was shown $605.64/yr, $204 of which came from a downgrade that
//      appeared on no card.
//
// Each of those shipped. Each has a test below.
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
const E = require('../navigator-streaming-engine.js');
const { analyze, SERVICES } = E;

const S = (serviceId, tierId, frequency) => ({ serviceId, tierId, frequency });
const SEPT = new Date('2026-09-12T12:00:00'); // mid NFL season
const JUNE = new Date('2026-06-12T12:00:00'); // NFL off-season

// ---------------------------------------------------------------- 1. timing

test('a sports service is NOT told to pause during its own season', () => {
  const r = analyze({
    subscriptions: [S('espn', 'select', 'occasionally')],
    favorites: [], sports: ['nfl'], household: 2, adsOk: true,
  }, { today: SEPT });
  const espn = r.actions.find((a) => a.service === 'espn');
  assert.ok(espn, 'no ESPN card at all');
  assert.notStrictEqual(
    espn.action, 'pause',
    'ESPN was told to pause in September, during the NFL season it is kept for',
  );
});

test('the same service IS told to pause in its off-season', () => {
  const r = analyze({
    subscriptions: [S('espn', 'select', 'occasionally')],
    favorites: [], sports: ['nfl'], household: 2, adsOk: true,
  }, { today: JUNE });
  const espn = r.actions.find((a) => a.service === 'espn');
  assert.strictEqual(espn.action, 'pause', 'ESPN was not paused in the NFL off-season');
  assert.ok(/restart around September/i.test(espn.reason), 'the pause card gives no restart month');
});

test('identical inputs give different answers in different months', () => {
  const input = {
    subscriptions: [S('paramount', 'essential', 'rarely')],
    favorites: [], sports: ['nfl'], household: 1, adsOk: true,
  };
  const inSeason = analyze(input, { today: SEPT }).actions.find((a) => a.service === 'paramount');
  const offSeason = analyze(input, { today: JUNE }).actions.find((a) => a.service === 'paramount');
  assert.notStrictEqual(
    inSeason.action, offSeason.action,
    'the engine returns the same action in September and June — it is not reading the date',
  );
});

test('no page hardcodes a season decision without consulting the date', () => {
  const engine = fs.readFileSync(path.join(root, 'navigator-streaming-engine.js'), 'utf8');
  assert.ok(
    /isSportInSeason\s*\(/.test(engine),
    'the engine no longer has an in-season check',
  );
});

// ------------------------------------------------------- 2. pause for everyone

test('a household that follows no sport can still be told to pause', () => {
  const r = analyze({
    subscriptions: [
      S('max', 'adfree', 'occasionally'),
      S('hulu', 'noads', 'occasionally'),
      S('appletv', 'standard', 'rarely'),
    ],
    favorites: ['The Last of Us', 'Severance'], sports: [], household: 2, adsOk: false,
  }, { today: SEPT });
  const paused = r.actions.filter((a) => a.action === 'pause');
  assert.ok(
    paused.length > 0,
    'the scripted-TV household got no pause recommendation — this is the case that returned three KEEPs and $0',
  );
});

test('naming a show you watch does not suppress pausing everything else', () => {
  const withFavorite = analyze({
    subscriptions: [S('hulu', 'noads', 'occasionally'), S('max', 'adfree', 'occasionally')],
    favorites: ['The Last of Us'], sports: [], household: 1, adsOk: false,
  }, { today: SEPT });
  // The Last of Us is on HBO Max, so Max is kept and Hulu — which has
  // nothing the customer named — should be pausable.
  const hulu = withFavorite.actions.find((a) => a.service === 'hulu');
  assert.strictEqual(hulu.action, 'pause', 'Hulu was kept despite nothing the customer named being on it');
  const max = withFavorite.actions.find((a) => a.service === 'max');
  assert.strictEqual(max.action, 'keep', 'HBO Max was not kept despite carrying a named show');
});

test('a pause with no known restart date is worth $0 in the annual headline', () => {
  const r = analyze({
    subscriptions: [S('hulu', 'noads', 'rarely')],
    favorites: [], sports: [], household: 1, adsOk: false,
  }, { today: SEPT });
  const hulu = r.actions.find((a) => a.service === 'hulu');
  assert.strictEqual(hulu.action, 'pause');
  assert.strictEqual(hulu.annualSaving, 0, 'an undated pause was annualised into the headline');
  assert.ok(hulu.monthlyWhilePaused > 0, 'the monthly rate while paused is not reported');
  assert.ok(r.pausedMonthlyUpside > 0, 'pausedMonthlyUpside does not surface the undated pause');
});

// ------------------------------------------------- 3. numbers that add up

test('the headline saving equals the sum of the cards shown', () => {
  const scenarios = [
    { subscriptions: [S('netflix','premium','weekly'), S('max','adfree','occasionally'), S('hulu','noads','weekly'),
                      S('disney','premium','rarely'), S('paramount','showtime','rarely'), S('espn','unlimited','occasionally')],
      favorites: ['Stranger Things','The Bear'], sports: ['nfl'], household: 4, adsOk: false },
    { subscriptions: [S('espn','unlimited','occasionally'), S('youtubetv','base','weekly')],
      favorites: [], sports: ['nfl','nba'], household: 2, adsOk: true },
    { subscriptions: [S('starz','standard','never'), S('amcplus','standard','never'), S('netflix','premium','daily')],
      favorites: [], sports: [], household: 1, adsOk: false },
    { subscriptions: [S('netflix','premium','weekly'), S('disney','premium','occasionally'),
                      S('hulu','noads','occasionally'), S('max','adfree','occasionally')],
      favorites: [], sports: [], household: 2, adsOk: false, budget: 40 },
  ];
  for (const [i, input] of scenarios.entries()) {
    for (const today of [SEPT, JUNE]) {
      const r = analyze(input, { today });
      const sum = Math.round(r.actions.reduce((s, a) => s + (a.annualSaving || 0), 0) * 100) / 100;
      assert.ok(
        Math.abs(Math.max(0, sum) - r.savingsYearly) < 0.02,
        `scenario ${i}: headline $${r.savingsYearly} but the cards add to $${sum} — the difference is money the customer was never told how to save`,
      );
    }
  }
});

test('a tier change is always its own card, never folded silently into a pause', () => {
  // The regression: identical recommendation, two different starting tiers,
  // $204/yr of difference and no card explaining it.
  const base = { favorites: [], sports: ['nfl'], household: 2, adsOk: true };
  const fromExpensive = analyze({ ...base, subscriptions: [S('espn', 'unlimited', 'occasionally')] }, { today: JUNE });
  const fromCheap = analyze({ ...base, subscriptions: [S('espn', 'select', 'occasionally')] }, { today: JUNE });
  const delta = Math.round((fromExpensive.savingsYearly - fromCheap.savingsYearly) * 100) / 100;
  assert.ok(delta > 0, 'expected the expensive tier to show a larger saving');
  const downgrade = fromExpensive.actions.find((a) => a.action === 'downgrade' && a.service === 'espn');
  assert.ok(downgrade, `the extra $${delta}/yr is claimed with no downgrade card to explain it`);
  assert.ok(
    Math.abs(downgrade.annualSaving - delta) < 0.02,
    `the downgrade card claims $${downgrade.annualSaving} but the headline moved by $${delta}`,
  );
});

test('every action carries an annualSaving the UI can show', () => {
  const r = analyze({
    subscriptions: [S('netflix','premium','weekly'), S('espn','unlimited','occasionally'), S('starz','standard','never')],
    favorites: [], sports: ['nfl'], household: 2, adsOk: true,
  }, { today: JUNE });
  for (const a of r.actions) {
    assert.strictEqual(typeof a.annualSaving, 'number', `${a.service}/${a.action} has no annualSaving`);
    assert.ok(Number.isFinite(a.annualSaving), `${a.service}/${a.action} annualSaving is not finite`);
  }
});

// ------------------------------------------------------ catalog integrity

test('the catalog lives in exactly one place', () => {
  // Two inline copies drifted: on 2026-09-12 dashboard.html priced Netflix
  // Premium at $26.99 while streaming.html still said $24.99, because an
  // August refresh only landed in one of them.
  for (const f of ['streaming.html', 'dashboard.html']) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(
      !/const SERVICES\s*=\s*\{/.test(s),
      `${f} has its own inline SERVICES catalog again — it must use navigator-streaming-engine.js`,
    );
    assert.ok(
      s.includes('navigator-streaming-engine.js'),
      `${f} does not load the shared engine`,
    );
  }
});

test('the catalog says when it was last verified, and both pages show it', () => {
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(E.CATALOG_VERIFIED), 'CATALOG_VERIFIED is not a date');
  assert.ok(!Number.isNaN(Date.parse(E.CATALOG_VERIFIED)), 'CATALOG_VERIFIED does not parse');
  for (const f of ['streaming.html', 'dashboard.html']) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(
      s.includes('data-catalog-verified'),
      `${f} shows dollar figures without saying when the prices were checked`,
    );
    assert.ok(
      !/list prices as of August 2026/.test(s),
      `${f} still hardcodes a stale "as of" date instead of stamping CATALOG_VERIFIED`,
    );
  }
});

test('every service carries a price and a check date', () => {
  for (const [id, svc] of Object.entries(SERVICES)) {
    assert.ok(svc.tiers.length > 0, `${id} has no tiers`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(svc.checked || ''), `${id} has no checked date`);
    for (const t of svc.tiers) {
      assert.ok(typeof t.price === 'number' && t.price > 0, `${id}/${t.id} has no price`);
    }
  }
});

// ------------------------------------------------------------------ report
if (failures.length) {
  console.error(`\nstreaming-engine: ${passed} passed, ${failures.length} FAILED\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`streaming-engine: ${passed} passed`);
