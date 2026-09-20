'use strict';

// The deterministic half of Insurance Navigator.
//
// Every check in here runs on figures extracted from the customer's own
// renewal notice and, when they sent one, their prior policy. No model runs
// in this file. Nothing here consults an outside source, and nothing here is
// allowed to estimate: if a check cannot be computed from what was uploaded,
// it is skipped by name rather than guessed at.
//
// docs/INSURANCE-AUDIT.md is why this file exists. The product previously ran
// on a single model call, told to read whatever was attached and "give a
// clear verdict on whether the renewal looks fair/typical" — a claim this
// codebase's own audits of Home Savings and Government Money had already
// found and banned everywhere else, because nobody here holds a rate table or
// a market-pricing corpus. That is why there is no "typical" or "market"
// judgement anywhere below: every finding this engine produces rests on
// arithmetic between two documents the customer themselves provided, which is
// the one kind of insurance claim this codebase can actually stand behind.
//
// The other thing this file will not do is recommend cutting coverage to cut
// a premium. A dropped coverage line or a shrunk limit is always reported as
// its own finding, in the coverage-gap category, regardless of which
// direction the premium moved — the brief this audit was built against calls
// this "minimize unnecessary cost while preserving appropriate protection,
// not minimize premiums at all costs", and the category ordering below (see
// CATEGORY_ORDER) puts coverage gaps ahead of every savings-shaped finding
// for exactly that reason.

// --- vocabulary -------------------------------------------------------------

// Ordered strongest-for-the-customer-to-see-first. A coverage gap is a
// protection risk, not a savings opportunity, and it outranks even a
// confirmed unexplained premium rise: money is recoverable, a lapsed
// endorsement discovered after a loss is not.
const Category = {
  COVERAGE_GAP: 'coverage_gap',
  WORTH_CHALLENGING: 'worth_challenging',
  REQUIRES_DOCUMENTATION: 'requires_documentation',
  LIKELY_JUSTIFIED: 'likely_justified',
  WITHIN_NORMS: 'within_norms',
};

const CATEGORY_ORDER = {
  [Category.COVERAGE_GAP]: 0,
  [Category.WORTH_CHALLENGING]: 1,
  [Category.REQUIRES_DOCUMENTATION]: 2,
  [Category.LIKELY_JUSTIFIED]: 3,
  [Category.WITHIN_NORMS]: 4,
};

// Deliberately two members, not the three or four this codebase's other
// engines carry. There is no TYPICAL_RANGE or MARKET_NORM kind here on
// purpose — see the file header. Every finding this engine produces is either
// arithmetic on the customer's own two documents, or a document's own stated
// terms; nothing here is ever a comparison to what is usual elsewhere.
const EvidenceKind = {
  INTERNAL_ARITHMETIC: 'hard_rule:internal_arithmetic',
  DOCUMENT_TERMS: 'hard_rule:document_terms',
  NONE: 'no_evidence_available',
};

const Actionability = {
  ASK_INSURER: 'ask_insurer_before_renewal',
  REVIEW_BEFORE_ACCEPTING: 'review_before_accepting',
  NEEDS_DOCS: 'requires_additional_documentation',
  NONE: 'no_action_needed',
};

// A materiality floor for the premium-change headline, not a market
// judgement. 5% is a disclosed, fixed threshold for "worth a question to your
// insurer" — it says nothing about what any other customer's renewal did, and
// it is never described to the customer as typical or atypical. Below it, the
// only honest thing to say is that the premium barely moved.
const MATERIAL_CHANGE_THRESHOLD = 0.05;

const CHECK_NAMES = {
  premium_change: 'the premium change between your prior term and this renewal',
  coverage_limits: 'coverage limit changes by category',
  deductibles: 'deductible changes by category',
  discounts: 'whether previously-applied discounts still apply',
  exclusions_and_endorsements: 'new or dropped exclusions and endorsements',
};

