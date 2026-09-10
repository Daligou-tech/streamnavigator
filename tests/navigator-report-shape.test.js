// The report the engine stores must have the shape the renderers expect.
//
// Live evidence, rental submission 37466c44 on 2026-09-09: the tool schema
// declares missing_or_uncertain as an array of strings, and the model returned
// the STRING '["No live rental comp data...","Insurance competitiveness..."]}'
// — a serialised array with a stray brace on the end. Five real, useful
// caveats, in a container the page could not read.
//
// Nothing caught it. The tag-leak check looks for angle brackets and there were
// none. The JSON parsed. It was stored, served, and navigator-status.html
// called .forEach on a string.
//
// That throw did not merely drop one list. Everything after the failing line
// was abandoned, and after that line sit renderFixups() and the automatic PDF
// email. The customer saw a "What I couldn't verify" heading over an empty
// list, and the copy the intake page promised would arrive automatically never
// sent. One wrong container, three losses.
//
// These tests pin the normaliser that now sits between the model and the
// database. The content is never the thing at fault in this failure mode, so
// the rule is: recover every string, drop nothing.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal } = require('../api/_lib/navigator-engine');
const { normalizeReport, coerceStringArray } = __internal;

test('a serialised array with a trailing brace is recovered, not discarded', () => {
  const raw = '["No live rental comp data was available.","Insurance competitiveness could not be verified."]}';
  assert.deepEqual(coerceStringArray(raw), [
    'No live rental comp data was available.',
    'Insurance competitiveness could not be verified.',
  ]);
});

test('a clean array passes through unchanged', () => {
  assert.deepEqual(coerceStringArray(['a', 'b']), ['a', 'b']);
});

test('plain prose becomes a single item rather than being thrown away', () => {
  assert.deepEqual(coerceStringArray('I could not verify the rent comps.'),
    ['I could not verify the rent comps.']);
});

test('unparseable bracket text is kept whole rather than lost', () => {
  const raw = '["broken, no closing quote]';
  const out = coerceStringArray(raw);
  assert.equal(out.length, 1);
  assert.ok(out[0].includes('broken'), 'the customer-facing text must survive');
});

test('absent and empty values normalise to an empty array, never undefined', () => {
  for (const value of [undefined, null, '', '   ', 42, {}]) {
    assert.deepEqual(coerceStringArray(value), [], `failed for ${JSON.stringify(value)}`);
  }
});

test('normalizeReport repairs every list the renderers iterate', () => {
  const out = normalizeReport({
    headline: 'H',
    summary: 'S',
    sections: [{ title: 'A', items: '["one","two"]}' }, { title: 'B', items: ['three'] }],
    missing_or_uncertain: '["x"]}',
    key_numbers: [{ label: 'L', value: 'V' }, 'junk', null],
  });
  assert.ok(Array.isArray(out.missing_or_uncertain) && out.missing_or_uncertain.length === 1);
  assert.deepEqual(out.sections[0].items, ['one', 'two']);
  assert.deepEqual(out.sections[1].items, ['three']);
  assert.deepEqual(out.key_numbers, [{ label: 'L', value: 'V' }]);
  assert.equal(out.headline, 'H', 'normalising must not disturb the scalar fields');
});

test('a report whose sections are unusable normalises to zero sections', () => {
  // The engine treats this as a failed attempt and retries rather than storing
  // a report with no body. See generateNavigatorReport.
  assert.deepEqual(normalizeReport({ headline: 'H', sections: 'not a list' }).sections, []);
  assert.deepEqual(normalizeReport({ headline: 'H' }).sections, []);
});
