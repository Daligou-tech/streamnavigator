'use strict';

// What the Contractor Estimate Audit finds, and — more importantly — what it
// refuses to claim.
//
// Two kinds of assertion here, and the second kind is the point of the file.
//
// The first checks that a known-bad estimate produces the findings it should.
// That is ordinary.
//
// The second checks the restraint. A published national cost range must never
// be presented as proof of overcharging; a statutory cap must never be applied
// in a state that has no statute; the federal three-day cancellation right must
// never be asserted for a sale it does not cover. Each of those is a sentence a
// homeowner repeats to a contractor's face, and being wrong costs them the
// argument and their credibility for the rest of the job. The engine that this
// one replaced could produce any of the three on any run, because a model was
// deciding.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runContractorAudit, CATALOG, checkCountFor, Severity, EvidenceKind, ImpactKind,
} = require('../api/_lib/contractor-audit');
const { pressuredHvac, twoRoofs, unreadableScrap } = require('./fixtures/contractor-fixtures');

function findings(result) {
  return result.findings;
}

function one(result, checkId) {
  const hits = result.findings.filter((f) => f.checkId === checkId);
  assert.equal(hits.length >= 1, true, `no finding from ${checkId}`);
  return hits[0];
}

function none(result, checkId) {
  assert.equal(result.findings.filter((f) => f.checkId === checkId).length, 0,
    `${checkId} produced a finding it should not have`);
}

// --- the catalogue itself ---------------------------------------------------

test('every check declares a label and an id, and no id repeats', () => {
  const ids = CATALOG.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate check id in the catalogue');
  assert.deepEqual(CATALOG.filter((c) => !c.label).map((c) => c.id), [],
    'a check has no label — the report would print a blank row in "checks that could not run"');
  assert.deepEqual(CATALOG.filter((c) => typeof c.needs !== 'function' || typeof c.run !== 'function').map((c) => c.id), [],
    'a check cannot be run or counted');
});

test('a check that can be skipped says what was missing', () => {
  // "Checks we could not run: the payment schedule adds up to the contract
  // price" tells the customer nothing. The reason is what tells them whether
  // sending one more page would have changed the answer.
  const result = runContractorAudit(unreadableScrap(), { state: 'OH', signedAtHome: false });
  const unexplained = result.skipped.filter((s) => !s.includes(' — '));
  assert.deepEqual(unexplained, [],
    'a skipped check reached the report without a reason beside it');
});

test('the count the page advertises is the count the catalogue can run', () => {
  // contractor.html prints these numbers. They come from here so that adding a
  // check without updating the page fails the build rather than shipping a
  // page that undersells.
  assert.equal(checkCountFor('HVAC'), 32);
  assert.equal(checkCountFor('Roofing'), 29);
  assert.equal(checkCountFor('Windows'), 28);
  assert.equal(checkCountFor('Plumbing'), 26);
  assert.equal(checkCountFor('Electrical'), 26);
  assert.equal(checkCountFor('Other'), 26);
});

test('the trade the customer picked wins over the one the extractor guessed', () => {
  // The old intake form pre-set HVAC in JavaScript with nothing on screen
  // saying so, and a roofer's quote was analysed as an HVAC job after they had
  // paid. Letting the extractor override the answer would be the same defect
  // with a better excuse. The model's classification fills the gap only when
  // the customer left one.
  const hvacDocs = pressuredHvac();
  assert.equal(runContractorAudit(hvacDocs, { state: 'CA', category: 'Roofing' }).category, 'Roofing');
  assert.equal(runContractorAudit(hvacDocs, { state: 'CA', category: 'Other' }).category, 'HVAC');
  assert.equal(runContractorAudit(hvacDocs, { state: 'CA' }).category, 'HVAC');
});

