'use strict';

// Fixtures for insurance-audit.test.js, shaped exactly as
// api/_lib/insurance-extract.js records them — a `renewal` snapshot always
// present, a `prior_policy` snapshot present only when the scenario is
// meant to have one.

// A homeowner's renewal where the premium rose 15%, the dwelling limit was
// cut, the deductible rose, a discount disappeared, and a new exclusion was
// added — every coverage-gap and worth-challenging path in one fixture.
function homeCoverageCutBehindTheRise() {
  return {
    renewal: {
      carrier_name: 'Meridian Mutual',
      policy_period_start: '2026-11-01',
      policy_period_end: '2027-11-01',
      premium_total: 2300,
      coverages: [
        { label: 'Coverage A - Dwelling', category: 'dwelling', limit: 310000 },
        { label: 'Coverage C - Personal Property', category: 'personal_property', limit: 155000 },
        { label: 'Coverage E - Liability', category: 'liability', limit: 300000 },
      ],
      deductibles: [
        { label: 'All Other Perils', applies_to: 'dwelling', amount: 2500 },
      ],
      discounts_applied: ['Autopay Discount'],
      exclusions_endorsements: [
        { label: 'Water Backup Exclusion', kind: 'exclusion' },
        { label: 'Replacement Cost Endorsement', kind: 'endorsement' },
      ],
    },
    prior_policy: {
      carrier_name: 'Meridian Mutual',
      policy_period_start: '2025-11-01',
      policy_period_end: '2026-11-01',
      premium_total: 2000,
      coverages: [
        { label: 'Coverage A - Dwelling', category: 'dwelling', limit: 340000 },
        { label: 'Coverage C - Personal Property', category: 'personal_property', limit: 155000 },
        { label: 'Coverage E - Liability', category: 'liability', limit: 300000 },
      ],
      deductibles: [
        { label: 'All Other Perils', applies_to: 'dwelling', amount: 1500 },
      ],
      discounts_applied: ['Autopay Discount', 'Multi-Policy Discount'],
      exclusions_endorsements: [
        { label: 'Replacement Cost Endorsement', kind: 'endorsement' },
      ],
    },
  };
}

// An auto renewal where the premium rose, but the documents show genuinely
// more coverage behind it — liability limits raised, collision deductible
// lowered. The one path this engine calls likely justified.
function autoMoreCoverageBehindTheRise() {
  return {
    renewal: {
      carrier_name: 'Cardinal Auto',
      premium_total: 1380,
      coverages: [
        { label: 'Bodily Injury Liability', category: 'bodily_injury', limit: 250000 },
        { label: 'Property Damage Liability', category: 'property_damage', limit: 100000 },
        { label: 'Comprehensive', category: 'comprehensive', limit: null },
        { label: 'Collision', category: 'collision', limit: null },
      ],
      deductibles: [
        { label: 'Collision', applies_to: 'collision', amount: 500 },
        { label: 'Comprehensive', applies_to: 'comprehensive', amount: 500 },
      ],
      discounts_applied: [],
      exclusions_endorsements: [],
    },
    prior_policy: {
      carrier_name: 'Cardinal Auto',
      premium_total: 1140,
      coverages: [
        { label: 'Bodily Injury Liability', category: 'bodily_injury', limit: 100000 },
        { label: 'Property Damage Liability', category: 'property_damage', limit: 100000 },
        { label: 'Comprehensive', category: 'comprehensive', limit: null },
        { label: 'Collision', category: 'collision', limit: null },
      ],
      deductibles: [
        { label: 'Collision', applies_to: 'collision', amount: 1000 },
        { label: 'Comprehensive', applies_to: 'comprehensive', amount: 500 },
      ],
      discounts_applied: [],
      exclusions_endorsements: [],
    },
  };
}

// A renewal that rose a material amount with nothing on either document to
// explain it — no coverage change, no deductible change, no dropped
// discount. The plainest "ask your insurer why" case.
function premiumRoseUnexplained() {
  return {
    renewal: {
      carrier_name: 'Harborview Insurance',
      premium_total: 1650,
      coverages: [
        { label: 'Dwelling', category: 'dwelling', limit: 280000 },
      ],
      deductibles: [
        { label: 'All Perils', applies_to: 'dwelling', amount: 2000 },
      ],
      discounts_applied: ['Claims-Free Discount'],
      exclusions_endorsements: [],
    },
    prior_policy: {
      carrier_name: 'Harborview Insurance',
      premium_total: 1500,
      coverages: [
        { label: 'Dwelling', category: 'dwelling', limit: 280000 },
      ],
      deductibles: [
        { label: 'All Perils', applies_to: 'dwelling', amount: 2000 },
      ],
      discounts_applied: ['Claims-Free Discount'],
      exclusions_endorsements: [],
    },
  };
}

// A renewal that barely moved — under the materiality floor.
function premiumFlat() {
  return {
    renewal: {
      premium_total: 1020,
      coverages: [{ label: 'Dwelling', category: 'dwelling', limit: 300000 }],
      deductibles: [],
      discounts_applied: [],
      exclusions_endorsements: [],
    },
    prior_policy: {
      premium_total: 1000,
      coverages: [{ label: 'Dwelling', category: 'dwelling', limit: 300000 }],
      deductibles: [],
      discounts_applied: [],
      exclusions_endorsements: [],
    },
  };
}

// Only the renewal notice was uploaded, and it states no prior premium of
// its own. The comparison this product is sold on cannot run at all.
function renewalOnlyNoBaseline() {
  return {
    renewal: {
      premium_total: 1800,
      coverages: [{ label: 'Dwelling', category: 'dwelling', limit: 300000 }],
      deductibles: [],
      discounts_applied: [],
      exclusions_endorsements: [],
      renewal_prior_premium_stated: null,
    },
    prior_policy: null,
  };
}

// Only the renewal notice was uploaded, but it states its own prior premium
// ("your premium is changing from $X to $Y"). The premium check can run;
// nothing else can, because there is no prior document to compare coverage,
// deductibles, discounts or exclusions against.
function renewalOnlyWithStatedPriorPremium() {
  return {
    renewal: {
      premium_total: 1932,
      coverages: [{ label: 'Dwelling', category: 'dwelling', limit: 300000 }],
      deductibles: [],
      discounts_applied: [],
      exclusions_endorsements: [],
      renewal_prior_premium_stated: 1610,
    },
    prior_policy: null,
  };
}

module.exports = {
  homeCoverageCutBehindTheRise,
  autoMoreCoverageBehindTheRise,
  premiumRoseUnexplained,
  premiumFlat,
  renewalOnlyNoBaseline,
  renewalOnlyWithStatedPriorPremium,
};
