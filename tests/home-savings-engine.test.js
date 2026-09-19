// Home Savings Navigator — the behavioural contract.
//
// Before this file existed, /home-savings was the only priced Navigator with
// no test of its output at all. It could not have had one: there was nothing
// deterministic to assert on, only a 201-word prompt and a paid model call.
// See docs/HOME-SAVINGS-AUDIT.md.
//
// The assertions that matter most here are the refusals. An engine graded on
// the size of its headline total drifts, every time, towards counting things
// that are not money and recommending changes that cost the customer more than
// they save. Each of those is an invariant over arbitrary input, not a branch.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const E = require('../navigator-home-savings-engine');

const TODAY = new Date(2026, 8, 19); // 2026-09-19
const run = (bills) => E.analyze({ bills }, { today: TODAY });
const findingFor = (a, checkId) => a.findings.filter((f) => f.checkId === checkId)[0];

/* --------------------------------------------------------------- the checks */

test('every check in the catalog has a distinct id and a runner', () => {
  const ids = E.CHECKS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate check id');
  assert.equal(E.CHECK_COUNT, E.CHECKS.length);
  for (const c of E.CHECKS) {
    assert.ok(c.slug && c.label, `${c.id} is missing a slug or label`);
    assert.equal(typeof c.applies, 'function', `${c.id} has no applies()`);
  }
});

test('an equipment rental is priced from the fee on the bill, with the offset named', () => {
  const a = run([{ kind: 'internet', provider: 'Xfinity', monthly: 89, equipmentRental: true, equipmentFee: 15 }]);
  const f = findingFor(a, 'H1');
  assert.equal(f.action, 'replace');
  assert.equal(f.kind, 'confirmed');
  assert.equal(f.amount, 180);
  assert.ok(f.offset && f.offset.low > 0, 'a purchase is required and must be stated');
  assert.match(f.why.join(' '), /pays for itself/);
});

test('an unpriced finding still appears and is never given a figure', () => {
  const a = run([{ kind: 'internet', provider: 'Xfinity', monthly: 89, equipmentRental: true }]);
  const f = findingFor(a, 'H1');
  assert.equal(f.kind, 'unpriced');
  assert.equal(f.amount, 0);
  assert.equal(a.totals.confirmedAnnual, 0, 'an unpriced finding must not reach the total');
  assert.equal(a.totals.unpricedFindings, 1);
  assert.doesNotMatch(JSON.stringify(f), /\$\d/, 'no figure may be invented for an unpriced line');
});

test('a device instalment only counts once the customer says it is paid off', () => {
  const still = run([{ kind: 'mobile', provider: 'Verizon', monthly: 120, deviceInstalment: true, devicePaidOff: false, deviceFee: 27.08 }]);
  assert.equal(findingFor(still, 'H3'), undefined, 'an unpaid device is not a finding');

  const done = run([{ kind: 'mobile', provider: 'Verizon', monthly: 120, deviceInstalment: true, devicePaidOff: true, deviceFee: 27.08 }]);
  const f = findingFor(done, 'H3');
  assert.equal(f.kind, 'confirmed');
  assert.equal(f.amount, 324.96);
  assert.match(f.step, /credited back/, 'the months already overbilled are worth asking for');
});

test('a year-on-year fall is reported as a pass, not padded into a finding', () => {
  const a = run([{ kind: 'electric', provider: 'ConEd', monthly: 90, lastYearMonthly: 110 }]);
  const f = findingFor(a, 'H7');
  assert.equal(f.withinNorms, true);
  assert.equal(f.kind, 'none');
  assert.equal(a.totals.confirmedAnnual, 0);
  assert.equal(a.totals.increaseAnnual, 0);
});

/* ------------------------------------------------------------- the refusals */

test('REFUSAL: a promotional rate is never counted as a saving', () => {
  const a = run([{
    kind: 'internet', provider: 'Xfinity', monthly: 35,
    promoRate: true, promoEndsOn: '2026-12-01', standardRate: 89,
  }]);
  const f = findingFor(a, 'H2');
  assert.equal(f.kind, 'at_risk');
  assert.equal(f.amount, 0, 'a promotion ending is a rise, not a saving');
  assert.equal(a.totals.confirmedAnnual, 0);
  assert.equal(a.totals.promoExposureAnnual, 648, 'the exposure is reported separately');
  assert.match(f.action, /watch/);
  assert.ok(f.actOn, 'a dated finding must carry the date to act on');
});

