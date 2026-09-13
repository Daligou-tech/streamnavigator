'use strict';

// The email is the part the customer actually sends, under their own name, to
// someone who is about to be standing on their roof.
//
// So the assertions here are about voice and restraint before they are about
// content. A letter that accuses is worse than no letter: the homeowner loses
// the argument they were winning, and then has to work with this person for
// three weeks anyway.
//
// The specific failure this file was written after: the audit's `basis` field
// is addressed to the homeowner — "you told us this was quoted at your home",
// "if your contractor does not pay their supplier" — and pasting it unedited
// into an email addressed to that contractor reads as though somebody else
// wrote the letter. Which somebody else did, and the whole point is that it
// should not show.

const test = require('node:test');
const assert = require('node:assert/strict');

const { runContractorAudit, Severity } = require('../api/_lib/contractor-audit');
const { buildContractorEmails, renderContractorEmails, LEAD_IN } = require('../api/_lib/contractor-emails');
const { pressuredHvac, twoRoofs } = require('./fixtures/contractor-fixtures');

function emailsFor(fixture, ctx) {
  const audited = runContractorAudit(fixture, ctx);
  return { audited, emails: buildContractorEmails(audited.findings, { quotes: fixture.quotes }) };
}

test('one email per contractor with something to ask, and none for the others', () => {
  const fixture = twoRoofs();
  const { emails } = emailsFor(fixture, { state: 'FL', signedAtHome: false });
  assert.equal(emails.length, 1,
    'a letter was drafted to the contractor whose estimate was clean — that spends the customer\'s credibility '
    + 'on nothing, and it is the reason a form letter gets treated as a form letter');
  assert.equal(emails[0].to, 'Beacon Exteriors');
});

test('the letter asks and never alleges', () => {
  const { emails } = emailsFor(pressuredHvac(), { state: 'CA', homeSqft: 1850, signedAtHome: true });
  const body = emails[0].body;
  const accusations = [
    /you overcharged/i,
    /you are (overcharging|breaking|violating)/i,
    /this is illegal/i,
    /\bfraud/i,
    /\bscam/i,
    /you must\b/i,
  ];
  for (const pattern of accusations) {
    assert.equal(pattern.test(body), false, `the drafted email accuses rather than asks: ${pattern}`);
  }
  assert.match(body, /It is entirely possible I have misread something/);
});

test('nothing addressed to the homeowner leaks into a letter addressed to the contractor', () => {
  for (const [fixture, ctx] of [
    [pressuredHvac(), { state: 'CA', homeSqft: 1850, signedAtHome: true }],
    [twoRoofs(), { state: 'FL', signedAtHome: false }],
  ]) {
    const { emails } = emailsFor(fixture, ctx);
    for (const email of emails) {
      // "you told us", "your contractor", "we" — all correct in the report and
      // all wrong in a letter the homeowner signs.
      assert.equal(/you told us/i.test(email.body), false, 'the letter quotes the intake form back at the contractor');
      assert.equal(/your contractor/i.test(email.body), false,
        'the letter refers to the reader in the third person, which is how it reads as a template');
      assert.equal(/\bStreamNavigator\b/.test(email.body), false,
        'the letter names us; it is the customer\'s letter and we are not a party to it');
    }
  }
});

test('the paperwork asks arrive as one point, not as seven', () => {
  const { emails } = emailsFor(pressuredHvac(), { state: 'CA', homeSqft: 1850, signedAtHome: true });
  const body = emails[0].body;
  const numbered = body.split('\n').filter((l) => /^\d+\. /.test(l));
  assert.ok(numbered.length <= 12,
    `${numbered.length} numbered points — a contractor stops reading at four and answers none of them`);
  assert.match(body, /things I would like written into the contract before I sign:/);
});

test('the money questions come before the paperwork ones', () => {
  const { emails } = emailsFor(pressuredHvac(), { state: 'CA', homeSqft: 1850, signedAtHome: true });
  const body = emails[0].body;
  const arithmetic = body.indexOf('does not multiply out');
  const deposit = body.indexOf('above the limit my state sets');
  const price = body.indexOf('above the published national ranges');
  const paperwork = body.indexOf('written into the contract');

  assert.ok(arithmetic > -1 && deposit > -1 && price > -1 && paperwork > -1,
    'a point the ranking is asserted about is missing from the draft entirely');
  assert.ok(arithmetic < deposit, 'the arithmetic error should be raised first — it gets conceded, not argued');
  assert.ok(deposit < price, 'a statute outranks a comparison against a published average');
  assert.ok(price < paperwork, 'the price question was pushed below a list of contract amendments');
});

