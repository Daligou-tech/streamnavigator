// Nothing may ship a stylesheet that hides content pending a class only
// JavaScript applies.
//
// The scroll-reveal did exactly that: navigator-shared.css set
// `.reveal{opacity:0}` and navigator-shared.js added `.in` when an
// IntersectionObserver fired. It was removed on 2026-09-10 because it left
// bands of a page blank while a reader scrolled past them, and because
// closing.html and closing-scorecard.html had each already neutralised it
// locally with `opacity:1 !important` — the same conclusion reached twice
// without either fix reaching the others.
//
// The reason this is a test and not a deletion is the failure mode in the
// middle. Remove the observer and keep the rule and every page is blank
// forever, with nothing to notice it: the CSS is valid, the JS is valid, no
// request fails and no test that checks markup would care. That is a
// site-wide outage delivered by a tidy-up.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// streaming.html is the one page that keeps this pattern deliberately. It
// carries its own rule AND its own observer in the same file, does not load
// navigator-shared.js, and is a different product from the Navigators.
const SELF_CONTAINED = 'streaming.html';

const SOURCES = fs.readdirSync(ROOT)
  .filter((f) => /\.(html|css)$/.test(f))
  .filter((f) => f !== SELF_CONTAINED)
  .map((f) => ({ file: f, src: fs.readFileSync(path.join(ROOT, f), 'utf8') }));

// Deliberately narrow. An element hidden until you hover it, open an
// accordion, or trigger a toast is fine — it appears because somebody acted.
// The bug is content hidden until a SCROLL OBSERVER decides to show it, which
// is invisible to a reader who scrolls faster than the observer fires and
// invisible forever to anyone whose JavaScript did not run.
test('nothing hides content until a scroll observer reveals it', () => {
  const offenders = [];
  for (const { file, src } of SOURCES) {
    if (!/IntersectionObserver/.test(src)) continue;
    // A page (or the shared bundle) that observes scrolling must not also be
    // shipping a rule that starts elements invisible.
    const hides = (src.match(/\.[a-z-]+\s*\{[^}]*opacity\s*:\s*0\s*[;}][^}]*\}/gi) || [])
      .filter((rule) => !/\.toast|\.faq-a\b|hidden|\[hidden\]/i.test(rule));
    for (const rule of hides) {
      offenders.push(`${file}: ${rule.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }
  assert.deepEqual(offenders, [],
    'a file both observes scrolling and hides elements with opacity:0. That combination is the '
    + 'scroll-reveal removed on 2026-09-10: bands of the page stay blank while a reader scrolls '
    + 'past them, and if the observer is ever deleted the content is hidden permanently:\n  '
    + offenders.join('\n  '));
});

test('the shared bundle no longer observes scrolling at all', () => {
  const js = fs.readFileSync(path.join(ROOT, 'navigator-shared.js'), 'utf8');
  assert.ok(!/IntersectionObserver/.test(js),
    'navigator-shared.js is loaded by every Navigator page; a scroll observer there affects all of them');
});

test('the reveal animation is gone from both halves, not one', () => {
  const css = fs.readFileSync(path.join(ROOT, 'navigator-shared.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'navigator-shared.js'), 'utf8');
  const cssHasIt = /\.reveal\s*\{/.test(css);
  const jsHasIt = /IntersectionObserver/.test(js) && /\.reveal/.test(js);
  assert.equal(cssHasIt, jsHasIt,
    cssHasIt
      ? 'navigator-shared.css hides .reveal elements but nothing in navigator-shared.js reveals them — '
        + 'every page that loads both is now blank'
      : 'navigator-shared.js observes .reveal elements that no stylesheet defines');
  assert.equal(cssHasIt, false, 'the reveal animation was removed; putting it back needs both halves');
});

test('no page carries a class that nothing anywhere defines', () => {
  // The specific orphan this cleanup left behind twice: closing.html and
  // closing-scorecard.html each kept a `.reveal.in` rule after the thing it
  // partnered was deleted elsewhere.
  const pages = SOURCES.filter(({ file }) => file.endsWith('.html'));
  const orphans = [];
  for (const { file, src } of pages) {
    const usesClass = /class="[^"]*\breveal\b[^"]*"/.test(src);
    const definesRule = /\.reveal\b/.test(src.replace(/class="[^"]*"/g, ''));
    if (usesClass || definesRule) orphans.push(file);
  }
  assert.deepEqual(orphans, [],
    `these pages still reference the removed reveal animation: ${orphans.join(', ')}`);
});
