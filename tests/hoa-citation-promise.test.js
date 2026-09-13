// hoa.html promises "Your top 5 concerns, each backed by a page-level
// citation". Until 2026-09-13 nothing enforced it.
//
// attachCitations() resolves evidence ids, drops the ones that do not resolve,
// counts them, logs a warning — and the report shipped anyway. A finding whose
// ids all failed landed beside four cited ones with nothing to tell them apart,
// which is the honesty defect the consistency audit classes as research
// advertised but not performed.
//
// The fix reorders rather than deletes. An uncited concern can still be real;
// what it must not do is occupy one of the top five the page sold as cited.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { demoteUncitedFindings, deriveHoaReserveFigures } = require('../api/_lib/hoa-engine');

const cite = (page) => ({
  document_title: 'Reserve Study', start_page: page, end_page: page,
  cited_text: 'Percent funded: 22.5%',
});

const finding = (concern, citations) => ({ concern, severity: 'High', detail: '', citations });

test('an uncited finding drops below every cited one', () => {
  const report = {
    findings: [
      finding('cited first', [cite(4)]),
      finding('uncited', []),
      finding('cited second', [cite(9)]),
    ],
  };

  const counts = demoteUncitedFindings(report);

  assert.deepEqual(report.findings.map((f) => f.concern),
    ['cited first', 'cited second', 'uncited']);
  assert.deepEqual(counts, { cited: 2, uncited: 1 });
});

test('the order within each group is preserved', () => {
  // The engine ranks findings by severity before this runs. Partitioning must
  // not reshuffle that — only move the uncited ones to the end.
  const report = {
    findings: [
      finding('A', [cite(1)]), finding('B', []), finding('C', [cite(2)]),
      finding('D', []), finding('E', [cite(3)]),
    ],
  };
  demoteUncitedFindings(report);
  assert.deepEqual(report.findings.map((f) => f.concern), ['A', 'C', 'E', 'B', 'D']);
});

test('an uncited finding is marked so the page can say so', () => {
  const report = { findings: [finding('cited', [cite(4)]), finding('uncited', [])] };
  demoteUncitedFindings(report);
  assert.equal(report.findings[0].uncited, undefined);
  assert.equal(report.findings[1].uncited, true);
});

test('a finding whose citations are all null counts as uncited', () => {
  // resolve() pushes nothing for an id that does not resolve, but a defensive
  // null in the array must not read as a citation.
  const report = { findings: [finding('hollow', [null, undefined])] };
  const counts = demoteUncitedFindings(report);
  assert.equal(counts.uncited, 1);
  assert.equal(report.findings[0].uncited, true);
});

test('nothing is deleted — an uncited concern can still be real', () => {
  const report = { findings: [finding('A', []), finding('B', []), finding('C', [])] };
  demoteUncitedFindings(report);
  assert.equal(report.findings.length, 3);
});

test('a report with no findings is left alone', () => {
  const empty = { findings: [] };
  assert.deepEqual(demoteUncitedFindings(empty), { cited: 0, uncited: 0 });
  assert.deepEqual(demoteUncitedFindings({}), { cited: 0, uncited: 0 });
});

// --- what the grader should and should not still complain about -------------

const { checkHoaConsistency } = require('../api/_lib/hoa-engine');

test('a finding already demoted and marked is not reported again', () => {
  // checkHoaConsistency runs last, to catch what survived the repairs. An
  // uncited finding that demoteUncitedFindings moved to the end and marked has
  // been handled — it is labelled on the page as drawn from the analysis
  // rather than quoted. Flagging it anyway put a warning in the logs of every
  // report that has one, and a warning that always fires is one nobody reads.
  const report = { findings: [finding('cited', [cite(4)]), finding('uncited', [])] };
  demoteUncitedFindings(report);

  const { problems } = checkHoaConsistency({ report });
  assert.deepEqual(problems.filter((p) => p.class === 'uncited_finding'), []);
});

test('a finding with no citation that nothing marked is still reported', () => {
  // The case that matters: the demotion did not run, or something added a
  // finding after it did. On the page that finding reads exactly like the ones
  // that are sourced.
  const report = { findings: [finding('cited', [cite(4)]), finding('slipped through', [])] };

  const { problems } = checkHoaConsistency({ report });
  const hit = problems.find((p) => p.class === 'uncited_finding');
  assert.ok(hit, 'an unmarked uncited finding must still be caught');
  assert.match(hit.message, /was not marked as uncited/);
});

// --- percent funded, recomputed from its own two inputs ---------------------

test('a mistyped percent funded is corrected from the balances it is made of', () => {
  const report = {
    reserve_health: {
      percent_funded: '45%',
      reserve_balance: '$412,000',
      fully_funded_balance: '$1,830,000',
    },
    key_numbers: [{ label: 'Reserves funded', value: '45%' }],
  };

  const changes = deriveHoaReserveFigures(report);

  assert.equal(report.reserve_health.percent_funded, '23%');
  assert.equal(report.key_numbers[0].value, '23%',
    'the header must not keep repeating a figure the body no longer states');
  assert.equal(changes.length, 2);
  assert.match(changes[0].basis, /\$412,000 \/ \$1,830,000/);
});

test('a correct figure is left exactly as written', () => {
  const report = {
    reserve_health: {
      percent_funded: '22.5%',
      reserve_balance: '$412,000',
      fully_funded_balance: '$1,830,000',
    },
    key_numbers: [],
  };
  assert.deepEqual(deriveHoaReserveFigures(report), []);
  assert.equal(report.reserve_health.percent_funded, '22.5%');
});

test('half a point of rounding is not a contradiction', () => {
  const report = {
    reserve_health: {
      percent_funded: '23%',
      reserve_balance: '$412,000',
      fully_funded_balance: '$1,830,000',
    },
    key_numbers: [],
  };
  assert.deepEqual(deriveHoaReserveFigures(report), []);
});

test('nothing is invented when a balance is missing', () => {
  const report = {
    reserve_health: {
      percent_funded: '45%',
      reserve_balance: '$412,000',
      fully_funded_balance: '',
    },
    key_numbers: [],
  };
  assert.deepEqual(deriveHoaReserveFigures(report), []);
  assert.equal(report.reserve_health.percent_funded, '45%',
    'with nothing to derive from, the model’s figure stands rather than being blanked');
});
