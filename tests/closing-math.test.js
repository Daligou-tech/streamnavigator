// Run: node test/closing-math.test.js

'use strict';

const assert = require('assert');
const m = require('../api/_lib/closing-math');
const { Severity } = require('../api/_lib/closing-audit');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push(`${name}\n    ${err.message.split('\n')[0]}`); }
}

// A clean, ordinary fixed-rate purchase loan used as the baseline.
// $400,000 at 6.5% for 360 months.
const PI = m.monthlyPI(400000, 6.5, 360);          // 2528.27
const CLEAN = {
  loanAmount: 400000,
  annualRatePct: 6.5,
  termMonths: 360,
  statedPI: Math.round(PI * 100) / 100,
  amountFinanced: 392000,                           // $8,000 prepaid finance charges
  totalOfPayments: 925000,
  financeCharge: 520000,
  statedApr: 6.665,
  statedTipPct: 127.5,
  monthlyEscrow: 500,
  escrowedPropertyCostsYear1: 6000,
  terms: {},
};

// ---------------------------------------------------------------------------
// amortisation primitives
// ---------------------------------------------------------------------------

test('monthlyPI matches a hand-checked amortisation', () => {
  // $400,000 @ 6.5% / 360 -> $2,528.27
  assert.strictEqual(Math.round(m.monthlyPI(400000, 6.5, 360) * 100) / 100, 2528.27);
  // $250,000 @ 7.0% / 360 -> $1,663.26
  assert.strictEqual(Math.round(m.monthlyPI(250000, 7.0, 360) * 100) / 100, 1663.26);
  // $100,000 @ 5.0% / 180 -> $790.79
  assert.strictEqual(Math.round(m.monthlyPI(100000, 5.0, 180) * 100) / 100, 790.79);
});

test('a zero-rate loan amortises to simple division', () => {
  assert.strictEqual(m.monthlyPI(120000, 0, 120), 1000);
});

test('solveApr inverts monthlyPI when there are no fees', () => {
  // With amountFinanced === loanAmount the APR is the note rate.
  const apr = m.solveApr(400000, m.monthlyPI(400000, 6.5, 360), 360);
  assert.ok(Math.abs(apr - 6.5) < 0.001, `got ${apr}`);
});

test('solveApr rises above the note rate once fees are financed', () => {
  const apr = m.solveApr(392000, m.monthlyPI(400000, 6.5, 360), 360);
  assert.ok(apr > 6.5, `expected > 6.5, got ${apr}`);
  assert.ok(apr < 7.0, `implausibly high: ${apr}`);
});

test('solveApr declines when the payments cannot repay the principal', () => {
  assert.strictEqual(m.solveApr(400000, 100, 360), null);
});

// ---------------------------------------------------------------------------
// gating
// ---------------------------------------------------------------------------

test('the level-payment gate blocks each irregular feature by name', () => {
  const cases = [
    ['rate_can_increase', /interest rate can increase/],
    ['payment_can_increase', /principal and interest can increase/],
    ['has_balloon_payment', /balloon/],
    ['has_interest_only_period', /interest-only/],
  ];
  for (const [flag, re] of cases) {
    const g = m.levelPaymentApplies({ [flag]: true });
    assert.strictEqual(g.ok, false, `${flag} should block`);
    assert.ok(re.test(g.reasons.join(' ')), `${flag} reason not explained`);
  }
  assert.strictEqual(m.levelPaymentApplies({}).ok, true);
});

test('two-sided checks skip on an ARM rather than firing', () => {
  const arm = { ...CLEAN, statedPI: 1, terms: { rate_can_increase: true } };
  for (const fn of [m.checkMonthlyPI, m.checkAprAgainstStatedFigures,
    m.checkFinanceChargeFloor, m.checkTotalOfPaymentsFloor, m.checkTip]) {
    const r = fn(arm);
    assert.ok(r.skipped, `${fn.name} fired on an ARM instead of skipping`);
    assert.ok(/increase/.test(r.skipped), `${fn.name} did not say why`);
  }
});

test('every check skips rather than throwing on missing inputs', () => {
  const { findings, skipped } = m.runLoanMath({});
  assert.strictEqual(findings.length, 0);
  assert.strictEqual(skipped.length, 8);
});

