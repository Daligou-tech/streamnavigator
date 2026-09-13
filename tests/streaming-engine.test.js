// Run: node tests/streaming-engine.test.js
//
// StreamNavigator answers one question per subscription: should I be paying
// for this right now, and if not, when do I start again? This suite holds
// the engine to that, and to the rules that make the answer worth acting on.
//
// Every one of these covers something that actually shipped broken:
//
//   * The analyzer contained no reference to the current date, so on 12
//     September 2026 — five days into the NFL season — it told NFL
//     households to pause their NFL services.
//   * The only pause path sat behind a sports gate, so a household that
//     followed no sport could never be told to pause anything, and naming a
//     favourite show actively suppressed it.
//   * savingsYearly was derived from a recommended total, so the engine
//     banked a $204/yr downgrade it never told the customer to make.
//   * A paused row with no air date was told to restart after 30 days, on
//     no evidence, which undid the saving it had just produced.
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
const { decide, analyze, SERVICES, PRICING } = E;

const SEPT = '2026-09-12';  // mid NFL season
const JUNE = '2026-06-12';  // NFL off-season

const sub = (o) => Object.assign({
  serviceId: 'netflix', tierId: 'standard', price: 17.99,
  billingPeriod: 'monthly', renewalDate: '2026-10-15', status: 'active',
}, o);
const show = (o) => Object.assign({ kind: 'show', serviceId: 'netflix', title: 'A Show', currentlyAiring: false, nextAirDate: null }, o);
const sport = (title, serviceId) => ({ kind: 'sport', serviceId, title });

// ------------------------------------------------------- the worked example

test('the blueprint example reproduces exactly', () => {
  // "Your last show ended August 28. Your next starts November 14. Suspend
  // now and restart around November 13. Estimated savings: $35.98"
  const d = decide(
    sub({ price: 17.99, renewalDate: '2026-09-15' }),
    [show({ title: 'Wednesday', prevAirDate: '2026-08-28', nextAirDate: '2026-11-14' })],
    SEPT,
  );
  assert.strictEqual(d.action, 'suspend', `expected suspend, got ${d.action}`);
  assert.strictEqual(d.savings, 35.98, `expected $35.98 saved, got $${d.savings}`);
  assert.strictEqual(d.cycles, 2, `expected 2 skipped charges, got ${d.cycles}`);
  assert.strictEqual(d.restartDate, '2026-11-13', `expected restart 2026-11-13, got ${d.restartDate}`);
  assert.ok(/August 28/.test(d.why), 'the explanation does not say when the last show ended');
  assert.ok(/November 14/.test(d.why), 'the explanation does not say when the next one starts');
});

// ------------------------------------------------------------ KEEP

test('KEEP while something is actually airing', () => {
  const d = decide(sub(), [show({ title: 'Stranger Things', currentlyAiring: true, prevAirDate: '2026-09-08' })], SEPT);
  assert.strictEqual(d.action, 'keep');
  assert.ok(/airing new episodes/.test(d.why), 'no evidence of what is airing');
});

test('KEEP when the next episode lands before the next charge', () => {
  const d = decide(sub({ renewalDate: '2026-10-15' }), [show({ nextAirDate: '2026-10-01' })], SEPT);
  assert.strictEqual(d.action, 'keep');
  assert.ok(/before your October 15 renewal/.test(d.why), `expected the renewal named: "${d.why}"`);
});

test('KEEP a sports service during its own season', () => {
  const d = decide(sub({ serviceId: 'espn', tierId: 'select', price: 12.99 }), [sport('nfl', 'espn')], SEPT);
  assert.strictEqual(d.action, 'keep', 'ESPN was suspended during the NFL season');
});

test('SUSPEND that same service out of season', () => {
  const d = decide(sub({ serviceId: 'espn', tierId: 'select', price: 12.99, renewalDate: '2026-06-15' }), [sport('nfl', 'espn')], JUNE);
  assert.strictEqual(d.action, 'suspend', 'ESPN was kept through the NFL off-season');
  assert.ok(d.restartDate, 'no restart date offered');
  assert.ok(d.savings > 0, 'a whole off-season suspend saved nothing');
});

// ----------------------------------------------- suspending must be worth it

test('no suspend when the customer would be paying again a month later', () => {
  // Back before the charge AFTER next: switching off skips one charge and
  // then you are paying again — a round trip for a single month.
  const d = decide(sub({ renewalDate: '2026-09-20' }), [show({ nextAirDate: '2026-10-10' })], SEPT);
  assert.strictEqual(d.action, 'keep');
  assert.ok(/round trip for a single month/.test(d.why), `the reason does not explain why not: "${d.why}"`);
  assert.strictEqual(d.savings, 0);
});

