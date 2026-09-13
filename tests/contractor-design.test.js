'use strict';

// /contractor and /contractor-report use the /closing design system, and this
// is what keeps that true after today.
//
// "Matches /closing" is the kind of statement that is true on the day it is
// written and quietly false three edits later. closing.html carries its styles
// inline; navigator-editorial.css is a verbatim copy of that block, linked by
// the two contractor pages. The first assertion compares them character for
// character, so changing the palette or the type scale on closing.html fails
// the build until the copy is refreshed:
//
//   node -e "const fs=require('fs');const s=fs.readFileSync('closing.html','utf8');
//     const a=s.indexOf('<style>')+7, b=s.indexOf('</style>');
//     const css=fs.readFileSync('navigator-editorial.css','utf8');
//     const head=css.slice(0,css.indexOf('*/')+3);
//     fs.writeFileSync('navigator-editorial.css', head+s.slice(a,b).replace(/^\n/,''));"
//
// The rest assert that the contractor pages actually use it rather than quietly
// reintroducing the old rounded-pill, Inter-and-Sora styling they came from.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const closing = read('closing.html');
const editorial = read('navigator-editorial.css');
const PAGES = ['contractor.html', 'contractor-report.html'];

function closingStyleBlock() {
  const a = closing.indexOf('<style>') + '<style>'.length;
  const b = closing.indexOf('</style>');
  assert.ok(a > 7 && b > a, 'closing.html no longer carries a single inline style block');
  return closing.slice(a, b).replace(/^\n/, '');
}

function editorialBody() {
  const end = editorial.indexOf('*/');
  assert.ok(end > 0, 'navigator-editorial.css lost its header comment');
  return editorial.slice(end + 3).replace(/^\n/, '');
}

test('the shared stylesheet is byte-for-byte the block closing.html carries', () => {
  assert.equal(editorialBody(), closingStyleBlock(),
    'navigator-editorial.css has drifted from closing.html. /contractor claims to match /closing, and the way '
    + 'that claim stays true is this file. Re-copy the block (the command is in the header of this test) rather '
    + 'than editing either side by hand.');
});

test('both contractor pages link the shared stylesheet and nothing else', () => {
  for (const file of PAGES) {
    const page = read(file);
    assert.match(page, /<link rel="stylesheet" href="\/navigator-editorial\.css">/,
      `${file} does not link the shared design system`);
    assert.equal(/navigator-shared\.css/.test(page), false,
      `${file} still links navigator-shared.css — that is the old design system and loading both means whichever `
      + 'comes last wins, which is not a design decision');
  }
});

test('both contractor pages load the same typefaces closing.html does', () => {
  const families = ['Newsreader', 'IBM+Plex+Sans', 'IBM+Plex+Mono'];
  for (const file of PAGES) {
    const page = read(file);
    for (const family of families) {
      assert.ok(page.includes(family), `${file} does not load ${family.replace(/\+/g, ' ')}`);
    }
    for (const old of ['family=Inter', 'family=Sora']) {
      assert.equal(page.includes(old), false,
        `${file} still loads ${old.replace('family=', '')} — the typeface of the design this page moved off`);
    }
  }
});

test('neither page redefines a colour the shared system already owns', () => {
  // The failure this prevents is subtle and common: a page-specific style block
  // that hardcodes #1F1B16 because that was the old ink colour, so the page
  // looks right in isolation and wrong beside /closing.
  const tokens = ['--ink', '--paper', '--panel', '--rule', '--flag', '--ok', '--hold'];
  for (const file of PAGES) {
    const page = read(file);
    const ownStyles = page.slice(page.indexOf('<style>'), page.indexOf('</style>'));
    for (const token of tokens) {
      assert.equal(new RegExp(`${token}\\s*:`).test(ownStyles), false,
        `${file} redefines ${token} in its own style block instead of using the shared value`);
    }
    // Hex colours in the page's own block are allowed nowhere except where the
    // shared system has no token for the thing — and today it has one for
    // everything these pages draw.
    const hexes = (ownStyles.match(/#[0-9a-fA-F]{3,6}\b/g) || []);
    assert.deepEqual(hexes, [],
      `${file} hardcodes ${hexes.join(', ')} in its own style block; use the shared tokens so the two pages `
      + 'cannot diverge');
  }
});

test('the report page renders every severity the audit can produce', () => {
  // A severity with no heading on the page still renders, under "Other
  // findings" — but a finding a customer paid for landing in a catch-all is a
  // deploy that updated the engine and not the page, and it should be caught
  // here instead.
  const { Severity } = require('../api/_lib/contractor-audit');
  const page = read('contractor-report.html');
  const groups = page.slice(page.indexOf('var GROUPS'), page.indexOf('var ACTION_LABEL'));
  const unhandled = Object.values(Severity)
    .filter((s) => s !== 'within_norms')
    .filter((s) => !groups.includes(`'${s}'`));
  assert.deepEqual(unhandled, [],
    'the report page has no heading for these severities and would file them under "Other findings":\n  '
    + unhandled.join('\n  '));
});

test('the report page renders every actionability label the audit sets', () => {
  const { Actionability } = require('../api/_lib/contractor-audit');
  const page = read('contractor-report.html');
  const labels = page.slice(page.indexOf('var ACTION_LABEL'), page.indexOf('function el('));
  const unhandled = Object.values(Actionability)
    .filter((a) => a !== 'no_action_needed')
    .filter((a) => !labels.includes(a));
  assert.deepEqual(unhandled, [],
    'a finding would render with no timing beside it: ' + unhandled.join(', '));
});

test('report content is inserted as text, never as markup', () => {
  // The strings come from a model and from documents a stranger uploaded.
  // Neither is a place to trust angle brackets, and the old page built quote
  // cards with innerHTML and interpolated contractor names straight into them.
  const page = read('contractor-report.html');
  const script = page.slice(page.lastIndexOf('<script>'));
  const assignments = (script.match(/\.innerHTML\s*=\s*[^;]+/g) || [])
    .map((s) => s.trim())
    .filter((s) => !/=\s*''\s*$/.test(s));
  assert.deepEqual(assignments, [],
    'the report page assigns non-empty innerHTML from report data:\n  ' + assignments.join('\n  '));
});
