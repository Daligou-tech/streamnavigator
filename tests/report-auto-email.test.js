// Automatic delivery of the finished report, exercised against the real
// functions in navigator-status.html.
//
// Ten product pages promise "Delivered automatically" — closing.html says
// "usually within 5 minutes". What actually happened was that the report
// rendered on screen and a prompt asked whether the customer would like a PDF
// emailed. A customer who read the report and closed the tab, which is the
// ordinary thing to do, never received the copy they had been told was coming,
// and had nothing to forward to their lender or settlement agent.
//
// The two failure modes worth testing are opposite: not sending at all, and
// sending twice because the customer reloaded the page.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'navigator-status.html'), 'utf8');

// Line-ending agnostic on purpose. core.autocrlf is true on Windows and there
// is no .gitattributes, so navigator-status.html arrives with CRLF in a fresh
// clone and with LF whenever a tool has rewritten it. An LF-only '\n  }\n'
// anchor silently returns an empty string instead of the function body, and the
// suite then fails with "maybeAutoSendPdf is not defined" — which reads like a
// missing function rather than a line-ending mismatch, and sends you looking in
// the wrong file. upload-restore.test.js had the same bug.
const grab = (name) => {
  const i = src.indexOf('  function ' + name + '(');
  assert.notEqual(i, -1, `function ${name} not found in navigator-status.html`);
  const end = /\r?\n {2}\}\r?\n/.exec(src.slice(i));
  assert.notEqual(end, null, `could not find the end of ${name} in navigator-status.html`);
  return src.slice(i, i + end.index + end[0].length);
};

function harness({ email, alreadySent = false, sendResult = 'ok' } = {}) {
  const store = alreadySent ? { 'sn_pdf_sent_SUB1': '1' } : {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  const stored = { id: 'SUB1', token: 'TOK', email };
  const el = () => ({ hidden: true, textContent: '', focus() {} });
  const pdfPromptEl = el();
  const pdfHeadingEl = el();
  const pdfStatusEl = el();
  const pdfFormEl = el();
  const resendBtn = el();
  const document = { getElementById: (id) => (id === 'pdf-resend-btn' ? resendBtn : el()) };

  const sent = [];
  // Stands in for the real sendPdf, which is exercised end to end by the live
  // endpoint; what matters here is whether, and how often, it is called.
  function sendPdf(addr, opts) {
    sent.push({ addr, auto: !!(opts && opts.auto) });
    if (sendResult === 'ok') {
      store['sn_pdf_sent_SUB1'] = '1';
      pdfHeadingEl.textContent = '📧 Your report is on its way';
      pdfStatusEl.textContent = 'Sent to ' + addr + '.';
      resendBtn.hidden = false;
    } else {
      pdfPromptEl.hidden = false;
      pdfStatusEl.textContent = 'Something went wrong sending that — please try again.';
    }
  }

  const scope = {
    stored, localStorage, document, sendPdf,
    pdfPromptEl, pdfHeadingEl, pdfStatusEl, pdfFormEl,
  };
  const body = [
    grab('pdfSentKey'), grab('markPdfSent'), grab('alreadySentPdf'),
    grab('showResendOption'), grab('maybeAutoSendPdf'),
  ].join('\n');

  // eslint-disable-next-line no-new-func
  const run = new Function(...Object.keys(scope),
    body + '\n; return { maybeAutoSendPdf: maybeAutoSendPdf, alreadySentPdf: alreadySentPdf };');
  const api = run(...Object.values(scope));

  return { api, sent, store, pdfPromptEl, pdfHeadingEl, pdfStatusEl, resendBtn };
}

test('a finished report is emailed without the customer asking', () => {
  const h = harness({ email: 'buyer@gmail.com' });
  h.api.maybeAutoSendPdf();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0], { addr: 'buyer@gmail.com', auto: true });
  assert.equal(h.pdfPromptEl.hidden, true, 'the "want a PDF?" prompt should be gone');
  assert.match(h.pdfStatusEl.textContent, /Sent to buyer@gmail\.com/);
});

test('reloading the page does not send a second copy', () => {
  const h = harness({ email: 'buyer@gmail.com' });
  h.api.maybeAutoSendPdf();
  h.api.maybeAutoSendPdf();
  h.api.maybeAutoSendPdf();
  assert.equal(h.sent.length, 1, 'sent ' + h.sent.length + ' times');
});

test('a customer returning later is told it was already sent, not asked again', () => {
  const h = harness({ email: 'buyer@gmail.com', alreadySent: true });
  h.api.maybeAutoSendPdf();
  assert.equal(h.sent.length, 0);
  assert.equal(h.pdfPromptEl.hidden, true);
  assert.match(h.pdfStatusEl.textContent, /Sent to buyer@gmail\.com/);
  assert.equal(h.resendBtn.hidden, false, 'they must still be able to use another address');
});

test('with no address on file the manual prompt is left alone', () => {
  // navigator-intake makes email optional, so this path is real. Silently doing
  // nothing is correct here — there is nowhere to send it.
  for (const email of [null, undefined, '', 'not-an-email']) {
    const h = harness({ email });
    h.api.maybeAutoSendPdf();
    assert.equal(h.sent.length, 0, String(email));
    assert.equal(h.pdfPromptEl.hidden, true, 'prompt visibility left to the page');
  }
});

test('a failed automatic send is not recorded as sent', () => {
  // Otherwise the customer is told a copy is coming, no copy arrives, and a
  // reload reports it as already delivered.
  const h = harness({ email: 'buyer@gmail.com', sendResult: 'fail' });
  h.api.maybeAutoSendPdf();
  assert.equal(h.sent.length, 1);
  assert.equal(h.api.alreadySentPdf(), false);
  assert.equal(h.pdfPromptEl.hidden, false, 'manual controls must come back');
});

test('the page still promises automatic delivery, and now means it', () => {
  const closing = fs.readFileSync(path.join(__dirname, '..', 'closing.html'), 'utf8');
  assert.match(closing, /Delivered automatically/);
  // The claim is only honest while the auto-send is wired in.
  assert.match(src, /maybeAutoSendPdf\(\)/);
});
