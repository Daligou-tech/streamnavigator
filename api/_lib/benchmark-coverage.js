// What we can price, and what we cannot — named, before Sarah pays.
//
// The old scorecard said "Fees we have no rate data for: 10 of 14". That tells
// a customer a number and nothing else. She cannot tell whether the ten are the
// ones she cares about, and she is being asked to pay without knowing.
//
// This module answers a different question: for THIS property, in THIS county,
// which named categories of charge can we compare against a published rate, and
// which can we only check for arithmetic and duplication? The answer is a list
// of plain-English names, not a count.
//
// The honest framing matters as much as the data. There are three tiers, and
// they are not interchangeable:
//
//   priced      We hold a published rate, schedule or statute for this county
//               and can say what the charge should be.
//   distribution We hold no rate, but we hold what comparable loans actually
//               paid, so we can say where this charge sits in that spread.
//               This is a spread, not a rule. A charge above it is unusual,
//               not wrong.
//   unpriced    We hold neither. The charge is still checked for arithmetic,
//               duplication and tolerance, but we do not tell you if it is high.
//
// Nothing here guesses. A category with no row is reported as unpriced.

'use strict';

const { coverageFor } = require('./benchmark-corpus');

// Customer-facing names. These are what Sarah reads, so they say what the
// charge IS rather than repeating the code's category key.
const CATEGORY_LABELS = {
  origination: 'Origination charge / points',
  lender_fee: 'Lender fees (underwriting, processing, admin)',
  credit_report: 'Credit report fee',
  rate_lock_fee: 'Rate lock fee',
  appraisal: 'Appraisal fee',
  settlement_service: 'Settlement / closing fee',
  title_insurance_owners: "Owner's title insurance",
  title_insurance_lenders: "Lender's title insurance",
  survey: 'Survey fee',
  attorney: 'Attorney fee',
  recording_fee: 'Recording fees',
  transfer_tax: 'Transfer and recordation taxes',
  prepaid_interest: 'Prepaid interest',
  property_insurance: 'Homeowner\'s insurance premium',
  property_tax: 'Property taxes',
  escrow_deposit: 'Initial escrow deposit',
  hoa_dues: 'HOA dues and transfer fees',
  optional_product: 'Optional products',
  non_required_service: 'Services not required by the lender',
  affiliate_service: 'Services from a lender affiliate',
  unshoppable_service: 'Services you could not shop for',
  other: 'Other charges',
};

// Categories where "is this too high?" is a meaningful question. Prepaid
// interest, property taxes and escrow deposits are excluded on purpose: they
// are computed from the loan, not priced by a vendor, and they are already
// tested exactly by the arithmetic checks. Listing them as "we cannot price
// this" would be misleading — we can do better than price them, we can verify
// them.
const PRICEABLE_CATEGORIES = [
  'origination', 'lender_fee', 'credit_report', 'rate_lock_fee', 'appraisal',
  'settlement_service', 'title_insurance_owners', 'title_insurance_lenders',
  'survey', 'attorney', 'recording_fee', 'transfer_tax',
];

// Categories verified exactly by arithmetic rather than compared to a rate.
// Sarah should be told these are covered, not told they are a gap.
const VERIFIED_BY_ARITHMETIC = {
  prepaid_interest: 'Recomputed from your loan amount, rate and closing date.',
  property_tax: 'Proration recomputed from the tax period and your closing date.',
  escrow_deposit: 'Tested against the RESPA cushion limit and your disclosed annual costs.',
  hoa_dues: 'Checked against the property type you told us.',
};

const HARD_EVIDENCE_PREFIX = 'hard_rule:';

/**
 * Which named charge categories can be priced for this property.
 *
 * @param {function} getBenchmark  the corpus lookup (may be a null implementation)
 * @param {object}   ctx           { state, county, salePrice, loanAmount, propertyAddress }
 * @param {string[]} presentCategories  categories actually appearing on this CD
 */
function describeCoverage(getBenchmark, ctx = {}, presentCategories = []) {
  const present = new Set(presentCategories);
  const priced = [];
  const distribution = [];
  const unpriced = [];

  for (const category of PRICEABLE_CATEGORIES) {
    // Only report on categories that are actually on this document. Telling
    // Sarah we cannot price a survey fee she was never charged is noise.
    if (present.size && !present.has(category)) continue;

    let bm = null;
    try { bm = getBenchmark({ ...ctx, category }); } catch { bm = null; }

    const entry = { category, label: CATEGORY_LABELS[category] || category };

    if (!bm) {
      unpriced.push(entry);
    } else if (typeof bm.evidence === 'string' && bm.evidence.startsWith(HARD_EVIDENCE_PREFIX)) {
      priced.push({ ...entry, source: bm.source, jurisdiction: bm.jurisdiction });
    } else {
      distribution.push({ ...entry, source: bm.source, jurisdiction: bm.jurisdiction });
    }
  }

  const verified = Object.keys(VERIFIED_BY_ARITHMETIC)
    .filter((c) => !present.size || present.has(c))
    .map((c) => ({
      category: c,
      label: CATEGORY_LABELS[c] || c,
      how: VERIFIED_BY_ARITHMETIC[c],
    }));

  return {
    priced,
    distribution,
    unpriced,
    verified_by_arithmetic: verified,
    jurisdiction: ctx.county && ctx.state ? `${ctx.county}, ${ctx.state}`
      : (ctx.state || null),
    // Named, not counted. This is the sentence Sarah reads before paying.
    not_priced_sentence: unpriced.length
      ? 'We do not hold a published rate for these charges in your county, so we do '
        + 'not tell you whether they are high: '
        + joinNames(unpriced.map((u) => u.label)) + '. '
        + 'They are still checked for arithmetic, duplication, and — if you upload your '
        + 'Loan Estimate — whether they were allowed to increase.'
      : null,
    priced_sentence: priced.length
      ? 'We compare these against the published rate or statute for your county: '
        + joinNames(priced.map((p) => p.label)) + '.'
      : null,
    distribution_sentence: distribution.length
      ? 'For these we hold no published rate, but we do hold what comparable loans in '
        + 'your area actually paid, so we can tell you where yours sits in that spread. '
        + 'A charge above the spread is unusual, not proof of an error: '
        + joinNames(distribution.map((d) => d.label)) + '.'
      : null,
  };
}

// "A, B and C" — never "a few" or "several". A customer deciding whether to pay
// needs the names.
function joinNames(names) {
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Raw counts, for the corpus-filling decision rather than the customer. */
function corpusCoverage(getBenchmark, ctx) {
  return coverageFor(getBenchmark, ctx);
}

module.exports = {
  CATEGORY_LABELS,
  PRICEABLE_CATEGORIES,
  VERIFIED_BY_ARITHMETIC,
  describeCoverage,
  corpusCoverage,
  joinNames,
};
