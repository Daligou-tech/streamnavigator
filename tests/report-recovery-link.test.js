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

test('the report email carries a link back to the report', () => {
  assert.ok(/navigator-status\?id=/.test(emailer),
    'the emailed PDF is the only other copy of the report; without a link it is the only copy at all');
  assert.ok(/access_token/.test(emailer.slice(emailer.indexOf('reportUrl'), emailer.indexOf('reportUrl') + 400)),
    'the link must carry the token, or it opens to the same "could not find that submission"');
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
