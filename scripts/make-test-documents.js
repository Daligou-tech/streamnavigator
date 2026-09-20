#!/usr/bin/env node
// Generates the documents a live end-to-end test needs, with KNOWN answers.
//
// The offline harnesses run against stored extractions, so they agree with the
// extractor by construction — if it misreads what a section means, the fixture
// misreads it the same way. Only a real document tests that, and there were no
// documents in the repository.
//
// Every figure below is chosen so the correct result is known in advance, and
// several are chosen to be WRONG in a specific way, so a live run can be asked
// the only question that matters: did the check fire, on a document it actually
// had to read?
//
// Written to a directory you pass in (default ./tmp-test-docs), which is not
// committed.
//
//   node scripts/make-test-documents.js [outdir]

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');

const OUT = process.argv[2] || path.join(__dirname, '..', 'tmp-test-docs');
fs.mkdirSync(OUT, { recursive: true });

function write(name, build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 48 });
    const file = path.join(OUT, name);
    const stream = fs.createWriteStream(file);
    doc.pipe(stream);
    build(doc);
    doc.end();
    stream.on('finish', () => resolve(file));
    stream.on('error', reject);
  });
}

const H = (doc, text) => doc.font('Helvetica-Bold').fontSize(13).text(text).moveDown(0.4);
const S = (doc, text) => doc.font('Helvetica-Bold').fontSize(10).text(text).moveDown(0.2);
const P = (doc, text) => doc.font('Helvetica').fontSize(9).text(text).moveDown(0.2);
const row = (doc, label, value) => {
  doc.font('Helvetica').fontSize(9);
  const y = doc.y;
  doc.text(label, 48, y, { width: 330, continued: false });
  doc.text(value, 390, y, { width: 170, align: 'right' });
  doc.moveDown(0.15);
};

// ---------------------------------------------------------------------------
// GROUND TRUTH — closing
// ---------------------------------------------------------------------------
//
//   loan $300,000 @ 6.875%, 30 years, closing 2026-04-15, Richmond VA
//   sale price $375,000
//
//   PLANTED 1  prepaid interest billed 22 days. 15 April leaves 16 days to
//              month end, so check 11 must flag roughly $320.
//   PLANTED 2  the Loan Estimate says 6.5%. The CD says 6.875%. Check 29 must
//              report a rise of 0.375 points and must NOT call it a violation.
//   PLANTED 3  underwriting fee $795 -> $1,095. Zero tolerance, check 22, $300.
//   PLANTED 4  survey $475 -> $700 in section C with a written provider list.
//              That is the 10% basket, check 23, allowed $522.50, excess
//              $177.50 -- and it must NOT appear as a zero-tolerance violation.
//   CORRECT    transfer taxes. Richmond VA on $375,000 with a $300,000 loan:
//              deed 937.50 + local 312.50 + grantor 375.00 + DoT 750.00 +
//              local DoT 250.00 = $2,625.00. Check 28 must VERIFY, not flag.

const CD_FIGURES = {
  loanAmount: 300000,
  ratePct: 6.875,
  salePrice: 375000,
  closing: '04/15/2026',
  monthlyPI: 1970.79,
};

