// The paid report and the free scorecard must run the SAME audit.
//
// They did not. api/_lib/navigator-engine.js called runClosingAudit — the raw
// engine — while the scorecard called runDocumentAudit, which is that engine
// plus the document-intrinsic loan maths and minus the retired
// cannot-benchmark findings. The paid report was therefore built from a
// smaller audit than the free one.
//
// Not merely fewer reassurances. FEWER ERRORS. An APR disclosed below the note
// rate is a confirmed mathematical error and a potential TRID violation —
// checks 03 and 04 of the twenty-seven the marketing page enumerates by name.
// The free scorecard caught it. The paid report did not mention it at all.
//
// It also produced two symptoms that looked like the writer ignoring its
// instructions: told to name every check that passed it named one, because one
// was all it was handed; told never to mention benchmarking it kept writing a
// section about it, because six cannot-benchmark findings were sitting in the
// findings it was told to write up and not omit.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { runDocumentAudit } = require('../api/_lib/closing-service');

const amt = (value, page = 2) => ({ value, confidence: 0.99, page });
const li = (section, label, amount, category) => ({
  section, label, amount, category, page: 2, confidence: 0.99,
  paid_by: 'borrower', shoppable: false, amount_present: true, paid_before_closing: false,
});

// A loan whose own Loan Calculations box is internally consistent: $300,000 at
// 6.5% over 360 months pays $1,896.20/mo, and against an amount financed of
// $296,479.76 that implies an APR of 6.614%.
function extractionWith(overrides = {}) {
  return Object.assign({
    document_type: 'closing_disclosure',
    is_final: true,
    transaction_type: 'purchase',
    closing_date: '2026-04-15',
    loan_amount: 300000,
    interest_rate_pct: 6.5,
    loan_term_years: 30,
    pages_present: 5,
    property_state: 'VA',
    document_problems: [],
    prorations: [],
    line_items: [
      li('A', 'Underwriting Fee', 1095, 'origination'),
      li('B', 'Appraisal Fee', 650, 'appraisal'),
      li('C', 'Survey Fee', 475, 'survey'),
    ],
    section_totals: { A: amt(1095), B: amt(650), C: amt(475), J: amt(2220) },
    cash_to_close: {},
    monthly_principal_interest: amt(1896.2, 1),
    loan_calculations: {
      total_of_payments: amt(686152.24, 5),
      finance_charge: amt(386152.24, 5),
      amount_financed: amt(296479.76, 5),
      annual_percentage_rate_pct: 6.614,
      total_interest_percentage_pct: 127.5,
    },
    escrow: {},
    seller_credits_on_cd: [],
  }, overrides);
}

const run = (extraction) => runDocumentAudit({ extraction, answers: {} });
const ids = (findings) => findings.map((f) => f.checkId);

test('the loan-maths checks run at all', () => {
  // These are checks 02-09 on the marketing page. They live in the service
  // layer, so anything calling the raw engine gets none of them.
  //
  // Seven here, not nine: the escrow and discount-point checks need escrow
  // detail and a points line, which this deliberately minimal document does
  // not carry. Not running a check with no inputs is correct — the point is
  // that every check the document CAN support is present.
  const { findings } = run(extractionWith());
  const loanMath = ids(findings).filter((id) => /^LOAN_MATH/.test(id));
  assert.deepEqual(loanMath.sort(), [
    'LOAN_MATH_AMOUNT_FINANCED',
    'LOAN_MATH_APR',
    'LOAN_MATH_APR_FLOOR',
    'LOAN_MATH_FINANCE_CHARGE',
    'LOAN_MATH_PI',
    'LOAN_MATH_TIP',
    'LOAN_MATH_TOTAL_OF_PAYMENTS',
  ]);
});

