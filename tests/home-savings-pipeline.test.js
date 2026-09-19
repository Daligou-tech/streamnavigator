// The whole Home Savings pipeline, downstream of the model, against a document
// whose answers are known in advance.
//
// WHAT THIS PROVES AND WHAT IT DOES NOT.
//
// tests/home-savings-extract.test.js checks the classifier and the merge on
// inputs written to exercise them. This runs the real thing end to end:
// tests/fixtures/planted-home-savings.json is the transcription a correct
// reader would produce from the two PDFs that
// scripts/make-home-savings-documents.js writes, and every figure in those
// PDFs was chosen so the right answer is known before the run. Classification,
// the merge, all seven checks, the safety pass, the totals and the scorecard
// are all exercised against ground truth.
//
// WHAT IT CANNOT REACH: whether the extractor reads a real PDF correctly. That
// is one model call away and nothing offline can substitute for it. A live run
// was staged on production on 2026-09-19 — the intake and the sufficiency gate
// were confirmed against the deployed build — and generation was never started,
// so extraction-from-a-real-document is Unable to verify. It is labelled that
// way here rather than assumed working.
//
// The traps are the point. Three of the lines on those bills look exactly like
// findings and must never become one: two mandatory fees and a credit. A
// classifier that gets any of them wrong sends a customer to spend twenty
// minutes losing an argument on the phone.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const X = require('../api/_lib/home-savings-extract');
const ENGINE = require('../navigator-home-savings-engine');

const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'planted-home-savings.json'), 'utf8'
));
const TRUTH = FIXTURE._groundTruth;
const TODAY = new Date(2026, 8, 19); // 2026-09-19, the date the bills were written for

// The one pipeline, run once, exactly as api/_lib/navigator-engine.js runs it.
const extraction = X.normalizeExtraction(FIXTURE);
const merged = X.merge(FIXTURE._typedByCustomer, extraction);
const analysis = ENGINE.analyze({ bills: merged.bills }, {
  today: TODAY,
  openQuestions: merged.newQuestions,
  disagreements: merged.disagreements,
});
const block = ENGINE.toAuditBlock(analysis);
const scorecard = ENGINE.buildScorecard(analysis);

const findingFor = (id) => analysis.findings.filter((f) => f.checkId === id)[0];
const allText = JSON.stringify(block);

/* ------------------------------------------------------------ the findings */

test('the confirmed total is exactly the planted figure', () => {
  assert.equal(analysis.totals.confirmedAnnual, TRUTH.confirmedAnnual,
    'every confirmed dollar in this report is arithmetic on a line printed in the fixture');
});

test('H1 finds the gateway rental and prices it from the bill', () => {
  const t = TRUTH.findings.H1;
  const f = findingFor('H1');
  assert.ok(f, 'the equipment rental must be found');
  assert.equal(f.bill, t.bill);
  assert.equal(f.amount, t.annual);
  assert.equal(f.kind, t.kind);
  assert.equal(f.action, t.action);
  assert.match(f.basis, /Read from your statement: "Equipment Rental - Wireless Gateway" \$15\.00/);
  assert.ok(f.offset && f.offset.low > 0, 'and states the purchase it requires');
});

test('H3 reads "Payment 24 of 24" and needs nobody to remember it', () => {
  const t = TRUTH.findings.H3;
  const f = findingFor('H3');
  assert.ok(f, 'a completed agreement still being billed must be found');
  assert.equal(f.bill, t.bill);
  assert.equal(f.amount, t.annual);
  assert.equal(f.kind, t.kind);
  // The customer never answered devicePaidOff. The statement did.
  assert.equal(FIXTURE._typedByCustomer[1].devicePaidOff, undefined);
  assert.equal(merged.bills[1].devicePaidOff, true);
  assert.match(f.step, /credited back/);
});

test('H2 dates the promotion and never counts it', () => {
  const t = TRUTH.findings.H2;
  const f = findingFor('H2');
  assert.equal(f.kind, t.kind);
  assert.equal(f.amount, 0, 'a promotion ending is a rise, not a saving');
  assert.equal(f.exposureAnnual, t.exposureAnnual);
  assert.equal(analysis.totals.promoExposureAnnual, t.exposureAnnual);
  assert.equal(f.actOn, '2026-11-01', 'a month before it ends');
  assert.match(f.basis, /Read from your statement/);
});