const closingDisclosure = (doc) => {
  H(doc, 'Closing Disclosure');
  P(doc, 'This form is a statement of final loan terms and closing costs. Compare this document with your Loan Estimate.');
  doc.moveDown(0.3);

  S(doc, 'Closing Information');
  row(doc, 'Date Issued', '04/10/2026');
  row(doc, 'Closing Date', CD_FIGURES.closing);
  row(doc, 'Disbursement Date', CD_FIGURES.closing);
  row(doc, 'Settlement Agent', 'Old Dominion Title & Escrow LLC');
  row(doc, 'File #', 'ODT-2026-4417');
  row(doc, 'Property', '4418 Monument Avenue, Richmond, VA 23230');
  row(doc, 'County', 'Richmond');
  row(doc, 'Sale Price', '$375,000.00');
  doc.moveDown(0.3);

  S(doc, 'Loan Information');
  row(doc, 'Loan Term', '30 years');
  row(doc, 'Purpose', 'Purchase');
  row(doc, 'Product', 'Fixed Rate');
  row(doc, 'Loan Type', 'Conventional');
  row(doc, 'Lender', 'Ficus Bank');
  doc.moveDown(0.3);

  S(doc, 'Loan Terms');
  row(doc, 'Loan Amount', '$300,000.00');
  row(doc, 'Interest Rate', '6.875%');
  row(doc, 'Monthly Principal & Interest', '$1,970.79');
  doc.moveDown(0.3);

  S(doc, 'Projected Payments');
  row(doc, 'Principal & Interest', '$1,970.79');
  row(doc, 'Mortgage Insurance', '$0.00');
  row(doc, 'Estimated Escrow', '$618.00');
  row(doc, 'Estimated Total Monthly Payment', '$2,588.79');

  doc.addPage();
  H(doc, 'Closing Cost Details');

  S(doc, 'A. Origination Charges');
  row(doc, '01 Underwriting Fee to Ficus Bank', '$1,095.00');
  row(doc, '02 Processing Fee to Ficus Bank', '$670.00');
  row(doc, 'Section A Total', '$1,765.00');
  doc.moveDown(0.25);

  S(doc, 'B. Services Borrower Did Not Shop For');
  row(doc, '01 Appraisal Fee to Dominion Appraisal Group', '$650.00');
  row(doc, '02 Credit Report Fee to Info Co.', '$44.00');
  row(doc, 'Section B Total', '$694.00');
  doc.moveDown(0.25);

  S(doc, 'C. Services Borrower Did Shop For');
  row(doc, '01 Survey Fee to Commonwealth Survey Co.', '$700.00');
  row(doc, '02 Title - Settlement Agent Fee to Old Dominion Title', '$900.00');
  row(doc, '03 Title - Lender’s Title Insurance to Old Dominion Title', '$1,150.00');
  row(doc, 'Section C Total', '$2,750.00');
  doc.moveDown(0.25);

  S(doc, 'E. Taxes and Other Government Fees');
  row(doc, '01 Recording Fees  Deed: $46.00  Mortgage: $82.00', '$128.00');
  row(doc, '02 State Recordation Tax to Commonwealth of Virginia', '$1,687.50');
  row(doc, '03 Grantor Tax to Commonwealth of Virginia', '$375.00');
  row(doc, '04 Local Recordation Tax to City of Richmond', '$562.50');
  row(doc, 'Section E Total', '$2,753.00');
  doc.moveDown(0.25);

  S(doc, 'F. Prepaids');
  row(doc, '01 Prepaid Interest ($56.51 per day from 04/15/2026 for 22 days)', '$1,243.15');
  row(doc, '02 Homeowner’s Insurance Premium (12 mo.)', '$1,416.00');
  row(doc, 'Section F Total', '$2,659.15');
  doc.moveDown(0.25);

  S(doc, 'G. Initial Escrow Payment at Closing');
  row(doc, '01 Homeowner’s Insurance  $118.00 per month for 2 mo.', '$236.00');
  row(doc, '02 Property Taxes  $500.00 per month for 2 mo.', '$1,000.00');
  row(doc, '03 Aggregate Adjustment', '-$380.85');
  row(doc, 'Section G Total', '$855.15');
  doc.moveDown(0.25);

  S(doc, 'H. Other');
  row(doc, '01 Title - Owner’s Title Insurance (optional) to Old Dominion Title', '$1,800.00');
  row(doc, 'Section H Total', '$1,800.00');
  doc.moveDown(0.25);

  row(doc, 'J. TOTAL CLOSING COSTS (Borrower-Paid)', '$13,276.30');

  doc.addPage();
  H(doc, 'Calculating Cash to Close');
  row(doc, 'Total Closing Costs (J)', '$13,276.30');
  row(doc, 'Closing Costs Paid Before Closing', '$0.00');
  row(doc, 'Down Payment / Funds from Borrower', '$75,000.00');
  row(doc, 'Deposit', '-$7,500.00');
  row(doc, 'Seller Credits', '-$4,500.00');
  row(doc, 'Cash to Close', '$76,276.30');
  doc.moveDown(0.4);

  H(doc, 'Loan Calculations');
  row(doc, 'Total of Payments', '$709,484.40');
  row(doc, 'Finance Charge', '$413,004.64');
  row(doc, 'Amount Financed', '$296,479.76');
  row(doc, 'Annual Percentage Rate (APR)', '6.991%');
  row(doc, 'Total Interest Percentage (TIP)', '136.495%');
  doc.moveDown(0.4);

  H(doc, 'Escrow Account');
  P(doc, 'Escrowed Property Costs over Year 1: $7,416.00. This is the estimated total amount over year 1 for your escrowed property costs: Homeowner’s Insurance $1,416.00 and Property Taxes $6,000.00.');
  row(doc, 'Monthly Escrow Payment', '$618.00');
};

