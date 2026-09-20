/* =========================================================================
   navigator-property-tax-engine.js — the deterministic half of Property Tax
   Navigator.

   Before this file existed, /property-tax had the widest gap between page
   and prompt this codebase's audits had found on any product. The page's
   own "What You Get" promised "the specific comparable properties used as
   evidence," an "estimate of your potential overassessment, in dollars,"
   and "AI pulls comparable properties" — while PRODUCT_CONFIGS['property-tax']
   said, in its own words, the opposite: "You do not have access to a live
   MLS or county assessor database, so you cannot pull real comparable-sale
   records." The prompt was more honest than the page it served — which
   meant the page was simply wrong, in the same shape docs/GOVERNMENT-MONEY-
   AUDIT.md found on that product ("the page sells a live database lookup.
   There is no database, there is no lookup, and the engine's own prompt
   says so in writing"). See docs/PROPERTY-TAX-AUDIT.md.

   So this file does not try to fabricate a comparable-sale database this
   codebase does not hold. It does something narrower and defensible instead:
   arithmetic on figures the homeowner actually supplies — their own prior
   and current assessed value, their own effective tax rate from their own
   bill, and (if they did the legwork the old prompt already told them to do
   themselves) comparable properties they found and typed in. Nothing here
   ever invents a comparable, a sale price, or a "typical" overassessment
   percentage.

   ONE THING HERE LEADS EVERYTHING ELSE: a factual error on the assessment
   notice itself (wrong square footage, wrong bed/bath count, a structure
   that does not exist) is the single most winnable, least adversarial appeal
   ground there is — assessors correct plain data errors far more readily
   than they revalue a property — and it is reported first regardless of
   what the dollar figures say. See applyFactualErrorLead().

   Lives at the repository root, beside navigator-home-maintenance-engine.js
   and for the same reason: required by the API *and* served to the browser
   as a plain script, so the check that gates checkout and the check the
   server enforces cannot drift.
   ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PropertyTaxEngine = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const Category = {
    FACTUAL_ERROR: 'factual_error',
    WORTH_APPEALING: 'worth_appealing',
    REQUIRES_DOCUMENTATION: 'requires_documentation',
    LIKELY_JUSTIFIED: 'likely_justified',
    WITHIN_NORMS: 'within_norms',
  };

  const CATEGORY_ORDER = {
    [Category.FACTUAL_ERROR]: 0,
    [Category.WORTH_APPEALING]: 1,
    [Category.REQUIRES_DOCUMENTATION]: 2,
    [Category.LIKELY_JUSTIFIED]: 3,
    [Category.WITHIN_NORMS]: 4,
  };

  // Disclosed thresholds, not market claims — see insurance-audit.js's
  // MATERIAL_CHANGE_THRESHOLD for the same discipline stated at length. Both
  // numbers say "worth a second look," never "typical" or "usual."
  const MATERIAL_CHANGE_THRESHOLD = 0.05; // a 5%+ year-over-year change is worth flagging
  const ABOVE_COMPARABLES_THRESHOLD = 0.10; // 10%+ above the customer's OWN supplied comparables

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function pct(fraction, digits) {
    return (fraction * 100).toFixed(digits === undefined ? 1 : digits) + '%';
  }

  function money(n) {
    return '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
  }

  function rankFindings(findings) {
    return findings.slice().sort((a, b) => {
      const c = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
      if (c !== 0) return c;
      return Math.abs(b.dollarImpact || 0) - Math.abs(a.dollarImpact || 0);
    });
  }

  // The one finding that always leads, regardless of what the dollar
  // comparison below says. A factual error is reported on its own terms.
  function factualErrorFinding(f) {
    if (!f.factual_errors) return null;
    return {
      checkId: 'FACTUAL_ERROR_ON_NOTICE',
      title: 'The assessment notice has something factually wrong about the property',
      category: Category.FACTUAL_ERROR,
      basis: f.factual_errors_notes
        ? `Reported: ${f.factual_errors_notes}`
        : 'A specific factual error on the notice was flagged, without further detail.',
      recommendedAction: 'This is usually the fastest, least adversarial appeal ground there is — most assessors '
        + 'will correct a plain data error (square footage, bed/bath count, a structure that does not exist) without '
        + 'a full revaluation dispute. Contact the assessor\'s office and ask specifically how to correct the record.',
      dollarImpact: null,
    };
  }

  function trendFinding(f, taxRatePct) {
    const prior = num(f.prior_assessed_value);
    const current = num(f.new_assessed_value);
    if (prior === null || current === null || prior === 0) return null;

    const delta = current - prior;
    const changePct = delta / prior;
    const dollarImpact = taxRatePct !== null ? delta * (taxRatePct / 100) : null;

    if (Math.abs(changePct) < MATERIAL_CHANGE_THRESHOLD) {
      return {
        checkId: 'ASSESSMENT_CHANGE_IMMATERIAL',
        title: 'Assessment did not move by a meaningful amount',
        category: Category.WITHIN_NORMS,
        basis: `The assessment changed by ${money(delta)} (${pct(Math.abs(changePct))}), under the `
          + `${pct(MATERIAL_CHANGE_THRESHOLD, 0)} this review treats as worth a second look.`,
        recommendedAction: 'No action needed on the year-over-year change alone.',
        dollarImpact,
      };
    }

    if (delta > 0 && f.physical_changes) {
      return {
        checkId: 'ASSESSMENT_ROSE_WITH_IMPROVEMENT',
        title: 'Assessment rose alongside a reported change to the property',
        category: Category.LIKELY_JUSTIFIED,
        basis: `The assessment rose ${money(delta)} (${pct(changePct)})`
          + (f.physical_changes_notes ? `, alongside a reported change: ${f.physical_changes_notes}.` : ', alongside a reported physical change to the property.'),
        recommendedAction: 'Likely justified by the documents — the increase tracks a change you reported. Still '
          + 'worth confirming the assessor\'s valuation of the change itself is reasonable.',
        dollarImpact,
      };
    }

    if (delta > 0) {
      return {
        checkId: 'ASSESSMENT_ROSE_NO_CHANGE_REPORTED',
        title: 'Assessment rose with no reported change to the property',
        category: Category.WORTH_APPEALING,
        basis: `The assessment rose ${money(delta)} (${pct(changePct)}) from the prior year, and no physical `
          + 'change to the property was reported.',
        recommendedAction: 'This is the strongest case in this report for an appeal: ask the assessor\'s office '
          + 'directly what drove the increase, and request the comparable properties or valuation method they used.',
        dollarImpact,
      };
    }

    // Fell — good news, no action.
    return {
      checkId: 'ASSESSMENT_FELL',
      title: 'Assessment is lower than the prior year',
      category: Category.WITHIN_NORMS,
      basis: `The assessment changed by ${money(delta)} (${pct(changePct)}).`,
      recommendedAction: 'No action needed.',
      dollarImpact,
    };
  }

  // Arithmetic on comparables the CUSTOMER supplied — never ones this engine
  // invents. See the file header: this is what "tell them to pull their own
  // comps" becomes when there is a structured field to put them in.
  //
  // Carries a dollarImpact the same way trendFinding does, and for the same
  // reason: docs/PROPERTY-TAX-AUDIT.md found this finding always shipped
  // with dollarImpact: null, regardless of whether a tax rate existed, which
  // is a second, narrower instance of the report's main gap — a "worth
  // appealing" category with no dollar figure behind it.
  function comparablesFinding(f, taxRatePct) {
    const comps = Array.isArray(f.comparables)
      ? f.comparables.map((c) => num(c && c.assessed_value)).filter((v) => v !== null)
      : [];
    const current = num(f.new_assessed_value);
    if (!comps.length || current === null) return null;

    const average = comps.reduce((a, b) => a + b, 0) / comps.length;
    if (average === 0) return null;
    const excessPct = (current - average) / average;

    if (excessPct >= ABOVE_COMPARABLES_THRESHOLD) {
      const dollarImpact = taxRatePct !== null ? (current - average) * (taxRatePct / 100) : null;
      return {
        checkId: 'ABOVE_OWN_COMPARABLES',
        title: 'Assessment is above the comparable properties you provided',
        category: Category.WORTH_APPEALING,
        basis: `Your assessment (${money(current)}) is ${pct(excessPct)} above the average of the `
          + `${comps.length} comparable ${comps.length === 1 ? 'property' : 'properties'} you supplied `
          + `(${money(average)}), at or above the ${pct(ABOVE_COMPARABLES_THRESHOLD, 0)} this review treats as worth citing.`,
        recommendedAction: 'Bring these specific comparables to the assessor\'s office or the appeal board — citing '
          + 'named nearby properties assessed lower is the same evidence assessors themselves use.',
        dollarImpact,
      };
    }
    return null;
  }

  function analyze(formData) {
    const f = formData || {};
    const taxRatePct = num(f.tax_rate_pct);

    const findings = [];
    const factual = factualErrorFinding(f);
    if (factual) findings.push(factual);

    const trend = trendFinding(f, taxRatePct);
    if (trend) findings.push(trend);

    const comp = comparablesFinding(f, taxRatePct);
    if (comp) findings.push(comp);

    const hasBaseline = num(f.prior_assessed_value) !== null
      || (Array.isArray(f.comparables) && f.comparables.length > 0)
      || f.factual_errors === true;

    if (!hasBaseline) {
      findings.push({
        checkId: 'COMPARISON_NOT_POSSIBLE',
        title: 'No basis for a comparison yet',
        category: Category.REQUIRES_DOCUMENTATION,
        basis: 'No prior assessed value, no comparable properties, and no factual error were given — there is '
          + 'nothing yet to compare this year\'s assessment against.',
        recommendedAction: 'Send last year\'s assessment notice, or the assessed value of one or two comparable '
          + 'nearby properties from your county assessor\'s public records site, and this can be run in full.',
        dollarImpact: null,
      });
    }

    return {
      findings: rankFindings(findings),
      hasBaseline,
      taxRatePct,
    };
  }

  function checkSufficiency(formData) {
    const missing = [];
    const f = formData || {};

    if (num(f.new_assessed_value) === null) {
      missing.push({
        key: 'new_assessed_value', label: 'Enter your current assessed value',
        why: 'This is the figure being appealed — every check in this review starts from it.',
      });
    }

    if (typeof f.physical_changes !== 'boolean') {
      missing.push({
        key: 'physical_changes', label: 'Say whether anything about the property has changed since the last assessment',
        why: 'A reported addition or renovation changes whether an increase looks justified — without an answer, that check is skipped.',
      });
    }

    if (typeof f.factual_errors !== 'boolean') {
      missing.push({
        key: 'factual_errors', label: 'Say whether the notice has anything factually wrong about the property',
        why: 'A data error is the single most actionable finding this review can surface, and it is only checked if you answer this.',
      });
    }

    const hasPriorValue = num(f.prior_assessed_value) !== null;
    const hasComparables = Array.isArray(f.comparables)
      && f.comparables.filter((c) => c && String(c.address || '').trim() && num(c.assessed_value) !== null).length > 0;
    const hasNumericBaseline = hasPriorValue || hasComparables;
    const hasBaseline = hasNumericBaseline || f.factual_errors === true;
    if (!hasBaseline) {
      missing.push({
        key: 'baseline', label: 'Add last year\'s assessed value, or at least one comparable property, or confirm a factual error',
        why: 'Without one of these three, there is nothing to compare this year\'s assessment against.',
      });
    }

    // docs/PROPERTY-TAX-AUDIT.md's highest-impact finding: a numeric baseline
    // (a prior value or comparables) produces a dollarImpact ONLY when a tax
    // rate exists — trendFinding and comparablesFinding both return
    // dollarImpact: null without one. Making the rate required exactly when
    // it would otherwise be used is what closes that gap, without asking for
    // it when it would do nothing — a factual-error-only submission has no
    // delta to multiply a rate against, so it stays optional there.
    if (hasNumericBaseline && num(f.tax_rate_pct) === null) {
      missing.push({
        key: 'tax_rate_pct',
        label: 'Add your effective tax rate',
        why: 'This is what turns a percentage change into an actual dollar figure — usually printed on your '
          + 'tax bill as a mill rate or effective rate — and without it this review can only tell you whether '
          + 'you have a case, not what it is worth.',
      });
    }

    return { sufficient: missing.length === 0, missing };
  }

  const api = {
    Category, CATEGORY_ORDER, MATERIAL_CHANGE_THRESHOLD, ABOVE_COMPARABLES_THRESHOLD,
    analyze, checkSufficiency, rankFindings,
    _internal: { num, pct, money },
  };

  return api;
}));
