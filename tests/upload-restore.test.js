// The upload restore, exercised over its whole lifecycle against the real code
// in closing.html.
//
// Restoring the customer's files when they come back from the scorecard shipped
// without an exit: the cache reloaded on every page load, and removing a file
// with the X cleared the box but not the cache, so a refresh put it straight
// back. A customer who uploaded the wrong document could not get rid of it
// without closing the tab. The feature has to restore exactly once per
// submission, and a test that only checks "the file comes back" would have
// passed on the broken version.
'use strict';
const fs = require('fs');
const assert = require('node:assert/strict');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'closing.html'), 'utf8');

// rememberUploads became async when closing.html moved its uploads straight to
// Storage: there is no base64 lying around any more, so it has to encode for
// the cache itself. Match either shape rather than silently grabbing nothing --
// an indexOf miss returns -1 and slices garbage that fails later as a syntax
// error with no hint about which helper moved.
const grab = (name) => {
  const i = ['  async function ' + name + '(', '  function ' + name + '(']
    .map((m) => src.indexOf(m))
    .find((n) => n >= 0);
  assert.ok(i !== undefined, name + ' not found in closing.html');
  // \r?\n, not '\n': git hands Windows checkouts a CRLF working copy of
  // closing.html, and an indexOf for '\n  }\n' finds nothing there. It failed
  // as "Unexpected token )" from an eval of the empty string -- which names
  // neither the file nor the reason.
  const end = /\r?\n {2}\}\r?\n/.exec(src.slice(i));
  assert.ok(end, name + ' has no closing brace at function indent');
  return src.slice(i, i + end.index + end[0].length);
};

const store = {};
const sessionStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
const UPLOAD_CACHE_KEY = 'closing_uploads';
const UPLOAD_CACHE_LIMIT = 3500000;
let attached = [];
const input = { set files(v) { attached = v; }, get files() { return attached; },
  dispatchEvent: () => {} };
class DataTransfer { constructor(){ this.files = []; this.items = { add: (f) => this.files.push(f) }; } }
const document = { getElementById: () => null };
const atob = (b64) => Buffer.from(b64, 'base64').toString('binary');
const File = class { constructor(parts, name, opts){ this.name = name; this.type = opts.type; } };
// rememberUploads encodes the files itself now, so it needs the helper
// navigator-shared.js supplies to the page.
const fileToBase64 = async (f) => f.dataBase64;

// eval in a scope where the helpers land as locals of this module
const rememberUploads = eval('(' + grab('rememberUploads').replace(/^\s*(async )?function rememberUploads/, '$1function') + ')');
const restoreUploads = eval('(' + grab('restoreUploads').replace(/^\s*(async )?function restoreUploads/, '$1function') + ')');

// Real File objects carry a size, and rememberUploads reads it before deciding
// whether encoding is worth doing at all.
const files = [{ name: 'CD-health.PDF', type: 'application/pdf', size: 5, dataBase64: 'aGVsbG8=' }];

async function main() {

await rememberUploads(files, 'a@b.com');
restoreUploads();
assert.equal(attached.length, 1, 'first restore should attach the file');

attached = [];
restoreUploads();
assert.equal(attached.length, 0, 'a refresh must NOT re-attach the file');

restoreUploads();
assert.equal(attached.length, 0, 'still gone on a third load');

await rememberUploads(files, 'a@b.com');
attached = [];
restoreUploads();
assert.equal(attached.length, 1, 'a new submission re-arms the restore');

store[UPLOAD_CACHE_KEY] = JSON.stringify({ files, email: 'a@b.com', saved_at: Date.now() - 3600000 });
attached = [];
restoreUploads();
assert.equal(attached.length, 0, 'an hour-old cache must not restore');

// --- a package too big to keep must leave nothing behind -------------------
// The upload ceiling is 20MB now and sessionStorage holds a few. The old guard
// encoded everything first and measured the result, which on a 20MB package
// means a visible pause on the submit click for a cache that is then thrown
// away. So the size check has to come BEFORE the encode -- and a package over
// the limit has to clear any earlier cache rather than leave a stale one for
// restoreUploads to put back.
await rememberUploads(files, 'a@b.com');
assert.ok(store[UPLOAD_CACHE_KEY], 'a small package should be cached');

let encodeCalls = 0;
const bigFiles = [{ name: 'contract.pdf', type: 'application/pdf', size: 20 * 1024 * 1024,
  get dataBase64() { encodeCalls += 1; return 'aGVsbG8='; } }];
await rememberUploads(bigFiles, 'a@b.com');
assert.equal(encodeCalls, 0, 'an oversized package must not be encoded at all');
assert.equal(store[UPLOAD_CACHE_KEY], undefined, 'an oversized package must clear the cache');

attached = [];
restoreUploads();
assert.equal(attached.length, 0, 'nothing to restore after an oversized package');

}
main().catch((err) => { console.error(err); process.exit(1); });


// --- the answer on screen must be the answer that gets sent ----------------
// Reported as "the questions default to Buying a home". The page has no such
// default; browsers put the previous <select> value back on reload. That
// restoration fires no change event, so rememberAnswers never ran and
// savedAnswers stayed empty -- the page showed an answer the audit was never
// told about, and every check depending on it was skipped in silence.

const pageHtml = fs.readFileSync(path.join(__dirname, '..', 'closing.html'), 'utf8');

for (const id of ['q-transaction-type', 'q-property-type', 'q-provider-list']) {
  const tag = (pageHtml.match(new RegExp('<select id="' + id + '"[^>]*>')) || [''])[0];
  assert.ok(tag, id + ' select not found');
  assert.match(tag, /autocomplete="off"/, id + ' can still be refilled by the browser');
}

const restoreFn = (pageHtml.match(/function restoreAnswers\(\)[\s\S]*?\n  }/) || [''])[0];
assert.ok(restoreFn, 'restoreAnswers not found');
// The conditional form -- `if (tt && savedAnswers.transaction_type)` -- leaves a
// stale browser value in place whenever nothing is saved, which is exactly the
// case that misled the customer.
assert.equal(/&&\s*savedAnswers\./.test(restoreFn), false,
  'restoreAnswers only assigns when something is saved; a stale value survives');
for (const key of ['property_type', 'provider_list', 'transaction_type']) {
  assert.ok(new RegExp('savedAnswers\\.' + key + "\\s*\\|\\|\\s*''").test(restoreFn),
    key + ' is not reset to the empty choice when nothing is saved');
}

console.log('7/7 passed');