test('a trade-specific check is not counted against another trade', () => {
  // A roof check skipped on an HVAC estimate is not a check we failed to run,
  // it is a check that does not exist for that job. Counting it would make
  // every report look half finished and would trip the refund floor.
  const result = runContractorAudit(pressuredHvac(), { state: 'CA', homeSqft: 1850, signedAtHome: true });
  assert.equal(result.skipped.some((s) => /roof|window/i.test(s)), false,
    'a roofing or window check was reported as skipped on an HVAC estimate');
});

// --- the findings -----------------------------------------------------------

test('a line that does not multiply out is caught with both figures', () => {
  const f = one(runContractorAudit(pressuredHvac(), { state: 'CA' }), 'LINE_EXTENSIONS_CORRECT');
  assert.equal(f.severity, Severity.CONFIRMED_ERROR);
  assert.equal(f.evidence, EvidenceKind.DOCUMENT_ARITHMETIC);
  assert.equal(f.dollarImpact, 200);
  assert.match(f.basis, /2,320\.00/);
  assert.match(f.basis, /2,520\.00/);
});

test('a deposit over a statutory cap names the statute and the overage', () => {
  const f = one(runContractorAudit(pressuredHvac(), { state: 'CA' }), 'DEPOSIT_WITHIN_STATE_CAP');
  assert.equal(f.severity, Severity.EXCEEDS_LEGAL_LIMIT);
  assert.equal(f.evidence, EvidenceKind.STATUTE);
  assert.equal(f.impactKind, ImpactKind.OVER_LEGAL_CAP);
  assert.equal(f.dollarImpact, 3000);
  assert.match(f.citation, /7159\.5/);
});

test('a tax credit claim is measured against whether the credit still exists', () => {
  const f = one(runContractorAudit(pressuredHvac(), { state: 'CA' }), 'TAX_CREDIT_CLAIMS_STILL_VALID');
  assert.equal(f.severity, Severity.SALES_PRESSURE);
  assert.match(f.basis, /2025-12-31/);
  assert.match(f.citation, /25C/);
});

test('two quotes are compared on scope as well as on price', () => {
  const result = runContractorAudit(twoRoofs(), { state: 'FL', signedAtHome: false });
  const spread = one(result, 'QUOTES_COMPARED');
  assert.equal(spread.dollarImpact, 4500);
  assert.equal(spread.impactKind, ImpactKind.SPREAD);

  const apples = one(result, 'QUOTES_ARE_APPLES_TO_APPLES');
  assert.equal(apples.evidence, EvidenceKind.CROSS_QUOTE);
  // A $4,500 spread between an architectural tear-off and a 3-tab overlay is a
  // scope difference before it is a price difference, and the report has to say
  // which dimensions differ rather than leaving the customer to conclude that
  // the cheaper contractor is the better deal.
  assert.match(apples.basis, /tear-off or overlay/);
  assert.match(apples.basis, /warranty on labour/);
});

test('the clean quote in a two-quote comparison is not manufactured a problem', () => {
  const result = runContractorAudit(twoRoofs(), { state: 'FL', signedAtHome: false });
  const apexFlagged = result.findings.filter(
    (f) => f.quote === 'Quote 1' && f.severity !== Severity.WITHIN_NORMS && f.severity !== Severity.VERIFY_YOURSELF
  );
  assert.deepEqual(apexFlagged.map((f) => f.checkId), [],
    'the well-written estimate was flagged for something — the audit is inventing findings to look busy');
});

// --- restraint --------------------------------------------------------------

test('a statutory deposit cap is never applied in a state that has no statute', () => {
  // Ohio has no cap. Claiming one, in a sentence the homeowner is going to
  // repeat, is worse than saying nothing at all.
  const result = runContractorAudit(twoRoofs(), { state: 'OH', signedAtHome: false });
  none(result, 'DEPOSIT_WITHIN_STATE_CAP');
  const norm = one(result, 'DEPOSIT_AGAINST_NORM');
  assert.equal(norm.citation, null, 'a norm-based finding carried a statutory citation');
  assert.match(norm.basis, /no statutory maximum/);
});