// The Loan Estimate. Two figures differ from the CD on purpose.
const loanEstimate = (doc) => {
  H(doc, 'Loan Estimate');
  row(doc, 'Date Issued', '03/14/2026');
  row(doc, 'Applicants', 'Alex Rivera and Sam Rivera');
  row(doc, 'Property', '4418 Monument Avenue, Richmond, VA 23230');
  row(doc, 'Sale Price', '$375,000.00');
  row(doc, 'Lender', 'Ficus Bank');
  doc.moveDown(0.3);

  S(doc, 'Loan Terms');
  row(doc, 'Loan Amount', '$300,000.00');
  row(doc, 'Interest Rate', '6.5%');
  row(doc, 'Monthly Principal & Interest', '$1,896.20');
  doc.moveDown(0.3);

  P(doc, 'Before closing, your interest rate, points, and lender credits can change unless you lock the interest rate. This rate is not locked.');
  doc.moveDown(0.3);

  S(doc, 'A. Origination Charges');
  row(doc, 'Underwriting Fee', '$795.00');
  row(doc, 'Processing Fee', '$670.00');
  doc.moveDown(0.25);

  S(doc, 'B. Services You Cannot Shop For');
  row(doc, 'Appraisal Fee', '$650.00');
  row(doc, 'Credit Report Fee', '$44.00');
  doc.moveDown(0.25);

  S(doc, 'C. Services You Can Shop For');
  row(doc, 'Survey Fee', '$475.00');
  row(doc, 'Title - Settlement Agent Fee', '$900.00');
  row(doc, 'Title - Lender’s Title Insurance', '$1,150.00');
  doc.moveDown(0.25);

  S(doc, 'E. Taxes and Other Government Fees');
  row(doc, 'Recording Fees and Other Taxes', '$2,753.00');
};

// ---------------------------------------------------------------------------
// GROUND TRUTH — HOA
// ---------------------------------------------------------------------------
//
//   84 units. Reserve balance $486,000 against a fully funded $1,620,000,
//   which is exactly 30.0% funded. The budget contributes $60,000 a year
//   against a recommended $210,000. Roof due 2029 at $840,000; at the current
//   contribution the fund reaches $666,000, a gap of $174,000, or $2,071.43
//   per unit.
//
//   Expected score: HIGH. 30% funded is Moderate on its own, underfunding is
//   Moderate, and the line of credit in the minutes is High. The basis must
//   name all three.
//
//   Expected restrictions: leasing capped at 20% (16.8 -> 17 units), cap full,
//   9 on the waitlist, 12-month minimum, one year owner-occupancy first.
//   Capital contribution $1,200 and a $350 transfer fee due at closing.
//   Reserve study is from 2021, which must raise the stale-study caveat.

