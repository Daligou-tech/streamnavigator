// The contract navigator-subscription-engine.js is held to.
//
// Three of these tests are invariants rather than examples. They enumerate
// every combination of the answers a customer can give — several thousand
// inputs — and assert that no combination at all can produce a recommendation
// that loses the customer money or data. That is deliberate: the audit of
// 2026-09-19 found that on three of thirteen realistic household scenarios the
// obvious read of the only signal the old product collected ("used twice",
// "never opened it", "barely used") pointed straight at the recommendation
// that made the customer worse off. An example test would have caught the
// three cases somebody thought of. These catch the ones nobody did.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../navigator-subscription-engine.js');
const { Action, SavingKind } = E;

const TODAY = '2026-06-15';
const LOSES_ACCESS = [Action.CANCEL, Action.CANCEL_AND_RETURN, Action.ROTATE, Action.DOWNGRADE];

function line(over) {
  return Object.assign({
    name: 'Example Service', price: 12.99, period: 'monthly',
    lastUsed: '6-plus-months', wouldMiss: 'not-at-all', usedBy: 'just-me', status: 'active',
  }, over);
}

// Every answer a customer can give, crossed. ~5k inputs.
function everyInput() {
  const out = [];
  const names = ['Hulu', 'Netflix', 'iCloud 2TB', 'Amazon Prime', 'Spotify', 'Adobe Creative Cloud',
    'Gym', 'Some Unknown Thing', 'NYT'];
  const prices = [null, 3.99, 12.99, 119.00];
  const periods = ['monthly', 'annual'];
  for (const name of names) {
    for (const price of prices) {
      for (const period of periods) {
        for (const lastUsed of E.LAST_USED) {
          for (const wouldMiss of E.WOULD_MISS) {
            for (const usedBy of E.USED_BY) {
              out.push(line({
                name, price, period, lastUsed, wouldMiss, usedBy,
                renewalDate: period === 'annual' ? '2027-01-10' : null,
              }));
            }
          }
        }
      }
    }
  }
  return out;
}

const ALL = everyInput();

/* ------------------------------------------------------------ invariants */

test('INVARIANT: a plan somebody else uses is never cancelled, rotated or downgraded', () => {
  const bad = [];
  for (const l of ALL) {
    const d = E.decide(Object.assign({}, l, { usedBy: 'someone-else-too' }), TODAY);
    if (LOSES_ACCESS.includes(d.action)) {
      bad.push(`${l.name} ${l.period} ${l.lastUsed}/${l.wouldMiss} -> ${d.action} (${d.ruleId})`);
    }
  }
  assert.deepEqual(bad.slice(0, 8), [],
    `${bad.length} inputs cancel a shared plan on one person's say-so`);
});

test('INVARIANT: a prepaid annual plan mid-term is never cancelled, rotated or downgraded', () => {
  const bad = [];
  for (const l of ALL) {
    if (l.period !== 'annual') continue;
    const d = E.decide(Object.assign({}, l, { prepaid: true, renewalDate: '2027-01-10' }), TODAY);
    if (LOSES_ACCESS.includes(d.action)) {
      bad.push(`${l.name} ${l.lastUsed}/${l.wouldMiss}/${l.usedBy} -> ${d.action} (${d.ruleId})`);
    }
  }
  assert.deepEqual(bad.slice(0, 8), [],
    `${bad.length} inputs cancel a year the customer has already paid for`);
});

test('INVARIANT: something holding the customer\'s own data is never cancelled', () => {
  const bad = [];
  for (const l of ALL) {
    for (const name of ['iCloud 2TB', 'Dropbox', '1Password', 'Google One']) {
      const d = E.decide(Object.assign({}, l, { name }), TODAY);
      if (d.action === Action.CANCEL || d.action === Action.CANCEL_AND_RETURN) {
        bad.push(`${name} ${l.lastUsed}/${l.wouldMiss} -> ${d.action} (${d.ruleId})`);
      }
    }
  }
  assert.deepEqual(bad.slice(0, 8), [],
    `${bad.length} inputs delete the customer's own files to save a subscription fee`);
});

