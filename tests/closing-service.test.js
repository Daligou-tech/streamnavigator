// Run: node test/closing-service.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const svc = require('../api/_lib/closing-service');
const { Severity } = require('../api/_lib/closing-audit');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push(`${name}\n    ${err.message.split('\n')[0]}`); }
}

// A structurally complete CD with several planted defects.
const CD = () => ({
  document_type: 'closing_disclosure',
  transaction_type: 'purchase',
  loan_amount: 400000,
  interest_rate_pct: 6.5,
  loan_term_years: 30,
  sale_price: 500000,
  closing_date: '2026-03-15',
  property_state: 'MD',
  property_county: 'Baltimore City',
  monthly_principal_interest: { value: 2600, confidence: 0.98, page: 1 },
  loan_terms_features: { rate_can_increase: false, payment_can_increase: false },
  loan_calculations: {
    amount_financed: { value: 392000, confidence: 0.97, page: 5 },
    finance_charge: { value: 400000, confidence: 0.97, page: 5 },
    total_of_payments: { value: 925000, confidence: 0.97, page: 5 },
    annual_percentage_rate_pct: 6.4,
    total_interest_percentage_pct: 127.5,
  },
  points_lines: [{ points_pct: 1, charged_amount: 6000 }],
  line_items: [],
  section_totals: {},
  cash_to_close: {},
});

// A clean CD: correct payment, APR above the note rate, consistent page 5.
const CLEAN_CD = () => {
  const cd = CD();
  cd.monthly_principal_interest.value = 2528.27;
  cd.loan_calculations.finance_charge.value = 520000;
  cd.loan_calculations.total_of_payments.value = 925000;
  cd.loan_calculations.annual_percentage_rate_pct = 6.665;
  cd.loan_calculations.total_interest_percentage_pct = 127.5;
  cd.points_lines = [{ points_pct: 1, charged_amount: 4000 }];
  return cd;
};

// ---------------------------------------------------------------------------
// the catalog is the contract
// ---------------------------------------------------------------------------

test('the catalog names every checkId the engine can emit', () => {
  const dir = path.join(__dirname, '..', 'api', '_lib');
  const sources = ['closing-audit.js', 'closing-extract.js', 'closing-math.js']
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

  const emitted = new Set();
  const re = /checkId:\s*'([A-Z0-9_]+)'/g;
  let m;
  while ((m = re.exec(sources)) !== null) emitted.add(m[1]);

  const known = new Set([...svc.CATALOG_BY_ID.keys(), ...svc.BENCHMARK_CHECK_IDS]);
  const missing = [...emitted].filter((id) => !known.has(id));
  assert.deepStrictEqual(missing, [],
    `checkIds the engine emits but the catalog does not list: ${missing.join(', ')}. `
    + 'Add them to CATALOG or the scorecard denominator is wrong.');
});

test('no catalog entry names a check the engine cannot emit', () => {
  const dir = path.join(__dirname, '..', 'api', '_lib');
  const sources = ['closing-audit.js', 'closing-extract.js', 'closing-math.js']
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  const orphans = svc.CATALOG.filter((c) => !sources.includes(`checkId: '${c.id}'`));
  assert.deepStrictEqual(orphans.map((c) => c.id), []);
});

test('every catalog entry has a customer-readable label and a group', () => {
  for (const c of svc.CATALOG) {
    assert.ok(c.label && c.label.length > 15, `thin label on ${c.id}`);
    assert.ok(c.group, `no group on ${c.id}`);
    assert.ok(Object.values(svc.Needs).includes(c.needs), `bad needs on ${c.id}`);
  }
});

// ---------------------------------------------------------------------------
// benchmarks are absent, not merely disabled
// ---------------------------------------------------------------------------

test('no benchmark finding reaches the customer', () => {
  const r = svc.runDocumentAudit({ extraction: CD() });
  for (const f of r.findings) {
    assert.ok(!svc.BENCHMARK_CHECK_IDS.has(f.checkId), `benchmark finding leaked: ${f.checkId}`);
    assert.notStrictEqual(f.severity, Severity.CANNOT_BENCHMARK);
  }
});

test('benchmark gaps are named, never reduced to a count', () => {
  const { scorecard } = svc.runDocumentAudit({ extraction: CD() });
  // The old "10 of 14 fees, no rate data" told Sarah a number and nothing else.
  assert.ok(!('benchmarkable_count' in scorecard));
  assert.ok(!('cannot_benchmark_count' in scorecard));
  assert.ok(scorecard.benchmark_coverage, 'no coverage disclosure');
  assert.ok(/published rate or statute/.test(scorecard.evidence_basis));
});