test('REFUSAL: cover the customer relies on is never a recommendation to drop it', () => {
  const a = run([{
    kind: 'insurance', provider: 'Allstate', monthly: 142,
    duplicateCoverage: true, duplicateFee: 8, reliesOnCoverage: true,
  }]);
  const f = findingFor(a, 'H5');
  assert.equal(f.action, 'review');
  assert.equal(f.blockedRuleId, 'S1');
  assert.equal(f.amount, 0);
  assert.equal(a.totals.confirmedAnnual, 0, 'a blocked finding must not reach the total');
  assert.match(f.why.join(' '), /rarely identical|rely on/);
});

test('REFUSAL: the same finding DOES count when they do not rely on it', () => {
  const a = run([{
    kind: 'insurance', provider: 'Allstate', monthly: 142,
    duplicateCoverage: true, duplicateFee: 8, reliesOnCoverage: false,
  }]);
  const f = findingFor(a, 'H5');
  assert.equal(f.action, 'stop');
  assert.equal(f.kind, 'confirmed');
  assert.equal(a.totals.confirmedAnnual, 96);
});

test('INVARIANT: the safety pass can only ever downgrade, never raise', () => {
  // Every combination of the answers that drive a safety rule, against every
  // bill kind. A safety pass that ever produced a MORE aggressive action than
  // the base decision would be a bug that no single example would catch.
  const RANK = { review: 0, watch: 1, call: 2, replace: 3, stop: 4 };
  let checked = 0;
  for (const kind of Object.keys(E.BILL_KINDS)) {
    for (const promoRate of [true, false, null]) {
      for (const relies of [true, false, null]) {
        const bill = {
          kind, provider: 'Test Co', monthly: 100,
          equipmentRental: true, equipmentFee: 15,
          deviceInstalment: true, devicePaidOff: true, deviceFee: 20,
          duplicateCoverage: true, duplicateFee: 8, reliesOnCoverage: relies,
          addOns: [{ label: 'Add-on', monthly: 6 }],
          autopayDiscount: false, promoRate, lastYearMonthly: 80,
        };
        for (const f of run([bill]).findings) {
          checked += 1;
          if (!f.provisionalAction) continue;
          assert.ok(RANK[f.action] <= RANK[f.provisionalAction],
            `${kind}/${promoRate}/${relies}: ${f.checkId} was raised from `
            + `${f.provisionalAction} to ${f.action}`);
        }
      }
    }
  }
  assert.ok(checked > 100, `only ${checked} findings exercised`);
});

test('INVARIANT: confirmedAnnual only ever contains confirmed findings', () => {
  for (const kind of Object.keys(E.BILL_KINDS)) {
    for (const promoRate of [true, false, null]) {
      const a = run([{
        kind, provider: 'Test Co', monthly: 100, promoRate,
        equipmentRental: true, equipmentFee: 15,
        duplicateCoverage: true, duplicateFee: 8, reliesOnCoverage: true,
        addOns: [{ label: 'Add-on' }], autopayDiscount: false, lastYearMonthly: 70,
      }]);
      const sum = a.findings
        .filter((f) => f.kind === 'confirmed')
        .reduce((s, f) => s + f.amount, 0);
      assert.equal(a.totals.confirmedAnnual, Math.round(sum * 100) / 100,
        `${kind}/${promoRate}: total disagrees with its own confirmed findings`);
    }
  }
});

test('INVARIANT: the two exposure figures are never summed into one', () => {
  // A bill can be both on a promotion AND up on last year. $74 -> $89 -> $104
  // is one bill with two different $180 figures, and adding them would be a
  // number the customer cannot reconstruct from their own statement.
  const a = run([{
    kind: 'internet', provider: 'Xfinity', monthly: 89, lastYearMonthly: 74,
    promoRate: true, promoEndsOn: '2026-12-01', standardRate: 104,
  }]);
  assert.equal(a.totals.promoExposureAnnual, 180);
  assert.equal(a.totals.increaseAnnual, 180);
  assert.equal(a.totals.confirmedAnnual, 0, 'neither is a saving');
  const s = E.buildScorecard(a);
  assert.equal(s.promoExposureAnnual, 180);
  assert.equal(s.increaseAnnual, 180);
  assert.ok(!('atRiskExposureAnnual' in s), 'the merged figure must not come back');
});

test('an autopay discount question never carries a figure', () => {
  const a = run([{ kind: 'gym', provider: 'Planet Fitness', monthly: 40, autopayDiscount: false }]);
  const f = findingFor(a, 'H6');
  assert.equal(f.kind, 'at_risk');
  assert.equal(f.amount, 0);
  assert.match(f.why.join(' '), /do not know whether yours does/);
});

/* ------------------------------------------------------------- the coverage */

