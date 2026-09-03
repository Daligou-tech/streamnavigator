// Loan-math checks that need nothing but the Closing Disclosure itself.
//
// Every check here is arithmetic on figures printed on the document. No rate
// table, no benchmark corpus, no market data, no model judgement. If the
// customer uploads one CD and nothing else, all of this runs.
//
// The design rule is ONE-SIDED BOUNDS wherever a bound exists.
//
// A two-sided check ("this should equal X") fires whenever our model of the
// loan is wrong -- an interest-only period, a step rate, MI that drops off at
// 78%, a buydown. A one-sided check ("this cannot be less than X") fires only
// when the document states something arithmetically impossible, and the
// impossibility does not depend on our model being complete. A floor violation
// is a fact about the document. That distinction is what makes these safe to
// sell without a benchmark behind them.
//
// Two-sided checks are still here, because exact identities like the payment
// formula are worth testing, but each one is gated: it declines to run unless
// the loan is fixed-rate and fully amortising with a level payment, and it
// says so instead of guessing.

'use strict';

const audit = require('./closing-audit');

const { Severity, EvidenceKind, Actionability, finding, toCents, toDollars } = audit;

const ARITH = EvidenceKind.INTERNAL_ARITHMETIC;

// Regulation Z accuracy tolerances.
const APR_TOLERANCE_REGULAR = 0.125;      // §1026.22(a)(2), 1/8 of 1 percentage point
const FINANCE_CHARGE_TOLERANCE = 100;     // §1026.18(d)(1), real-property-secured
const DOLLAR_ROUNDING = 1.0;              // payment tables round to the dollar

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---------------------------------------------------------------------------
// amortisation
// ---------------------------------------------------------------------------

/** Level monthly principal-and-interest payment. */
function monthlyPI(loanAmount, annualRatePct, termMonths) {
  const i = annualRatePct / 100 / 12;
  if (i === 0) return loanAmount / termMonths;
  return (loanAmount * i) / (1 - Math.pow(1 + i, -termMonths));
}

/** Present value of `n` level payments of `pmt` at monthly rate `i`. */
function pv(pmt, i, n) {
  if (i === 0) return pmt * n;
  return (pmt * (1 - Math.pow(1 + i, -n))) / i;
}

/**
 * Solve for the annual percentage rate that equates a level payment stream to
 * the amount financed, by bisection. Bisection rather than Newton because it
 * cannot diverge, and a wrong APR here would be an accusation.
 * Returns null if no rate in a sane range fits.
 */
function solveApr(amountFinanced, payment, n) {
  if (!(amountFinanced > 0) || !(payment > 0) || !(n > 0)) return null;
  if (payment * n <= amountFinanced) return null; // no finance charge to solve for

  let lo = 0;
  let hi = 1; // 100% per month, far above any real mortgage
  for (let k = 0; k < 200; k += 1) {
    const mid = (lo + hi) / 2;
    if (pv(payment, mid, n) > amountFinanced) lo = mid;
    else hi = mid;
  }
  const apr = ((lo + hi) / 2) * 12 * 100;
  return Number.isFinite(apr) ? Math.round(apr * 1000) / 1000 : null;
}

// ---------------------------------------------------------------------------
// gating
// ---------------------------------------------------------------------------

/**
 * Whether the payment-stream model (level payment, fully amortising) applies.
 * Anything that makes the stream irregular disqualifies the two-sided checks.
 */
function levelPaymentApplies(t = {}) {
  const reasons = [];
  if (t.rate_can_increase) reasons.push('the interest rate can increase after closing');
  if (t.payment_can_increase) reasons.push('the monthly principal and interest can increase');
  if (t.loan_amount_can_increase) reasons.push('the loan balance can increase');
  if (t.has_balloon_payment) reasons.push('the loan has a balloon payment');
  if (t.has_interest_only_period) reasons.push('the loan has an interest-only period');
  return { ok: reasons.length === 0, reasons };
}

const skip = (what, why) => ({ skipped: `${what} (${why})` });

// ---------------------------------------------------------------------------
// 1. Monthly principal and interest  (two-sided, gated, exact)
// ---------------------------------------------------------------------------