test('the coverage disclosure names every unpriced category in plain English', () => {
  const cd = CD();
  cd.line_items = [
    { category: 'title_insurance_owners', amount: 1800, label: "Owner's Title Insurance" },
    { category: 'appraisal', amount: 650, label: 'Appraisal Fee' },
    { category: 'transfer_tax', amount: 6750, label: 'Transfer Tax' },
  ];
  const { scorecard } = svc.runDocumentAudit({ extraction: cd });
  const cov = scorecard.benchmark_coverage;

  // Only categories actually on the document are discussed.
  const named = [...cov.priced, ...cov.distribution, ...cov.unpriced].map((c) => c.category);
  assert.ok(!named.includes('survey'), 'discussed a category not on the document');

  assert.ok(cov.not_priced_sentence, 'nothing tells Sarah what is unpriced');
  // Real names, not codes.
  assert.ok(/Owner's title insurance/.test(cov.not_priced_sentence)
    || /Owner's title insurance/.test(JSON.stringify(cov.priced)),
    'title insurance is never named');
  assert.ok(/Appraisal fee/.test(cov.not_priced_sentence)
    || /Appraisal fee/.test(JSON.stringify(cov.priced)),
    'appraisal is never named');
});

test('the disclosure uses no vague quantifiers', () => {
  const cd = CD();
  cd.line_items = [
    { category: 'title_insurance_owners', amount: 1800 },
    { category: 'appraisal', amount: 650 },
    { category: 'settlement_service', amount: 900 },
    { category: 'survey', amount: 400 },
  ];
  const { scorecard } = svc.runDocumentAudit({ extraction: cd });
  const text = JSON.stringify(scorecard.benchmark_coverage).toLowerCase();
  for (const re of [/\ba few\b/, /\bseveral\b/, /\bsome of your\b/, /\bvarious\b/,
    /\ba number of\b/, /\bnumerous\b/, /\bmany of\b/]) {
    assert.ok(!re.test(text), `coverage disclosure contains a vague quantifier: ${re}`);
  }
});

test('charges verified by arithmetic are not reported as a coverage gap', () => {
  const cd = CD();
  cd.line_items = [{ category: 'prepaid_interest', amount: 480 }];
  const { scorecard } = svc.runDocumentAudit({ extraction: cd });
  const cov = scorecard.benchmark_coverage;
  assert.ok(!cov.unpriced.some((u) => u.category === 'prepaid_interest'),
    'prepaid interest listed as unpriced when it is verified exactly');
  assert.ok(cov.verified_by_arithmetic.some((x) => x.category === 'prepaid_interest'));
});

test('the null benchmark never returns a value', () => {
  assert.strictEqual(svc.NO_BENCHMARKS({ category: 'appraisal', state: 'MD' }), null);
  assert.strictEqual(svc.NO_BENCHMARKS.stacked({ category: 'transfer_tax' }).total, null);
});

// ---------------------------------------------------------------------------
// the CD alone produces sellable findings
// ---------------------------------------------------------------------------

test('a CD with planted defects yields multiple findings from the document alone', () => {
  const r = svc.runDocumentAudit({ extraction: CD() });
  const real = r.findings.filter((f) => f.severity !== Severity.WITHIN_NORMS
    && f.severity !== Severity.INFORMATIONAL);
  assert.ok(real.length >= 5, `expected several findings, got ${real.length}`);
  const ids = new Set(real.map((f) => f.checkId));
  for (const expected of ['LOAN_MATH_PI', 'LOAN_MATH_APR_FLOOR', 'LOAN_MATH_POINTS']) {
    assert.ok(ids.has(expected), `missing ${expected}`);
  }
});

test('a clean CD produces no error-severity findings', () => {
  const r = svc.runDocumentAudit({ extraction: CLEAN_CD() });
  const errs = r.findings.filter((f) => f.severity === Severity.CONFIRMED_MATH_ERROR
    || f.severity === Severity.POTENTIAL_TRID_VIOLATION);
  assert.deepStrictEqual(errs.map((f) => f.title), []);
});

// ---------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------

test('coverage assigns every catalog check exactly one status', () => {
  const r = svc.runDocumentAudit({ extraction: CD() });
  assert.strictEqual(r.coverage.length, svc.CATALOG.length);
  const valid = new Set(['ran', 'needs_document', 'not_applicable']);
  for (const c of r.coverage) assert.ok(valid.has(c.status), `${c.id}: ${c.status}`);
  assert.strictEqual(
    r.scorecard.checks_run + r.scorecard.checks_blocked + r.scorecard.checks_not_applicable,
    svc.CATALOG.length);
});