test('INVARIANT: no dollar figure is ever produced for a line with no price', () => {
  const bad = [];
  for (const l of ALL) {
    if (l.price !== null) continue;
    const d = E.decide(l, TODAY);
    if (d.saving.amount !== 0) bad.push(`${l.name} -> ${d.saving.amount} (${d.ruleId})`);
    if (d.annualCost !== null) bad.push(`${l.name} annualCost invented: ${d.annualCost}`);
  }
  assert.deepEqual(bad.slice(0, 8), [], `${bad.length} unpriced lines were given a figure anyway`);
});

test('INVARIANT: a saving never exceeds what the subscription costs in a year', () => {
  const bad = [];
  for (const l of ALL) {
    const d = E.decide(l, TODAY);
    if (d.annualCost === null) continue;
    if (d.saving.amount > d.annualCost + 0.001) {
      bad.push(`${l.name} saves ${d.saving.amount} on a ${d.annualCost}/yr subscription (${d.ruleId})`);
    }
  }
  assert.deepEqual(bad.slice(0, 8), [], bad.join('\n  '));
});

test('INVARIANT: a link is only ever produced for a service whose link was checked', () => {
  const stream = require('../navigator-streaming-engine.js');
  const known = new Set(Object.values(stream.MANAGE_URLS));
  const bad = [];
  for (const name of ['Hulu', 'Netflix', 'Gym', 'Some Unknown Thing', 'HelloFresh', 'Adobe',
    'iCloud 2TB', 'NYT', 'Peloton', '1Password']) {
    const d = E.decide(line({ name }), TODAY);
    if (d.manage.url && !known.has(d.manage.url)) bad.push(`${name} -> ${d.manage.url}`);
    if (!d.manage.url) {
      assert.ok(d.manage.hint && /not going to invent/.test(d.manage.hint),
        `${name} has no link and no honest explanation of why`);
    }
  }
  assert.deepEqual(bad, [],
    'these URLs were produced by the engine and are not in the hand-checked table:\n  '
    + bad.join('\n  '));
});

test('INVARIANT: "rotate" is never used on a service that cannot actually pause', () => {
  const bad = [];
  for (const name of ['Hulu', 'Netflix', 'Peacock', 'Disney+', 'YouTube TV', 'Sling TV',
    'Paramount+', 'Some Unknown Thing']) {
    const d = E.decide(line({
      name, price: 9.99, wouldMiss: 'a-lot', lastUsed: '2-3-months',
      seasonal: { need: 'one show', fromMonth: 9, toMonth: 4 },
    }), TODAY);
    if (d.action === Action.ROTATE && d.canPause !== true) bad.push(`${name} (canPause=${d.canPause})`);
  }
  assert.deepEqual(bad, [],
    'a "rotate" on a service with no hold is a cancellation the customer was not warned about: '
    + bad.join(', '));
});

/* -------------------------------------------- the thirteen audit scenarios */

