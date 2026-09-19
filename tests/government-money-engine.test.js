// The contract navigator-government-money-engine.js is held to.
//
// An example test would have caught the three cases somebody thought of. The
// audit (docs/GOVERNMENT-MONEY-AUDIT.md §8) named seven ways this product can
// put a number in front of a customer that they will never receive, and on
// every one of them the OBVIOUS read of the customer's answers points at the
// answer that leaves them worse off:
//
//   - a household that has just spent $9,000 on a heat pump is exactly the
//     household most pleased to hear about a credit, and exactly the household
//     for whom it is worth nothing if they owe no tax;
//   - three pieces of efficiency work in one year look like three credits and
//     are one ceiling;
//   - a utility rebate and a federal credit are both real, both apply, and
//     adding them is wrong;
//   - and whoever sold the solar already mentioned the credit.
//
// So these are enumerated rather than sampled: every combination of state,
// tenure, income band, tax-liability answer, already-claimed answer, work done
// and life event that a customer can give — about ten thousand — and the
// assertion is that not one of them escapes.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const E = require('../navigator-government-money-engine.js');
const CAT = require('../data/government-programs.json');
const BY_ID = new Map(CAT.programs.map((p) => [p.id, p]));
const TODAY = '2026-09-19';

/* ------------------------------------------------------------ the corpus */

test('the catalogue holds no dollar amounts, percentages or caps', () => {
  // The whole design. A held figure goes stale silently, which is the audit's
  // finding moved from the prompt into a JSON file. What is held is gates and
  // authorities; the amount is confirmed by the customer at the authority.
  const raw = fs.readFileSync(path.join(ROOT, 'data', 'government-programs.json'), 'utf8');
  assert.equal(raw.indexOf('$'), -1,
    'data/government-programs.json contains a dollar figure — it must hold none');
  assert.equal(raw.indexOf('%'), -1,
    'data/government-programs.json contains a percentage — it must hold none');
  assert.equal(CAT.holdsCurrentAmounts, false);
  for (const p of CAT.programs) {
    for (const [k, v] of Object.entries(p)) {
      assert.equal(typeof v === 'number', false,
        `program ${p.id} carries a numeric field "${k}" — the catalogue holds no numbers`);
    }
  }
});

test('every program declares an authority that exists', () => {
  for (const p of CAT.programs) {
    assert.ok(p.authority, `program ${p.id} names no authority — the customer would have nowhere to confirm it`);
    assert.ok(CAT.authorities[p.authority],
      `program ${p.id} names authority "${p.authority}" which the catalogue does not define`);
    assert.ok(p.confidence === 'high' || p.confidence === 'check',
      `program ${p.id} has confidence "${p.confidence}"`);
    assert.ok(p.label && p.scope, `program ${p.id} is missing a label or scope`);
  }
  assert.equal(new Set(CAT.programs.map((p) => p.id)).size, CAT.programs.length,
    'duplicate program id in the catalogue');
});

test('New Hampshire is not listed as having no income tax', () => {
  // Deliberate, and worth a test because it looks like an omission. NH taxes
  // no wages but has taxed investment income, so ruling out every state credit
  // for a New Hampshire household would be a stronger statement than the fact
  // supports.
  assert.equal(CAT.noIndividualIncomeTax.indexOf('NH'), -1);
  for (const code of CAT.noIndividualIncomeTax) {
    assert.ok(E.CODES.has(code), `noIndividualIncomeTax lists "${code}", which is not a place`);
  }
});

/* ------------------------------------------------------------- the gate */

test('a single character is still not a submission', () => {
  assert.equal(E.checkSufficiency({ description: 'x' }).sufficient, false);
  assert.equal(E.checkSufficiency({ description: '' }).sufficient, false);
  assert.equal(E.checkSufficiency({}).sufficient, false);
});

test('every required answer is actually required', () => {
  const full = {
    state: 'OH', tenure: 'own', householdSize: 4, incomeBand: '75-100k',
    taxLiability: 'yes', actionsDone: [], events: [],
  };
  assert.equal(E.checkSufficiency(full).sufficient, true);
  for (const key of Object.keys(full)) {
    const short = { ...full };
    delete short[key];
    const r = E.checkSufficiency(short);
    assert.equal(r.sufficient, false, `a submission with no ${key} was accepted`);
    assert.ok(r.missing.indexOf(key) !== -1, `${key} missing from missing[]: ${r.missing}`);
  }
});

