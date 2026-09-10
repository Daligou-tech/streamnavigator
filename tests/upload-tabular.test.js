// CSV uploads, and the ten products that must keep refusing them.
//
// A rent roll lives in a spreadsheet, and /rental invited one for months while
// the upload endpoint returned 400 for .csv and .xlsx — the page named the
// likeliest file the customer had and the server refused it.
//
// Fixing that globally would have re-created the HEIC failure with a different
// extension. Every engine except this one maps an unknown extension to
// image/jpeg and hands it to an API that takes PDFs and images, so a .csv
// accepted by HOA is stored, charged for, and fails during analysis — after
// payment. So the allowance is per-product and most of this file is about the
// products that do NOT get it.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  allowedExtFor, allowedMimeFor, allowsTabular, isTabularUpload,
  TABULAR_PRODUCTS, ALLOWED_UPLOAD_EXT, MAX_TABULAR_FILE_BYTES, MAX_DIRECT_FILE_BYTES,
} = require('../api/_lib/upload-limits');

const OTHER_PRODUCTS = [
  'property-tax', 'home-savings', 'subscriptions', 'government-money',
  'home-maintenance', 'landlord', 'insurance', 'buying', 'hoa', 'closing', 'contractor',
];

test('rental takes a CSV', () => {
  assert.ok(allowedExtFor('rental').includes('csv'));
  assert.ok(allowedExtFor('rental').includes('tsv'));
  assert.ok(allowsTabular('rental'));
});

test('every other product still refuses one', () => {
  for (const product of OTHER_PRODUCTS) {
    assert.deepEqual(allowedExtFor(product), ALLOWED_UPLOAD_EXT,
      `${product} would accept a file its engine cannot read`);
    assert.equal(allowsTabular(product), false);
  }
});

test('a product only joins the list once something can read the file', () => {
  // The guard is a comment in upload-limits.js and a branch in
  // navigator-engine.js. This is the test that makes adding a product to
  // TABULAR_PRODUCTS without wiring the branch fail loudly.
  const engine = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'api', '_lib', 'navigator-engine.js'), 'utf8');
  assert.ok(/isTabularUpload\(path\)/.test(engine),
    'navigator-engine.js must branch on isTabularUpload before any product may accept text');
  for (const product of TABULAR_PRODUCTS) {
    const { PRODUCT_CONFIGS } = require('../api/_lib/navigator-engine');
    assert.ok(PRODUCT_CONFIGS[product],
      `${product} accepts text uploads but is not handled by navigator-engine.js, which is `
      + 'the only place the text branch exists');
  }
});

test('the Excel-associated MIME type is accepted, but only alongside a csv extension', () => {
  // A .csv on a machine with Excel installed frequently arrives as
  // application/vnd.ms-excel — which is also the type of a binary .xls. That is
  // safe only because the extension is checked independently, so this asserts
  // both halves.
  assert.ok(allowedMimeFor('rental').includes('application/vnd.ms-excel'));
  assert.ok(!allowedExtFor('rental').includes('xls'), 'a real .xls must still be refused');
  assert.ok(!allowedExtFor('rental').includes('xlsx'));
  assert.ok(!allowedMimeFor('hoa').includes('application/vnd.ms-excel'));
});

test('a stored path is recognised as tabular by its extension', () => {
  assert.ok(isTabularUpload('rental/abc-123/1757000000000-rent_roll.csv'));
  assert.ok(isTabularUpload('export.TSV'), 'case does not matter');
  assert.ok(!isTabularUpload('rental/abc-123/1757000000000-statement.pdf'));
  assert.ok(!isTabularUpload('roll.csv.pdf'), 'only the final extension counts');
  assert.ok(!isTabularUpload(''));
  assert.ok(!isTabularUpload(null));
});

test('a CSV gets a much lower size ceiling than a scanned document', () => {
  // It is read into the prompt as text, so the limit is about context, not
  // storage. 50MB of CSV is tens of millions of tokens.
  assert.ok(MAX_TABULAR_FILE_BYTES < MAX_DIRECT_FILE_BYTES / 5);
  assert.equal(MAX_TABULAR_FILE_BYTES, 5 * 1024 * 1024);
});