function checkMonthlyPI(opts = {}) {
  const { loanAmount, annualRatePct, termMonths, statedPI, terms = {} } = opts;
  if ([loanAmount, annualRatePct, termMonths, statedPI].some((v) => num(v) === null)) {
    return skip('monthly principal and interest', 'a required loan term was not readable');
  }
  const gate = levelPaymentApplies(terms);
  if (!gate.ok) {
    return skip('monthly principal and interest', gate.reasons.join('; '));
  }

  const expected = Math.round(monthlyPI(loanAmount, annualRatePct, termMonths) * 100) / 100;
  const variance = Math.round((statedPI - expected) * 100) / 100;

  if (Math.abs(variance) <= DOLLAR_ROUNDING) {
    return finding({
      checkId: 'LOAN_MATH_PI',
      title: 'Monthly principal and interest matches the note terms',
      severity: Severity.WITHIN_NORMS,
      evidence: ARITH,
      charged: statedPI,
      expected,
      variance,
      basis: `${toDollars(toCents(loanAmount))} at ${annualRatePct}% over ${termMonths} months `
        + `amortises to ${toDollars(toCents(expected))} per month. The disclosure states `
        + `${toDollars(toCents(statedPI))}.`,
    });
  }

  return finding({
    checkId: 'LOAN_MATH_PI',
    title: 'Monthly principal and interest does not match the stated loan terms',
    severity: Severity.CONFIRMED_MATH_ERROR,
    evidence: ARITH,
    actionability: Actionability.CHANGEABLE_BEFORE_CLOSING,
    dollarImpact: Math.abs(variance),
    charged: statedPI,
    expected,
    variance,
    basis: `${toDollars(toCents(loanAmount))} at ${annualRatePct}% over ${termMonths} months `
      + `amortises to ${toDollars(toCents(expected))} per month. The disclosure states `
      + `${toDollars(toCents(statedPI))}, a difference of ${toDollars(toCents(Math.abs(variance)))}.`,
    whyItMatters: variance > 0
      ? `Over ${termMonths} payments that is `
        + `${toDollars(toCents(Math.abs(variance) * termMonths))} more than the note terms support.`
      : 'A payment below the amortising amount means the loan does not pay off over its stated term.',
    recommendedAction: 'Ask the lender to confirm the loan amount, rate and term on page 1 against '
      + 'the payment shown in Projected Payments. One of the four is wrong.',
    askLender: true,
  });
}

// ---------------------------------------------------------------------------
// 2. APR floor  (one-sided, ungated, always safe)
// ---------------------------------------------------------------------------

// The APR reflects the note rate plus the cost of credit. It is therefore never
// below the note rate whenever any finance charge exists, which is true of every
// mortgage that charges a single lender fee. This holds for adjustable and
// interest-only loans too, so it needs no gate.
function checkAprFloor(opts = {}) {
  const { statedApr, annualRatePct, financeCharge } = opts;
  if (num(statedApr) === null || num(annualRatePct) === null) {
    return skip('APR floor', 'the APR or the note rate was not readable');
  }
  if (num(financeCharge) !== null && financeCharge <= 0) {
    return skip('APR floor', 'no finance charge is disclosed');
  }

  if (statedApr >= annualRatePct) {
    return finding({
      checkId: 'LOAN_MATH_APR_FLOOR',
      title: 'APR is at or above the note rate, as expected',
      severity: Severity.WITHIN_NORMS,
      evidence: ARITH,
      charged: statedApr,
      expected: annualRatePct,
      basis: `The disclosed APR of ${statedApr}% is at or above the note rate of ${annualRatePct}%.`,
    });
  }

  return finding({
    checkId: 'LOAN_MATH_APR_FLOOR',
    title: 'Disclosed APR is below the note rate, which is not possible',
    severity: Severity.CONFIRMED_MATH_ERROR,
    evidence: ARITH,
    actionability: Actionability.CHANGEABLE_BEFORE_CLOSING,
    charged: statedApr,
    expected: annualRatePct,
    variance: Math.round((statedApr - annualRatePct) * 1000) / 1000,
    basis: `The disclosure states an APR of ${statedApr}% against a note rate of ${annualRatePct}%. `
      + 'The APR expresses the note rate plus the cost of credit, so it cannot be lower than the '
      + 'note rate on a loan that carries any finance charge.',
    whyItMatters: 'The APR is the figure borrowers use to compare offers. An understated APR makes '
      + 'this loan look cheaper than it is.',
    recommendedAction: 'Ask the lender to recompute the APR on page 5 and reissue the disclosure.',
    askLender: true,
  });
}

