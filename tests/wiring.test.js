// Wiring checks.
//
// Four bugs in one day shared a single cause: a key was READ by one file and
// WRITTEN by none. The feature was built, tested in isolation, and never
// connected — so `loan_estimates` and `contract_terms` were both classified,
// priced at $59, and silently never used.
//
// Unit tests cannot catch that, because each half passes on its own. These
// checks are mechanical: they read the source and verify the halves meet.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_DIR = path.join(__dirname, '..', 'api');
const { FORM_DATA_KEYS, KNOWN_KEYS, mergeFormData, mergeScorecard, read } =
  require('../api/_lib/submission-store');

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Scoped to the closing product. The other eleven Navigators store their own
// shapes in the same column (contractor uses `category` and `zip`, for example),
// and declaring their keys here would make this file a dumping ground rather
// than a contract for one product.
const CLOSING_FILES = /closing-|navigator-engine\.js$/;

const SOURCES = jsFiles(API_DIR)
  .filter((f) => CLOSING_FILES.test(path.basename(f)))
  .map((f) => ({ file: f, src: fs.readFileSync(f, 'utf8') }));
const rel = (f) => path.relative(path.join(__dirname, '..'), f).replace(/\\/g, '/');

// Reads look like formData.x, stored.x, submission.form_data.x
const READ = /\b(?:formData|stored)\.([a-z_][a-z0-9_]*)\b/g;

test('every form_data key read by an endpoint is declared', () => {
  const undeclared = [];
  for (const { file, src } of SOURCES) {
    for (const m of src.matchAll(READ)) {
      const key = m[1];
      // Property accesses on those objects that are not storage keys.
      if (['email', 'token', 'id', 'product', 'ts', 'access_token', 'status', 'file_paths'].includes(key)) continue;
      // navigator-engine serves every product; keys belonging to the others are
      // not this contract's business.
      if (['category', 'zip', 'financing', 'timeline', 'budget', 'notes'].includes(key)) continue;
      if (!KNOWN_KEYS.includes(key)) undeclared.push(`${rel(file)} reads formData.${key}`);
    }
  }
  assert.deepEqual(undeclared, [],
    'Undeclared keys. Either a typo that will never be read, or a new field that belongs in FORM_DATA_KEYS:\n  '
    + undeclared.join('\n  '));
});

test('every declared form_data key is actually written somewhere', () => {
  // This is the check that would have caught loan_estimates and contract_terms
  // being read in three places and written in none.
  const neverWritten = [];
  for (const key of KNOWN_KEYS) {
    const written = SOURCES.some(({ src }) =>
      new RegExp(`(^|[^.\\w])${key}\\s*:`, 'm').test(src));
    if (!written) neverWritten.push(`${key} (owner declared as ${FORM_DATA_KEYS[key]})`);
  }
  assert.deepEqual(neverWritten, [],
    'Declared but never written — the feature reading these will silently do nothing:\n  '
    + neverWritten.join('\n  '));
});

test('the declared owner file exists and mentions the key', () => {
  const wrong = [];
  for (const [key, owner] of Object.entries(FORM_DATA_KEYS)) {
    const entry = SOURCES.find(({ file }) => rel(file) === owner);
    if (!entry) { wrong.push(`${key}: owner ${owner} does not exist`); continue; }
    if (!entry.src.includes(key)) wrong.push(`${key}: owner ${owner} never mentions it`);
  }
  assert.deepEqual(wrong, []);
});

// --- merge behaviour ---------------------------------------------------------

test('merging never discards keys the caller did not mention', () => {
  const existing = {
    extraction: { a: 1 }, loan_estimates: [{ docId: 'LE1' }],
    contract_terms: [{ amount: 100 }], tier: { id: 'full' }, answers: { x: 1 },
  };
  const merged = mergeFormData(existing, { scorecard: { flag_count: 0 } });

  assert.deepEqual(merged.loan_estimates, existing.loan_estimates);
  assert.deepEqual(merged.contract_terms, existing.contract_terms);
  assert.deepEqual(merged.tier, existing.tier);
  assert.deepEqual(merged.answers, existing.answers);
  assert.equal(merged.scorecard.flag_count, 0);
});

test('undefined leaves a key alone; null clears it deliberately', () => {
  const existing = { loan_estimates: [{ docId: 'LE1' }], contract_terms: [{ amount: 100 }] };
  const merged = mergeFormData(existing, { loan_estimates: undefined, contract_terms: null });
  assert.deepEqual(merged.loan_estimates, existing.loan_estimates);
  assert.equal(merged.contract_terms, null);
});

test('a scorecard merge keeps endpoint-level fields', () => {
  // buildScorecard returns only document-level fields. Replacing rather than
  // merging is what wiped tier and tolerance results after a correction.
  const previous = { tier: { id: 'full' }, tolerance_tested: true, loan_estimates_read: 1 };
  const fresh = { flag_count: 2, total_closing_costs: 5797.26 };
  const merged = mergeScorecard(previous, fresh, { cd_charge_lines: 23 });

  assert.deepEqual(merged.tier, { id: 'full' });
  assert.equal(merged.tolerance_tested, true);
  assert.equal(merged.flag_count, 2);
  assert.equal(merged.cd_charge_lines, 23);
});

test('reading an unknown key throws rather than returning undefined', () => {
  assert.throws(() => read({}, 'loan_estimate'), /unknown form_data key/);  // note the typo
  assert.equal(read({}, 'loan_estimates', null), null);
  assert.deepEqual(read({ loan_estimates: [1] }, 'loan_estimates'), [1]);
});