test('CD-only blocks the LE and contract checks and says so', () => {
  const r = svc.runDocumentAudit({ extraction: CD() });
  const blocked = r.coverage.filter((c) => c.status === 'needs_document');
  assert.ok(blocked.some((c) => c.blockedBy === svc.Needs.LE));
  assert.ok(blocked.some((c) => c.blockedBy === svc.Needs.CONTRACT));
  assert.ok(/Loan Estimate/.test(r.scorecard.coverage_headline));
});

test('the denominator is checks, not fees, and is reachable', () => {
  const r = svc.runDocumentAudit({ extraction: CD() });
  assert.strictEqual(r.scorecard.checks_total, svc.CATALOG.length);
  assert.ok(r.scorecard.checks_total > 20);
});

test('every blocked check becomes an unlock with a document it can accept', () => {
  const r = svc.runDocumentAudit({ extraction: CD() });
  assert.ok(r.scorecard.unlocks.length >= 2);
  for (const u of r.scorecard.unlocks) {
    assert.ok(u.title && u.why && u.accepts, 'unlock is a dead end');
    assert.ok(u.unlocks_count > 0);
    assert.ok(Array.isArray(u.unlocks) && u.unlocks.length === u.unlocks_count);
  }
});

test('answering the two questions clears that blocker', () => {
  const withAnswers = svc.runDocumentAudit({
    extraction: CD(), answers: { property_type: 'single_family' },
  });
  const blocked = withAnswers.coverage.filter(
    (c) => c.status === 'needs_document' && c.blockedBy === svc.Needs.ANSWERS);
  assert.deepStrictEqual(blocked.map((c) => c.id), []);
});

// ---------------------------------------------------------------------------
// price follows analysis that ran
// ---------------------------------------------------------------------------

test('CD alone is the basic price', () => {
  const r = svc.runDocumentAudit({ extraction: CD() });
  assert.strictEqual(r.tier.id, 'basic');
  assert.strictEqual(r.tier.price, svc.PRICES.basic);
});

test('an unusable Loan Estimate stays at the basic price and explains why', () => {
  const r = svc.runDocumentAudit({
    extraction: CD(), loanEstimates: null, unusableDocuments: ['loan_estimate'],
  });
  assert.strictEqual(r.tier.price, svc.PRICES.basic);
  assert.ok(r.tier.downgrade_reasons.length > 0);
  assert.ok(/could not be read/.test(r.tier.downgrade_reasons[0]));
});

test('a contract that reconciles moves the price up and names the checks that ran', () => {
  const r = svc.runDocumentAudit({
    extraction: CD(),
    contractTerms: { salePrice: 450000, sellerCredits: 5000 }, // deliberately mismatched
  });
  if (r.tier.id === 'full') {
    assert.strictEqual(r.tier.price, svc.PRICES.full);
    assert.ok(r.tier.upgrade_checks_ran.length > 0);
  } else {
    // If CONTRACT_RECON produced nothing, the price must NOT have moved.
    assert.strictEqual(r.tier.price, svc.PRICES.basic);
  }
});

test('the price is never full when no upgrade check produced a result', () => {
  const r = svc.runDocumentAudit({ extraction: CD(), contractTerms: {} });
  assert.strictEqual(r.tier.id, 'basic');
  assert.ok(/no check requiring another document produced a result/.test(r.tier.price_explanation));
});

// ---------------------------------------------------------------------------
// degradation
// ---------------------------------------------------------------------------

test('a sparse CD degrades to skips rather than throwing', () => {
  const r = svc.runDocumentAudit({
    extraction: { document_type: 'closing_disclosure', line_items: [], section_totals: {}, cash_to_close: {} },
  });
  assert.ok(Array.isArray(r.findings));
  assert.ok(r.skipped.length > 0);
  assert.strictEqual(r.tier.price, svc.PRICES.basic);
});

test('no extraction is a programmer error, not a silent empty report', () => {
  assert.throws(() => svc.runDocumentAudit({}), /requires an extraction/);
});

// ---------------------------------------------------------------------------

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n${failures.length} of ${total} failed:\n`);
  failures.forEach((f) => console.error('  x ' + f + '\n'));
  process.exit(1);
}
console.log(`${passed}/${total} passed`);