const SCENARIOS = [
  ['heavily used, wanted', line({ name: 'Netflix', price: 19.99, lastUsed: 'this-week', wouldMiss: 'a-lot', usedBy: 'someone-else-too' }), Action.KEEP],
  ['dead for four months', line({ name: 'Hulu', price: 18.99, lastUsed: '2-3-months', wouldMiss: 'not-at-all' }), Action.CANCEL],
  ['seasonal, no pause', line({ name: 'Peacock', price: 7.99, lastUsed: '2-3-months', wouldMiss: 'a-lot', seasonal: { sport: 'epl' } }), Action.CANCEL_AND_RETURN],
  ['prepaid annual, barely used', line({ name: 'Adobe Creative Cloud', price: 719.88, period: 'annual', renewalDate: '2027-03-14', lastUsed: '6-plus-months', wouldMiss: 'not-at-all' }), Action.KEEP_UNTIL],
  ['shared family plan', line({ name: 'Spotify Duo', price: 16.99, lastUsed: '6-plus-months', wouldMiss: 'not-at-all', usedBy: 'someone-else-too' }), Action.REVIEW],
  ['bundled membership', line({ name: 'Amazon Prime', price: 14.99, lastUsed: '6-plus-months', wouldMiss: 'not-at-all' }), Action.REVIEW],
  ['gym on a contract', line({ name: 'Gym membership', price: 39.00, lastUsed: '6-plus-months', wouldMiss: 'not-at-all' }), Action.CANCEL],
  ['cloud storage, barely used', line({ name: 'iCloud 2TB', price: 9.99, lastUsed: '6-plus-months', wouldMiss: 'not-at-all' }), Action.REVIEW],
  ['legacy rate, rarely read', line({ name: 'NYT Digital', price: 4.00, lastUsed: '2-3-months', wouldMiss: 'a-bit', promoRate: true }), Action.KEEP],
  ['cancelled, now needed', line({ name: 'Disney+', price: 9.99, status: 'cancelled', wouldMiss: 'a-lot' }), Action.RESTART],
  ['trivial and wanted', line({ name: 'Weather app', price: 2.99, lastUsed: '2-3-months', wouldMiss: 'a-bit' }), Action.KEEP],
  ['trivial and unwanted', line({ name: 'Weather app', price: 2.99, lastUsed: '6-plus-months', wouldMiss: 'not-at-all' }), Action.CANCEL],
  ['no price given', line({ name: 'Gym', price: null, lastUsed: '6-plus-months', wouldMiss: 'not-at-all' }), Action.REVIEW],
];

for (const [label, input, expected] of SCENARIOS) {
  test(`scenario: ${label} -> ${expected}`, () => {
    const d = E.decide(input, TODAY);
    assert.equal(d.action, expected, `got ${d.action} (${d.ruleId}): ${d.why.join(' ')}`);
    assert.ok(d.why.length, 'every decision must say why');
    assert.ok(d.doThis, 'every decision must end at something the customer can do');
  });
}

test('the unpriced line still says which way it points', () => {
  const d = E.decide(line({ name: 'Gym', price: null, lastUsed: '6-plus-months', wouldMiss: 'not-at-all' }), TODAY);
  assert.equal(d.action, Action.REVIEW);
  assert.equal(d.provisionalAction, Action.CANCEL);
  assert.equal(d.saving.kind, SavingKind.UNPRICED);
});

/* ---------------------------------------------------------- the arithmetic */

test('a two-month rotation saves two cycles, not a year', () => {
  // The flattering error this product is most likely to be caught making.
  // Premier League runs Aug-May, so the off-season is June and July.
  const d = E.decide(line({
    name: 'Peacock', price: 7.99, lastUsed: '2-3-months', wouldMiss: 'a-lot',
    seasonal: { sport: 'epl' },
  }), TODAY);
  assert.equal(d.cyclesSkipped, 2);
  assert.equal(d.saving.amount, 15.98);
  assert.equal(d.saving.kind, SavingKind.CONDITIONAL);
  assert.match(d.saving.basis, /not the full year/);
});

test('a cancellation saves twelve months of the monthly price', () => {
  const d = E.decide(line({ name: 'Hulu', price: 18.99, lastUsed: 'never', wouldMiss: 'not-at-all' }), TODAY);
  assert.equal(d.saving.amount, 227.88);
  assert.equal(d.saving.kind, SavingKind.CONFIRMED);
});

test('a promotional rate turns any saving into one that is shown but not counted', () => {
  const d = E.decide(line({ name: 'Some Service', price: 25.00, lastUsed: 'never', wouldMiss: 'not-at-all', promoRate: true }), TODAY);
  assert.equal(d.action, Action.REVIEW);
  assert.notEqual(d.saving.kind, SavingKind.CONFIRMED);
});