test('a check that applies but was not answered is named, not silently passed', () => {
  const a = run([{ kind: 'internet', provider: 'Xfinity', monthly: 89 }]);
  assert.equal(a.findings.length, 0);
  const slugs = a.couldNotRun.map((c) => c.checkId).sort();
  assert.deepEqual(slugs, ['H1', 'H2', 'H4', 'H6', 'H7'],
    'every applicable check with no answer must appear in couldNotRun');
});

test('an empty add-on answer counts as a check that ran', () => {
  const asked = run([{ kind: 'internet', provider: 'X', monthly: 89, addOns: [] }]);
  assert.ok(!asked.couldNotRun.some((c) => c.checkId === 'H4'), 'an empty array is an answer');

  const notAsked = run([{ kind: 'internet', provider: 'X', monthly: 89 }]);
  assert.ok(notAsked.couldNotRun.some((c) => c.checkId === 'H4'), 'null is not an answer');
});

test('a clean scorecard says so plainly rather than manufacturing concern', () => {
  const a = run([{
    kind: 'electric', provider: 'ConEd', monthly: 90,
    promoRate: false, autopayDiscount: true, lastYearMonthly: 95,
  }]);
  const s = E.buildScorecard(a);
  assert.equal(s.confirmedAnnual, 0);
  assert.equal(s.nothingFound, true);
  assert.match(s.headline, /found nothing you should stop paying for/);
  assert.match(s.headline, /free/);
});

/* ----------------------------------------------------------- the sufficiency */

test('a submission with no document is refused, whatever else it carries', () => {
  const r = E.checkSufficiency({
    bills: [{ kind: 'internet', provider: 'Xfinity', monthly: 89, promoRate: true }],
  }, 0);
  assert.equal(r.sufficient, false);
  assert.ok(r.missing.some((m) => m.key === 'files'),
    'requiresFiles is enforced after payment in navigator-engine.js — it must be '
    + 'enforced before payment here');
});

test('a submission with a document but no named bill is refused', () => {
  const r = E.checkSufficiency({ bills: [{ kind: 'internet', monthly: 89 }] }, 1);
  assert.equal(r.sufficient, false);
  assert.ok(r.missing.some((m) => m.key === 'bills'));
});

test('a submission where no question was answered at all is refused', () => {
  const r = E.checkSufficiency({ bills: [{ kind: 'internet', provider: 'Xfinity', monthly: 89 }] }, 1);
  assert.equal(r.sufficient, false);
  assert.ok(r.missing.some((m) => m.key === 'answers'));
});

test('a submission with no price on any bill is refused', () => {
  const r = E.checkSufficiency({
    bills: [{ kind: 'internet', provider: 'Xfinity', promoRate: false }],
  }, 1);
  assert.equal(r.sufficient, false);
  assert.ok(r.missing.some((m) => m.key === 'monthly'));
});

test('a complete submission passes', () => {
  const r = E.checkSufficiency({
    bills: [{ kind: 'internet', provider: 'Xfinity', monthly: 89, promoRate: false }],
  }, 1);
  assert.deepEqual(r.missing, []);
  assert.equal(r.sufficient, true);
});

test('the page and the server gate on the same function', () => {
  const page = fs.readFileSync(path.join(ROOT, 'home-savings-intake.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'api', 'navigator-intake.js'), 'utf8');
  assert.match(page, /E\.checkSufficiency/, 'the page must gate its button on the engine');
  assert.match(server, /checkHomeSavingsSufficiency\(formData, attachmentCount\)/,
    'the endpoint must run the same check');
  assert.match(server, /require\('\.\.\/navigator-home-savings-engine'\)/);
});

/* ----------------------------------------------------------- the audit block */

test('every finding handed to the writer carries a checkId and a saving kind', () => {
  const a = run([
    { kind: 'internet', provider: 'Xfinity', monthly: 89, equipmentRental: true, equipmentFee: 15, promoRate: true, promoEndsOn: '2026-12-01', standardRate: 104 },
    { kind: 'mobile', provider: 'Verizon', monthly: 120, deviceInstalment: true, devicePaidOff: true, deviceFee: 27.08 },
  ]);
  const block = E.toAuditBlock(a);
  assert.ok(block.findings.length >= 3);
  for (const f of block.findings) {
    assert.ok(f.checkId, 'the output ceiling counts checkIds');
    assert.ok(['confirmed', 'at_risk', 'unpriced', 'none'].includes(f.savingKind));
    assert.ok(f.basis, 'every finding states what it rests on');
    assert.ok(f.step, 'every finding states what to do');
  }
  assert.equal(block.checkCount, E.CHECK_COUNT);
});