// ---------------------------------------------------------------------------
// 3. APR against the disclosure's own figures  (two-sided, gated)
// ---------------------------------------------------------------------------

function checkAprAgainstStatedFigures(opts = {}) {
  const { statedApr, amountFinanced, statedPI, termMonths, terms = {} } = opts;
  if ([statedApr, amountFinanced, statedPI, termMonths].some((v) => num(v) === null)) {
    return skip('APR recomputation', 'the APR, amount financed, payment or term was not readable');
  }
  const gate = levelPaymentApplies(terms);
  if (!gate.ok) return skip('APR recomputation', gate.reasons.join('; '));

  const computed = solveApr(amountFinanced, statedPI, termMonths);
  if (computed === null) {
    return skip('APR recomputation', 'the disclosed figures do not describe a solvable payment stream');
  }
  const variance = Math.round((statedApr - computed) * 1000) / 1000;

  if (Math.abs(variance) <= APR_TOLERANCE_REGULAR) {
    return finding({
      checkId: 'LOAN_MATH_APR',
      title: 'APR agrees with the disclosure\'s own amount financed and payment',
      severity: Severity.WITHIN_NORMS,
      evidence: ARITH,
      charged: statedApr,
      expected: computed,
      variance,
      basis: `An amount financed of ${toDollars(toCents(amountFinanced))} repaid in ${termMonths} `
        + `payments of ${toDollars(toCents(statedPI))} implies an APR of ${computed}%. The `
        + `disclosure states ${statedApr}%, within the 0.125 percentage point tolerance.`,
    });
  }

  const understated = variance < 0;
  return finding({
    checkId: 'LOAN_MATH_APR',
    title: understated
      ? 'Disclosed APR is lower than the disclosure\'s own figures support'
      : 'Disclosed APR does not agree with the disclosure\'s own figures',
    severity: Severity.POTENTIAL_TRID_VIOLATION,
    evidence: ARITH,
    actionability: Actionability.CHANGEABLE_BEFORE_CLOSING,
    charged: statedApr,
    expected: computed,
    variance,
    basis: `An amount financed of ${toDollars(toCents(amountFinanced))} repaid in ${termMonths} `
      + `payments of ${toDollars(toCents(statedPI))} implies an APR of ${computed}%. The disclosure `
      + `states ${statedApr}%, a difference of ${Math.abs(variance)} percentage points. All three `
      + 'inputs are printed on this document.',
    whyItMatters: understated
      ? 'Regulation Z treats a disclosed APR as accurate only within one eighth of a percentage '
        + 'point for a regular transaction. An understatement beyond that is a disclosure error, and '
        + 'the remedies for it are the lender\'s problem rather than yours.'
      : 'The three figures on page 5 do not reconcile with each other, so at least one of them is wrong.',
    recommendedAction: 'Ask the lender which of the amount financed, the payment or the APR is '
      + 'incorrect, and to reissue the disclosure.',
    askLender: true,
  });
}

// ---------------------------------------------------------------------------
// 4. Finance charge floor  (one-sided)
// ---------------------------------------------------------------------------