test('the escrow and points checks run once the document carries them', () => {
  const { findings } = run(extractionWith({
    escrow: {
      monthly_escrow_payment: amt(470.83, 1),
      escrowed_property_costs_year1: amt(5650, 4),
      annual_disbursements: [
        { item: 'Property Taxes', annual_amount: 4200, confidence: 0.98 },
        { item: "Homeowner's Insurance", annual_amount: 1450, confidence: 0.98 },
      ],
    },
    points_lines: [{ points_pct: 0.25, charged_amount: 750 }],
    loan_amount: 300000,
  }));
  const loanMath = ids(findings).filter((id) => /^LOAN_MATH/.test(id));
  assert.ok(loanMath.includes('LOAN_MATH_ESCROW_MONTHLY'), loanMath.join(', '));
  assert.ok(loanMath.includes('LOAN_MATH_POINTS'), loanMath.join(', '));
});

test('an APR below the note rate is caught, not silently dropped', () => {
  const { findings } = run(extractionWith({
    loan_calculations: Object.assign(extractionWith().loan_calculations, {
      annual_percentage_rate_pct: 5.9,
    }),
  }));
  const floor = findings.find((f) => f.checkId === 'LOAN_MATH_APR_FLOOR');
  assert.ok(floor, 'the APR floor check produced no finding');
  assert.equal(floor.severity, 'confirmed_mathematical_error');
  const apr = findings.find((f) => f.checkId === 'LOAN_MATH_APR');
  assert.equal(apr.severity, 'potential_trid_violation');
});

test('retired benchmark findings never reach the customer', () => {
  const { findings } = run(extractionWith());
  const bench = findings.filter((f) => f.severity === 'cannot_benchmark');
  assert.deepEqual(bench.map((f) => f.title), [],
    'cannot-benchmark findings are filtered by the service and must stay filtered');
});

test('the cure deadline survives the service layer', () => {
  // Only the raw engine returned cureNote, which was one of the reasons the
  // report was calling the raw engine. It is computed when a tolerance finding
  // exists, so this needs a Loan Estimate showing the fee lower than the CD.
  const out = runDocumentAudit({
    extraction: extractionWith(),
    answers: { provider_list: 'yes' },
    loanEstimates: [{
      docId: 'LE1',
      dateIssued: '2026-03-14',
      dateReceived: '2026-03-14',
      loanAmount: 300000,
      changedCircumstanceDocumented: false,
      charges: {
        'origination:underwriting_fee': {
          label: 'Underwriting Fee', amount: 795, category: 'origination', shoppable: false,
        },
      },
    }],
  });
  assert.equal(typeof out.cureNote, 'string',
    'cureNote came back ' + JSON.stringify(out.cureNote));
  assert.match(out.cureNote, /1026\.19\(f\)\(2\)\(v\)/);
});

test('findings come back ranked, most severe first', () => {
  // closing-service guarded this with `audit.rank ? ... : findings` — but the
  // export is rankFindings, so the guard was always false and the sort the
  // comment promises never ran.
  const { findings } = run(extractionWith({
    loan_calculations: Object.assign(extractionWith().loan_calculations, {
      annual_percentage_rate_pct: 5.9,
    }),
  }));
  const firstWithinNorms = findings.findIndex((f) => f.severity === 'within_norms');
  const lastError = findings.map((f) => f.severity)
    .lastIndexOf('confirmed_mathematical_error');
  assert.ok(lastError < firstWithinNorms,
    'a confirmed error sorted after a passing check');
});

test('the report generator calls the service, not the raw engine', () => {
  // The contract this file exists to protect. A future edit that reaches for
  // runClosingAudit here silently shrinks the paid product again, and no
  // behavioural test would notice because both functions return findings.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'api', '_lib', 'navigator-engine.js'), 'utf8');
  assert.match(src, /runDocumentAudit\(/,
    'navigator-engine must build the report from runDocumentAudit');
  assert.doesNotMatch(src, /=\s*runClosingAudit\(/,
    'navigator-engine must not audit with the raw engine — it omits the loan '
    + 'maths and includes retired benchmark findings');
});