test('a point held out of the draft is counted, not silently dropped', () => {
  const { audited, emails } = emailsFor(pressuredHvac(), { state: 'CA', homeSqft: 1850, signedAtHome: true });
  const email = emails[0];
  const flagged = audited.findings.filter((f) => f.severity !== Severity.WITHIN_NORMS);
  assert.ok(email.heldBack > 0, 'this fixture is meant to overflow the cap; the assertion below is not exercised');
  assert.ok(email.pointCount + email.heldBack <= flagged.length,
    'the draft claims more points than the audit found');
  // The report page prints heldBack. A customer who counts fourteen findings
  // and ten points has to be told the four were a decision.
  const reportPage = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'contractor-report.html'), 'utf8');
  assert.match(reportPage, /heldBack/,
    'the page never shows how many points were left out of the draft');
});

test('every check that can produce a sendable finding has a sentence written for it', () => {
  // A missing lead-in falls back to a neutral one rather than dropping the
  // point, which is the right failure — but a neutral "could you help me with
  // this one?" in place of a specific question is a worse letter, so the gap is
  // caught here rather than shipped.
  const { CATALOG } = require('../api/_lib/contractor-audit');
  const { NOT_SENT_BY_DESIGN } = require('../api/_lib/contractor-emails');
  const missing = CATALOG.map((c) => c.id)
    .filter((id) => !NOT_SENT_BY_DESIGN.has(id))
    .filter((id) => !LEAD_IN[id]);
  assert.deepEqual(missing, [],
    'these checks have no sentence written for the email and would fall back to a generic one:\n  '
    + missing.join('\n  '));
});

test('the plain-text rendering carries every letter', () => {
  const fixture = pressuredHvac();
  const { emails } = emailsFor(fixture, { state: 'CA', homeSqft: 1850, signedAtHome: true });
  const text = renderContractorEmails(emails);
  for (const email of emails) {
    assert.ok(text.includes(email.subject), 'a subject line vanished from the plain-text rendering');
    assert.ok(text.includes(email.body.slice(0, 60)), 'a letter body vanished from the plain-text rendering');
  }
});

test('the contractor report reaches the PDF builder in a shape it understands', () => {
  const { toGenericReportShape } = require('../api/_lib/contractor-report-view');
  const fixture = pressuredHvac();
  const audited = runContractorAudit(fixture, { state: 'CA', homeSqft: 1850, signedAtHome: true });
  const emails = buildContractorEmails(audited.findings, { quotes: fixture.quotes });

  const shaped = toGenericReportShape({
    category: audited.category,
    headline: 'Four things to settle before you sign.',
    summary: 'Summary.',
    do_first: ['Do the first thing'],
    coverage: { checks_run: audited.checksRun, checks_total: audited.checksTotal, could_not_run: audited.skipped },
    quotes: fixture.quotes,
    findings: audited.findings,
    emails,
    unreadable: [],
  });

  assert.ok(Array.isArray(shaped.sections) && shaped.sections.length > 3);
  assert.ok(Array.isArray(shaped.key_numbers) && shaped.key_numbers.length >= 2);
  assert.ok(shaped.emails.length === emails.length && shaped.emails[0].email.body);

  // The headline figure must not sum a published-range distance into money the
  // customer is owed. $4,650 above a national band is not $4,650 anybody owes.
  const disputed = shaped.key_numbers.find((n) => /Arithmetic and statutory/.test(n.label));
  assert.ok(disputed, 'the money figure disappeared from the PDF headline numbers');
  assert.equal(/4,650/.test(disputed.value), false,
    'a published-range distance was summed into the figure labelled as arithmetic and statutory difference');
  assert.match(disputed.value, /3,200/,
    'expected the $200 line error plus the $3,000 statutory overage, and nothing else');
});