// The finance charge is the total cost of credit: interest over the term, plus
// prepaid finance charges, plus mortgage insurance. It therefore cannot be less
// than interest alone. Adding items can only push it up, so a floor breach is
// unambiguous even when we cannot enumerate every component.
function checkFinanceChargeFloor(opts = {}) {
  const { financeCharge, amountFinanced, statedPI, termMonths, terms = {} } = opts;
  if ([financeCharge, amountFinanced, statedPI, termMonths].some((v) => num(v) === null)) {
    return skip('finance charge', 'the finance charge, amount financed, payment or term was not readable');
  }
  const gate = levelPaymentApplies(terms);
  if (!gate.ok) return skip('finance charge', gate.reasons.join('; '));

  const floor = Math.round((statedPI * termMonths - amountFinanced) * 100) / 100;
  const shortfall = Math.round((floor - financeCharge) * 100) / 100;

  if (shortfall <= FINANCE_CHARGE_TOLERANCE) {
    return finding({
      checkId: 'LOAN_MATH_FINANCE_CHARGE',
      title: 'Finance charge is consistent with the payment stream',
      severity: Severity.WITHIN_NORMS,
      evidence: ARITH,
      charged: financeCharge,
      expected: floor,
      basis: `${termMonths} payments of ${toDollars(toCents(statedPI))} against an amount financed `
        + `of ${toDollars(toCents(amountFinanced))} is at least `
        + `${toDollars(toCents(floor))} in interest. The disclosure states `
        + `${toDollars(toCents(financeCharge))}.`,
    });
  }

  return finding({
    checkId: 'LOAN_MATH_FINANCE_CHARGE',
    title: 'Disclosed finance charge is less than the interest the payments produce',
    severity: Severity.POTENTIAL_TRID_VIOLATION,
    evidence: ARITH,
    actionability: Actionability.CHANGEABLE_BEFORE_CLOSING,
    dollarImpact: shortfall,
    charged: financeCharge,
    expected: floor,
    variance: -shortfall,
    basis: `${termMonths} payments of ${toDollars(toCents(statedPI))} total `
      + `${toDollars(toCents(statedPI * termMonths))}. Against an amount financed of `
      + `${toDollars(toCents(amountFinanced))} that is ${toDollars(toCents(floor))} of interest `
      + `alone, before any prepaid finance charge or mortgage insurance. The disclosure states a `
      + `finance charge of ${toDollars(toCents(financeCharge))}, which is `
      + `${toDollars(toCents(shortfall))} less than interest by itself.`,
    whyItMatters: 'The finance charge is the headline cost-of-credit figure. Understating it '
      + 'understates what the loan costs, and Regulation Z treats it as accurate only within $100 '
      + 'on a loan secured by real property.',
    recommendedAction: 'Ask the lender to recompute the Loan Calculations box on page 5.',
    askLender: true,
  });
}

// ---------------------------------------------------------------------------
// 5. Total of payments floor  (one-sided)
// ---------------------------------------------------------------------------

function checkTotalOfPaymentsFloor(opts = {}) {
  const { totalOfPayments, statedPI, termMonths, terms = {} } = opts;
  if ([totalOfPayments, statedPI, termMonths].some((v) => num(v) === null)) {
    return skip('total of payments', 'the total of payments, payment or term was not readable');
  }
  const gate = levelPaymentApplies(terms);
  if (!gate.ok) return skip('total of payments', gate.reasons.join('; '));

  const floor = Math.round(statedPI * termMonths * 100) / 100;
  const shortfall = Math.round((floor - totalOfPayments) * 100) / 100;

  if (shortfall <= DOLLAR_ROUNDING) {
    return finding({
      checkId: 'LOAN_MATH_TOTAL_OF_PAYMENTS',
      title: 'Total of payments is consistent with the payment schedule',
      severity: Severity.WITHIN_NORMS,
      evidence: ARITH,
      charged: totalOfPayments,
      expected: floor,
      basis: `${termMonths} payments of ${toDollars(toCents(statedPI))} is `
        + `${toDollars(toCents(floor))}. The disclosure states `
        + `${toDollars(toCents(totalOfPayments))}, which includes loan costs as well.`,
    });
  }

  return finding({
    checkId: 'LOAN_MATH_TOTAL_OF_PAYMENTS',
    title: 'Total of payments is less than the scheduled payments themselves',
    severity: Severity.CONFIRMED_MATH_ERROR,
    evidence: ARITH,
    actionability: Actionability.CHANGEABLE_BEFORE_CLOSING,
    dollarImpact: shortfall,
    charged: totalOfPayments,
    expected: floor,
    variance: -shortfall,
    basis: `Page 5 states a total of payments of ${toDollars(toCents(totalOfPayments))}. The `
      + `payment schedule alone is ${termMonths} payments of ${toDollars(toCents(statedPI))}, or `
      + `${toDollars(toCents(floor))}. The total of payments also includes loan costs and mortgage `
      + 'insurance, so it cannot be the smaller of the two.',
    whyItMatters: 'Page 5 is the figure most borrowers use to understand what the loan costs in '
      + 'total over its life.',
    recommendedAction: 'Ask the lender to reconcile page 5 against Projected Payments on page 1.',
    askLender: true,
  });
}