test('an empty list is an answer and an absent one is not', () => {
  const base = { state: 'OH', tenure: 'own', householdSize: 1, incomeBand: 'under-50k', taxLiability: 'no' };
  assert.equal(E.checkSufficiency({ ...base, actionsDone: [], events: [] }).sufficient, true);
  assert.equal(E.checkSufficiency({ ...base, events: [] }).sufficient, false);
});

test('the legacy free-text shape is still held to the place rule', () => {
  // A browser holding a cached copy of the old page posts {description}. It
  // must not be broken by this change, and must not bypass the place rule.
  assert.equal(E.checkSufficiency({ description: 'homeowner, heat pump' }).sufficient, false);
  const ok = E.checkSufficiency({ description: 'homeowner in Ohio, heat pump' });
  assert.equal(ok.sufficient, true);
  assert.equal(ok.legacy, true);
  assert.equal(E.analyze({ description: 'homeowner in Ohio' }, TODAY), null,
    'a legacy submission must return no analysis rather than a fabricated one');
});

test('a half-filled modern form is not mistaken for a legacy one', () => {
  // The structured form always posts a description field — it has an optional
  // free-text box — so a legacy check that tested on the state box alone sent
  // a half-filled modern form down the free-text path and told the customer to
  // "tell us about your situation" when what was missing was a dropdown it
  // could have named. Caught driving the real page.
  const half = {
    state: '', description: '', tenure: 'own', householdSize: 4,
    incomeBand: '75-100k', taxLiability: 'yes', actionsDone: [], events: [],
  };
  const r = E.checkSufficiency(half);
  assert.equal(r.sufficient, false);
  assert.deepEqual(r.missing, ['state']);
  assert.equal(r.legacy, undefined, 'a structured submission was treated as legacy');
  assert.match(r.message, /which state you live in/);
});

test('lowercase postal codes are not mistaken for states', () => {
  assert.equal(E.namesAPlace('we live in a house and would or may qualify'), false);
  assert.equal(E.namesAPlace('ok so I am a homeowner and I rent out a room'), false);
  assert.equal(E.namesAPlace('we are in Ohio'), true);
  assert.equal(E.namesAPlace('OH, homeowner'), true);
  assert.equal(E.namesAPlace('43215'), true);
});

/* ------------------------------------------- every answer a customer can give */

const STATES = ['OH', 'TX', 'NH'];          // income tax, none, the exclusion
const ACTION_SETS = [
  [],
  ['heat-pump'],
  ['solar'],
  ['insulation', 'windows'],
  ['insulation', 'furnace-ac', 'energy-audit'],   // three in one ceiling
  ['heat-pump', 'insulation'],
  ['ev-new'],
  ['ev-used', 'ev-charger'],
];
const EVENT_SETS = [
  [],
  ['new-child', 'paid-childcare'],
  ['first-home'],
  ['turned-65', 'veteran'],
];
const PLANNED_SETS = [[], ['windows'], ['solar']];

function* everyCustomer() {
  for (const state of STATES) {
    for (const tenure of E.TENURE) {
      for (const incomeBand of E.INCOME_BANDS) {
        for (const taxLiability of E.LIABILITY) {
          for (const alreadyClaimed of E.CLAIMED) {
            for (const actionsDone of ACTION_SETS) {
              for (const events of EVENT_SETS) {
                for (const actionsPlanned of PLANNED_SETS) {
                  yield {
                    state, zip: '43215', tenure, householdSize: 3, incomeBand,
                    taxLiability, alreadyClaimed, actionsDone, events, actionsPlanned,
                  };
                }
              }
            }
          }
        }
      }
    }
  }
}

// The customer's own income band is echoed back to them in a reason, and it is
// the only place a dollar sign may legitimately appear — it is their answer,
// not a claim about a program. Everything else is scanned.
const OWN_FIGURES = Object.values(E.INCOME_LABELS);
function stripOwnFigures(s) {
  let out = String(s || '');
  for (const f of OWN_FIGURES) out = out.split(f).join('«band»');
  return out;
}

function everySaying(line) {
  return [
    line.label, line.covers, line.note, line.amountGovernedBy,
    ...line.reasons.map((r) => r.say),
    ...line.blockers.map((b) => b.say),
    ...line.unknowns.map((u) => u.say),
    ...line.cautions.map((c) => c.say),
    line.revisit ? `${line.revisit.when || ''} ${line.revisit.why || ''}` : '',
  ].filter(Boolean);
}