const reserveStudy = (doc) => {
  H(doc, 'Maple Court Condominium Association');
  S(doc, 'Reserve Study — Level I Full Analysis');
  P(doc, 'Prepared October 2021 by Bickford Reserve Consulting. 84 residential units.');
  doc.moveDown(0.4);

  S(doc, 'Funding Summary');
  row(doc, 'Current reserve balance (as of 09/30/2021)', '$486,000');
  row(doc, 'Fully funded balance', '$1,620,000');
  row(doc, 'Percent funded', '30.0%');
  row(doc, 'Recommended annual reserve contribution', '$210,000');
  doc.moveDown(0.4);

  S(doc, 'Component Inventory — Major Items');
  row(doc, 'Roof membrane replacement  (remaining life 8 years, due 2029)', '$840,000');
  row(doc, 'Asphalt paving overlay  (remaining life 4 years)', '$96,000');
  row(doc, 'Boiler replacement  (remaining life 11 years)', '$210,000');
  row(doc, 'Elevator modernisation  (remaining life 14 years)', '$320,000');
  doc.moveDown(0.4);

  P(doc, 'The association is presently funding reserves below the level this study recommends. Continued underfunding at the current rate will leave the reserve fund unable to meet the roof replacement scheduled for 2029 without a special assessment or borrowing.');
};

const budget = (doc) => {
  H(doc, 'Maple Court Condominium Association');
  S(doc, 'Approved Operating Budget — Fiscal Year 2026');
  P(doc, '84 units. Monthly assessment per unit: $415. Annual assessment per unit: $4,980.');
  doc.moveDown(0.4);

  S(doc, 'Revenue');
  row(doc, 'Regular assessments', '$418,320');
  row(doc, 'Interest and other income', '$4,200');
  row(doc, 'Total revenue', '$422,520');
  doc.moveDown(0.4);

  S(doc, 'Expenses');
  row(doc, 'Insurance', '$74,000');
  row(doc, 'Utilities', '$88,400');
  row(doc, 'Landscaping and snow', '$41,000');
  row(doc, 'Management fee', '$52,600');
  row(doc, 'Repairs and maintenance', '$63,200');
  row(doc, 'Administrative and legal', '$21,400');
  row(doc, 'Transfer to reserves', '$60,000');
  row(doc, 'Total expenses', '$400,600');
  doc.moveDown(0.4);

  S(doc, 'Notes to the Budget');
  P(doc, 'The transfer to reserves of $60,000 is below the $210,000 recommended by the 2021 reserve study. The Board has elected to hold assessments flat for fiscal 2026.');
  P(doc, 'Owner delinquency over 90 days stood at 12.4% of units as of the November 2025 financial statement.');
};

const minutes = (doc) => {
  H(doc, 'Maple Court Condominium Association');
  S(doc, 'Board of Directors — Minutes of the Meeting of 14 March 2026');
  doc.moveDown(0.3);

  P(doc, 'Present: five directors, the managing agent, and eleven owners.');
  doc.moveDown(0.3);

  S(doc, '4. Reserve Funding and the Roof');
  P(doc, 'The managing agent reported that the engineer’s inspection of February 2026 found the roof membrane deteriorating faster than the 2021 reserve study anticipated, and recommended replacement be brought forward. The Treasurer observed that the reserve fund will not support the work at the current rate of contribution.');
  doc.moveDown(0.3);

  S(doc, '5. Funding Options');
  P(doc, 'The Board discussed three options: a special assessment, an increase in monthly assessments, and borrowing. Counsel advised that a special assessment of this size would require an owner vote under Article VII of the Bylaws.');
  P(doc, 'MOTION carried 4-1 to establish a $250,000 line of credit with Commonwealth Community Bank, secured against future assessments, to provide interim funding for roof work.');
  doc.moveDown(0.3);

  S(doc, '6. Insurance');
  P(doc, 'The agent reported that the master policy renewal carries a 5% named-storm deductible, increased from a flat $25,000 at the prior renewal.');
  doc.moveDown(0.3);

  S(doc, '7. Litigation');
  P(doc, 'No litigation is pending against the Association. The construction-defect claim against the original developer was settled in 2019.');
};