test('totals are kept by kind and never added across kinds', () => {
  const a = E.analyze({
    lines: [
      line({ name: 'Hulu', price: 18.99, lastUsed: 'never', wouldMiss: 'not-at-all' }),
      line({ name: 'Peacock', price: 7.99, lastUsed: '2-3-months', wouldMiss: 'a-lot', seasonal: { sport: 'epl' } }),
      line({ name: 'Starz', price: 10.99, lastUsed: 'never', wouldMiss: 'not-at-all', promoRate: true }),
      line({ name: 'Gym', price: null, lastUsed: 'never', wouldMiss: 'not-at-all' }),
    ],
  }, { today: TODAY });

  assert.equal(a.totals.confirmedAnnual, 227.88, 'only the confirmed cancellation counts');
  assert.equal(a.totals.conditionalAnnual, 15.98, 'the rotation counts its cycles, separately');
  assert.equal(a.totals.atRiskAnnual, 0, 'a blocked promo line is not a saving at all');
  assert.equal(a.totals.unpricedLines, 1);
  // The number the customer is shown must never be the sum of the three.
  assert.notEqual(a.totals.confirmedAnnual,
    a.totals.confirmedAnnual + a.totals.conditionalAnnual + a.totals.atRiskAnnual);
});

test('an annual plan is not counted as twelve times its price', () => {
  const d = E.decide(line({ name: 'Some Service', price: 119.00, period: 'annual', prepaid: false, lastUsed: 'never', wouldMiss: 'not-at-all' }), TODAY);
  assert.equal(d.annualCost, 119.00);
  assert.equal(d.saving.amount, 119.00);
});

/* ----------------------------------------------------------- the scorecard */

test('the scorecard reports finding nothing as a result, not an apology', () => {
  const a = E.analyze({
    lines: [
      line({ name: 'Netflix', price: 19.99, lastUsed: 'this-week', wouldMiss: 'a-lot' }),
      line({ name: 'Spotify', price: 11.99, lastUsed: 'this-week', wouldMiss: 'a-lot' }),
    ],
  }, { today: TODAY });
  const sc = E.buildScorecard(a);
  assert.equal(sc.actionableLines, 0);
  assert.ok(sc.nothingFound);
  assert.match(sc.headline, /found nothing you should stop paying for/);
  assert.match(sc.headline, /for free/);
});

test('the scorecard never leaks the paid report', () => {
  const a = E.analyze({
    lines: [line({ name: 'Hulu', price: 18.99, lastUsed: 'never', wouldMiss: 'not-at-all' })],
  }, { today: TODAY });
  const sc = E.buildScorecard(a);
  const json = JSON.stringify(sc);
  assert.ok(!json.includes('Hulu'), 'the free scorecard must not name which line is which');
  assert.ok(!/http/.test(json), 'the free scorecard must not hand over the cancellation links');
  assert.ok(!json.includes('doThis'), 'the free scorecard must not hand over the steps');
  assert.equal(sc.confirmedAnnual, 227.88, 'but it must show the number honestly');
});

/* --------------------------------------------------------- the paywall gate */

test('a single character is not a submission', () => {
  const r = E.checkSufficiency({ lines: [{ name: 'a' }] });
  assert.equal(r.sufficient, false);
  assert.ok(r.missing.length);
});

test('an empty list is not a submission', () => {
  assert.equal(E.checkSufficiency({}).sufficient, false);
  assert.equal(E.checkSufficiency({ lines: [] }).sufficient, false);
});

test('a name and a price without the three answers is not a submission', () => {
  const r = E.checkSufficiency({ lines: [{ name: 'Hulu', price: 18.99, period: 'monthly' }] });
  assert.equal(r.sufficient, false);
  assert.ok(r.missing.some((m) => m.key === 'answers'));
});

test('a complete line passes', () => {
  const r = E.checkSufficiency({
    lines: [{ name: 'Hulu', price: 18.99, period: 'monthly', lastUsed: 'never', wouldMiss: 'not-at-all', usedBy: 'just-me' }],
  });
  assert.equal(r.sufficient, true, JSON.stringify(r.missing));
});

test('an annual plan without a renewal date is not a submission', () => {
  const r = E.checkSufficiency({
    lines: [{ name: 'Adobe', price: 719.88, period: 'annual', lastUsed: 'never', wouldMiss: 'not-at-all', usedBy: 'just-me' }],
  });
  assert.equal(r.sufficient, false);
  assert.ok(r.missing.some((m) => m.key === 'renewalDate'),
    'on an annual plan the date is the whole decision');
});

