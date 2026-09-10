// The letters a landlord sends under their own name.
//
// These go to a servicer who holds their loan for another twenty years, a
// manager who collects their rent every month, and an agent who renews their
// policy. The audit can be wrong about a line on a statement and survive it. A
// letter that accuses one of those three of overcharging cannot.
//
// So the assertions here are mostly about what the letters must NOT say, and
// about the one structural rule: no finding routed to nobody, and no letter
// written to a party with nothing to ask.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRentalEmails, renderRentalLetters } = require('../api/_lib/rental-emails');
const { runRentalAudit } = require('../api/_lib/rental-audit');

const FINDINGS = [
  {
    checkId: 'PMI_STILL_CHARGED',
    title: 'Mortgage insurance of $118/month is still being charged at 65.8% loan-to-value',
    severity: 'recoverable_charge',
    actionability: 'actionable_now',
    basis: 'The statement shows a principal balance of $253,412.88 against a value of $385,000. Servicers normally allow cancellation at 80%.',
    charged: 1416,
    dollarImpact: 1416,
    askServicer: true,
  },
  {
    checkId: 'MAINT_SCHEDULE_FOOTS',
    title: 'The repairs you were billed exceed the repairs itemised on the same statement',
    severity: 'confirmed_arithmetic_error',
    actionability: 'actionable_now',
    basis: 'The 16 line items on the repair schedule total $6,900. The statement bills $7,400.',
    charged: 7400,
    expected: 6900,
    dollarImpact: 500,
    askManager: true,
  },
  {
    checkId: 'RENT_COMP_NOT_TESTABLE',
    title: 'Your rent could not be tested against comparable units',
    severity: 'requires_documentation',
    actionability: 'requires_additional_documentation',
    basis: 'This audit compares a unit against identical units in the same property.',
    dollarImpact: null,
    askManager: true,
  },
];

const CTX = { propertyAddress: '1428 Garfield Ave, Kansas City, MO 64127', managerName: 'Meridian Property Group, LLC' };

test('each finding reaches the party that can do something about it', () => {
  const emails = buildRentalEmails(FINDINGS, CTX);
  assert.ok(emails.servicer, 'the mortgage insurance finding is the servicer\'s to answer');
  assert.ok(emails.manager, 'the statement discrepancy is the manager\'s');
  assert.equal(emails.insurer, null, 'nothing here is for the agent, so no letter is written to them');
  assert.ok(/mortgage insurance/i.test(emails.servicer.body));
  assert.ok(/\$7,400/.test(emails.manager.body) && /\$6,900/.test(emails.manager.body));
});

test('a finding that needs another document from the customer is not sent to anyone', () => {
  const emails = buildRentalEmails(FINDINGS, CTX);
  assert.equal(emails.manager.findingCount, 1,
    'the rent-comparison gap is a task for the landlord, not a question for their manager');
  assert.ok(!/comparable units/.test(emails.manager.body));
});

test('the letters ask, and never allege', () => {
  const emails = buildRentalEmails(FINDINGS, CTX);
  const forbidden = /overcharg|you charged me|illegal|improper|fraud|refund me|owe me|demand/i;
  for (const [who, email] of Object.entries(emails)) {
    if (!email) continue;
    assert.ok(!forbidden.test(email.body), `the ${who} letter accuses someone: ${email.body}`);
    assert.ok(!forbidden.test(email.subject), `the ${who} subject accuses someone: ${email.subject}`);
  }
  assert.ok(/reading something wrong/.test(emails.manager.body),
    'the manager letter leaves room for a straightforward explanation');
});

test('the subject names the ask, and the property', () => {
  const emails = buildRentalEmails(FINDINGS, CTX);
  assert.equal(emails.servicer.subject, 'Request to cancel mortgage insurance — 1428 Garfield Ave, Kansas City, MO 64127');
  assert.ok(emails.manager.subject.includes('1428 Garfield Ave'));
});

test('a property with nothing to ask produces no letters at all', () => {
  const emails = buildRentalEmails([], CTX);
  assert.deepEqual(emails, { servicer: null, manager: null, insurer: null });
  assert.equal(renderRentalLetters(emails), '', 'and nothing is rendered into the report');
});

test('the rendered block carries every letter that exists, once', () => {
  const rendered = renderRentalLetters(buildRentalEmails(FINDINGS, CTX));
  assert.equal((rendered.match(/EMAIL TO /g) || []).length, 2);
  assert.ok(rendered.includes('EMAIL TO LOAN SERVICER'));
  assert.ok(rendered.includes('EMAIL TO PROPERTY MANAGER (Meridian Property Group, LLC)'));
});

test('a letter signs off with a placeholder rather than a name we do not have', () => {
  const emails = buildRentalEmails(FINDINGS, { propertyAddress: '1428 Garfield Ave' });
  assert.ok(emails.servicer.body.includes('[your name]'),
    'we never learn the landlord\'s name, and a blank signature reads as an unfinished draft');
});

test('the audit engine and the letter writer agree on routing', () => {
  // Every finding the engine routes somewhere must be renderable, and no
  // finding may be routed to a recipient the letter writer does not know about.
  const KNOWN = ['askServicer', 'askManager', 'askInsurer'];
  const fixture = require('./fixtures/rental-leaky-fourplex.json');
  for (const finding of runRentalAudit(fixture).findings) {
    for (const key of Object.keys(finding)) {
      if (/^ask/.test(key)) {
        assert.ok(KNOWN.includes(key), `${finding.checkId} routes to an unknown recipient: ${key}`);
      }
    }
  }
  const emails = buildRentalEmails(runRentalAudit(fixture).findings, CTX);
  assert.ok(emails.servicer && emails.manager && emails.insurer,
    'this property has something for all three parties');
});
