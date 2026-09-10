// What the upload box says it takes must be what the server actually takes.
//
// Why this exists: rental.html invited the customer to send the one document
// the product is built around — "Upload your rent roll and expenses" — and told
// them, two lines under a file picker whose own accept list read
// ".pdf,.jpg,.jpeg,.png,.webp", that "Spreadsheets, PDFs, or photos of
// statements all work". Its FAQ repeated it: "any common format (spreadsheet,
// PDF, statements)". Neither was true. api/navigator-upload-url.js refuses
// .xlsx and .csv outright, verified against production on 2026-09-09.
//
// A rent roll lives in a spreadsheet. So the page's headline instruction, on
// the page where the customer is deciding whether to pay $149, named the most
// likely file they had and the server refused it — after they had read the
// pricing card and started the flow.
//
// Two mechanical checks, deliberately few. The first keeps the file picker and
// the server agreeing. The second refuses affirmative copy about a format we
// cannot read. Saying we CANNOT read something is fine and is what the fixed
// copy does, so the negation carve-out below is load-bearing, not a loophole.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { ALLOWED_UPLOAD_EXT } = require('../api/_lib/upload-limits');

const PAGES = fs.readdirSync(ROOT)
  .filter((f) => f.endsWith('.html'))
  .filter((f) => /accept="/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));

test('every upload page offers a file picker matching the server allowlist', () => {
  assert.ok(PAGES.length >= 10, `only found ${PAGES.length} pages with a file picker`);
  const expected = ALLOWED_UPLOAD_EXT.map((e) => `.${e}`).sort().join(',');
  const wrong = [];
  for (const file of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of html.matchAll(/accept="([^"]+)"/g)) {
      const got = m[1].split(',').map((s) => s.trim().toLowerCase()).sort().join(',');
      if (got !== expected) wrong.push(`${file}: accept="${m[1]}"`);
    }
  }
  assert.deepEqual(wrong, [],
    `a file picker disagrees with ALLOWED_UPLOAD_EXT (${expected}) — the OS picker would `
    + `offer a file api/navigator-upload-url.js then refuses:\n  ${wrong.join('\n  ')}`);
});

test('no page claims we accept a format the server refuses', () => {
  // Formats a landlord/homeowner plausibly holds, that nothing downstream reads.
  const UNREADABLE = /\b(spreadsheets?|excel|\.xlsx|\.csv|csv|\.docx|word documents?|heic)\b/i;
  const ACCEPTS = /\b(work|works|accepted?|accepts|fine|supported|upload|send|attach|drag)\b/i;
  const NEGATED = /\b(can'?t|cannot|can’t|not|don'?t|doesn'?t|won'?t|unable|before|first|instead)\b/i;

  const offenders = [];
  for (const file of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const text = html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ');
    for (const sentence of text.split(/(?<=[.!?])\s+|\n/)) {
      const s = sentence.trim();
      if (!s || !UNREADABLE.test(s)) continue;
      const named = s.match(UNREADABLE)[0].toLowerCase().replace(/^\./, '');
      if (ALLOWED_UPLOAD_EXT.includes(named)) continue;
      if (NEGATED.test(s)) continue;          // "we can't read .csv" is honest copy
      if (!ACCEPTS.test(s)) continue;         // a passing mention, not an offer
      offenders.push(`${file}: ${s.replace(/\s+/g, ' ').slice(0, 140)}`);
    }
  }
  assert.deepEqual(offenders, [],
    'a page offers a file format the upload endpoint refuses:\n  ' + offenders.join('\n  '));
});
