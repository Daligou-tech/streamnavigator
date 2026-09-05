// Run: node tests/legal.test.js
//
// The legal pages are the one part of the site nobody re-reads. A liability cap
// that names an entity which does not exist protects nothing, and a governing
// law clause with an unfilled blank in it is worse than no clause at all --
// both fail silently and look fine.
//
// This suite exists because the shipped cap named "STREAMNAVIGATOR, INC." while
// every other one of the 22 entity references on the site said "StreamNavigator
// LLC". Nothing caught it for as long as it sat there.
//
// Same idea as check-prices.js: the guard is cheap, the failure it prevents is
// not.
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}\n    ${err.message.split('\n')[0]}`); }
}

const root = path.join(__dirname, '..');
const LEGAL_PAGES = ['terms.html', 'privacy-policy.html'];
const terms = fs.readFileSync(path.join(root, 'terms.html'), 'utf8');

// The legal entity. One name, everywhere, or the cap is arguably a cap on
// somebody else's liability.
const ENTITY = 'StreamNavigator LLC';

test('no legal page names an entity other than ' + ENTITY, () => {
  const wrong = [];
  for (const file of LEGAL_PAGES) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    text.split('\n').forEach((line, i) => {
      // Any "StreamNavigator, Inc." / "StreamNavigator Inc" spelling, in any case.
      if (/streamnavigator,?\s+inc\.?/i.test(line)) wrong.push(`${file}:${i + 1}`);
    });
  }
  if (wrong.length) {
    throw new Error('entity named as "Inc." at ' + wrong.join(', ') + ' -- should be ' + ENTITY);
  }
});

test('no unresolved drafting placeholder is live on a legal page', () => {
  const left = [];
  for (const file of LEGAL_PAGES) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/\[\[[A-Z_]+\]\]/.test(line)) {
        left.push(`${file}:${i + 1} ${(line.match(/\[\[[A-Z_]+\]\]/) || [])[0]}`);
      }
    });
  }
  if (left.length) {
    throw new Error('placeholder still in the shipped page: ' + left.join(', '));
  }
});

test('the limitation of liability caps damages at fees paid', () => {
  if (!/TOTAL AGGREGATE LIABILITY/i.test(terms)) throw new Error('no aggregate liability cap found');
  if (!/AMOUNT YOU ACTUALLY PAID US/i.test(terms)) throw new Error('cap is not tied to fees actually paid');
});

test('the arbitration agreement and class-action waiver are both present', () => {
  if (!/id="disputes"/.test(terms)) throw new Error('no dispute resolution section');
  if (!/binding individual arbitration/i.test(terms)) throw new Error('no agreement to arbitrate');
  if (!/class-action waiver/i.test(terms)) throw new Error('no class-action waiver');
  // An arbitration clause with no opt-out is materially weaker on
  // unconscionability review. Cheap to keep, expensive to have skipped.
  if (!/Arbitration Opt-Out/i.test(terms)) throw new Error('no opt-out mechanism');
});

test('the closing audit is disclaimed as not legal advice', () => {
  if (!/not legal advice/i.test(terms)) throw new Error('closing audit is not disclaimed as non-advice');
  if (!/TILA|RESPA|TRID/.test(terms)) throw new Error('no disclaimer of compliance determination');
});

test('the survival clause covers the sections that need to survive', () => {
  const survival = (terms.match(/Sections that by their nature[^<]*/) || [''])[0];
  for (const needed of ['Disclaimers', 'Limitation of Liability', 'Arbitration', 'Governing Law']) {
    if (!survival.includes(needed)) throw new Error(needed + ' is not listed as surviving termination');
  }
});

// Renumbering by hand is how a table of contents starts pointing at the wrong
// section. Check the anchors and the numbers against each other instead.
test('the table of contents matches the sections, in order', () => {
  const tocIds = [...terms.matchAll(/<li><a href="#([a-z-]+)">/g)].map((m) => m[1]);
  const bodyIds = [...terms.matchAll(/<h2 id="([a-z-]+)">/g)].map((m) => m[1]);
  if (tocIds.join(',') !== bodyIds.join(',')) {
    throw new Error('toc [' + tocIds.join(', ') + '] != body [' + bodyIds.join(', ') + ']');
  }
});

test('section numbers run 1..N with no gaps or repeats', () => {
  const nums = [...terms.matchAll(/<h2 id="[a-z-]+">(\d+)\./g)].map((m) => Number(m[1]));
  const expected = nums.map((_, i) => i + 1);
  if (nums.join(',') !== expected.join(',')) {
    throw new Error('numbered ' + nums.join(',') + ' -- expected ' + expected.join(','));
  }
});

test('every in-page anchor resolves to a real section', () => {
  const bodyIds = new Set([...terms.matchAll(/<h2 id="([a-z-]+)">/g)].map((m) => m[1]));
  const dangling = [...terms.matchAll(/href="#([a-z-]+)"/g)]
    .map((m) => m[1])
    .filter((id) => id !== 'top' && !bodyIds.has(id));
  if (dangling.length) throw new Error('dangling anchors: ' + [...new Set(dangling)].join(', '));
});

const total = passed + failures.length;
if (failures.length) {
  console.error(`${passed}/${total} passed`);
  failures.forEach((f) => console.error('  FAIL  ' + f));
  process.exit(1);
}
console.log(`${passed}/${total} passed`);