test('every line must be answered, not just the first', () => {
  const r = E.checkSufficiency({
    lines: [
      { name: 'Hulu', price: 18.99, period: 'monthly', lastUsed: 'never', wouldMiss: 'not-at-all', usedBy: 'just-me' },
      { name: 'Max', price: 16.99, period: 'monthly' },
    ],
  });
  assert.equal(r.sufficient, false);
  assert.ok(r.missing.some((m) => /Max/.test(m.label)), 'the customer is told which one');
});

/* ------------------------------------------------------------- list paste */

test('a pasted list becomes lines with the prices read and nothing invented', () => {
  const lines = E.parseList('Netflix $19.99\nHulu 18.99/mo\nAdobe CC $719.88/year\ngym');
  assert.equal(lines.length, 4);
  assert.equal(lines[0].name, 'Netflix');
  assert.equal(lines[0].price, 19.99);
  assert.equal(lines[2].period, 'annual');
  assert.equal(lines[3].name, 'gym');
  assert.equal(lines[3].price, null, 'a line with no price must not be given one');
  for (const l of lines) {
    assert.equal(l.lastUsed, 'unknown', 'parsing must never guess an answer');
    assert.equal(l.wouldMiss, 'unknown');
  }
});

test('a pasted list is a head start, never a complete submission on its own', () => {
  const lines = E.parseList('Netflix $19.99, Hulu $18.99');
  assert.equal(E.checkSufficiency({ lines }).sufficient, false);
});

/* ------------------------------------------------------- duplicate coverage */

test('three video services in one household are named as overlap', () => {
  const a = E.analyze({
    lines: [
      line({ name: 'Netflix', price: 19.99, lastUsed: 'this-week', wouldMiss: 'a-lot' }),
      line({ name: 'HBO Max', price: 16.99, lastUsed: 'this-week', wouldMiss: 'a-lot' }),
      line({ name: 'Paramount+', price: 12.99, lastUsed: 'this-week', wouldMiss: 'a-lot' }),
    ],
  }, { today: TODAY });
  assert.equal(a.overlaps.length, 1);
  assert.equal(a.overlaps[0].id, 'streaming');
  assert.equal(a.overlaps[0].count, 3);
  assert.match(a.overlaps[0].note, /not something we can decide/,
    'overlap is an observation, not a recommendation the engine is entitled to make');
});

test('overlap does not fire on two services where three is the household norm', () => {
  const a = E.analyze({
    lines: [
      line({ name: 'Netflix', price: 19.99, lastUsed: 'this-week', wouldMiss: 'a-lot' }),
      line({ name: 'HBO Max', price: 16.99, lastUsed: 'this-week', wouldMiss: 'a-lot' }),
    ],
  }, { today: TODAY });
  assert.deepEqual(a.overlaps, []);
});

/* -------------------------------------------------------------- the report */

test('every line appears in the output, including the ones with nothing to do', () => {
  const names = ['Netflix', 'Hulu', 'Spotify', 'iCloud 2TB', 'Gym'];
  const a = E.analyze({ lines: names.map((name) => line({ name, price: 9.99 })) }, { today: TODAY });
  assert.equal(a.decisions.length, names.length);
});

test('the report opens on the line with the most at stake', () => {
  const a = E.analyze({
    lines: [
      line({ name: 'Weather app', price: 2.99, lastUsed: 'never', wouldMiss: 'not-at-all' }),
      line({ name: 'Hulu', price: 18.99, lastUsed: 'never', wouldMiss: 'not-at-all' }),
    ],
  }, { today: TODAY });
  assert.equal(a.decisions[0].name, 'Hulu');
});

test('a restart carries a date, not a vague instruction', () => {
  const d = E.decide(line({
    name: 'Peacock', price: 7.99, status: 'cancelled', wouldMiss: 'a-lot',
    seasonal: { sport: 'nfl' },
  }), TODAY);
  assert.ok(d.restartOn || d.actOn, 'a restart with no date is not actionable');
});