const bylaws = (doc) => {
  H(doc, 'Maple Court Condominium Association');
  S(doc, 'Bylaws — Selected Articles');
  doc.moveDown(0.3);

  S(doc, 'Article XI — Leasing of Units');
  P(doc, '11.1  No more than twenty percent (20%) of the units in the Association may be leased at any one time. The Board shall maintain a waiting list of owners wishing to lease.');
  P(doc, '11.2  No unit may be leased for a term of less than twelve (12) months. Transient, vacation and short-term rental of any kind is prohibited.');
  P(doc, '11.3  No owner may lease a unit until that owner has occupied the unit as a primary residence for at least one (1) year following purchase.');
  P(doc, '11.4  Leasing rights do not run with the unit and are not transferable to a purchaser.');
  doc.moveDown(0.3);

  S(doc, 'Article XII — Transfer of Units');
  P(doc, '12.1  Upon each conveyance of a unit, the purchaser shall pay to the Association a working capital contribution equal to two (2) months of the then-current regular assessment.');
  P(doc, '12.2  A transfer fee of three hundred fifty dollars ($350) is payable to the managing agent upon each conveyance.');
  doc.moveDown(0.3);

  S(doc, 'Article XIV — Use Restrictions');
  P(doc, '14.1  No more than two (2) domestic pets may be kept in any unit. No pet exceeding forty (40) pounds at maturity is permitted.');
  P(doc, '14.2  Each unit is assigned one (1) parking space. Commercial vehicles, boats and recreational vehicles may not be parked on the property.');
  P(doc, '14.3  No alteration to any common element or to the exterior of a unit may be made without prior written approval of the Architectural Review Committee.');
  doc.moveDown(0.3);

  S(doc, 'Article XV — Resale Certificate');
  P(doc, 'As of the date of this certificate, seventeen (17) of the eighty-four (84) units are leased, which is the maximum permitted under Article XI. Nine (9) owners are presently on the leasing waiting list.');
};

// ---------------------------------------------------------------------------
// GROUND TRUTH — insurance
// ---------------------------------------------------------------------------
//
//   Meridian Mutual homeowners policy. Renewal term 11/01/2026-11/01/2027,
//   premium $2,300; prior term 11/01/2025-11/01/2026, premium $2,000.
//
//   These figures are not arbitrary — they are
//   tests/fixtures/insurance-fixtures.js's homeCoverageCutBehindTheRise(),
//   transcribed onto paper instead of typed as JSON. That fixture is already
//   the hand-authored "correct extraction" api/_lib/insurance-audit.js is
//   tested against (tests/insurance-audit.test.js), so a live read of these
//   two PDFs can be compared directly against it with no second ground-truth
//   document to keep in sync — see scripts/insurance-audit-harness.js
//   --compare, which does exactly that.
//
//   PLANTED 1  dwelling limit cut $340,000 -> $310,000 while the premium
//              rose. Must produce PREMIUM_ROSE_COVERAGE_DECREASED and
//              COVERAGE_LIMIT_REDUCED, both coverage_gap where the second
//              applies, ranked ahead of everything else.
//   PLANTED 2  deductible rose $1,500 -> $2,500 alongside the same premium
//              rise. Must produce DEDUCTIBLE_INCREASED, worth_challenging.
//   PLANTED 3  the Multi-Policy Discount is on the prior policy and absent
//              from the renewal; Autopay Discount is on both and must NOT be
//              reported as dropped. Must produce DISCOUNT_DROPPED naming only
//              Multi-Policy Discount.
//   PLANTED 4  a Water Backup Exclusion appears on the renewal's schedule of
//              forms and not the prior policy's. Must produce
//              NEW_EXCLUSION_ADDED. The Replacement Cost Endorsement is on
//              both and must NOT be reported as dropped.
//   UNCHANGED  personal property ($155,000) and liability ($300,000) limits
//              are identical on both documents and must produce no coverage
//              finding for either category.