test('exactly one of the two deposit checks ever runs, and neither is reported as skipped', () => {
  for (const state of ['CA', 'OH', 'NY']) {
    const result = runContractorAudit(twoRoofs(), { state, signedAtHome: false });
    const ran = result.findings.filter(
      (f) => f.checkId === 'DEPOSIT_WITHIN_STATE_CAP' || f.checkId === 'DEPOSIT_AGAINST_NORM'
    );
    assert.equal(ran.length > 0, true, `neither deposit check ran in ${state}`);
    assert.equal(new Set(ran.map((f) => f.checkId)).size, 1, `both deposit checks ran in ${state}`);
    assert.equal(result.skipped.some((s) => /deposit is within/i.test(s)), false,
      `${state} reported a deposit check as skipped when its sibling ran`);
  }
});

test('a published national range is never presented as proof of overcharging', () => {
  const f = one(runContractorAudit(pressuredHvac(), { state: 'CA' }), 'PRICE_AGAINST_PUBLISHED_RANGE');
  assert.equal(f.evidence, EvidenceKind.PUBLISHED_RANGE);
  assert.equal(f.impactKind, ImpactKind.ABOVE_PUBLISHED_RANGE,
    'a band overage must not be typed as an arithmetic discrepancy or a statutory overage — '
    + 'those are figures somebody owes, and this one is not');
  assert.match(f.basis, /A national range is not a local quote/);
  assert.match(f.recommendedAction, /second bid/);
});

test('a price inside the published range is not sold as a clean bill of health', () => {
  const result = runContractorAudit(twoRoofs(), { state: 'FL', signedAtHome: false });
  const inside = result.findings.filter((f) => f.checkId === 'PRICE_AGAINST_PUBLISHED_RANGE');
  assert.equal(inside.length, 2);
  for (const f of inside) {
    assert.equal(f.severity, Severity.WITHIN_NORMS);
    assert.match(f.basis, /not proof of a good\s+price/,
      'being inside a national range was reported as though it meant the price was good');
  }
});

test('the federal cancellation right is not asserted for a sale it does not cover', () => {
  const away = runContractorAudit(pressuredHvac(), { state: 'CA', signedAtHome: false });
  const f = one(away, 'RIGHT_TO_CANCEL_NOTICE');
  assert.equal(f.severity, Severity.VERIFY_YOURSELF);
  assert.match(f.title, /does not attach/);

  const atHome = runContractorAudit(pressuredHvac(), { state: 'CA', signedAtHome: true });
  assert.equal(one(atHome, 'RIGHT_TO_CANCEL_NOTICE').severity, Severity.EXCEEDS_LEGAL_LIMIT);

  // Unanswered is not "no". Guessing either way sends the homeowner into an
  // argument on a false premise, so the check declines to run and says so.
  const unknown = runContractorAudit(pressuredHvac(), { state: 'CA' });
  none(unknown, 'RIGHT_TO_CANCEL_NOTICE');
  assert.equal(unknown.skipped.some((s) => /three-day cancellation/.test(s)), true);
});

test('R-410A is reported as an outgoing platform, not as a violation', () => {
  const f = one(runContractorAudit(pressuredHvac(), { state: 'CA' }), 'HVAC_REFRIGERANT_GENERATION');
  assert.notEqual(f.severity, Severity.EXCEEDS_LEGAL_LIMIT,
    'installing remaining R-410A stock was never prohibited; calling it unlawful is a false accusation');
  assert.match(f.basis, /not a violation/);
  assert.match(f.recommendedAction, /discount/);
});

