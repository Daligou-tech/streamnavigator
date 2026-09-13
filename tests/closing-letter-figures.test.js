// What the customer actually signs and sends.
//
// The letters are the most consequential thing this product emits. A finding
// that is merely wrong in the report is an embarrassment; the same finding in
// the letter is the customer putting their name to it and sending it to the
// institution funding their mortgage. They get roughly one of these letters'
// worth of a lender's attention.
//
// This builds them from tests/fixtures/planted-purchase-va.json — a document
// whose right answers are known — and checks the figures that come out. It
// exists because check 29 shipped with its rate in the money fields, and the
// letter duly said "Charged $6.88; the figure I get is $6.50 — a difference of
// $0.38." Every unit test passed. Nothing looked at the letter.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runDocumentAudit } = require('../api/_lib/closing-service');
const { buildEmails } = require('../api/_lib/closing-emails');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'planted-purchase-va.json'), 'utf8'
));

function letters() {
  const { findings } = runDocumentAudit({
    extraction: fixture.extraction,
    answers: fixture.answers,
    loanEstimates: fixture.loanEstimates,
  });
  return buildEmails(findings, {
    propertyAddress: fixture.extraction.property_address,
    closingDate: fixture.extraction.closing_date,
    borrowerName: 'Alex Rivera and Sam Rivera',
    lenderName: fixture.extraction.lender_name,
    settlementName: fixture.extraction.settlement_agent_name,
  });
}

test('the lender letter carries the two real dollar findings, with the right figures', () => {
  const body = letters().lender.body;
  // $795 -> $1,095 on a zero-tolerance charge.
  assert.match(body, /Charged \$1,095\.00; the figure I get is \$795\.00 — a difference of \$300\.00/);
  // 22 days billed where the closing date supports 16.
  assert.match(body, /Charged \$1,243\.15; the figure I get is \$904\.11 — a difference of \$339\.04/);
  assert.match(body, /6 days more than the 16 I make it/);
});

test('the rate finding appears, and is not priced', () => {
  const body = letters().lender.body;
  const item = body.split(/\n(?=\d+\. )/).find((s) => /interest rate/i.test(s));
  assert.ok(item, 'the rate check sets askLender, so it must reach the letter');

  assert.match(item, /a rise of 0\.375 percentage points/);
  assert.ok(!/\$/.test(item.split('\n').slice(0, 3).join('\n')),
    'a rate must never be rendered as money in the letter');
});

test('no letter item quotes a figure under a dollar', () => {
  // The general form of the bug. A sub-dollar figure in a letter to a lender is
  // always either a rate, a percentage or a unit count that has been run
  // through money() — never a real finding worth raising.
  for (const letter of Object.values(letters())) {
    if (!letter || !letter.body) continue;
    const matches = letter.body.match(/\$0\.\d\d\b/g) || [];
    assert.deepEqual(matches, [], `${letter.subject} quotes ${matches.join(', ')}`);
  }
});

test('no letter heading addresses the recipient as "your"', () => {
  // The customer is writing. "Your interest rate" reads as the lender's.
  for (const letter of Object.values(letters())) {
    if (!letter || !letter.body) continue;
    const headings = (letter.body.match(/^\d+\. .+$/gm) || []);
    const offenders = headings.filter((h) => /\byour\b/i.test(h));
    assert.deepEqual(offenders, [], `${letter.subject}: ${offenders.join('; ')}`);
  }
});

test('nothing needing another document is sent to anyone', () => {
  // A finding whose next step is "upload your Loan Estimate" is addressed to
  // the customer, not to a recipient, and must never reach a letter.
  const { findings } = runDocumentAudit({
    extraction: fixture.extraction,
    answers: fixture.answers,
    loanEstimates: fixture.loanEstimates,
  });
  const sent = new Set();
  for (const letter of Object.values(letters())) {
    if (letter && letter.checkIds) letter.checkIds.forEach((id) => sent.add(id));
  }
  const needsDocs = findings
    .filter((f) => f.actionability === 'requires_additional_documentation')
    .map((f) => f.checkId);
  for (const id of needsDocs) {
    assert.ok(!sent.has(id), `${id} needs another document and must not be in a letter`);
  }
});

test('the letter is addressed and signed', () => {
  const lender = letters().lender;
  assert.match(lender.body, /Alex Rivera and Sam Rivera\s*$/);
  assert.match(lender.body, /4418 Monument Avenue/);
  assert.match(lender.body, /closing April 15, 2026/);
});
