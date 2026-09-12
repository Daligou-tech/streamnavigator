// A paid report has to be reachable from a device other than the one that
// bought it.
//
// The audit's §05 found this and it was the last open item: a report is keyed
// to localStorage, so paying on a phone and opening on a laptop produced "We
// couldn't find that submission" about a report that exists, is finished, and
// is paid for. The customer's only other copy is the emailed PDF.
//
// Half the fix was already here — getStoredSubmission() adopts id and token
// from the query string. Nothing ever sent the customer a URL carrying them,
// so the capability existed and no customer could reach it. These two halves
// are useless apart, which is why they are tested together.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const emailer = fs.readFileSync(path.join(ROOT, 'api', 'email-report-pdf.js'), 'utf8');
const shared = fs.readFileSync(path.join(ROOT, 'navigator-shared.js'), 'utf8');
const statusPage = fs.readFileSync(path.join(ROOT, 'navigator-status.html'), 'utf8');

const delivery = fs.readFileSync(path.join(ROOT, 'api', '_lib', 'report-delivery.js'), 'utf8');

test('the report email carries a link back to the report', () => {
  assert.ok(/reportUrl/.test(emailer) && /statusLink\(submission\)/.test(emailer),
    'the emailed PDF is the only other copy of the report; without a link it is the only copy at all');
  assert.ok(/reportUrl/.test(emailer.slice(emailer.indexOf('text: ['), emailer.indexOf('attachments'))),
    'the link has to be in the body the customer reads, not merely computed');
});

test('both emails build the link with one builder, not two', () => {
  // docs/REPORT-CONSISTENCY-AUDIT.md records what two independently written
  // copies of one thing did to the closing letters: two wordings for one
  // letter, drifting apart quietly. The sweep and the status page both send
  // this link; they must not each own a URL.
  assert.ok(/statusLink/.test(delivery) && /module\.exports[\s\S]*statusLink/.test(delivery),
    'report-delivery.js owns the link and must export it');
  assert.ok(/require\('\.\/_lib\/report-delivery'\)/.test(emailer),
    'email-report-pdf.js must borrow that builder rather than hand-rolling a second URL');
  assert.ok(!/navigator-status\?id=\$\{/.test(emailer),
    'a second hand-built status URL has reappeared in the emailer');
});

test('the link builder carries every part the status page needs', () => {
  const fn = delivery.slice(delivery.indexOf('function statusLink'), delivery.indexOf('function body'));
  for (const part of ['id', 'access_token', 'product']) {
    assert.ok(fn.includes(part), `statusLink drops ${part}, which the page reads back`);
  }
});

test('the link is built from credentials the caller already proved they hold', () => {
  // This endpoint authenticates by comparing the submitted token against the
  // row before it does anything. The link mints no new capability; it carries
  // the existing one somewhere the browser can no longer reach.
  const authIndex = emailer.indexOf('submission.access_token !== token');
  const linkIndex = emailer.indexOf('const reportUrl');
  assert.ok(authIndex > 0 && linkIndex > authIndex,
    'the link must be built after the token check, never before it');
});

test('the query string is adopted and then taken out of the address bar', () => {
  const fn = shared.slice(shared.indexOf('function getStoredSubmission'));
  assert.ok(/params\.get\('id'\)/.test(fn) && /params\.get\('t'\)/.test(fn),
    'the page must accept the link the email sends');
  assert.ok(/replaceState/.test(fn),
    'a bearer token must not sit in the URL bar for a screenshot, a shared link, or '
    + 'the history of a shared laptop once localStorage has it');

  // Order matters: store first, then scrub. Scrubbing before storing loses it.
  const store = fn.indexOf("localStorage.setItem('sn_last_submission'");
  const scrub = fn.indexOf('replaceState');
  assert.ok(store > 0 && scrub > store, 'scrub after storing, or the credential is lost');
});

test('both halves or neither — an id with no token never replaces a working reference', () => {
  const fn = shared.slice(shared.indexOf('function getStoredSubmission'));
  assert.ok(/if \(id && token\)/.test(fn),
    'an id alone is not a credential and would overwrite a localStorage entry that works');
});

test('the not-found message tells the customer where the link actually is', () => {
  assert.ok(/open the email we sent you/i.test(statusPage),
    '"check your email" is only useful once the email contains something to act on');
  assert.ok(!/Check your email, or reach out/.test(statusPage),
    'the old copy pointed at an email that carried no way back');
});
