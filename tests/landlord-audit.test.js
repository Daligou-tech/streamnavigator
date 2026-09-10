// The deterministic half of Landlord Navigator.
//
// The audit of 2026-09-10 found the product selling "required tenant notice
// periods and formats for your area" on top of a system prompt that forbade
// the model from stating an exact notice period, with an empty data/ directory
// behind it. api/_lib/landlord-audit.js replaced the guessing with matching,
// and these are the invariants that keep it honest.
//
// The load-bearing one is "no finding states a figure". Everything else in
// this file is a check behaving correctly; that one is the promise the page
// makes and the reason a landlord can act on a finding without being misled
// by it.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runLandlordAudit, Severity, EvidenceKind, CATALOG,
} = require('../api/_lib/landlord-audit');

// Fixed, so a test that depends on a countdown does not start failing in
// ninety days' time.
const ASOF = '2026-09-10';

function audit(properties) {
  return runLandlordAudit({ properties, asOf: ASOF });
}

function byId(result, checkId) {
  return result.findings.filter((f) => f.checkId === checkId);
}

const SEATTLE = { label: 'Ravenna duplex', city: 'Seattle', state: 'WA', year_built: 1994 };

// --- registration -----------------------------------------------------------

test('a covered city with no registration is a flagged requirement, not a suggestion', () => {
  const r = audit([{ ...SEATTLE, registered: 'no' }]);
  const [finding] = byId(r, 'REGISTRATION_MISSING');
  assert.ok(finding, 'Seattle runs RRIO and the landlord said they are not in it');
  assert.equal(finding.severity, Severity.REQUIREMENT_UNMET);
  assert.equal(finding.evidence, EvidenceKind.JURISDICTION_HIGH);
  assert.match(finding.title, /Seattle, WA/);
  assert.match(finding.recommendedAction, /Seattle Department of Construction and Inspections/);
});

test('a registered property comes back clean rather than silent', () => {
  const r = audit([{ ...SEATTLE, registered: 'yes' }]);
  const [finding] = byId(r, 'REGISTRATION_HELD');
  assert.ok(finding, 'a landlord who is compliant paid to be told so');
  assert.equal(finding.severity, Severity.WITHIN_NORMS);
  assert.equal(byId(r, 'REGISTRATION_MISSING').length, 0);
});

test('an unanswered registration question is reported as unanswered, not as met', () => {
  const r = audit([SEATTLE]);
  const [finding] = byId(r, 'REGISTRATION_UNKNOWN');
  assert.ok(finding);
  assert.equal(finding.severity, Severity.REQUIREMENT_LIKELY);
});

test('a confirm-first entry never produces a requirement-unmet finding', () => {
  // Cleveland is marked "check" in the reference set. The distinction between
  // "you are not registered" and "you may need to be" is the whole reason the
  // confidence field exists, and collapsing it is how a landlord ends up
  // arguing with a city about a rule that did not apply to them.
  const r = audit([{ city: 'Cleveland', state: 'OH', year_built: 1990, registered: 'no' }]);
  const [finding] = byId(r, 'REGISTRATION_MISSING');
  assert.ok(finding);
  assert.equal(finding.severity, Severity.REQUIREMENT_LIKELY);
  assert.equal(finding.confidence, 'check');
  assert.equal(finding.evidence, EvidenceKind.JURISDICTION_CHECK);
});

test('a city we hold nothing for is named, never passed over in silence', () => {
  const r = audit([{ city: 'Boise', state: 'ID', year_built: 1990 }]);
  const [gap] = byId(r, 'REGISTRATION_NOT_COVERED');
  assert.ok(gap, 'a short report on an uncovered city would otherwise read as a clean one');
  assert.equal(gap.severity, Severity.COVERAGE_GAP);
  assert.match(gap.title, /Boise, ID/);
  assert.deepEqual(r.coverage.uncovered, ['Boise, ID']);
  assert.deepEqual(r.coverage.covered, []);
});

test('a city with no registry is told so, which is worth knowing', () => {
  const r = audit([{ city: 'Austin', state: 'TX', year_built: 2001, registered: 'no' }]);
  const [finding] = byId(r, 'REGISTRATION_NOT_REQUIRED');
  assert.ok(finding, 'Austin has no general registry — the answer is "nothing to do", not a flag');
  assert.equal(finding.severity, Severity.WITHIN_NORMS);
  assert.equal(byId(r, 'REGISTRATION_MISSING').length, 0);
});