test('H6 passes on the bill that has the discount and asks on the one that does not', () => {
  const xfinity = analysis.findings.filter((f) => f.checkId === 'H6' && f.bill === 'Xfinity')[0];
  assert.ok(xfinity, 'Xfinity prints no autopay discount, so the question is raised');
  assert.equal(xfinity.amount, 0, 'and carries no figure, because we do not know what theirs is worth');

  const verizon = analysis.findings.filter((f) => f.checkId === 'H6' && f.bill === 'Verizon')[0];
  assert.equal(verizon, undefined, 'Verizon has one — the check ran and passed');
  assert.equal(merged.bills[1].autopayDiscount, true);
  assert.ok(!analysis.couldNotRun.some((c) => c.checkId === 'H6' && c.bill === 'Verizon'),
    'and it counts as run, not as a gap');
});

/* --------------------------------------------------------------- the traps */

test('TRAP: no mandatory fee or credit is ever presented as droppable', () => {
  for (const trap of TRUTH.traps) {
    assert.ok(!allText.includes(trap),
      `"${trap}" reached the report. It is mandatory or a credit, and a customer sent to `
      + `cancel it comes back knowing the report was guessing.`);
  }
});

test('TRAP: the mandatory fees are classified, not merely absent by luck', () => {
  const xfinityLines = extraction.bills[0].lineItems;
  const byLabel = (l) => xfinityLines.filter((li) => li.label === l)[0];
  assert.equal(byLabel('Broadcast TV Fee').category, X.Category.TAX_OR_FEE);
  assert.equal(byLabel('Regional Sports Fee').category, X.Category.TAX_OR_FEE);
  assert.equal(byLabel('Equipment Return Credit').category, X.Category.CREDIT);
  assert.notEqual(byLabel('Equipment Return Credit').category, X.Category.EQUIPMENT,
    'it contains the word "equipment" and is money in the customer\'s favour');
});

/* ----------------------------------------------------- questions, not findings */

test('an add-on on the bill the customer never named is a question', () => {
  for (const label of TRUTH.questionsNotFindings) {
    const q = merged.newQuestions.filter((n) => n.label === label)[0];
    assert.ok(q, `"${label}" must be raised as a question`);
    assert.equal(q.checkId, 'H4');
    assert.match(q.question, /Do you use it\?$/);
  }
  assert.equal(findingFor('H4'), undefined,
    'an add-on on the statement is not an add-on the customer wants rid of');
});

test('no question ever reaches a total', () => {
  const questionMoney = merged.newQuestions.reduce((s, q) => s + (q.monthly || 0), 0);
  assert.ok(questionMoney > 0, 'the fixture does carry unanswered money');
  assert.equal(analysis.totals.confirmedAnnual, TRUTH.confirmedAnnual,
    'and none of it is in the confirmed figure');
});

/* ------------------------------------------------------------ disagreements */

test('where the form and the statement disagree, the statement wins and it is said', () => {
  const fields = merged.disagreements.map((d) => d.field).sort();
  assert.deepEqual(fields, TRUTH.disagreements.slice().sort());

  // The customer typed $75 and said they rent nothing.
  assert.equal(merged.bills[0].monthly, 89, 'the bill is right about the total');
  assert.equal(merged.bills[0].equipmentRental, true, 'and about the equipment');
  assert.equal(block.disagreements.length, 2, 'and the writer is told to report both');
});

/* ------------------------------------------------------------- the write-up */

test('every finding handed to the writer is checkable by the customer in ten seconds', () => {
  for (const f of block.findings) {
    assert.ok(f.checkId && f.basis && f.step);
    assert.ok(['confirmed', 'at_risk', 'unpriced', 'none'].includes(f.savingKind));
    if (f.savingKind === 'confirmed') {
      assert.match(f.basis, /Read from your statement/,
        `${f.checkId} counts money without quoting the line it came from`);
    }
  }
});

test('the scorecard reports the documents were read, because they were', () => {
  assert.equal(analysis.documentsRead, true);
  assert.match(scorecard.headline, /from the lines printed on your statements/);
  assert.equal(scorecard.confirmedAnnual, TRUTH.confirmedAnnual);
  assert.equal(scorecard.promoExposureAnnual, 180);
});

test('the report never claims to know a market rate', () => {
  const forbidden = /above market|below market|market rate|typically costs|usually costs|overpaying/i;
  assert.doesNotMatch(allText, forbidden,
    'this product holds no price data and nothing it emits may imply otherwise');
});

/* ------------------------------------------------------ the honest limitation */

test('UNABLE TO VERIFY OFFLINE: that the extractor reads a real PDF correctly', () => {
  // Deliberately a passing test with a body that documents the gap, so the
  // limitation is in the suite output rather than only in a comment somebody
  // has to go and find. Everything above runs on a hand-written transcription;
  // whether the model produces that transcription from
  // tmp-home-savings-docs/*.pdf needs one live run.
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', 'make-home-savings-documents.js')),
    'the documents that would settle it are generated by this script');
  assert.equal(FIXTURE._documents.length, 2);
});
