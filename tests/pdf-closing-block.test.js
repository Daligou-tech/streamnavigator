// The closing block has to reach the PDF.
//
// api/_lib/pdf-report.js rendered report.emails and nothing else, so a closing
// block that is a CHECKLIST rather than a set of drafted letters never reached
// the emailed copy at all. It showed on the status page and vanished from the
// document the customer keeps and forwards.
//
// Found while testing Landlord Navigator's action pack, where the pack IS the
// deliverable: a 29,000-character document was arriving as a 2KB PDF. Every
// product whose closing block is a checklist had the same hole — the property
// tax appeal checklist, the subscriptions keep/cancel list, and the rest.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildReportPdfBuffer } = require('../api/_lib/pdf-report');

const BASE = {
  headline: 'Eleven of your twelve properties are not enrolled',
  summary: 'A summary.',
  key_numbers: [{ label: 'checks run', value: '48 of 48' }],
  sections: [{ icon: '🏠', title: 'Unit 1', items: ['One finding.'] }],
  missing_or_uncertain: ['Something unverified.'],
};

const LONG_PACK = Array.from({ length: 300 },
  (_, i) => `  ${i + 1}. An action line with an office to contact and a reason.`).join('\n');

test('a checklist closing block reaches the PDF', async () => {
  const withBlock = await buildReportPdfBuffer(
    { ...BASE, closing_title: 'Your action pack', closing_body: LONG_PACK },
    { generatedAt: 'September 12, 2026' }
  );
  const without = await buildReportPdfBuffer(BASE, { generatedAt: 'September 12, 2026' });

  assert.ok(withBlock.length > without.length * 3,
    `the closing block is being dropped: ${withBlock.length} bytes with it against `
    + `${without.length} without, on a body of ${LONG_PACK.length} characters`);
  assert.equal(withBlock.slice(0, 5).toString(), '%PDF-');
});

test('an empty or missing closing block changes nothing', async () => {
  const base = await buildReportPdfBuffer(BASE, { generatedAt: 'x' });
  for (const body of ['', '   ', null, undefined]) {
    const out = await buildReportPdfBuffer({ ...BASE, closing_body: body }, { generatedAt: 'x' });
    assert.ok(Math.abs(out.length - base.length) < 400,
      'an absent closing block must not add a blank page with a heading on it');
  }
});

test('a report that drafts letters keeps them last and does not print them twice', async () => {
  // Closing and Rental put the rendered letters in closing_body AND in
  // report.emails. Rendering both would give the customer the same letter
  // twice, several pages apart.
  const letters = {
    ...BASE,
    closing_title: 'Ready-to-send emails',
    closing_body: 'EMAIL TO LENDER\n\nSubject: A question\n\nDear sir,\n\nRegards.',
    emails: { lender: { to: 'a@b.c', subject: 'A question', body: 'Dear sir,\n\nRegards.' } },
  };
  const withBoth = await buildReportPdfBuffer(letters, { generatedAt: 'x' });
  const lettersOnly = await buildReportPdfBuffer(
    { ...BASE, emails: letters.emails }, { generatedAt: 'x' }
  );
  assert.ok(Math.abs(withBoth.length - lettersOnly.length) < 400,
    'the closing block is being rendered alongside the letters it is a copy of');
});

test('a very long block does not throw, and pages rather than overflowing', async () => {
  const huge = Array.from({ length: 2000 }, (_, i) => `line ${i} of a very long action pack`).join('\n');
  const out = await buildReportPdfBuffer(
    { ...BASE, closing_title: 'Pack', closing_body: huge }, { generatedAt: 'x' }
  );
  assert.equal(out.slice(0, 5).toString(), '%PDF-');
  assert.ok(out.length > 20000, 'a 2,000-line pack should produce a substantial document');
});

test('the title is used, and a missing one still gets a heading', async () => {
  // A slab of monospaced text with no heading reads as a rendering accident.
  const named = await buildReportPdfBuffer(
    { ...BASE, closing_title: 'Your action pack', closing_body: LONG_PACK }, { generatedAt: 'x' }
  );
  const unnamed = await buildReportPdfBuffer(
    { ...BASE, closing_body: LONG_PACK }, { generatedAt: 'x' }
  );
  assert.equal(named.slice(0, 5).toString(), '%PDF-');
  assert.equal(unnamed.slice(0, 5).toString(), '%PDF-');
  assert.ok(unnamed.length > 5000, 'a block with no title must still render its content');
});