test('the "not worth it" test is billing dates, not a count of days', () => {
  // This is the case a fixed 45-day floor got wrong: 37 days out, with a
  // renewal in 3 days, it said "not worth the hassle" about a real charge
  // the customer would have skipped. The gap spans two renewals, so it is
  // worth it, and the engine now says so.
  const d = decide(sub({ price: 18.99, renewalDate: '2026-09-16' }), [show({ nextAirDate: '2026-10-20' })], SEPT);
  assert.strictEqual(d.action, 'suspend', 'a 37-day gap spanning two charges was refused');
  assert.strictEqual(d.cycles, 2, `expected 2 skipped charges, got ${d.cycles}`);
  assert.strictEqual(d.savings, 37.98);
});

test('the engine agrees with the blueprint rule across the whole band', () => {
  // "Suspend when nothing tagged is airing and nothing has a confirmed date
  // before the renewal after next." Asserted directly rather than through a
  // day-count approximation of it.
  const cases = [
    ['2026-09-16', '2026-10-15'], ['2026-09-16', '2026-10-20'], ['2026-09-16', '2026-11-05'],
    ['2026-09-14', '2026-10-25'], ['2026-09-30', '2026-11-10'], ['2026-09-16', '2026-09-20'],
  ];
  for (const [renewalDate, nextAirDate] of cases) {
    const d = decide(sub({ price: 18.99, renewalDate }), [show({ nextAirDate })], SEPT);
    const nextRenewal = E.nextRenewalFrom({ renewalDate, billingPeriod: 'monthly' }, SEPT);
    const expected = E.toDate(nextAirDate) > E.advance(nextRenewal, 'monthly') ? 'suspend' : 'keep';
    assert.strictEqual(d.action, expected,
      `renewal ${renewalDate}, back ${nextAirDate}: engine said ${d.action}, blueprint says ${expected}`);
  }
});