// ---------------------------------------------------------------------------
// 6. Amount financed ceiling  (one-sided)
// ---------------------------------------------------------------------------

// Amount financed is the loan amount less prepaid finance charges. It is
// therefore never greater than the loan amount. This holds for every loan type.
function checkAmountFinancedCeiling(opts = {}) {
  const { amountFinanced, loanAmount } = opts;
  if ([amountFinanced, loanAmount].some((v) => num(v) === null)) {
    return skip('amount financed', 'the amount financed or the loan amount was not readable');
  }
  const excess = Math.round((amountFinanced - loanAmount) * 100) / 100;

  if (excess <= DOLLAR_ROUNDING) {
    return finding({
      checkId: 'LOAN_MATH_AMOUNT_FINANCED',
      title: 'Amount financed is at or below the loan amount, as expected',
      severity: Severity.WITHIN_NORMS,
      evidence: ARITH,
      charged: amountFinanced,
      expected: loanAmount,
      basis: `Amount financed ${toDollars(toCents(amountFinanced))} against a loan amount of `
        + `${toDollars(toCents(loanAmount))}. The difference is the prepaid finance charge.`,
    });
  }

  return finding({
    checkId: 'LOAN_MATH_AMOUNT_FINANCED',
    title: 'Amount financed exceeds the loan amount',
    severity: Severity.CONFIRMED_MATH_ERROR,
    evidence: ARITH,
    actionability: Actionability.CHANGEABLE_BEFORE_CLOSING,
    dollarImpact: excess,
    charged: amountFinanced,
    expected: loanAmount,
    variance: excess,
    basis: `Page 5 states an amount financed of ${toDollars(toCents(amountFinanced))} against a `
      + `loan amount of ${toDollars(toCents(loanAmount))} on page 1. The amount financed is the `
      + 'loan amount less the charges paid out of it, so it cannot be the larger number.',
    whyItMatters: 'The amount financed drives the APR calculation, so an error here propagates to '
      + 'the rate you are comparing against other offers.',
    recommendedAction: 'Ask the lender to reconcile page 5 against the loan amount on page 1.',
    askLender: true,
  });
}

// ---------------------------------------------------------------------------
// 7. Total interest percentage  (two-sided, gated, exact identity)
// ---------------------------------------------------------------------------

function checkTip(opts = {}) {
  const { statedTipPct, loanAmount, statedPI, termMonths, terms = {} } = opts;
  if ([statedTipPct, loanAmount, statedPI, termMonths].some((v) => num(v) === null)) {
    return skip('total interest percentage', 'a required figure was not readable');
  }
  const gate = levelPaymentApplies(terms);
  if (!gate.ok) return skip('total interest percentage', gate.reasons.join('; '));

  const totalInterest = statedPI * termMonths - loanAmount;
  const computed = Math.round((totalInterest / loanAmount) * 1000) / 10;
  const variance = Math.round((statedTipPct - computed) * 10) / 10;

  // A whole percentage point of slack: the TIP is disclosed to one decimal and
  // the payment it is derived from is rounded to the dollar.
  if (Math.abs(variance) <= 1.0) {
    return finding({
      checkId: 'LOAN_MATH_TIP',
      title: 'Total interest percentage agrees with the payment schedule',
      severity: Severity.WITHIN_NORMS,
      evidence: ARITH,
      charged: statedTipPct,
      expected: computed,
      variance,
      basis: `${termMonths} payments of ${toDollars(toCents(statedPI))} on a loan of `
        + `${toDollars(toCents(loanAmount))} is ${computed}% of the loan amount in interest. `
        + `The disclosure states ${statedTipPct}%.`,
    });
  }

  return finding({
    checkId: 'LOAN_MATH_TIP',
    title: 'Total interest percentage does not agree with the payment schedule',
    severity: Severity.POTENTIAL_TRID_VIOLATION,
    evidence: ARITH,
    actionability: Actionability.CHANGEABLE_BEFORE_CLOSING,
    charged: statedTipPct,
    expected: computed,
    variance,
    basis: `${termMonths} payments of ${toDollars(toCents(statedPI))} on a loan of `
      + `${toDollars(toCents(loanAmount))} produces ${toDollars(toCents(totalInterest))} of `
      + `interest, or ${computed}% of the loan amount. The disclosure states ${statedTipPct}%.`,
    whyItMatters: 'The total interest percentage is one of the two comparison figures on page 5, '
      + 'alongside the APR.',
    recommendedAction: 'Ask the lender to recompute the total interest percentage.',
    askLender: true,
  });
}

