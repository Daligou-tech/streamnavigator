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

const grab = (name) => {
  const i = src.indexOf('  function ' + name + '(');
  const j = src.indexOf('\n  }\n', i) + 4;
  return src.slice(i, j);
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

// eval in a scope where the helpers land as locals of this module
const rememberUploads = eval('(' + grab('rememberUploads').replace(/^\s*function rememberUploads/, 'function') + ')');
const restoreUploads = eval('(' + grab('restoreUploads').replace(/^\s*function restoreUploads/, 'function') + ')');

const files = [{ name: 'CD-health.PDF', type: 'application/pdf', dataBase64: 'aGVsbG8=' }];

rememberUploads(files, 'a@b.com');
restoreUploads();
assert.equal(attached.length, 1, 'first restore should attach the file');

attached = [];
restoreUploads();
assert.equal(attached.length, 0, 'a refresh must NOT re-attach the file');

restoreUploads();
assert.equal(attached.length, 0, 'still gone on a third load');

rememberUploads(files, 'a@b.com');
attached = [];
restoreUploads();
assert.equal(attached.length, 1, 'a new submission re-arms the restore');

store[UPLOAD_CACHE_KEY] = JSON.stringify({ files, email: 'a@b.com', saved_at: Date.now() - 3600000 });
attached = [];
restoreUploads();
assert.equal(attached.length, 0, 'an hour-old cache must not restore');

console.log('5/5 passed');
