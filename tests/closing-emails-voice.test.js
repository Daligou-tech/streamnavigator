// The letters the customer actually sends, checked for whose voice they are in.
//
// The report renders one set of emails on screen (written by the model) and the
// PDF renders another (assembled here, in code). Only the PDF version is
// emailed, and since the report is now delivered automatically, the assembled
// version is the one every customer receives.
//
// It was pasting three engine fields straight into the letter. Two of them —
// whyItMatters and recommendedAction — are written BY the audit TO the
// customer, in the second person. Dropped into a letter written BY the customer
// TO their lender, every one of them inverted:
//
//   "Excess cushion is YOUR cash sitting in the servicer's account"
//   "ASK THE LENDER to show the day count"        (addressed to the lender)
//   "the most recoverable error WE look for"      (StreamNavigator's voice,
//                                                  over the customer's name)
//
// A customer who forwarded that to the bank funding their house would have been
// embarrassed by it. These tests fail if any of it comes back.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildEmails } = require('../api/_lib/closing-emails');
const audit = require('../api/_lib/closing-audit');

const CTX = {
  lenderName: 'Ficus Bank, N.A.',
  settlementName: 'Meridian Title & Escrow LLC',
  propertyAddress: '1418 Ashgrove Lane, Fairfax, VA 22031',
  closingDate: '2026-04-15',
  borrowerName: 'Dana R. Whitfield',
};

// Real findings from the audit engine, not hand-written fixtures — the leaked
// strings came from fields a fixture author would not think to include.
const prepaid = audit.checkPrepaidInterest({
  loanAmount: 300000, annualRatePct: 6.5, closingDate: '2026-04-15', chargedAmount: 1175.24,
});
const cushion = audit.checkEscrowCushion(
  { "Homeowner's Insurance": 1450, 'Property Taxes': 4200 }, 1354
);
const contract = audit.reconcileContract(
  [{ kind: 'seller_credit', label: 'Seller subsidy', amount: 6000, provision: 'Paragraph 4(b)' }],
  { seller_credits: 3000 }
)[0];

const withRouting = (f, who) => Object.assign({}, f,
  who === 'lender' ? { askLender: true } : { askSettlement: true });

const FINDINGS = [
  withRouting(prepaid, 'lender'),
  withRouting(cushion, 'lender'),
  withRouting(contract, 'settlement'),
];

const mails = buildEmails(FINDINGS, CTX);

test('both letters are addressed to a named recipient', () => {
  assert.equal(mails.lender.to, 'Ficus Bank, N.A.');
  // Was null: the settlement agent is printed on page 1 of every Closing
  // Disclosure but was never extracted, so the letter went to nobody.
  assert.equal(mails.settlement.to, 'Meridian Title & Escrow LLC');
});

test('no letter instructs its own recipient to ask themselves', () => {
  for (const [who, m] of Object.entries(mails)) {
    assert.doesNotMatch(m.body, /ask the lender/i, who);
    assert.doesNotMatch(m.body, /ask your lender/i, who);
    assert.doesNotMatch(m.body, /send the contract provision/i, who);
    assert.doesNotMatch(m.body, /re-run the initial escrow/i, who);
  }
});

test('no letter speaks in StreamNavigator’s voice', () => {
  for (const [who, m] of Object.entries(mails)) {
    // "we look for", "we hold", "we name" — the vendor, in a letter the
    // customer signs.
    assert.doesNotMatch(m.body, /\bwe (look|hold|name|check|found)\b/i, who);
  }
});

test('no letter tells the recipient the money is theirs', () => {
  // "Excess cushion is your cash sitting in the servicer's account" — true of
  // the customer, false and confusing when sent to the lender.
  assert.doesNotMatch(mails.lender.body, /your cash/i);
  assert.doesNotMatch(mails.settlement.body, /your negotiated credits/i);
});

test('every dollar figure in a letter is formatted as money', () => {
  // toDollars returns a number, so interpolating it into prose produced
  // "Contract provides 6000" and "a shortfall of 3000".
  for (const [who, m] of Object.entries(mails)) {
    const lines = m.body.split('\n');
    for (const line of lines) {
      // A bare 4+ digit integer that is not part of a citation, a date, a
      // percentage or a day count.
      const bare = line.match(/(?<![$\d.,])\b\d{4,}\b(?![\d.,]*\s*(?:days?|%))/g) || [];
      const allowed = /1026\.|1024\.|Paragraph|20\d\d|VA \d{5}|-day basis/;
      const suspicious = bare.filter(() => !allowed.test(line));
      assert.deepEqual(suspicious, [], `${who}: unformatted figure in "${line.trim()}"`);
    }
  }
});

test('the facts the customer needs still survive', () => {
  const b = mails.lender.body;
  assert.match(b, /\$1,175\.24/);          // what was charged
  assert.match(b, /\$854\.79/);            // what it should be
  assert.match(b, /\$320\.45/);            // the difference
  assert.match(b, /1026\.19\(e\)\(3\)\(i\)|1024\.17/); // the citation
  assert.match(b, /22\.0 days rather than the 16/);    // the day-count fact
  assert.match(mails.settlement.body, /Paragraph 4\(b\)/);
  assert.match(mails.settlement.body, /\$6,000\.00/);
});

test('the letters still ask rather than allege', () => {
  for (const [who, m] of Object.entries(mails)) {
    assert.match(m.body, /I may well be reading something wrong/i, who);
    assert.doesNotMatch(m.body, /\b(illegal|overcharged me|you overcharged|violation by you)\b/i, who);
  }
});