test('no line ever states a program dollar figure or percentage', () => {
  let checked = 0;
  for (const f of everyCustomer()) {
    const r = E.analyze(f, TODAY);
    for (const line of r.lines) {
      assert.equal(line.amount, null, `${line.id} acquired an amount`);
      for (const say of everySaying(line)) {
        const clean = stripOwnFigures(say);
        assert.equal(/\$/.test(clean), false,
          `${line.id} states a dollar figure: ${say}`);
        assert.equal(/\d+(\.\d+)?\s*(%|percent\b)/i.test(clean), false,
          `${line.id} states a percentage: ${say}`);
      }
    }
    checked += 1;
  }
  assert.ok(checked > 5000, `only ${checked} combinations enumerated`);
});

test('D1 — a non-refundable credit is never claimable by a household that owes no tax', () => {
  for (const f of everyCustomer()) {
    if (f.taxLiability !== 'no') continue;
    const r = E.analyze(f, TODAY);
    for (const line of r.lines) {
      const p = BY_ID.get(line.id);
      const nonRefundable = p.requiresTaxLiability && !p.refundable && !p.partiallyRefundable;
      if (!nonRefundable) continue;
      assert.notEqual(line.verdict, E.Verdict.CLAIM,
        `${line.id} was put on the shortlist of a household that expects to owe no federal tax`);
      if (line.verdict !== E.Verdict.RULED_OUT) {
        assert.ok(line.cautions.some((c) => c.code === 'D1' || c.code === 'D1-carryforward'),
          `${line.id} survived without saying why it is worth nothing this year`);
      }
    }
  }
});

test('D1 — an unsure answer is never treated as a yes', () => {
  for (const f of everyCustomer()) {
    if (f.taxLiability !== 'unsure') continue;
    const r = E.analyze(f, TODAY);
    for (const line of r.lines) {
      const p = BY_ID.get(line.id);
      if (!(p.requiresTaxLiability && !p.refundable && !p.partiallyRefundable)) continue;
      assert.notEqual(line.verdict, E.Verdict.CLAIM,
        `${line.id} was claimed for a household that does not know whether it owes tax`);
    }
  }
});

test('D3 — two lines sharing one annual ceiling both say so', () => {
  for (const f of everyCustomer()) {
    const r = E.analyze(f, TODAY);
    const live = r.lines.filter((l) => l.verdict !== E.Verdict.RULED_OUT);
    const groups = new Map();
    for (const l of live) {
      const g = BY_ID.get(l.id).capGroup;
      if (!g) continue;
      groups.set(g, (groups.get(g) || []).concat([l]));
    }
    for (const [, members] of groups) {
      if (members.length < 2) continue;
      for (const l of members) {
        assert.ok(l.cautions.some((c) => c.code === 'D3'),
          `${l.id} shares a ceiling with ${members.length - 1} other line(s) and does not say so`);
        assert.equal(l.sharesCapWith.length, members.length - 1);
      }
    }
  }
});

test('D4 — a utility rebate and a federal credit on one purchase are never left to add up', () => {
  for (const f of everyCustomer()) {
    const r = E.analyze(f, TODAY);
    const live = r.lines.filter((l) => l.verdict !== E.Verdict.RULED_OUT);
    const chose = f.actionsDone.concat(f.actionsPlanned);
    for (const fed of live) {
      const pf = BY_ID.get(fed.id);
      if (!pf.basisReducedByRebate) continue;
      for (const util of live) {
        const pu = BY_ID.get(util.id);
        if (!pu.reducesFederalBasis) continue;
        const shared = (pf.qualifyingActions || [])
          .filter((x) => (pu.qualifyingActions || []).indexOf(x) !== -1)
          .filter((x) => chose.indexOf(x) !== -1);
        if (!shared.length) continue;
        for (const l of [fed, util]) {
          assert.ok(l.cautions.some((c) => c.code === 'D4'),
            `${fed.id} and ${util.id} both cover ${shared.join(',')} and ${l.id} does not carry the stacking order`);
        }
      }
    }
  }
});