// ---------------------------------------------------------------------------
// the clean loan produces no errors
// ---------------------------------------------------------------------------

test('a clean fixed-rate loan raises no error-severity findings', () => {
  const { findings } = m.runLoanMath(CLEAN);
  const bad = findings.filter((f) => f.severity !== Severity.WITHIN_NORMS);
  assert.deepStrictEqual(bad.map((f) => f.checkId), [], JSON.stringify(bad.map((f) => f.title)));
});

// ---------------------------------------------------------------------------
// each check catches its own defect
// ---------------------------------------------------------------------------

test('a wrong monthly payment is caught and priced over the term', () => {
  const r = m.checkMonthlyPI({ ...CLEAN, statedPI: 2600 });
  assert.strictEqual(r.severity, Severity.CONFIRMED_MATH_ERROR);
  assert.ok(r.dollarImpact > 70 && r.dollarImpact < 73, `impact ${r.dollarImpact}`);
  // 71.73 x 360 = 25,822.80. toDollars returns a bare Number, matching the
  // formatting used elsewhere in the engine, so match on the digits.
  assert.ok(/25822/.test(r.whyItMatters), `should price the error over the term: ${r.whyItMatters}`);
});

test('a payment within a dollar is treated as rounding', () => {
  const r = m.checkMonthlyPI({ ...CLEAN, statedPI: CLEAN.statedPI + 0.6 });
  assert.strictEqual(r.severity, Severity.WITHIN_NORMS);
});

test('an APR below the note rate is caught without any gate', () => {
  const r = m.checkAprFloor({ statedApr: 6.4, annualRatePct: 6.5, financeCharge: 500 });
  assert.strictEqual(r.severity, Severity.CONFIRMED_MATH_ERROR);
});

test('the APR floor still applies to an ARM', () => {
  const r = m.checkAprFloor({ statedApr: 5.9, annualRatePct: 6.5, financeCharge: 1 });
  assert.strictEqual(r.severity, Severity.CONFIRMED_MATH_ERROR);
});

test('an understated APR beyond the 0.125 tolerance is caught', () => {
  const r = m.checkAprAgainstStatedFigures({ ...CLEAN, statedApr: 6.4 });
  assert.strictEqual(r.severity, Severity.POTENTIAL_TRID_VIOLATION);
  assert.ok(/lower than/.test(r.title));
});

test('an APR inside the 0.125 tolerance passes', () => {
  const exact = m.solveApr(CLEAN.amountFinanced, CLEAN.statedPI, CLEAN.termMonths);
  const r = m.checkAprAgainstStatedFigures({ ...CLEAN, statedApr: exact + 0.12 });
  assert.strictEqual(r.severity, Severity.WITHIN_NORMS);
});

test('a finance charge below interest alone is caught', () => {
  const r = m.checkFinanceChargeFloor({ ...CLEAN, financeCharge: 400000 });
  assert.strictEqual(r.severity, Severity.POTENTIAL_TRID_VIOLATION);
  assert.ok(r.dollarImpact > 0);
});

test('the finance charge floor allows the $100 Regulation Z tolerance', () => {
  const floor = CLEAN.statedPI * CLEAN.termMonths - CLEAN.amountFinanced;
  assert.strictEqual(
    m.checkFinanceChargeFloor({ ...CLEAN, financeCharge: floor - 99 }).severity,
    Severity.WITHIN_NORMS);
  assert.strictEqual(
    m.checkFinanceChargeFloor({ ...CLEAN, financeCharge: floor - 101 }).severity,
    Severity.POTENTIAL_TRID_VIOLATION);
});

test('a total of payments below the payment schedule is caught', () => {
  const r = m.checkTotalOfPaymentsFloor({ ...CLEAN, totalOfPayments: 800000 });
  assert.strictEqual(r.severity, Severity.CONFIRMED_MATH_ERROR);
});

test('an amount financed above the loan amount is caught', () => {
  const r = m.checkAmountFinancedCeiling({ amountFinanced: 405000, loanAmount: 400000 });
  assert.strictEqual(r.severity, Severity.CONFIRMED_MATH_ERROR);
  assert.strictEqual(r.dollarImpact, 5000);
});