test('the federal efficiency minimum is the one for the customer\'s own region', () => {
  // 14.5 SEER2 clears the 13.4 minimum in the North and the 14.3 minimum in the
  // South. The same equipment passing in one state and failing in another is
  // the whole reason the intake asks for a state.
  const north = runContractorAudit(pressuredHvac(), { state: 'NY' });
  assert.equal(one(north, 'HVAC_MEETS_FEDERAL_EFFICIENCY').severity, Severity.WITHIN_NORMS);

  const low = pressuredHvac();
  low.quotes[0].hvac.seer2 = 13.8;
  assert.equal(one(runContractorAudit(low, { state: 'NY' }), 'HVAC_MEETS_FEDERAL_EFFICIENCY').severity,
    Severity.WITHIN_NORMS);
  const failing = one(runContractorAudit(low, { state: 'TX' }), 'HVAC_MEETS_FEDERAL_EFFICIENCY');
  assert.equal(failing.severity, Severity.EXCEEDS_LEGAL_LIMIT);
  assert.match(failing.basis, /Southeast/);
});

test('the sizing check needs the house, and says so rather than guessing', () => {
  const without = runContractorAudit(pressuredHvac(), { state: 'CA' });
  none(without, 'HVAC_SIZED_TO_THE_HOUSE');
  assert.equal(without.skipped.some((s) => /home size from the intake form/.test(s)), true);

  const with3000 = runContractorAudit(pressuredHvac(), { state: 'CA', homeSqft: 3000 });
  const f = one(with3000, 'HVAC_SIZED_TO_THE_HOUSE');
  assert.match(f.title, /undersized/);
  assert.match(f.recommendedAction, /Manual J/);
});

// --- coverage and the refund floor -----------------------------------------

test('a thin document produces low coverage rather than a confident short report', () => {
  const result = runContractorAudit(unreadableScrap(), { state: 'OH', signedAtHome: false });
  assert.equal(result.checksRun / result.checksTotal < 0.6, true,
    'a handwritten scrap with no legible total scored above the refund floor — the floor is not protecting anyone');
  assert.equal(result.findings.some((f) => f.dollarImpact), false,
    'a document with no readable price produced a dollar figure');
});

test('a well-formed estimate scores well above the refund floor', () => {
  for (const [fixture, ctx] of [
    [pressuredHvac(), { state: 'CA', homeSqft: 1850, signedAtHome: true }],
    [twoRoofs(), { state: 'FL', signedAtHome: false }],
  ]) {
    const result = runContractorAudit(fixture, ctx);
    assert.equal(result.checksRun / result.checksTotal > 0.8, true,
      `only ${result.checksRun}/${result.checksTotal} ran on a complete estimate — a paying customer would be `
      + 'refunded for a report that is actually fine');
  }
});

test('one broken check does not cost the customer the other thirty', () => {
  const broken = pressuredHvac();
  // A shape the extractor should never produce, which is exactly when this
  // matters: the odd document is the one that finds the crash.
  broken.quotes[0].line_items = [{ description: 'x', get amount() { throw new Error('boom'); } }];
  const result = runContractorAudit(broken, { state: 'CA', signedAtHome: true });
  assert.equal(findings(result).length > 15, true, 'a throwing check took the report down with it');
  assert.equal(result.skipped.some((s) => /could not be computed/.test(s)), true,
    'a check that threw was not reported as uncomputable');
});

test('every flagged finding carries the figures or the rule it rests on', () => {
  for (const [fixture, ctx] of [
    [pressuredHvac(), { state: 'CA', homeSqft: 1850, signedAtHome: true }],
    [twoRoofs(), { state: 'FL', signedAtHome: false }],
  ]) {
    const result = runContractorAudit(fixture, ctx);
    for (const f of result.findings) {
      assert.equal(typeof f.title === 'string' && f.title.length > 0, true, `${f.checkId} has no title`);
      assert.equal(typeof f.basis === 'string' && f.basis.length > 20, true,
        `${f.checkId} has no basis — a finding without its working is an assertion`);
      assert.ok(Object.values(Severity).includes(f.severity), `${f.checkId} has an unknown severity`);
      if (f.severity !== Severity.WITHIN_NORMS) {
        assert.equal(typeof f.recommendedAction === 'string' && f.recommendedAction.length > 0, true,
          `${f.checkId} flags a problem and does not say what to do about it`);
      }
    }
  }
});