test('a state-level registration requirement reaches a city we hold no entry for', () => {
  // Arizona requires registration with the county assessor statewide, so a
  // landlord in Tucson is covered even though only Phoenix has a city entry.
  const r = audit([{ city: 'Tucson', state: 'AZ', year_built: 1999, registered: 'no' }]);
  const [finding] = byId(r, 'REGISTRATION_MISSING');
  assert.ok(finding, 'the statewide entry has to reach cities without their own');
  assert.equal(byId(r, 'REGISTRATION_NOT_COVERED').length, 0);
});

// --- dates ------------------------------------------------------------------

test('a lapsed registration counts the days and says so', () => {
  const r = audit([{ ...SEATTLE, registered: 'yes', registration_expires: '2026-08-01' }]);
  const [finding] = byId(r, 'REGISTRATION_EXPIRED');
  assert.ok(finding);
  assert.equal(finding.severity, Severity.REQUIREMENT_UNMET);
  assert.equal(finding.evidence, EvidenceKind.DATE_ARITHMETIC);
  assert.match(finding.title, /40 days ago/, 'the arithmetic is the finding');
});

test('a renewal inside ninety days is a deadline; one beyond it is not', () => {
  const soon = audit([{ ...SEATTLE, registration_expires: '2026-10-30' }]);
  assert.equal(byId(soon, 'REGISTRATION_DUE_SOON')[0].severity, Severity.DEADLINE_NEAR);

  const later = audit([{ ...SEATTLE, registration_expires: '2027-06-01' }]);
  assert.equal(byId(later, 'REGISTRATION_CURRENT')[0].severity, Severity.WITHIN_NORMS);
  assert.equal(byId(later, 'REGISTRATION_DUE_SOON').length, 0);
});