test('the amount financed ceiling needs no gate and passes on an ARM', () => {
  const r = m.checkAmountFinancedCeiling({ amountFinanced: 392000, loanAmount: 400000 });
  assert.strictEqual(r.severity, Severity.WITHIN_NORMS);
});

test('a wrong total interest percentage is caught', () => {
  const r = m.checkTip({ ...CLEAN, statedTipPct: 90 });
  assert.strictEqual(r.severity, Severity.POTENTIAL_TRID_VIOLATION);
});

test('points that do not match their own percentage are caught', () => {
  // 1% of $400,000 is $4,000, not $6,000.
  const r = m.checkPointsArithmetic({ pointsPct: 1, loanAmount: 400000, chargedAmount: 6000 });
  assert.strictEqual(r.severity, Severity.CONFIRMED_MATH_ERROR);
  assert.strictEqual(r.expected, 4000);
  assert.strictEqual(r.dollarImpact, 2000);
});

test('points that match pass', () => {
  const r = m.checkPointsArithmetic({ pointsPct: 0.75, loanAmount: 400000, chargedAmount: 3000 });
  assert.strictEqual(r.severity, Severity.WITHIN_NORMS);
});

test('escrow over-collection is priced over the year', () => {
  const r = m.checkEscrowMonthlyVsAnnual({ monthlyEscrow: 600, escrowedPropertyCostsYear1: 6000 });
  assert.ok(/more than/.test(r.title));
  assert.strictEqual(r.dollarImpact, 1200);
});

test('escrow under-collection is reported as a coming shortage', () => {
  const r = m.checkEscrowMonthlyVsAnnual({ monthlyEscrow: 400, escrowedPropertyCostsYear1: 6000 });
  assert.ok(/less than/.test(r.title));
  assert.ok(/shortage/.test(r.whyItMatters));
});

// ---------------------------------------------------------------------------
// the property that makes these safe to sell without a benchmark
// ---------------------------------------------------------------------------

test('one-sided checks never fire on an overstatement', () => {
  // Every floor/ceiling check must stay silent when the document errs in the
  // direction that is arithmetically possible. This is what stops a false
  // accusation on a loan whose structure we have not modelled.
  assert.strictEqual(
    m.checkFinanceChargeFloor({ ...CLEAN, financeCharge: 900000 }).severity,
    Severity.WITHIN_NORMS);
  assert.strictEqual(
    m.checkTotalOfPaymentsFloor({ ...CLEAN, totalOfPayments: 1500000 }).severity,
    Severity.WITHIN_NORMS);
  assert.strictEqual(
    m.checkAmountFinancedCeiling({ amountFinanced: 100, loanAmount: 400000 }).severity,
    Severity.WITHIN_NORMS);
  assert.strictEqual(
    m.checkAprFloor({ statedApr: 9.9, annualRatePct: 6.5, financeCharge: 1 }).severity,
    Severity.WITHIN_NORMS);
});

test('every finding carries a basis, a check id and internal-arithmetic evidence', () => {
  const { findings } = m.runLoanMath({ ...CLEAN, statedPI: 2600, statedApr: 6.4 });
  assert.ok(findings.length > 0);
  for (const f of findings) {
    assert.ok(f.checkId, 'missing checkId');
    assert.ok(f.basis && f.basis.length > 40, `thin basis on ${f.checkId}`);
    assert.strictEqual(f.evidence, 'hard_rule:internal_arithmetic');
  }
});

test('no finding reaches a legal conclusion', () => {
  const { findings } = m.runLoanMath({ ...CLEAN, statedPI: 2600, statedApr: 6.4,
    financeCharge: 400000, totalOfPayments: 800000 });
  const text = JSON.stringify(findings).toLowerCase();
  // Word-boundary matching: "reissue" legitimately contains "sue".
  for (const re of [/\billegal\b/, /you are entitled/, /violation of law/, /\bsue\b/,
    /\bdamages\b/, /\bunlawful\b/]) {
    assert.ok(!re.test(text), `finding text matches ${re}`);
  }
});

// ---------------------------------------------------------------------------

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n${failures.length} of ${total} failed:\n`);
  failures.forEach((f) => console.error('  x ' + f + '\n'));
  process.exit(1);
}
console.log(`${passed}/${total} passed`);
