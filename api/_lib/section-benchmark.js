// Section-total checks against what comparable loans actually paid.
//
// This is the only place in the audit where a finding rests on other people's
// transactions rather than on a rule or on arithmetic. That makes the wording
// as important as the number, so the constraints are structural:
//
//   * It only ever fires ABOVE the spread. Being cheaper than comparable loans
//     is not a finding.
//   * It never uses "should", "overcharge", "wrong", "error" or "violation".
//     The strongest thing it says is that the total is higher than most
//     comparable loans, which is a fact about the sample, not about the lender.
//   * Its severity is capped at ABOVE_BENCHMARK. It can never be a
//     CONFIRMED_MATH_ERROR or a POTENTIAL_TRID_VIOLATION, because a
//     distribution cannot establish either.
//   * It always states the sample size and the fact that the sample excludes
//     smaller lenders, so the customer can weigh it.
//   * It applies to a SECTION TOTAL, and says so. HMDA carries Box A and
//     Section D totals, not line items, and the report must not imply we
//     priced any individual fee.

'use strict';

const audit = require('./closing-audit');

const { Severity, Actionability, finding, toCents, toDollars } = audit;

const SECTIONS = [
  {
    category: 'origination_charges_total',
    checkId: 'SECTION_TOTAL_ORIGINATION',
    name: 'Origination charges',
    box: 'Section A',
    what: 'the fees your lender charges to make the loan, including points',
  },
  {
    category: 'total_loan_costs',
    checkId: 'SECTION_TOTAL_LOAN_COSTS',
    name: 'Total loan costs',
    box: 'Section D',
    what: 'everything in Sections A, B and C added together',
  },
];

const money = (n) => toDollars(toCents(n));

/**
 * @param {object}   opts
 * @param {object}   opts.sectionTotals  { A: number, D: number }
 * @param {function} opts.getBenchmark
 * @param {object}   opts.ctx            { state, county, loanAmount, ... }
 */
function checkSectionTotals(opts = {}) {
  const { sectionTotals = {}, getBenchmark, ctx = {} } = opts;
  const findings = [];
  const skipped = [];

  if (typeof getBenchmark !== 'function') {
    return { findings, skipped: ['section totals against comparable loans (no benchmark source)'] };
  }

  for (const s of SECTIONS) {
    const charged = s.box === 'Section A' ? sectionTotals.A : sectionTotals.D;
    if (typeof charged !== 'number' || charged <= 0) {
      skipped.push(`${s.name} against comparable loans (the ${s.box} total was not readable)`);
      continue;
    }

    let bm = null;
    try { bm = getBenchmark({ ...ctx, category: s.category }); } catch { bm = null; }

    if (!bm || typeof bm.high !== 'number') {
      // Named, not counted. The customer is told which specific total we could
      // not compare, and this is what feeds the pre-payment disclosure.
      skipped.push(`${s.name} against comparable loans (we hold no comparison data `
        + `for ${bm ? bm.jurisdiction : (ctx.county && ctx.state ? `${ctx.county}, ${ctx.state}` : 'your county')} `
        + 'at this loan size)');
      continue;
    }

    const band = bm.loanBandLabel ? ` for loans of ${bm.loanBandLabel}` : '';
    const where = bm.jurisdiction || 'your area';
    const sample = bm.sampleSize
      ? `${bm.sampleSize} comparable loans`
      : 'comparable loans';

    if (charged <= bm.high) {
      findings.push(finding({
        checkId: s.checkId,
        title: `${s.name} are in line with comparable loans`,
        severity: Severity.WITHIN_NORMS,
        evidence: bm.evidence,
        charged,
        expected: null,
        basis: `Your ${s.box} total is ${money(charged)}. Across ${sample} in ${where}${band}, `
          + `the midpoint was ${money(bm.low)} and nine in ten came in below ${money(bm.high)}.`,
        detail: { low: bm.low, high: bm.high, sampleSize: bm.sampleSize, source: bm.source },
      }));
      continue;
    }

    const over = Math.round((charged - bm.high) * 100) / 100;
    findings.push(finding({
      // Deliberately not "too high" and not "overcharge". Higher than most is
      // what the data supports; anything stronger it does not.
      checkId: s.checkId,
      title: `${s.name} are higher than most comparable loans in ${where}`,
      severity: Severity.ABOVE_BENCHMARK,
      evidence: bm.evidence,
      actionability: Actionability.CHANGEABLE_BEFORE_CLOSING,
      dollarImpact: over,
      charged,
      expected: bm.high,
      variance: over,
      basis: `Your ${s.box} total is ${money(charged)}. Across ${sample} in ${where}${band}, `
        + `the midpoint was ${money(bm.low)} and nine in ten came in below ${money(bm.high)}. `
        + `Yours is ${money(over)} above that ninth-in-ten figure.`,
      whyItMatters:
        `${s.box} is ${s.what}. This compares the section TOTAL, not any single fee `
        + 'inside it, so it does not tell you which charge accounts for the difference. '
        + 'It is also a spread of what other borrowers paid, not a rate anyone is '
        + 'required to charge — a total above it is unusual, not an error. '
        + (bm.caveat ? '' : ''),
      recommendedAction:
        `Ask your lender to itemise ${s.box} and explain the charges that make it up. `
        + 'Origination charges are among the fees most often reduced when questioned '
        + 'before closing.',
      askLender: true,
      detail: {
        low: bm.low, high: bm.high, sampleSize: bm.sampleSize,
        source: bm.source, sourceUrl: bm.sourceUrl, caveat: bm.caveat,
        sectionTotalOnly: true,
      },
    }));
  }

  return { findings, skipped };
}

module.exports = { checkSectionTotals, SECTIONS };