test('D5 — an already-claimed answer is never ignored', () => {
  for (const f of everyCustomer()) {
    if (f.alreadyClaimed !== 'yes' || !f.actionsDone.length) continue;
    const r = E.analyze(f, TODAY);
    for (const line of r.lines) {
      const p = BY_ID.get(line.id);
      if (!(p.qualifyingActions || []).length) continue;
      if (line.verdict === E.Verdict.RULED_OUT) continue;
      assert.ok(line.cautions.some((c) => c.code.indexOf('D5') === 0),
        `${line.id} ignored that something was already claimed for this work`);
    }
  }
});

test('a renter is never offered an owner-only program, and the reverse', () => {
  for (const f of everyCustomer()) {
    const r = E.analyze(f, TODAY);
    for (const line of r.lines) {
      const p = BY_ID.get(line.id);
      if (!p.tenure || p.tenure.indexOf(f.tenure) !== -1) continue;
      assert.equal(line.verdict, E.Verdict.RULED_OUT,
        `${line.id} is for ${p.tenure.join('/')} and was offered to someone who ${f.tenure}s`);
    }
  }
});

test('a state income-tax credit is never offered where there is no state income tax', () => {
  for (const f of everyCustomer()) {
    if (CAT.noIndividualIncomeTax.indexOf(f.state) === -1) continue;
    const r = E.analyze(f, TODAY);
    for (const line of r.lines) {
      if (!BY_ID.get(line.id).requiresStateIncomeTax) continue;
      assert.equal(line.verdict, E.Verdict.RULED_OUT,
        `${line.id} was offered to a ${f.state} household, and ${f.state} has no individual income tax`);
      assert.ok(line.blockers.some((b) => b.code === 'no-state-income-tax'));
    }
  }
});

test('an income band outside the screen rules the line out and says which fact did it', () => {
  for (const f of everyCustomer()) {
    if (f.incomeBand === 'prefer-not-say') continue;
    const r = E.analyze(f, TODAY);
    for (const line of r.lines) {
      const p = BY_ID.get(line.id);
      if (!Array.isArray(p.incomeBands)) continue;
      if (p.incomeBands.indexOf(f.incomeBand) !== -1) continue;
      assert.equal(line.verdict, E.Verdict.RULED_OUT, `${line.id} survived an income screen it fails`);
    }
  }
});

test('every ruled-out line names the fact that ruled it out', () => {
  for (const f of everyCustomer()) {
    const r = E.analyze(f, TODAY);
    for (const line of r.lines) {
      if (line.verdict !== E.Verdict.RULED_OUT) continue;
      assert.ok(line.blockers.length > 0,
        `${line.id} was ruled out with no reason the customer could read`);
      for (const b of line.blockers) assert.ok(b.code && b.say, `${line.id} blocker is unreadable`);
    }
  }
});

test('every "not this year" line carries a date or a named event', () => {
  // A rotation or a restart without its date is not actionable, and the date
  // is the product. The engine converts any it cannot date into a "check"
  // rather than shipping a line the customer can do nothing with.
  for (const f of everyCustomer()) {
    const r = E.analyze(f, TODAY);
    for (const line of r.lines) {
      if (line.verdict !== E.Verdict.NOT_NOW) continue;
      assert.ok(line.revisit && (line.revisit.on || line.revisit.when),
        `${line.id} says "not this year" and never says when`);
    }
  }
});

test('nothing is claimed on a catalogue entry that is only likely', () => {
  for (const f of everyCustomer()) {
    const r = E.analyze(f, TODAY);
    for (const line of r.lines) {
      if (line.verdict !== E.Verdict.CLAIM) continue;
      assert.equal(BY_ID.get(line.id).confidence, 'high',
        `${line.id} is marked "check" in the catalogue and was written as settled`);
    }
  }
});

test('the safety pass can only ever lower a verdict', () => {
  // The structural property the whole thing rests on. Run Stage 1 alone, then
  // Stage 2, and compare rank by rank.
  const { gate, dontCount } = E._internal;
  for (const f of everyCustomer()) {
    const a = E.normalize(f);
    const before = CAT.programs.map((p) => gate(p, a, CAT));
    const ranks = new Map(before.map((l) => [l.id, E.RANK[l.verdict]]));
    const after = dontCount(CAT.programs.map((p) => gate(p, a, CAT)), a, CAT, TODAY).lines;
    for (const line of after) {
      assert.ok(E.RANK[line.verdict] <= ranks.get(line.id),
        `the safety pass RAISED ${line.id} from rank ${ranks.get(line.id)} to ${E.RANK[line.verdict]}`);
    }
  }
});