// ---------------------------------------------------------------------------
// 8. Points arithmetic  (exact identity, no gate needed)
// ---------------------------------------------------------------------------

function checkPointsArithmetic(opts = {}) {
  const { pointsPct, loanAmount, chargedAmount } = opts;
  if ([pointsPct, loanAmount, chargedAmount].some((v) => num(v) === null)) {
    return skip('discount points', 'the points percentage or the charged amount was not readable');
  }
  const expected = Math.round(loanAmount * (pointsPct / 100) * 100) / 100;
  const variance = Math.round((chargedAmount - expected) * 100) / 100;

  if (Math.abs(variance) <= DOLLAR_ROUNDING) {
    return finding({
      checkId: 'LOAN_MATH_POINTS',
      title: 'Discount points match the stated percentage',
      severity: Severity.WITHIN_NORMS,
      evidence: ARITH,
      charged: chargedAmount,
      expected,
      variance,
      basis: `${pointsPct}% of ${toDollars(toCents(loanAmount))} is `
        + `${toDollars(toCents(expected))}, and that is what is charged.`,
    });
  }

  return finding({
    checkId: 'LOAN_MATH_POINTS',
    title: 'Discount points charged do not match the percentage printed beside them',
    severity: Severity.CONFIRMED_MATH_ERROR,
    evidence: ARITH,
    actionability: Actionability.CHANGEABLE_BEFORE_CLOSING,
    dollarImpact: Math.abs(variance),
    charged: chargedAmount,
    expected,
    variance,
    basis: `Section A describes the points as ${pointsPct}% of the loan amount. `
      + `${pointsPct}% of ${toDollars(toCents(loanAmount))} is ${toDollars(toCents(expected))}, `
      + `but ${toDollars(toCents(chargedAmount))} is charged, a difference of `
      + `${toDollars(toCents(Math.abs(variance)))}.`,
    whyItMatters: 'Points are a zero-tolerance charge. The percentage and the dollar figure are '
      + 'printed on the same line, so they are meant to be two views of one number.',
    recommendedAction: variance > 0
      ? 'Ask the lender to correct the charge to the percentage disclosed, or to explain the difference.'
      : 'Ask the lender which of the two figures is correct.',
    askLender: true,
  });
}

// ---------------------------------------------------------------------------
// 9. Escrow: monthly collection against the disclosed annual disbursements
// ---------------------------------------------------------------------------