test('a lease ending inside the notice window is flagged with the day count', () => {
  const r = audit([{ ...SEATTLE, lease_ends: '2026-11-30' }]);
  const [finding] = byId(r, 'LEASE_NOTICE_WINDOW');
  assert.ok(finding);
  assert.equal(finding.severity, Severity.DEADLINE_NEAR);
  assert.match(finding.title, /81 days/);
  // The one number this product must never print, in the finding most tempting
  // to print it in.
  assert.equal(/\b(30|60|90) days'? notice\b/.test(finding.basis), false);
});

test('a lease far out is reported as clear rather than left off the report', () => {
  const r = audit([{ ...SEATTLE, lease_ends: '2027-08-01' }]);
  assert.equal(byId(r, 'LEASE_NOTICE_CLEAR')[0].severity, Severity.WITHIN_NORMS);
});

// --- lead -------------------------------------------------------------------

test('pre-1978 with no disclosure on file is flagged; post-1978 is settled by the year', () => {
  const old = audit([{ ...SEATTLE, year_built: 1948, lead_disclosure_on_file: 'no' }]);
  const [missing] = byId(old, 'LEAD_DISCLOSURE_MISSING');
  assert.ok(missing);
  assert.equal(missing.severity, Severity.REQUIREMENT_UNMET);
  assert.equal(missing.evidence, EvidenceKind.FEDERAL_RULE);

  const modern = audit([{ ...SEATTLE, year_built: 1994, lead_disclosure_on_file: 'no' }]);
  assert.equal(byId(modern, 'LEAD_DISCLOSURE_MISSING').length, 0);
  assert.equal(byId(modern, 'LEAD_NOT_TARGET_HOUSING')[0].severity, Severity.WITHIN_NORMS);
});

test('a child under six in a pre-1978 unit fires the state regime, and only once', () => {
  const r = audit([{
    label: 'Ashwood duplex', city: 'Cambridge', state: 'MA', year_built: 1908,
    child_under_six: 'yes', lead_disclosure_on_file: 'no',
  }]);
  const [child] = byId(r, 'LEAD_CHILD_STATE_REGIME');
  assert.ok(child, 'Massachusetts writes duties around exactly this fact pattern');
  assert.equal(child.severity, Severity.REQUIREMENT_UNMET);
  // LEAD_STATE covers the landlord who thinks disclosure is the end of it. When
  // the child check has already fired, saying it twice under two headings makes
  // a report look padded and buries the stronger of the two.
  assert.equal(byId(r, 'LEAD_STATE_REGIME').length, 0);
});

test('a pre-1978 unit in a lead-certificate state is flagged with no child present', () => {
  const r = audit([{ city: 'Providence', state: 'RI', year_built: 1920, child_under_six: 'no' }]);
  const [finding] = byId(r, 'LEAD_STATE_REGIME');
  assert.ok(finding);
  assert.equal(finding.severity, Severity.REQUIREMENT_LIKELY);
});

// --- deposits and permits ---------------------------------------------------

test('a commingled deposit is a requirement in a state that forbids it, a warning elsewhere', () => {
  const florida = audit([{ city: 'Miami', state: 'FL', year_built: 2004, deposit_held: 'commingled' }]);
  assert.equal(byId(florida, 'DEPOSIT_COMMINGLED')[0].severity, Severity.REQUIREMENT_UNMET);

  const texas = audit([{ city: 'Austin', state: 'TX', year_built: 2004, deposit_held: 'commingled' }]);
  assert.equal(byId(texas, 'DEPOSIT_COMMINGLED')[0].severity, Severity.VERIFY_LOCALLY);
});

test('holding no deposit produces no deposit finding at all', () => {
  const r = audit([{ ...SEATTLE, deposit_held: 'none' }]);
  assert.equal(r.findings.filter((f) => f.checkId.startsWith('DEPOSIT')).length, 0,
    'there is nothing to say about a deposit that does not exist');
});

test('planned work on a pre-1978 building raises the lead-safe contractor question', () => {
  const r = audit([{ ...SEATTLE, year_built: 1954, planned_work: 'replacing the roof' }]);
  const [finding] = byId(r, 'PERMIT_PLANNED_WORK');
  assert.ok(finding);
  assert.match(finding.basis, /certified for lead-safe renovation/);
  assert.match(finding.title, /replacing the roof/);
});

// --- the portfolio ----------------------------------------------------------

test('a portfolio in two states is told its lease template cannot be one template', () => {
  const r = audit([
    { city: 'Seattle', state: 'WA', year_built: 1994 },
    { city: 'Denver', state: 'CO', year_built: 1988 },
  ]);
  assert.equal(byId(r, 'PORTFOLIO_MULTI_STATE').length, 1);
  const single = audit([{ city: 'Seattle', state: 'WA', year_built: 1994 }]);
  assert.equal(byId(single, 'PORTFOLIO_MULTI_STATE').length, 0);
});

test('findings are labelled with the property they belong to', () => {
  const r = audit([
    { label: 'Cedar St', city: 'Kansas City', state: 'MO', year_built: 1954, registered: 'no' },
    { city: 'Denver', state: 'CO', year_built: 1988, registered: 'no' },
  ]);
  const names = new Set(r.findings.map((f) => f.property).filter(Boolean));
  assert.ok(names.has('Cedar St'), 'a nickname the landlord gave is the one they will recognise');
  assert.ok(names.has('Property 2'), 'and one they did not name still needs a handle');
});

test('a blank build year is a named skip, not a check that quietly did not run', () => {
  const r = audit([{ city: 'Seattle', state: 'WA' }]);
  assert.ok(r.skipped.some((s) => /federal lead-paint disclosure/.test(s)),
    `the skip has to be named so the customer knows which answer would turn it on: ${r.skipped.join('; ')}`);
  assert.ok(r.checksRun < r.checksTotal);
});

test('coverage is reported as two lists, not as a count', () => {
  const r = audit([
    { city: 'Seattle', state: 'WA', year_built: 1994 },
    { city: 'Boise', state: 'ID', year_built: 1990 },
  ]);
  assert.deepEqual(r.coverage.covered, ['Seattle, WA']);
  assert.deepEqual(r.coverage.uncovered, ['Boise, ID']);
});

// --- ranking ----------------------------------------------------------------

test('unmet requirements outrank deadlines, and the sooner deadline comes first', () => {
  const r = audit([
    { label: 'A', city: 'Seattle', state: 'WA', year_built: 1994, registration_expires: '2026-11-20' },
    { label: 'B', city: 'Denver', state: 'CO', year_built: 1988, registered: 'no', lease_ends: '2026-09-25' },
  ]);
  const order = r.findings.map((f) => f.severity);
  assert.equal(order[0], Severity.REQUIREMENT_UNMET, 'Denver is not registered — that leads');

  const deadlines = r.findings.filter((f) => f.severity === Severity.DEADLINE_NEAR);
  assert.ok(deadlines.length >= 2);
  assert.ok(deadlines[0].daysOut <= deadlines[1].daysOut,
    'a renewal fourteen days out and one eighty days out are not the same errand');
});

// --- the honesty invariants -------------------------------------------------

test('no finding anywhere states a fee, a penalty, or an ordinance number', () => {
  // The promise the page makes, enforced over every string this engine can
  // produce, on a portfolio built to trip every check. A figure here is not a
  // typo — it is the failure mode this whole rewrite exists to prevent, and
  // the reason the reference set holds no fees to leak in the first place.
  const r = audit([
    { label: 'A', city: 'Boston', state: 'MA', year_built: 1901, child_under_six: 'yes',
      lead_disclosure_on_file: 'no', registered: 'no', deposit_held: 'commingled',
      lease_ends: '2026-10-20', registration_expires: '2026-08-01', planned_work: 'gut the kitchen' },
    { label: 'B', city: 'Chicago', state: 'IL', year_built: 1962, registered: 'yes',
      deposit_held: 'commingled', lease_ends: '2027-05-01' },
    { label: 'C', city: 'Boise', state: 'ID', year_built: 1999 },
    { label: 'D', city: 'Philadelphia', state: 'PA', year_built: 1930, lead_disclosure_on_file: 'yes' },
  ]);
  assert.ok(r.findings.length > 15, `only ${r.findings.length} findings on a portfolio built to trip everything`);

  const MONEY = /\$\s?\d/;
  // "§ 5-12-170", "Section 8-2 of", "Ordinance 21-0435", "Chapter 22.214".
  const CITATION = /§|\b(?:ordinance|statute|code section|chapter)\s+[\d.-]+|\bsection\s+\d+[\d.-]*\b/i;
  const offenders = [];
  for (const finding of r.findings) {
    for (const key of ['title', 'basis', 'recommendedAction', 'verifyWith']) {
      const text = String(finding[key] || '');
      if (MONEY.test(text)) offenders.push(`${finding.checkId}.${key}: a dollar figure — "${text.slice(0, 90)}"`);
      if (CITATION.test(text)) offenders.push(`${finding.checkId}.${key}: a citation — "${text.slice(0, 90)}"`);
    }
  }
  assert.deepEqual(offenders, [],
    'the engine holds no fees and no citations, so printing one means it was invented:\n  '
    + offenders.join('\n  '));
});

test('every finding names an office to confirm it with, and carries a confidence', () => {
  const r = audit([
    { city: 'Seattle', state: 'WA', year_built: 1955, registered: 'no', deposit_held: 'commingled',
      lease_ends: '2026-10-01', planned_work: 'rewire' },
    { city: 'Boise', state: 'ID', year_built: 2010 },
  ]);
  const bad = r.findings.filter((f) => !f.verifyWith || !['high', 'check'].includes(f.confidence));
  assert.deepEqual(bad.map((f) => f.checkId), [],
    'naming the office IS the answer this product gives in place of a figure — a finding without one '
    + 'is a dead end, and one without a confidence cannot be written up honestly');
});

test('a malformed answer costs that check, not the rest of the report', () => {
  const r = audit([{ city: 'Seattle', state: 'WA', year_built: 'nineteen-oh-eight', registered: 'no' }]);
  assert.ok(byId(r, 'REGISTRATION_MISSING').length, 'the registration check does not need the year');
  assert.ok(r.skipped.some((s) => /lead/.test(s)), 'and the lead check reports itself as skipped');
});

test('no properties produces no findings and no invented portfolio', () => {
  const r = audit([]);
  assert.deepEqual(r.findings, []);
  assert.equal(r.checksTotal, 0);
});

// --- the catalog itself -----------------------------------------------------

test('every check declares a label and an id, and no id is used twice', () => {
  const ids = CATALOG.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate check id in the catalog');
  assert.deepEqual(CATALOG.filter((c) => !c.label).map((c) => c.id), [],
    'a check with no label cannot be named in the skipped list');
  assert.ok(CATALOG.length >= 9, `only ${CATALOG.length} checks — the page sells ten`);
});
