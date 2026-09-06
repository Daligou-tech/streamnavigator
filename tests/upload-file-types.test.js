// The upload zone's file-TYPE filter, exercised against the real wireUploadZone
// in navigator-shared.js.
//
// Why this exists: the zone validated file count, per-file size and running
// total, but never the type. The `accept` attribute on the <input> was doing
// the work, and it only filters the operating system's file picker — it has no
// effect on drag-and-drop, and every upload zone on the site says "or drag
// files here". A dragged .docx was accepted into the list, base64'd, uploaded,
// and failed a few seconds later with "our document reader is temporarily
// unavailable", which is not what happened and not something the customer can
// act on.
//
// The HEIC case is the one that mattered most in practice. It is the iPhone
// camera's default format and the page invites photographing the document, so
// the most obvious way for a phone user to send us their Closing Disclosure
// produced a permanent failure dressed as a temporary one. The drop-path tests
// below are the regression guard: a change that validates only the change
// handler would pass a naive test and leave the actual hole open.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'navigator-shared.js'), 'utf8');

// --- the smallest DOM that lets the real code run ---------------------------

function makeEl() {
  const el = {
    children: [],
    className: '',
    style: {},
    textContent: '',
    _listeners: {},
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(k, fn) { (this._listeners[k] = this._listeners[k] || []).push(fn); },
    removeEventListener() {},
    click() {},
    getAttribute() { return null; },
    set innerHTML(v) { if (v === '') this.children = []; },
    get innerHTML() { return ''; },
  };
  return el;
}

function loadShared() {
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    document: {
      createElement: () => makeEl(),
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'navigator-shared.js' });
  return ctx;
}

// Drives a real wireUploadZone and reports what the customer would see.
function mountZone({ accept = '.pdf,.jpg,.jpeg,.png,.webp', opts } = {}) {
  const ctx = loadShared();
  const zoneEl = makeEl();
  const listEl = makeEl();
  const inputEl = makeEl();
  inputEl.files = [];
  inputEl.getAttribute = (k) => (k === 'accept' ? accept : null);

  const uploader = ctx.wireUploadZone(zoneEl, inputEl, listEl, opts);

  const rowsText = () => listEl.children
    .map((r) => (r.children.length ? r.children.map((c) => c.textContent).join('') : r.textContent))
    .filter(Boolean);

  return {
    uploader,
    // the picker path
    pick(files) {
      inputEl.files = files;
      inputEl._listeners.change.forEach((fn) => fn());
    },
    // the path `accept` never covered
    drop(files) {
      zoneEl._listeners.drop.forEach((fn) => fn({
        preventDefault() {},
        dataTransfer: { files },
      }));
    },
    // Array.from brings the list out of the vm realm; a vm-realm array fails
    // deepStrictEqual against a host-realm one even when the contents match.
    accepted: () => Array.from(uploader.getFiles()).map((f) => f.name),
    rows: rowsText,
    rejectionFor(name) {
      return rowsText().find((t) => t.indexOf(name) !== -1 && t.indexOf('⚠') !== -1) || null;
    },
  };
}

const file = (name, bytes = 1024) => ({ name, size: bytes, type: '' });

// --- the hole that shipped --------------------------------------------------

test('a dragged .docx is refused, not silently accepted', () => {
  const z = mountZone();
  z.drop([file('contract.docx')]);
  assert.deepEqual(z.accepted(), []);
  assert.match(z.rejectionFor('contract.docx'), /\.docx file is not something we can read/);
});

test('a dragged iPhone photo is refused with advice about HEIC specifically', () => {
  const z = mountZone();
  z.drop([file('IMG_4471.HEIC', 2 * 1024 * 1024)]);
  assert.deepEqual(z.accepted(), []);
  const reason = z.rejectionFor('IMG_4471.HEIC');
  assert.match(reason, /iPhone photos are saved as HEIC/);
  assert.match(reason, /original PDF/);
});

test('.heif is treated the same as .heic', () => {
  const z = mountZone();
  z.drop([file('scan.heif')]);
  assert.deepEqual(z.accepted(), []);
  assert.match(z.rejectionFor('scan.heif'), /iPhone photos are saved as HEIC/);
});

test('the picker path refuses the same types', () => {
  const z = mountZone();
  z.pick([file('notes.txt')]);
  assert.deepEqual(z.accepted(), []);
  assert.match(z.rejectionFor('notes.txt'), /\.txt file is not something we can read/);
});

// --- what must still work ---------------------------------------------------

test('the documents customers actually send are accepted', () => {
  const z = mountZone();
  z.drop([
    file('closing-disclosure.pdf'),
    file('estimate.JPG'),
    file('page2.png'),
    file('page3.webp'),
    file('page4.jpeg'),
  ]);
  assert.deepEqual(z.accepted(), [
    'closing-disclosure.pdf', 'estimate.JPG', 'page2.png', 'page3.webp', 'page4.jpeg',
  ]);
  assert.equal(z.rejectionFor('closing-disclosure.pdf'), null);
});

test('a file with no extension is refused rather than guessed at', () => {
  const z = mountZone();
  z.drop([file('scan')]);
  assert.deepEqual(z.accepted(), []);
  assert.match(z.rejectionFor('scan'), /that file type is not something we can read/);
});

// --- ordering ---------------------------------------------------------------

test('type is reported before size, so a small HEIC is not blamed on the limit', () => {
  // 900KB: well under any ceiling. Telling this customer about a 3.2MB limit
  // would send them off to compress a file whose size was never the problem.
  const z = mountZone({ opts: { maxFileBytes: 3.2 * 1024 * 1024 } });
  z.drop([file('IMG_0001.heic', 900 * 1024)]);
  const reason = z.rejectionFor('IMG_0001.heic');
  assert.match(reason, /HEIC/);
  assert.doesNotMatch(reason, /limit is/);
});

test('an oversized but supported file still reports the size limit', () => {
  const z = mountZone({ opts: { maxFileBytes: 3.2 * 1024 * 1024 } });
  z.drop([file('huge-scan.pdf', 5 * 1024 * 1024)]);
  assert.deepEqual(z.accepted(), []);
  assert.match(z.rejectionFor('huge-scan.pdf'), /the limit is 3\.2MB per file/);
});

// --- where the allowed list comes from --------------------------------------

test('the allowed list is read from the input, so a page cannot drift from it', () => {
  const z = mountZone({ accept: '.pdf' });
  z.drop([file('a.pdf'), file('b.png')]);
  assert.deepEqual(z.accepted(), ['a.pdf']);
  assert.match(z.rejectionFor('b.png'), /Please upload PDF\./);
});

test('an input with no accept attribute still refuses unreadable types', () => {
  const z = mountZone({ accept: null });
  z.drop([file('c.pdf'), file('d.docx')]);
  assert.deepEqual(z.accepted(), ['c.pdf']);
  assert.match(z.rejectionFor('d.docx'), /PDF, JPG, JPEG, PNG, WEBP/);
});

test('MIME entries in accept are ignored in favour of extensions', () => {
  const z = mountZone({ accept: 'application/pdf,.pdf,.png' });
  z.drop([file('e.pdf'), file('f.png'), file('g.gif')]);
  assert.deepEqual(z.accepted(), ['e.pdf', 'f.png']);
  assert.ok(z.rejectionFor('g.gif'));
});