// Two-sided but self-contained: page 4 states the escrowed property costs over
// year 1 and page 1 states the monthly escrow payment. They are two views of
// the same annual figure.
function checkEscrowMonthlyVsAnnual(opts = {}) {
  const { monthlyEscrow, escrowedPropertyCostsYear1 } = opts;
  if ([monthlyEscrow, escrowedPropertyCostsYear1].some((v) => num(v) === null)) {
    return skip('escrow monthly collection', 'the monthly escrow or the year-one escrowed costs were not readable');
  }
  if (escrowedPropertyCostsYear1 <= 0) {
    return skip('escrow monthly collection', 'no escrowed property costs are disclosed');
  }

  const expected = Math.round((escrowedPropertyCostsYear1 / 12) * 100) / 100;
  const variance = Math.round((monthlyEscrow - expected) * 100) / 100;
  const annualOver = Math.round(variance * 12 * 100) / 100;

  // $5/month of slack for rounding across twelve payments.
  if (Math.abs(variance) <= 5) {
    return finding({
      checkId: 'LOAN_MATH_ESCROW_MONTHLY',
      title: 'Monthly escrow matches the disclosed annual escrowed costs',
      severity: Severity.WITHIN_NORMS,
      evidence: ARITH,
      charged: monthlyEscrow,
      expected,
      variance,
      basis: `Page 4 discloses ${toDollars(toCents(escrowedPropertyCostsYear1))} of escrowed `
        + `property costs over year one, or ${toDollars(toCents(expected))} a month. Page 1 `
        + `collects ${toDollars(toCents(monthlyEscrow))}.`,
    });
  }

  const over = variance > 0;
  return finding({
    checkId: 'LOAN_MATH_ESCROW_MONTHLY',
    title: over
      ? 'Monthly escrow collects more than the disclosed annual costs require'
      : 'Monthly escrow collects less than the disclosed annual costs require',
    severity: Severity.INFORMATIONAL,
    evidence: ARITH,
    actionability: Actionability.CHANGEABLE_BEFORE_CLOSING,
    dollarImpact: Math.abs(annualOver),
    charged: monthlyEscrow,
    expected,
    variance,
    basis: `Page 4 discloses ${toDollars(toCents(escrowedPropertyCostsYear1))} of escrowed property `
      + `costs over year one, which is ${toDollars(toCents(expected))} a month. Page 1 collects `
      + `${toDollars(toCents(monthlyEscrow))}, a difference of `
      + `${toDollars(toCents(Math.abs(variance)))} a month or `
      + `${toDollars(toCents(Math.abs(annualOver)))} over the year.`,
    whyItMatters: over
      ? 'Over-collection is your money held in the lender\'s escrow account. RESPA requires an '
        + 'annual analysis and a refund of a surplus above the permitted balance, but that is a '
        + 'year away and the money is yours now.'
      : 'Under-collection produces an escrow shortage at the first annual analysis, and the '
        + 'payment rises to cover it.',
    recommendedAction: 'Ask the lender to confirm the monthly escrow against the year-one escrowed '
      + 'property costs on page 4.',
    askLender: true,
  });
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

const CHECKS = [
  ['monthly principal and interest', checkMonthlyPI],
  ['APR floor', checkAprFloor],
  ['APR recomputation', checkAprAgainstStatedFigures],
  ['finance charge', checkFinanceChargeFloor],
  ['total of payments', checkTotalOfPaymentsFloor],
  ['amount financed', checkAmountFinancedCeiling],
  ['total interest percentage', checkTip],
  ['escrow monthly collection', checkEscrowMonthlyVsAnnual],
];

/**
 * Runs every document-intrinsic loan-math check.
 * @returns {{findings: object[], skipped: string[]}}
 */
function runLoanMath(input = {}) {
  const findings = [];
  const skipped = [];

  for (const [, fn] of CHECKS) {
    const r = fn(input);
    if (r && r.skipped) skipped.push(r.skipped);
    else if (r) findings.push(r);
  }

  for (const p of input.pointsLines || []) {
    const r = checkPointsArithmetic({
      pointsPct: p.pointsPct,
      loanAmount: input.loanAmount,
      chargedAmount: p.chargedAmount,
    });
    if (r && r.skipped) skipped.push(r.skipped);
    else if (r) findings.push(r);
  }

  return { findings, skipped };
}

module.exports = {
  monthlyPI,
  solveApr,
  levelPaymentApplies,
  checkMonthlyPI,
  checkAprFloor,
  checkAprAgainstStatedFigures,
  checkFinanceChargeFloor,
  checkTotalOfPaymentsFloor,
  checkAmountFinancedCeiling,
  checkTip,
  checkPointsArithmetic,
  checkEscrowMonthlyVsAnnual,
  runLoanMath,
  APR_TOLERANCE_REGULAR,
  FINANCE_CHARGE_TOLERANCE,
};