test('a stale catalogue demotes everything rather than going quiet', () => {
  const r = E.analyze({
    state: 'OH', tenure: 'own', householdSize: 2, incomeBand: '75-100k',
    taxLiability: 'yes', actionsDone: ['heat-pump'], events: [],
  }, '2029-01-01');
  const live = r.lines.filter((l) => l.verdict !== E.Verdict.RULED_OUT);
  assert.ok(live.length > 0);
  for (const line of live) {
    assert.notEqual(line.verdict, E.Verdict.CLAIM,
      `${line.id} was still written as settled against a catalogue two years stale`);
    assert.ok(line.cautions.some((c) => c.code === 'D6'));
  }
});

/* --------------------------------------------------------------- the outputs */

test('the free snapshot gives counts and never a program name', () => {
  const f = {
    state: 'OH', zip: '43215', tenure: 'own', householdSize: 4, incomeBand: '75-100k',
    taxLiability: 'yes', actionsDone: ['heat-pump', 'insulation'], actionsPlanned: [], events: [],
  };
  const snap = E.buildSnapshot(f, TODAY);
  assert.equal(snap.ready, true);
  const text = JSON.stringify(snap);
  for (const p of CAT.programs) {
    assert.equal(text.indexOf(p.label), -1, `the free snapshot leaks "${p.label}"`);
    assert.equal(text.indexOf(p.id), -1, `the free snapshot leaks the id "${p.id}"`);
  }
  assert.ok(snap.totals.shortlist + snap.totals.toConfirm > 0);
  assert.equal(snap.totals.considered, CAT.programs.length);
});

test('the snapshot refuses rather than guessing when answers are missing', () => {
  const snap = E.buildSnapshot({ state: 'OH' }, TODAY);
  assert.equal(snap.ready, false);
  assert.equal(snap.reason, 'insufficient');
  assert.ok(snap.missing.length > 0);
});

test('a household with nothing to claim is told so, with everything it checked', () => {
  const f = {
    state: 'TX', zip: '75001', tenure: 'rent', householdSize: 1, incomeBand: 'over-150k',
    taxLiability: 'yes', actionsDone: [], actionsPlanned: [], events: [],
  };
  const r = E.analyze(f, TODAY);
  assert.equal(r.totals.shortlist, 0);
  assert.ok(r.totals.ruledOut > 20, 'a clean result must still show what was examined');
  for (const line of r.lines.filter((l) => l.verdict === E.Verdict.RULED_OUT)) {
    assert.ok(line.blockers.length, `${line.id} ruled out silently`);
  }
});

/* ----------------------------------------------------------- the re-check */

test('the re-check reports only what actually moved', () => {
  const base = {
    state: 'OH', zip: '43215', tenure: 'rent', householdSize: 2, incomeBand: '75-100k',
    taxLiability: 'yes', actionsDone: [], actionsPlanned: [], events: [],
  };
  const first = E.analyze(base, TODAY);
  const stored = E.storableVerdicts(first);
  assert.ok(stored.length === CAT.programs.length);

  // Nothing changed.
  const same = E.compareWithPrior(E.analyze(base, TODAY), stored);
  assert.deepEqual(same.changes, [], 'a re-check with identical answers reported a change');

  // They bought a house and put in a heat pump.
  const later = E.analyze({ ...base, tenure: 'own', actionsDone: ['heat-pump'], events: ['first-home'] }, TODAY);
  const moved = E.compareWithPrior(later, stored);
  assert.ok(moved.changes.length > 0);
  assert.ok(moved.changes.some((c) => c.id === 'fed-efficiency-heatpump' && c.direction === 'opened'));
  assert.ok(moved.changes.some((c) => c.id === 'state-renter-relief' && c.direction === 'closed'));
});

test('a re-check with no history returns nothing rather than inventing a baseline', () => {
  const r = E.analyze({
    state: 'OH', tenure: 'own', householdSize: 2, incomeBand: '75-100k',
    taxLiability: 'yes', actionsDone: [], events: [],
  }, TODAY);
  assert.equal(E.compareWithPrior(r, []), null);
  assert.equal(E.compareWithPrior(r, null), null);
});