const insuranceRenewalNotice = (doc) => {
  H(doc, 'Meridian Mutual Insurance Company');
  S(doc, 'Homeowners Renewal Declarations');
  P(doc, 'This is your renewal notice. Review the coverages, limits and deductibles below before your current policy expires.');
  doc.moveDown(0.3);

  S(doc, 'Policy Information');
  row(doc, 'Policy Number', 'HO-4471182');
  row(doc, 'Named Insured', 'Dana and Chris Alvarez');
  row(doc, 'Property Address', '118 Birchwood Lane, Maple Grove, MN 55369');
  row(doc, 'Policy Period', '11/01/2026 to 11/01/2027');
  doc.moveDown(0.3);

  S(doc, 'Coverages and Limits');
  row(doc, 'Coverage A - Dwelling', '$310,000');
  row(doc, 'Coverage C - Personal Property', '$155,000');
  row(doc, 'Coverage E - Liability', '$300,000');
  doc.moveDown(0.3);

  S(doc, 'Deductibles');
  row(doc, 'All Other Perils', '$2,500');
  doc.moveDown(0.3);

  S(doc, 'Discounts Applied');
  P(doc, 'Autopay Discount');
  doc.moveDown(0.3);

  S(doc, 'Schedule of Forms and Endorsements');
  P(doc, 'HO 04 95 - Water Backup and Sump Overflow Exclusion');
  P(doc, 'HO 07 42 - Replacement Cost Endorsement (Dwelling)');
  doc.moveDown(0.3);

  S(doc, 'Premium');
  row(doc, 'Your premium is changing from', '$2,000.00');
  row(doc, 'to', '$2,300.00');
  P(doc, 'This renewal notice reflects your premium for the term shown above. Review your coverage carefully — if you have questions, contact your agent before this policy takes effect.');
};

const insurancePriorPolicy = (doc) => {
  H(doc, 'Meridian Mutual Insurance Company');
  S(doc, 'Homeowners Policy Declarations');
  doc.moveDown(0.3);

  S(doc, 'Policy Information');
  row(doc, 'Policy Number', 'HO-4471182');
  row(doc, 'Named Insured', 'Dana and Chris Alvarez');
  row(doc, 'Property Address', '118 Birchwood Lane, Maple Grove, MN 55369');
  row(doc, 'Policy Period', '11/01/2025 to 11/01/2026');
  doc.moveDown(0.3);

  S(doc, 'Coverages and Limits');
  row(doc, 'Coverage A - Dwelling', '$340,000');
  row(doc, 'Coverage C - Personal Property', '$155,000');
  row(doc, 'Coverage E - Liability', '$300,000');
  doc.moveDown(0.3);

  S(doc, 'Deductibles');
  row(doc, 'All Other Perils', '$1,500');
  doc.moveDown(0.3);

  S(doc, 'Discounts Applied');
  P(doc, 'Autopay Discount');
  P(doc, 'Multi-Policy Discount');
  doc.moveDown(0.3);

  S(doc, 'Schedule of Forms and Endorsements');
  P(doc, 'HO 07 42 - Replacement Cost Endorsement (Dwelling)');
  doc.moveDown(0.3);

  S(doc, 'Premium');
  row(doc, 'Total Annual Premium', '$2,000.00');
};

(async () => {
  const made = [];
  made.push(await write('closing-disclosure.pdf', closingDisclosure));
  made.push(await write('loan-estimate.pdf', loanEstimate));
  made.push(await write('hoa-reserve-study.pdf', reserveStudy));
  made.push(await write('hoa-budget.pdf', budget));
  made.push(await write('hoa-minutes.pdf', minutes));
  made.push(await write('hoa-bylaws.pdf', bylaws));
  made.push(await write('insurance-renewal-notice.pdf', insuranceRenewalNotice));
  made.push(await write('insurance-prior-policy.pdf', insurancePriorPolicy));
  made.forEach((f) => console.log('wrote', f, fs.statSync(f).size, 'bytes'));
})();
