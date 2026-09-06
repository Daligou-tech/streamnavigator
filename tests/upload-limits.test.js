// Tests for api/_lib/upload-limits.js.
//
// The important one here is isStagingPath. /api/navigator-intake accepts a
// list of storage paths from the browser and moves each onto the submission.
// Without a strict check on the shape of those paths, a caller could name any
// key in the bucket — including another customer's completed submission — and
// have that document copied onto a row they control. Every case below that
// asserts a rejection is a real way to read someone else's HOA package or
// closing disclosure.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isStagingPath,
  safeFileName,
  extensionOf,
  asMB,
  MAX_DIRECT_FILE_BYTES,
  MAX_DIRECT_TOTAL_BYTES,
  MAX_TOTAL_BYTES,
} = require('../api/_lib/upload-limits');

const IP = 'a'.repeat(32);
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const VALID = `staging/${IP}/${UUID}__reserve_study.pdf`;

test('a path this server issued is accepted', () => {
  assert.equal(isStagingPath(VALID), true);
});

test('a path pointing at a completed submission is rejected', () => {
  // The attack: claim someone else's uploaded documents by naming them.
  assert.equal(isStagingPath('hoa/11460e6f-f78f-4a8e-b78c-e5142f83ab9f/1788102669194-docs.pdf'), false);
  assert.equal(isStagingPath('closing/abc/CD.pdf'), false);
});

test('directory traversal is rejected', () => {
  assert.equal(isStagingPath(`staging/${IP}/../../hoa/x/secret.pdf`), false);
  assert.equal(isStagingPath(`staging/${IP}/${UUID}__../../../etc/passwd`), false);
});

test('a malformed or missing staging prefix is rejected', () => {
  assert.equal(isStagingPath(`stagingx/${IP}/${UUID}__a.pdf`), false);
  assert.equal(isStagingPath(`${IP}/${UUID}__a.pdf`), false);
  assert.equal(isStagingPath(`/staging/${IP}/${UUID}__a.pdf`), false);
});

test('a wrong-shaped IP hash or upload id is rejected', () => {
  assert.equal(isStagingPath(`staging/tooshort/${UUID}__a.pdf`), false);
  assert.equal(isStagingPath(`staging/${'Z'.repeat(32)}/${UUID}__a.pdf`), false, 'hash is hex only');
  assert.equal(isStagingPath(`staging/${IP}/notauuid__a.pdf`), false);
});

test('a missing separator or empty filename is rejected', () => {
  assert.equal(isStagingPath(`staging/${IP}/${UUID}_a.pdf`), false, 'single underscore is not the separator');
  assert.equal(isStagingPath(`staging/${IP}/${UUID}__`), false);
});

test('non-strings and nested extra segments are rejected', () => {
  assert.equal(isStagingPath(null), false);
  assert.equal(isStagingPath(undefined), false);
  assert.equal(isStagingPath(42), false);
  assert.equal(isStagingPath(`staging/${IP}/${UUID}__a/b.pdf`), false);
});

test('safeFileName strips anything that could shape a path', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'etc_passwd');
  assert.equal(safeFileName('Reserve Study 2026.pdf'), 'Reserve_Study_2026.pdf');
  assert.equal(safeFileName(''), 'document');
  assert.equal(safeFileName(null), 'document');
});

test('safeFileName keeps the extension on a very long name', () => {
  const long = 'a'.repeat(300) + '.pdf';
  const out = safeFileName(long);
  assert.ok(out.length <= 120);
  assert.ok(out.endsWith('.pdf'), 'the tail is kept so the extension survives');
});

test('a sanitized name still produces a valid staging path', () => {
  // safeFileName feeds directly into the path that isStagingPath then has to
  // accept; if these two ever disagree every upload silently fails to attach.
  const path = `staging/${IP}/${UUID}__${safeFileName('HOA Reserve Study (2026) FINAL.pdf')}`;
  assert.equal(isStagingPath(path), true);
});

test('extensionOf reads the last segment, case-insensitively', () => {
  assert.equal(extensionOf('scan.PDF'), 'pdf');
  assert.equal(extensionOf('a.b.jpeg'), 'jpeg');
  assert.equal(extensionOf('noextension'), '');
});

test('the direct route is meaningfully larger than the base64 route', () => {
  // The whole point of the direct upload: a reserve study runs 5-20MB and
  // could not fit through the old ~3.17MB request-body ceiling.
  assert.ok(MAX_TOTAL_BYTES < 4 * 1024 * 1024);
  assert.ok(MAX_DIRECT_TOTAL_BYTES > MAX_DIRECT_FILE_BYTES, 'a package holds more than one document');
  assert.equal(asMB(MAX_DIRECT_FILE_BYTES), 50);
  assert.equal(asMB(MAX_DIRECT_TOTAL_BYTES), 150);
  // Must not exceed the bucket's own file_size_limit (50MB), which is the
  // backstop for a client that ignores what this module says.
  assert.ok(MAX_DIRECT_FILE_BYTES <= 50 * 1024 * 1024);
});