// --- small helpers ----------------------------------------------------------

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function money(v) {
  const n = num(v);
  if (n === null) return null;
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: Math.abs(n) % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function pct(fraction, digits) {
  const n = num(fraction);
  if (n === null) return null;
  return (n * 100).toFixed(digits === undefined ? 1 : digits) + '%';
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

// Human-readable labels for the fixed category vocabulary, so a finding's
// basis reads as a sentence rather than a database key.
const COVERAGE_LABELS = {
  dwelling: 'dwelling coverage',
  other_structures: 'other structures coverage',
  personal_property: 'personal property coverage',
  loss_of_use: 'loss of use coverage',
  liability: 'liability coverage',
  medical_payments: 'medical payments coverage',
  bodily_injury: 'bodily injury coverage',
  property_damage: 'property damage coverage',
  comprehensive: 'comprehensive coverage',
  collision: 'collision coverage',
  uninsured_motorist: 'uninsured/underinsured motorist coverage',
  personal_injury_protection: 'personal injury protection',
  umbrella_liability: 'umbrella liability coverage',
  other: 'coverage',
};

function coverageLabel(category) {
  return COVERAGE_LABELS[category] || 'coverage';
}

// The first coverage line recorded for a category. Declarations pages
// essentially never carry two lines of the same category, and if one did,
// preferring the first is the same "do not guess which one governs" choice
// this codebase makes elsewhere rather than summing or averaging.
function byCategory(list) {
  const map = new Map();
  for (const item of arr(list)) {
    const category = item && item.category;
    if (!category) continue;
    if (!map.has(category)) map.set(category, item);
  }
  return map;
}

function byDeductibleCategory(list) {
  const map = new Map();
  for (const item of arr(list)) {
    const category = item && item.applies_to;
    if (!category) continue;
    if (!map.has(category)) map.set(category, item);
  }
  return map;
}

function normalizedLabel(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// --- the audit ---------------------------------------------------------------

function rankFindings(findings) {
  return findings.slice().sort((a, b) => {
    const c = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
    if (c !== 0) return c;
    return Math.abs(b.dollarImpact || 0) - Math.abs(a.dollarImpact || 0);
  });
}

// renewal is required (the intake gates on it); prior_policy may be null,
// matching the shape api/_lib/insurance-extract.js hands back — a caller can
// pass the extraction straight through. When neither the prior policy nor a
// prior-premium figure printed on the renewal notice itself is available,
// the comparison this product is sold on cannot run, and the engine says so
// rather than judging the renewal in isolation.
function runInsuranceAudit({ renewal, prior_policy: priorPolicy }) {
  const findings = [];
  const skipped = [];
  const checksTotal = Object.keys(CHECK_NAMES).length;
  let checksRun = 0;

  const r = renewal || {};
  const p = priorPolicy || null;

  const renewalPremium = num(r.premium_total);
  const priorPremium = p ? num(p.premium_total) : null;
  const statedPriorPremium = num(r.renewal_prior_premium_stated);

  // Prefer an actual prior-policy document over a figure the renewal notice
  // states about itself — both are printed figures, but the document is the
  // fuller comparison (it carries coverage and deductible detail the renewal
  // notice's own "changing from $X to $Y" line does not).
  const priorPremiumValue = priorPremium !== null ? priorPremium : statedPriorPremium;
  const priorPremiumSource = priorPremium !== null
    ? 'prior_policy_document'
    : (statedPriorPremium !== null ? 'renewal_notice_stated' : null);

  const comparisonAvailable = renewalPremium !== null && priorPremiumValue !== null;

  if (!comparisonAvailable) {
    findings.push({
      checkId: 'COMPARISON_NOT_POSSIBLE',
      title: 'No prior premium to compare this renewal against',
      category: Category.REQUIRES_DOCUMENTATION,
      evidence: EvidenceKind.NONE,
      actionability: Actionability.NEEDS_DOCS,
      basis: renewalPremium === null
        ? 'The premium on the renewal notice itself could not be read.'
        : 'Neither a prior policy document nor a prior-premium figure printed on the renewal notice was available.',
      recommendedAction: 'Send your prior policy or declarations page, or the renewal notice\'s own prior-premium line if it has one, and this comparison can run.',
      dollarImpact: null,
      detail: {},
    });
    skipped.push(
      CHECK_NAMES.premium_change,
      CHECK_NAMES.coverage_limits,
      CHECK_NAMES.deductibles,
      CHECK_NAMES.discounts,
      CHECK_NAMES.exclusions_and_endorsements,
    );
    return { findings, skipped, checksRun: 0, checksTotal, comparisonAvailable: false, priorPremiumSource: null };
  }

  checksRun += 1; // premium_change always runs once comparisonAvailable is true

  const premiumDelta = renewalPremium - priorPremiumValue;
  const premiumPct = priorPremiumValue !== 0 ? premiumDelta / priorPremiumValue : null;

  // --- coverage limits, by category -----------------------------------------

  let coverageIncreased = [];
  let coverageDecreased = [];
  let coverageRemoved = [];
  if (r.coverages && r.coverages.length && p && p.coverages && p.coverages.length) {
    checksRun += 1;
    const renewalCov = byCategory(r.coverages);
    const priorCov = byCategory(p.coverages);

    for (const [category, priorItem] of priorCov) {
      const renewalItem = renewalCov.get(category);
      const priorLimit = num(priorItem.limit);
      if (!renewalItem) {
        if (priorLimit !== null) coverageRemoved.push({ category, priorLimit, label: priorItem.label });
        continue;
      }
      const renewalLimit = num(renewalItem.limit);
      if (priorLimit === null || renewalLimit === null) continue;
      if (renewalLimit < priorLimit) {
        coverageDecreased.push({ category, priorLimit, renewalLimit, label: renewalItem.label });
      } else if (renewalLimit > priorLimit) {
        coverageIncreased.push({ category, priorLimit, renewalLimit, label: renewalItem.label });
      }
    }

    for (const item of coverageRemoved) {
      findings.push({
        checkId: 'COVERAGE_LIMIT_REMOVED',
        title: `${coverageLabel(item.category)} no longer appears on the renewal`,
        category: Category.COVERAGE_GAP,
        evidence: EvidenceKind.INTERNAL_ARITHMETIC,
        actionability: Actionability.ASK_INSURER,
        basis: `Your prior policy carried ${coverageLabel(item.category)} at ${money(item.priorLimit)} ("${item.label}"). This renewal does not list it.`,
        recommendedAction: 'Confirm with your insurer whether this coverage was intentionally dropped before you accept the renewal.',
        dollarImpact: null,
        detail: item,
      });
    }
    for (const item of coverageDecreased) {
      findings.push({
        checkId: 'COVERAGE_LIMIT_REDUCED',
        title: `${coverageLabel(item.category)} limit reduced`,
        category: Category.COVERAGE_GAP,
        evidence: EvidenceKind.INTERNAL_ARITHMETIC,
        actionability: Actionability.ASK_INSURER,
        basis: `${coverageLabel(item.category)} fell from ${money(item.priorLimit)} to ${money(item.renewalLimit)} between your prior policy and this renewal.`,
        recommendedAction: 'Ask your insurer why this limit was reduced and whether it still matches what you need covered.',
        dollarImpact: item.renewalLimit - item.priorLimit,
        detail: item,
      });
    }
  } else {
    skipped.push(CHECK_NAMES.coverage_limits + (p ? ' (coverage limits were not available on both documents)' : ' (no prior policy was provided)'));
  }

  // --- deductibles, by category ----------------------------------------------

  let deductibleIncreased = [];
  let deductibleDecreased = [];
  if (r.deductibles && r.deductibles.length && p && p.deductibles && p.deductibles.length) {
    checksRun += 1;
    const renewalDed = byDeductibleCategory(r.deductibles);
    const priorDed = byDeductibleCategory(p.deductibles);

    for (const [category, priorItem] of priorDed) {
      const renewalItem = renewalDed.get(category);
      if (!renewalItem) continue;
      const priorAmount = num(priorItem.amount);
      const renewalAmount = num(renewalItem.amount);
      if (priorAmount === null || renewalAmount === null) continue;
      if (priorItem.is_percentage || renewalItem.is_percentage) continue; // not comparable as dollars
      if (renewalAmount > priorAmount) {
        deductibleIncreased.push({ category, priorAmount, renewalAmount, label: renewalItem.label });
      } else if (renewalAmount < priorAmount) {
        deductibleDecreased.push({ category, priorAmount, renewalAmount, label: renewalItem.label });
      }
    }

    for (const item of deductibleIncreased) {
      // A deductible that rose alongside a premium that also rose, or held
      // flat, is the customer taking on more risk with nothing to show for
      // it — that is worth challenging on its own terms, independent of the
      // headline premium finding below. If the premium instead fell, the
      // trade is at least visible and this is reported as informational.
      const worseDeal = premiumDelta >= 0;
      findings.push({
        checkId: 'DEDUCTIBLE_INCREASED',
        title: `${coverageLabel(item.category)} deductible increased`,
        category: worseDeal ? Category.WORTH_CHALLENGING : Category.WITHIN_NORMS,
        evidence: EvidenceKind.INTERNAL_ARITHMETIC,
        actionability: worseDeal ? Actionability.ASK_INSURER : Actionability.NONE,
        basis: `The deductible for ${coverageLabel(item.category)} rose from ${money(item.priorAmount)} to ${money(item.renewalAmount)}`
          + (worseDeal ? ' while the total premium did not fall.' : ', alongside a lower total premium.'),
        recommendedAction: worseDeal
          ? 'Ask your insurer what the deductible increase was for, since it is not offset by a lower premium.'
          : 'No action needed — you are carrying more of the risk yourself in exchange for a lower premium, which is a trade you can evaluate on its own terms.',
        dollarImpact: item.renewalAmount - item.priorAmount,
        detail: item,
      });
    }
  } else {
    skipped.push(CHECK_NAMES.deductibles + (p ? ' (deductible figures were not available on both documents)' : ' (no prior policy was provided)'));
  }

  // --- discounts ---------------------------------------------------------------

  let discountsDropped = [];
  if (p && arr(p.discounts_applied).length) {
    checksRun += 1;
    const renewalDiscounts = new Set(arr(r.discounts_applied).map(normalizedLabel));
    discountsDropped = arr(p.discounts_applied).filter((d) => !renewalDiscounts.has(normalizedLabel(d)));
    if (discountsDropped.length) {
      findings.push({
        checkId: 'DISCOUNT_DROPPED',
        title: discountsDropped.length === 1
          ? `The ${discountsDropped[0]} discount no longer applies`
          : `${discountsDropped.length} discounts no longer apply`,
        category: Category.WORTH_CHALLENGING,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.ASK_INSURER,
        basis: `Your prior policy listed ${discountsDropped.join(', ')} as applied. None of these appear on this renewal.`,
        recommendedAction: 'Ask your insurer why each discount stopped applying and whether you still qualify.',
        dollarImpact: null,
        detail: { discountsDropped },
      });
    }
  } else if (!p) {
    skipped.push(CHECK_NAMES.discounts + ' (no prior policy was provided)');
  } else {
    checksRun += 1; // prior policy had no discounts listed; nothing to lose, check "ran"
  }

  // --- exclusions and endorsements ---------------------------------------------

  let newExclusions = [];
  let droppedEndorsements = [];
  if (arr(r.exclusions_endorsements).length || (p && arr(p.exclusions_endorsements).length)) {
    checksRun += 1;
    const priorLabels = new Set(arr(p && p.exclusions_endorsements).map((e) => normalizedLabel(e.label)));
    const renewalLabels = new Set(arr(r.exclusions_endorsements).map((e) => normalizedLabel(e.label)));

    if (p) {
      newExclusions = arr(r.exclusions_endorsements)
        .filter((e) => e.kind === 'exclusion' && !priorLabels.has(normalizedLabel(e.label)));
      droppedEndorsements = arr(p.exclusions_endorsements)
        .filter((e) => e.kind === 'endorsement' && !renewalLabels.has(normalizedLabel(e.label)));
    }

    for (const item of newExclusions) {
      findings.push({
        checkId: 'NEW_EXCLUSION_ADDED',
        title: `New exclusion on this renewal: ${item.label}`,
        category: Category.COVERAGE_GAP,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.ASK_INSURER,
        basis: `"${item.label}" appears on this renewal's schedule of forms and did not appear on your prior policy's.`,
        recommendedAction: 'Ask your insurer exactly what this exclusion removes and whether it affects a loss you would expect to be covered.',
        dollarImpact: null,
        detail: item,
      });
    }
    for (const item of droppedEndorsements) {
      findings.push({
        checkId: 'ENDORSEMENT_DROPPED',
        title: `Endorsement no longer on this renewal: ${item.label}`,
        category: Category.COVERAGE_GAP,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.ASK_INSURER,
        basis: `"${item.label}" was listed on your prior policy's schedule of forms and does not appear on this renewal's.`,
        recommendedAction: 'Ask your insurer whether this endorsement was intentionally dropped and what it covered.',
        dollarImpact: null,
        detail: item,
      });
    }
  } else {
    skipped.push(CHECK_NAMES.exclusions_and_endorsements + ' (no schedule of forms was readable on either document)');
  }

  // --- the headline premium finding --------------------------------------------
  //
  // Exactly one of these fires. Priority order: a coverage cut explains a
  // rise worse than anything else could (you are paying more for less); a
  // deductible increase with nothing to show for it is next; a genuine
  // increase in what you are covered for is the one case a rising premium is
  // likely justified; and a rise with no coverage-side explanation at all in
  // what the documents show is the plainest case for a direct question.

  const materialityBasis = `${money(Math.abs(premiumDelta))} (${pct(Math.abs(premiumPct === null ? 0 : premiumPct))}) `
    + `${premiumDelta >= 0 ? 'increase' : 'decrease'}, from ${money(priorPremiumValue)} to ${money(renewalPremium)}`
    + (priorPremiumSource === 'renewal_notice_stated' ? ', based on the prior premium your renewal notice itself states' : '.');

  const isMaterial = premiumPct !== null && Math.abs(premiumPct) >= MATERIAL_CHANGE_THRESHOLD;

  if (!isMaterial) {
    findings.push({
      checkId: 'PREMIUM_CHANGE_IMMATERIAL',
      title: 'Premium did not move by a meaningful amount',
      category: Category.WITHIN_NORMS,
      evidence: EvidenceKind.INTERNAL_ARITHMETIC,
      actionability: Actionability.NONE,
      basis: `Your premium changed by ${materialityBasis}, under the ${pct(MATERIAL_CHANGE_THRESHOLD, 0)} this review treats as worth a direct question.`,
      recommendedAction: 'No action needed on premium alone.',
      dollarImpact: premiumDelta,
      detail: { premiumPct },
    });
  } else if (premiumDelta < 0) {
    findings.push({
      checkId: 'PREMIUM_FELL',
      title: 'Premium is lower on this renewal',
      category: Category.WITHIN_NORMS,
      evidence: EvidenceKind.INTERNAL_ARITHMETIC,
      actionability: Actionability.NONE,
      basis: `Your premium changed by ${materialityBasis}.`,
      recommendedAction: 'No action needed — confirm the coverage and deductible findings above still meet your needs, and accept the renewal.',
      dollarImpact: premiumDelta,
      detail: { premiumPct },
    });
  } else if (coverageDecreased.length || coverageRemoved.length) {
    findings.push({
      checkId: 'PREMIUM_ROSE_COVERAGE_DECREASED',
      title: 'Premium rose while coverage was reduced',
      category: Category.WORTH_CHALLENGING,
      evidence: EvidenceKind.INTERNAL_ARITHMETIC,
      actionability: Actionability.ASK_INSURER,
      basis: `Your premium changed by ${materialityBasis}, while ` + (coverageRemoved.length
        ? `${coverageRemoved.map((c) => coverageLabel(c.category)).join(', ')} no longer appears on the renewal`
        : `${coverageDecreased.map((c) => coverageLabel(c.category)).join(', ')} was reduced`) + '.',
      recommendedAction: 'This is the strongest case in this report for a direct question to your insurer before accepting the renewal: you are paying more for less.',
      dollarImpact: premiumDelta,
      detail: { premiumPct, coverageDecreased, coverageRemoved },
    });
  } else if (deductibleIncreased.length && !coverageIncreased.length) {
    findings.push({
      checkId: 'PREMIUM_ROSE_DEDUCTIBLE_INCREASED',
      title: 'Premium rose while your deductible also increased',
      category: Category.WORTH_CHALLENGING,
      evidence: EvidenceKind.INTERNAL_ARITHMETIC,
      actionability: Actionability.ASK_INSURER,
      basis: `Your premium changed by ${materialityBasis}, while your ${deductibleIncreased.map((d) => coverageLabel(d.category)).join(', ')} deductible also rose. Neither the documents show more coverage nor a lower deductible to explain the increase.`,
      recommendedAction: 'Ask your insurer directly what accounts for the increase, since you are both paying more and carrying more risk yourself.',
      dollarImpact: premiumDelta,
      detail: { premiumPct, deductibleIncreased },
    });
  } else if (coverageIncreased.length || deductibleDecreased.length) {
    findings.push({
      checkId: 'PREMIUM_ROSE_COVERAGE_INCREASED',
      title: 'Premium rose alongside more coverage',
      category: Category.LIKELY_JUSTIFIED,
      evidence: EvidenceKind.INTERNAL_ARITHMETIC,
      actionability: Actionability.NONE,
      basis: `Your premium changed by ${materialityBasis}, while ` + [
        coverageIncreased.length ? `${coverageIncreased.map((c) => `${coverageLabel(c.category)} (${money(c.priorLimit)} → ${money(c.renewalLimit)})`).join(', ')} increased` : null,
        deductibleDecreased.length ? `${deductibleDecreased.map((d) => coverageLabel(d.category)).join(', ')} deductible decreased` : null,
      ].filter(Boolean).join(' and ') + '.',
      recommendedAction: 'Likely justified by the documents — the increase tracks a change in what you are covered for. Still worth a quick read to confirm the added protection is one you actually want.',
      dollarImpact: premiumDelta,
      detail: { premiumPct, coverageIncreased, deductibleDecreased },
    });
  } else {
    findings.push({
      checkId: 'PREMIUM_ROSE_NO_COVERAGE_CHANGE',
      title: 'Premium rose with no coverage or deductible change the documents explain',
      category: Category.WORTH_CHALLENGING,
      evidence: EvidenceKind.INTERNAL_ARITHMETIC,
      actionability: Actionability.ASK_INSURER,
      basis: `Your premium changed by ${materialityBasis}. Nothing in the coverage limits or deductibles on these two documents changed to account for it.`,
      recommendedAction: 'Ask your insurer directly what the increase is for. If the answer is not specific to your policy or property, this is worth shopping.',
      dollarImpact: premiumDelta,
      detail: { premiumPct },
    });
  }

  return {
    findings,
    skipped,
    checksRun,
    checksTotal,
    comparisonAvailable: true,
    priorPremiumSource,
  };
}

module.exports = {
  runInsuranceAudit,
  rankFindings,
  Category,
  CATEGORY_ORDER,
  EvidenceKind,
  Actionability,
  MATERIAL_CHANGE_THRESHOLD,
  CHECK_NAMES,
  _internal: { num, money, pct, coverageLabel, normalizedLabel },
};
