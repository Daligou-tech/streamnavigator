// Every inline <script> on every page has to parse.
//
// Written after breaking landlord.html's intake form with a string literal that
// spanned two lines. One syntax error in one inline script kills the whole
// block: the property form never rendered, the pay button did nothing, and the
// page still looked completely normal — heading, checks, pricing card, all
// present. Nothing in the suite noticed.
//
// tests/render-check.js executes the report renderer, which is a different
// question and did not cover this. A page whose script does not parse is a page
// where nothing a customer does works, so it is worth its own mechanical check
// across all of them rather than only the one that broke.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

const PAGES = fs.readdirSync(ROOT)
  .filter((f) => f.endsWith('.html'))
  .sort();

// Inline JavaScript only, and the two exclusions are not incidental — both were
// flagged as broken on the first run of this file:
//
//   type="application/ld+json" on index.html is structured data, not code. It
//   is not meant to parse as JavaScript and does not.
//
//   dashboard.html's setup comment contains the words "the <script> block near
//   the bottom", and a matcher that does not strip HTML comments first reads
//   that prose as a script.
//
// A src= script is a real file, covered by the page loading it.
function inlineScripts(html) {
  // Blanked rather than removed, so reported line numbers still point at the
  // real file.
  const live = html.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
  const out = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(live)) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc=/i.test(attrs)) continue;
    const type = (attrs.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1];
    // No type, or an explicitly JavaScript one. Anything else — JSON-LD, an
    // HTML template, importmap — is not JavaScript and must not be parsed as it.
    if (type && !/^(?:text\/javascript|application\/javascript|module)$/i.test(type.trim())) continue;
    const body = m[2];
    if (body.trim()) out.push({ body, at: live.slice(0, m.index).split('\n').length });
  }
  return out;
}

test('there are pages to check, so this cannot pass by finding nothing', () => {
  assert.ok(PAGES.length >= 12, `only ${PAGES.length} html files found`);
});

test('every inline script on every page parses', () => {
  const broken = [];
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    for (const script of inlineScripts(html)) {
      try {
        // Parse only. Compiling as a script catches a syntax error without
        // running anything, which is the whole point — these scripts expect a
        // browser and must not execute here.
        new vm.Script(script.body, { filename: `${page}:${script.at}` });
      } catch (err) {
        broken.push(`${page} (script starting line ${script.at}): ${err.message}`);
      }
    }
  }
  assert.deepEqual(broken, [],
    'a page whose inline script does not parse looks completely normal and does nothing — '
    + `the form does not submit and no button works:\n  ${broken.join('\n  ')}`);
});

test('landlord.html carries the script its intake depends on', () => {
  // The specific failure that prompted this: the page rendered its heading,
  // its ten checks and its pricing card while the property form silently did
  // not exist, because the script that builds it had died on line one.
  const html = fs.readFileSync(path.join(ROOT, 'landlord.html'), 'utf8');
  const scripts = inlineScripts(html);
  assert.ok(scripts.length, 'landlord.html has no inline script at all');

  const intake = scripts.find((s) => s.body.includes('addProperty'));
  assert.ok(intake, 'the property-form script is gone from landlord.html');
  assert.doesNotThrow(() => new vm.Script(intake.body, { filename: 'landlord.html' }));

  for (const needed of ['propertyMarkup', 'readProperties', 'renumber', 'getRentalEntitlementSource']) {
    assert.ok(intake.body.includes(needed), `landlord.html's intake script no longer defines ${needed}`);
  }
});