test('a title keeps its capitals in the reason', () => {
  const d = decide(sub({ renewalDate: '2026-09-16' }), [show({ title: "Grey's Anatomy", nextAirDate: '2026-10-15' })], SEPT);
  assert.ok(/Grey's Anatomy/.test(d.why), `the title was mangled: "${d.why}"`);
  assert.ok(!/grey's anatomy/.test(d.why), 'a proper noun was lowercased in customer-facing copy');
});

test('no suspend when the return lands inside what is already paid for', () => {
  // Renewal is months away and the show is back before it: there is no
  // charge to skip, so cancelling would cost a resubscribe and save nothing.
  const d = decide(sub({ renewalDate: '2027-01-20' }), [show({ nextAirDate: '2026-12-01' })], SEPT);
  assert.strictEqual(d.action, 'keep');
  assert.ok(/before your January 20 renewal/.test(d.why), `expected the renewal named: "${d.why}"`);
  assert.strictEqual(d.savings, 0);
});

test('a suspend is only ever issued when it skips a real charge', () => {
  // Every suspend the engine can produce must skip at least one billing
  // date — otherwise it is asking for two chores in exchange for nothing.
  const cases = [
    [sub({ renewalDate: '2026-09-15' }), [show({ nextAirDate: '2026-11-14' })], SEPT],
    [sub({ renewalDate: '2026-09-20' }), [show({ nextAirDate: null, prevAirDate: '2026-05-01' })], SEPT],
    [sub({ serviceId: 'espn', price: 12.99, renewalDate: '2026-06-15' }), [sport('nfl', 'espn')], JUNE],
  ];
  for (const [s, w, t] of cases) {
    const d = decide(s, w, t);
    if (d.action !== 'suspend') continue;
    assert.ok(d.cycles === null || d.cycles >= 1, `a suspend skipping ${d.cycles} charges was issued`);
    assert.ok(d.savings > 0, 'a suspend with no saving was issued');
  }
});

test('an annual plan is never cancelled mid-term', () => {
  const d = decide(sub({ billingPeriod: 'annual', price: 199, renewalDate: '2027-03-01' }), [show({})], SEPT);
  assert.strictEqual(d.action, 'keep', 'an annual plan was told to cancel with months prepaid');
  assert.ok(/forfeits/.test(d.why), 'the reason does not explain the forfeit');
  assert.ok(d.decideOn, 'no date given for when to revisit it');
});

test('an annual plan IS actionable as its renewal approaches', () => {
  const d = decide(sub({ billingPeriod: 'annual', price: 199, renewalDate: '2026-09-20' }), [show({})], SEPT);
  assert.strictEqual(d.action, 'suspend');
});

// ----------------------------------------------------------- RESTART

test('RESTART only against a real date', () => {
  const paused = sub({ status: 'paused' });
  const noDate = decide(paused, [show({ nextAirDate: null })], SEPT);
  assert.strictEqual(noDate.action, 'watch', 'a paused service with nothing scheduled was told to restart');
  assert.strictEqual(noDate.restartDate, null, 'a restart date was invented with no air date');
  assert.ok(/will not tell you to start paying again on a guess/.test(noDate.why), 'the honest "no date" wording is gone');
  assert.ok(!/check.{0,12}every day|check daily/i.test(noDate.why),
    'the engine claims daily monitoring — the free analyzer runs once and watches nothing');

  const soon = decide(paused, [show({ nextAirDate: '2026-09-14' })], SEPT);
  assert.strictEqual(soon.action, 'restart', 'an imminent, dated return did not trigger a restart');
  assert.strictEqual(soon.restartDate, '2026-09-13', 'restart should land the day before');
});

test('a paused service stays off, with the date it comes back', () => {
  const d = decide(sub({ status: 'paused' }), [show({ nextAirDate: '2026-12-01' })], SEPT);
  assert.strictEqual(d.action, 'watch');
  assert.ok(/Keep Netflix off until December 1/.test(d.headline), `headline was "${d.headline}"`);
  assert.ok(d.savings > 0, 'staying off for 80 days was valued at nothing');
});

// --------------------------------------------------------- evidence & trust

test('every decision carries checkable evidence', () => {
  const d = decide(sub(), [show({ title: 'Wednesday', prevAirDate: '2026-08-28', nextAirDate: '2026-11-14' })], SEPT);
  assert.ok(Array.isArray(d.evidence) && d.evidence.length, 'no evidence array');
  const ev = d.evidence[0];
  assert.strictEqual(ev.title, 'Wednesday');
  assert.strictEqual(ev.source, 'TVmaze', 'the data source is not named');
  assert.ok(ev.nextDate, 'the evidence carries no date');
  assert.ok(d.confidence, 'no confidence level');
});

test('a sports date is flagged approximate, a TVmaze date is not', () => {
  const s = decide(sub({ serviceId: 'espn', price: 12.99, renewalDate: '2026-06-15' }), [sport('nfl', 'espn')], JUNE);
  assert.strictEqual(s.confidence, 'medium', 'a season-calendar estimate is being sold as exact');
  assert.ok(/around/.test(s.why), 'an approximate date is not hedged');
  const t = decide(sub({ renewalDate: '2026-09-15' }), [show({ nextAirDate: '2026-11-14' })], SEPT);
  assert.strictEqual(t.confidence, 'high', 'a confirmed TVmaze date should be high confidence');
});

test('a service with nothing tagged is never guessed at', () => {
  const d = decide(sub(), [], SEPT);
  assert.strictEqual(d.action, 'untracked');
  assert.strictEqual(d.savings, 0);
  assert.ok(/won't guess/.test(d.why), 'the engine guesses when it has nothing to go on');
});

test('cancel-only services say cancel, pausable ones say pause', () => {
  const netflix = decide(sub({ renewalDate: '2026-09-15' }), [show({ nextAirDate: '2026-12-20' })], SEPT);
  assert.ok(/^Cancel/.test(netflix.headline), `Netflix has no pause; headline was "${netflix.headline}"`);
  assert.ok(/keep access until/.test(netflix.why), 'does not explain that access runs to the period end');
  const hulu = decide(sub({ serviceId: 'hulu', tierId: 'noads', price: 18.99, renewalDate: '2026-09-15' }),
    [show({ serviceId: 'hulu', nextAirDate: '2026-12-20' })], SEPT);
  assert.ok(/^Pause/.test(hulu.headline), `Hulu supports pause; headline was "${hulu.headline}"`);
});

test('a suspend with no known return banks exactly one charge, not zero and not a guess', () => {
  // Crediting zero made the product look worthless in the case it is most
  // useful: a household told to cancel three services saw "you save $0".
  // Crediting a guessed gap length would have been the opposite failure.
  const d = decide(sub({ price: 18.49, renewalDate: '2026-09-16' }), [show({ nextAirDate: null, prevAirDate: '2025-05-25' })], SEPT);
  assert.strictEqual(d.action, 'suspend');
  assert.strictEqual(d.cycles, 1, 'an open-ended suspend should bank exactly one skipped charge');
  assert.strictEqual(d.savings, 18.49, `expected the one skipped charge, got $${d.savings}`);
  assert.strictEqual(d.openEnded, true, 'the open-ended flag is missing, so the UI cannot show the rate');
  assert.strictEqual(d.monthlyWhileOff, 18.49, 'the per-month upside is not reported');
});

test('a sports service is never downgraded to a cheaper tier', () => {
  // Cheaper sports tiers carry different games. The catalog does not model
  // which, so a downgrade here could take away the exact thing being paid
  // for — worse than no saving at all.
  const r = analyze({
    subscriptions: [sub({ serviceId:'peacock', tierId:'premiumplus', price:19.99, renewalDate:'2026-09-16' })],
    watchlist: [sport('nfl','peacock')], household: 2, adsOk: true,
  }, { today: SEPT });
  assert.strictEqual(r.decisions[0].action, 'keep');
  assert.strictEqual(r.actions.filter((a) => a.type === 'downgrade').length, 0,
    'a sports service was recommended a cheaper tier that may not carry the games');
  assert.ok(r.decisions[0].tierNote, 'the customer is not told why no cheaper plan was suggested');
});

test('a non-sports service still gets right-sized', () => {
  const r = analyze({
    subscriptions: [sub({ serviceId:'netflix', tierId:'premium', price:26.99, renewalDate:'2026-09-16' })],
    watchlist: [show({ serviceId:'netflix', currentlyAiring: true, prevAirDate:'2026-09-09' })],
    household: 1, adsOk: false,
  }, { today: SEPT });
  const dg = r.actions.find((a) => a.type === 'downgrade');
  assert.ok(dg, 'a one-person household on the 4-stream tier was not right-sized');
  assert.strictEqual(dg.annualSaving, 84, `expected $84/yr, got $${dg.annualSaving}`);
});

// ------------------------------------------ things a correct answer can miss
//
// Each of these is a way that acting on a RIGHT recommendation can still cost
// the customer money or access. The audit listed them as failure modes; none
// of them is caught by getting the keep/suspend call itself correct.

test('a promotional or legacy rate is flagged before you cancel it', () => {
  const plain = decide(sub({ renewalDate: '2026-09-16' }), [show({})], SEPT);
  assert.ok(!plain.cautions.some((c) => c.kind === 'promo'), 'a standard rate was flagged as promotional');
  const promo = decide(sub({ renewalDate: '2026-09-16', isPromoRate: true }), [show({})], SEPT);
  const c = promo.cautions.find((x) => x.kind === 'promo');
  assert.ok(c, 'cancelling a legacy price was recommended with no warning that it will not come back');
  assert.ok(/list price/i.test(c.text), 'the warning does not say what coming back costs');
});

test('a plan with non-streaming benefits is never treated as just streaming', () => {
  // Prime Video bundled with Prime carries delivery, music and the rest.
  const bundled = decide(
    { serviceId: 'primevideo', tierId: 'withprime', price: 14.99, billingPeriod: 'monthly', status: 'active', renewalDate: '2026-09-16' },
    [show({ serviceId: 'primevideo', title: 'The Boys' })], SEPT);
  const c = bundled.cautions.find((x) => x.kind === 'bundle-benefits');
  assert.ok(c, 'cancelling Prime was recommended as if it were only a video subscription');
  assert.ok(/delivery/i.test(c.text), 'the warning does not name what else is lost');
  // The standalone tiers carry no such warning.
  const standalone = decide(
    { serviceId: 'primevideo', tierId: 'noads', price: 11.99, billingPeriod: 'monthly', status: 'active', renewalDate: '2026-09-16' },
    [show({ serviceId: 'primevideo', title: 'The Boys' })], SEPT);
  assert.ok(!standalone.cautions.some((x) => x.kind === 'bundle-benefits'),
    'a video-only Prime tier was warned about as if it were the Prime bundle');
});

test('cancelling is never sold as lossless', () => {
  // Downloads go immediately and the profile window varies by service.
  const d = decide(sub({ renewalDate: '2026-09-16' }), [show({})], SEPT);
  assert.ok(d.cautions.some((c) => c.kind === 'account'), 'no warning about downloads or the profile window');
  assert.ok(!/watchlist are kept/.test(d.why),
    'the reason still promises the watchlist survives, which is not reliably true');
  // A service that genuinely pauses keeps the account, so it needs no warning.
  const hulu = decide(sub({ serviceId: 'hulu', tierId: 'noads', price: 18.99, renewalDate: '2026-09-16' }),
    [show({ serviceId: 'hulu' })], SEPT);
  assert.ok(!hulu.cautions.some((c) => c.kind === 'account'),
    'a real pause was warned about as if it lost the account');
});

test('a service two people in the house watch says so', () => {
  const d = decide(sub({ renewalDate: '2026-09-16' }), [
    show({ title: 'Wednesday', viewer: 'Sam' }),
    show({ title: 'Bridgerton', viewer: 'Alex' }),
  ], SEPT);
  assert.deepStrictEqual(d.viewers, ['Sam', 'Alex']);
  const c = d.cautions.find((x) => x.kind === 'household');
  assert.ok(c, 'a service two people follow was recommended for cancellation with no mention of the other person');
  assert.ok(/Sam and Alex/.test(c.text), 'the warning does not name them');
  assert.ok(d.evidence.every((e) => 'viewer' in e), 'the evidence does not carry who follows what');
});

test('one viewer is not a household warning', () => {
  const d = decide(sub({ renewalDate: '2026-09-16' }),
    [show({ title: 'Wednesday', viewer: 'Sam' }), show({ title: 'Bridgerton', viewer: 'Sam' })], SEPT);
  assert.ok(!d.cautions.some((x) => x.kind === 'household'), 'one person was warned about themselves');
});

test('the last useful moment is called out as such', () => {
  const far = decide(sub({ renewalDate: '2026-09-30' }), [show({})], SEPT);
  assert.ok(!far.urgent, 'a charge 17 days away was marked urgent');
  const near = decide(sub({ renewalDate: '2026-09-15' }), [show({})], SEPT);
  assert.strictEqual(near.urgent, true, 'a charge in 2 days was not marked urgent');
  assert.ok(/last useful moment/.test(near.why), `no urgency in the reason: "${near.why}"`);
  const today = decide(sub({ renewalDate: SEPT }), [show({})], SEPT);
  assert.ok(/renews TODAY/.test(today.why), 'a charge landing today reads the same as one in three days');
});

test('a declined suggestion stays declined', () => {
  const declined = decide(sub({ renewalDate: '2026-09-16', snoozedUntil: '2026-12-01' }), [show({})], SEPT);
  assert.strictEqual(declined.action, 'snoozed', 'a suggestion the customer declined came straight back');
  assert.strictEqual(declined.savings, 0, 'a declined suggestion still counted toward savings');
  assert.ok(/your call/i.test(declined.headline), 'the card does not make clear this was the customer\'s decision');
  assert.ok(declined.evidence.length, 'declining hid the evidence as well as the suggestion');
  // ...until it runs out.
  const expired = decide(sub({ renewalDate: '2026-09-16', snoozedUntil: '2026-08-01' }), [show({})], SEPT);
  assert.strictEqual(expired.action, 'suspend', 'an expired snooze still suppressed the suggestion');
});

test('a declined suggestion is worth nothing in the total', () => {
  const input = {
    subscriptions: [sub({ renewalDate: '2026-09-16', snoozedUntil: '2026-12-01' })],
    watchlist: [show({})], household: 1, adsOk: false,
  };
  const r = analyze(input, { today: SEPT });
  assert.strictEqual(r.savingsYearly, 0, 'a snoozed subscription was counted as a saving');
  assert.strictEqual(r.actions.filter((a) => a.type === 'suspend').length, 0);
});

test('the row mapping carries the new fields through', () => {
  const mapped = E.rowToSubscription({
    id: 'r1', service_name: 'Netflix', monthly_price: 19.99, status: 'active',
    next_renewal_date: '2026-09-16', billing_period: 'monthly',
    is_promo_rate: true, suggestion_snoozed_until: '2026-12-01',
  });
  assert.strictEqual(mapped.isPromoRate, true, 'the promo flag is dropped on the way in');
  assert.strictEqual(mapped.snoozedUntil, '2026-12-01', 'the snooze date is dropped on the way in');
  const item = E.favoriteToItem({ kind: 'show', title: 'X', service_name: 'Netflix', viewer: 'Sam' });
  assert.strictEqual(item.viewer, 'Sam', 'the viewer is dropped on the way in');
});

// ------------------------------------------------------------ savings maths

test('the headline saving is the sum of the actions shown', () => {
  const scenarios = [
    { subscriptions: [sub({ serviceId:'netflix', tierId:'premium', price:26.99, renewalDate:'2026-09-16' }),
                      sub({ serviceId:'max', tierId:'ultimate', price:22.99, renewalDate:'2026-09-20' }),
                      sub({ serviceId:'espn', tierId:'unlimited', price:31.99, renewalDate:'2026-09-18' })],
      watchlist: [show({ serviceId:'netflix', title:'Stranger Things', currentlyAiring:true, prevAirDate:'2026-09-09' }), sport('nfl','espn')],
      household: 4, adsOk: false },
    { subscriptions: [sub({ serviceId:'hulu', tierId:'noads', price:18.99, renewalDate:'2026-09-15' }),
                      sub({ serviceId:'disney', tierId:'premium', price:18.99, renewalDate:'2026-09-15' })],
      watchlist: [show({ serviceId:'hulu', title:'The Bear', nextAirDate:'2027-06-01' })],
      household: 2, adsOk: true },
  ];
  for (const [i, input] of scenarios.entries()) {
    for (const today of [SEPT, JUNE]) {
      const r = analyze(input, { today });
      const sum = E.round2(r.actions.reduce((s, a) => s + (a.annualSaving || 0), 0));
      assert.ok(Math.abs(sum - r.savingsYearly) < 0.02,
        `scenario ${i}: headline $${r.savingsYearly} but the actions add to $${sum}`);
    }
  }
});

test('net savings after the fee are stated, not left to the customer', () => {
  const r = analyze({
    subscriptions: [sub({ serviceId:'espn', tierId:'unlimited', price:31.99, renewalDate:'2026-06-15' })],
    watchlist: [sport('nfl','espn')], household: 2, adsOk: true,
  }, { today: JUNE });
  assert.strictEqual(r.feeAnnual, 19.99, 'the fee is not the recommended $19.99');
  assert.strictEqual(r.netSavingsYearly, E.round2(r.savingsYearly - 19.99), 'net savings are wrong');
  assert.ok(r.currentAnnual > 0 && r.optimisedAnnual >= 0, 'current/optimised annual cost missing');
});

test('an overridden recommendation stops counting toward savings', () => {
  const input = {
    subscriptions: [sub({ serviceId:'espn', tierId:'select', price:12.99, renewalDate:'2026-06-15' })],
    watchlist: [sport('nfl','espn')], household: 1, adsOk: true,
  };
  const on = analyze(input, { today: JUNE });
  const off = analyze(Object.assign({}, input, { overrides: { espn: true } }), { today: JUNE });
  assert.ok(on.savingsYearly > 0, 'expected a saving before the override');
  assert.strictEqual(off.savingsYearly, 0, 'an overridden recommendation still counted');
  assert.ok(off.decisions[0].overridden, 'the decision is not marked overridden');
});

// ------------------------------------------------------- catalog & pricing

test('the catalog lives in exactly one place', () => {
  for (const f of ['streaming.html', 'dashboard.html']) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/const SERVICES\s*=\s*\{/.test(s), `${f} has its own inline SERVICES catalog again`);
    assert.ok(s.includes('navigator-streaming-engine.js'), `${f} does not load the shared engine`);
  }
});

test('the catalog says when it was last verified, and both pages show it', () => {
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(E.CATALOG_VERIFIED), 'CATALOG_VERIFIED is not a date');
  for (const f of ['streaming.html', 'dashboard.html']) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(s.includes('data-catalog-verified'), `${f} shows dollar figures without a checked-on date`);
  }
});

test('every service carries a price, a check date and a pause policy', () => {
  for (const [id, svc] of Object.entries(SERVICES)) {
    assert.ok(svc.tiers.length > 0, `${id} has no tiers`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(svc.checked || ''), `${id} has no checked date`);
    assert.strictEqual(typeof svc.canPause, 'boolean', `${id} does not say whether it can be paused`);
    for (const t of svc.tiers) assert.ok(typeof t.price === 'number' && t.price > 0, `${id}/${t.id} has no price`);
  }
});

test('the fee is the recommended one, and below the defensible ceiling', () => {
  assert.strictEqual(PRICING.annualCents, 1999);
  assert.ok(PRICING.annualCents <= PRICING.maxDefensibleCents);
});

// ------------------------------------------------------------------ report
if (failures.length) {
  console.error(`\nstreaming-engine: ${passed} passed, ${failures.length} FAILED\n`);
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`streaming-engine: ${passed} passed`);
