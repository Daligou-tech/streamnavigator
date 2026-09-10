'use strict';

// The deterministic half of Rental Navigator.
//
// Every check in here runs on numbers extracted from the landlord's own
// documents and produces an exact figure or nothing at all. No model runs in
// this file. Nothing here consults an outside source, and nothing here is
// allowed to estimate: if a check cannot be computed from what was uploaded,
// it is skipped by name rather than guessed at.
//
// Why this exists, in one example. An audit of three live paid reports on
// 2026-09-09 ran a four-unit property whose mortgage statement showed $118 a
// month of mortgage insurance against a balance of $253,412 on a $385,000
// purchase — 66% loan-to-value, well past the point that charge normally
// stops. The model read the statement. It quoted the cash-flow figure that
// includes the charge. It never mentioned it. On a second property with no
// mortgage insurance, the same model volunteered "no PMI (25% down)"
// unprompted. Same engine, same prompt, opposite outcomes, because nothing was
// checking a list — it was noticing what caught its eye.
//
// The same run's expense schedule itemised $6,900 of repairs against a stated
// total of $7,400. Nothing in the pipeline added up a column, so a $500 hole in
// a managed statement went out as a clean report.
//
// Both are arithmetic. Arithmetic belongs here, where it runs the same way
// every time, and the model's job downstream is to write up what this file
// found — never to add to it. That is the arrangement api/_lib/closing-audit.js
// already proved on the Closing Disclosure product, and this file follows it
// deliberately rather than inventing a second idiom.

// --- vocabulary -------------------------------------------------------------

// Ordered strongest first. The ladder is rental-specific on purpose: "confirmed
// arithmetic error" and "charge a rule says should have stopped" are different
// claims from "above a typical range", and a report that blurs them is telling
// a landlord that a market opinion and a proven subtraction carry equal weight.
const Severity = {
  CONFIRMED_ERROR: 'confirmed_arithmetic_error',
  RECOVERABLE_CHARGE: 'recoverable_charge',
  BELOW_INTERNAL_COMP: 'below_internal_comparable',
  UNRECOVERED_COST: 'unrecovered_owner_cost',
  // Proved against the same property twelve months earlier, which is why it
  // outranks a comparison against what is typical elsewhere. See rental-trend.js.
  COST_ROSE: 'rose_against_prior_period',
  ABOVE_TYPICAL_RANGE: 'above_typical_range',
  CAPITAL_DECISION: 'capital_decision_due',
  REQUIRES_DOCUMENTATION: 'requires_documentation',
  WITHIN_NORMS: 'within_norms',
};

const SEVERITY_ORDER = {
  [Severity.CONFIRMED_ERROR]: 0,
  [Severity.RECOVERABLE_CHARGE]: 1,
  [Severity.BELOW_INTERNAL_COMP]: 2,
  [Severity.UNRECOVERED_COST]: 3,
  [Severity.COST_ROSE]: 4,
  [Severity.ABOVE_TYPICAL_RANGE]: 5,
  [Severity.CAPITAL_DECISION]: 6,
  [Severity.REQUIRES_DOCUMENTATION]: 7,
  [Severity.WITHIN_NORMS]: 8,
};

// What the finding rests on. The distinction that matters to a landlord is
// between something proved from their own paperwork and something compared
// against what is usual — the first survives an argument with a property
// manager and the second does not.
const EvidenceKind = {
  INTERNAL_ARITHMETIC: 'hard_rule:internal_arithmetic',
  INTERNAL_COMPARABLE: 'hard_rule:comparable_unit_same_property',
  DOCUMENT_TERMS: 'hard_rule:document_terms',
  LENDER_RULE: 'hard_rule:standard_lender_threshold',
  TYPICAL_RANGE: 'market_norm:typical_range',
  NONE: 'no_evidence_available',
};

const Actionability = {
  ACT_NOW: 'actionable_now',
  AT_RENEWAL: 'actionable_at_renewal',
  CAPITAL_DECISION: 'requires_capital_decision',
  NEEDS_DOCS: 'requires_additional_documentation',
};

// A dollar figure means different things in different findings and a ranked
// list that hides the difference is dishonest. $1,416 of mortgage insurance is
// money that stops leaving the account; $6,240 of owner-paid water is money
// currently unrecovered, only part of which any billback program recovers.
const ImpactKind = {
  RECOVERABLE: 'recoverable',   // stops or returns in full once acted on
  EXCESS: 'excess',             // the amount above the property's own baseline
  EXPOSURE: 'exposure',         // total currently borne; a share is addressable
  ERROR: 'unexplained',         // a discrepancy, not yet a saving
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
  return '$' + Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: Math.abs(n) % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function pct(v, digits) {
  const n = num(v);
  if (n === null) return null;
  return (n * 100).toFixed(digits === undefined ? 1 : digits) + '%';
}

function median(values) {
  const list = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

function sum(values) {
  return values.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

// Findings are read by the customer, so nothing that reaches a title or a basis
// may still look like a database key. The extractor is free to record a utility
// as "water_sewer" and a system as "hvac"; neither belongs in a sentence.
const LABELS = {
  water_sewer: 'water and sewer',
  hvac: 'HVAC',
  plumbing: 'plumbing',
  electrical: 'electrical',
  appliance: 'appliance',
  roof: 'roof',
  exterior: 'exterior',
  landscaping: 'landscaping',
};

function sentenceCase(text) {
  const t = String(text || "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function label(key) {
  const raw = String(key || '').trim();
  if (LABELS[raw.toLowerCase()]) return LABELS[raw.toLowerCase()];
  return raw.replace(/[_-]+/g, ' ');
}

// --- completeness -----------------------------------------------------------
//
// A "confirmed arithmetic error" is the strongest thing this product says. It
// sends a landlord to their property manager to ask why a statement is short.
// It has to be right every time, and the failure mode is not bad arithmetic —
// the subtraction is trivial — it is an extracted list with a line missing.
//
// Both live reports on 2026-09-09 hit it. One announced a $5,480 hole that was
// exactly the management fee, recorded in the management object and left out of
// the expense list. The other announced a $2,415 hole that was exactly the
// repairs line, itemised into maintenance_items and left out of the expense
// list. Both led the report. Both would have been read as an accusation.
//
// The extractor is now told plainly not to do that. This is the half of the fix
// that does not depend on it complying: three ways of noticing that a list is
// short, any of which makes the check decline to run and say so, because
// "we could not test your totals" costs a customer nothing and "your manager
// is short $5,480" costs them a relationship.
function listIsComplete(recorded, printedCount, alsoExpected) {
  const printed = num(printedCount);
  if (printed !== null && recorded.length !== printed) return false;
  for (const expected of alsoExpected || []) {
    if (expected) return false;
  }
  return true;
}

function expenseListIsComplete(x) {
  const lines = arr(x.expenses);
  const hasCategory = (c) => lines.some((e) => e && e.category === c);
  const management = x.management || {};
  return listIsComplete(lines, x.expense_lines_printed, [
    // A fee recorded in the management object with no matching expense line is
    // the exact shape of the first false positive.
    management.self_managed !== true
      && (num(management.fee_annual) !== null || num(management.fee_percent) !== null)
      && !hasCategory('management'),
    // And a repairs total with no repairs line is the shape of the second.
    num(x.maintenance_total_stated) !== null && !hasCategory('repairs_maintenance'),
  ]);
}

// --- the catalog ------------------------------------------------------------
//
// Each entry declares what it needs, so a check that cannot run is reported by
// name instead of quietly producing nothing. A landlord who is told "we could
// not test your escrow because the statement did not show the annual tax and
// insurance figures" has learned something; a silent omission teaches them that
// the escrow was fine.

const CATALOG = [];
// silentSkip marks a check that is the complement of another one — it only runs
// when its sibling cannot, so listing it as 'skipped' the rest of the time would
// tell the customer a check was missed when in fact the better one ran.
function check(id, checkLabel, needs, run, opts) {
  CATALOG.push({ id, label: checkLabel, needs, run, silentSkip: !!(opts && opts.silentSkip) });
}

// -- 1. Does the maintenance schedule add up to its own total? ---------------
check(
  'MAINT_SCHEDULE_FOOTS',
  'Repair line items add up to the repairs total billed',
  (x) => arr(x.maintenance_items).length >= 2 && num(x.maintenance_total_stated) !== null
    && listIsComplete(arr(x.maintenance_items), x.maintenance_lines_printed),
  (x) => {
    const items = arr(x.maintenance_items).map((i) => num(i.amount)).filter((n) => n !== null);
    const itemised = sum(items);
    const stated = num(x.maintenance_total_stated);
    const gap = Math.round((stated - itemised) * 100) / 100;

    if (Math.abs(gap) < 1) {
      return {
        checkId: 'MAINT_SCHEDULE_FOOTS',
        title: 'The itemised repairs add up to the repairs total you were billed',
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.INTERNAL_ARITHMETIC,
        actionability: Actionability.ACT_NOW,
        basis: `${items.length} line items totalling ${money(itemised)} against a stated total of ${money(stated)}.`,
        charged: stated,
        expected: itemised,
        dollarImpact: null,
      };
    }
    return {
      checkId: 'MAINT_SCHEDULE_FOOTS',
      title: gap > 0
        ? 'The repairs you were billed exceed the repairs itemised on the same statement'
        : 'The itemised repairs exceed the repairs total on the same statement',
      severity: Severity.CONFIRMED_ERROR,
      evidence: EvidenceKind.INTERNAL_ARITHMETIC,
      actionability: Actionability.ACT_NOW,
      basis: `The ${items.length} line items on the repair schedule total ${money(itemised)}. `
        + `The statement bills ${money(stated)}. The difference is ${money(gap)}, `
        + 'which is not explained anywhere on the document.',
      recommendedAction: 'Ask for the line items making up the difference, or a corrected statement.',
      charged: stated,
      expected: itemised,
      dollarImpact: Math.abs(gap),
      impactKind: ImpactKind.ERROR,
      askManager: true,
      detail: { itemCount: items.length, itemised, stated },
    };
  },
);

// -- 2. Do the operating expenses add up to their own total? -----------------
check(
  'EXPENSE_TOTAL_FOOTS',
  'Operating expense lines add up to the stated total',
  (x) => arr(x.expenses).length >= 3 && num(x.expense_total_stated) !== null
    && expenseListIsComplete(x),
  (x) => {
    // Subtotal rows are excluded by the extractor. If one slipped through it
    // would show up as a large positive gap, so the tolerance stays tight and
    // the finding says what it saw rather than asserting a cause.
    const lines = arr(x.expenses).map((e) => num(e.annual_amount)).filter((n) => n !== null);
    const itemised = sum(lines);
    const stated = num(x.expense_total_stated);
    const gap = Math.round((stated - itemised) * 100) / 100;

    if (Math.abs(gap) < 1) {
      return {
        checkId: 'EXPENSE_TOTAL_FOOTS',
        title: 'Your operating expense lines add up to the total on the statement',
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.INTERNAL_ARITHMETIC,
        actionability: Actionability.ACT_NOW,
        basis: `${lines.length} expense lines totalling ${money(itemised)}, against a stated total of ${money(stated)}.`,
        charged: stated,
        expected: itemised,
        dollarImpact: null,
      };
    }
    return {
      checkId: 'EXPENSE_TOTAL_FOOTS',
      title: 'The operating expense lines do not add up to the total on the statement',
      severity: Severity.CONFIRMED_ERROR,
      evidence: EvidenceKind.INTERNAL_ARITHMETIC,
      actionability: Actionability.ACT_NOW,
      basis: `The ${lines.length} expense lines total ${money(itemised)}. The statement's own `
        + `total is ${money(stated)} — a difference of ${money(gap)}.`,
      recommendedAction: 'Ask for a corrected statement or the missing line items.',
      charged: stated,
      expected: itemised,
      dollarImpact: Math.abs(gap),
      impactKind: ImpactKind.ERROR,
      askManager: true,
      detail: { lineCount: lines.length, itemised, stated },
    };
  },
);

// -- 3. Is mortgage insurance still being charged past the usual threshold? ---
check(
  'PMI_STILL_CHARGED',
  'Mortgage insurance tested against loan-to-value',
  (x) => num((x.loan || {}).mortgage_insurance_monthly) !== null
    && num((x.loan || {}).current_balance) !== null
    && (num((x.property || {}).purchase_price) !== null || num((x.loan || {}).original_property_value) !== null),
  (x) => {
    const loan = x.loan || {};
    const property = x.property || {};
    const monthly = num(loan.mortgage_insurance_monthly);
    const balance = num(loan.current_balance);
    const basisValue = num(loan.original_property_value) !== null
      ? num(loan.original_property_value)
      : num(property.purchase_price);
    const ltv = balance / basisValue;
    const annual = Math.round(monthly * 12 * 100) / 100;

    if (monthly <= 0) {
      return {
        checkId: 'PMI_STILL_CHARGED',
        title: 'No mortgage insurance is being charged on this loan',
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.ACT_NOW,
        basis: 'The mortgage statement shows no mortgage insurance premium.',
        dollarImpact: null,
      };
    }
    if (ltv > 0.8) {
      return {
        checkId: 'PMI_STILL_CHARGED',
        title: 'Mortgage insurance is being charged, and the loan has not yet reached the usual cancellation point',
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.INTERNAL_ARITHMETIC,
        actionability: Actionability.ACT_NOW,
        basis: `Balance ${money(balance)} against ${money(basisValue)} is ${pct(ltv)} loan-to-value. `
          + 'Cancellation is normally available at 80%.',
        dollarImpact: null,
        detail: { ltv, annual },
      };
    }
    return {
      checkId: 'PMI_STILL_CHARGED',
      title: `Mortgage insurance of ${money(monthly)}/month is still being charged at ${pct(ltv)} loan-to-value`,
      severity: Severity.RECOVERABLE_CHARGE,
      evidence: EvidenceKind.LENDER_RULE,
      actionability: Actionability.ACT_NOW,
      basis: `The statement shows a principal balance of ${money(balance)} against a value of `
        + `${money(basisValue)} — ${pct(ltv)} loan-to-value. Servicers normally allow a borrower to `
        + 'request cancellation of mortgage insurance at 80%, and on an owner-occupied one-to-four '
        + 'family loan the Homeowners Protection Act requires automatic termination at 78% of the '
        + 'original value. On an investment or entity-held loan that statutory automatic termination '
        + 'may not apply, and cancellation is then the servicer\'s own policy — which is why this is a '
        + 'written request rather than a settled entitlement. The loan-to-value figure itself is '
        + 'arithmetic from the statement and does not depend on which rule governs.',
      recommendedAction: 'Send a written cancellation request to the servicer, citing the current balance '
        + 'and the original value. Expect to be asked for a current appraisal at your own cost; the '
        + 'appraisal is worth it only if it is less than the annual premium.',
      charged: annual,
      dollarImpact: annual,
      impactKind: ImpactKind.RECOVERABLE,
      askServicer: true,
      detail: { ltv, monthly, balance, basisValue },
    };
  },
);

// -- 4. Is a unit priced below identical units in the same building? ---------
check(
  'UNIT_BELOW_INTERNAL_COMP',
  'Each unit compared against identical units in the same property',
  (x) => arr(x.units).filter((u) => num(u.monthly_rent) !== null).length >= 3,
  (x) => {
    const units = arr(x.units).filter((u) => num(u.monthly_rent) !== null);

    // Group by floorplan. Bedrooms and bathrooms must match; square footage is
    // allowed 10% either way, because a rent roll that lists 780 and 795 for the
    // same original floorplan is describing one floorplan, not two.
    const groups = [];
    for (const unit of units) {
      const sqft = num(unit.sqft);
      const found = groups.find((g) => {
        const h = g[0];
        if (num(h.bedrooms) !== num(unit.bedrooms)) return false;
        if (num(h.bathrooms) !== num(unit.bathrooms)) return false;
        const hs = num(h.sqft);
        if (hs === null || sqft === null) return true;
        return Math.abs(hs - sqft) / Math.max(hs, sqft) <= 0.1;
      });
      if (found) found.push(unit); else groups.push([unit]);
    }

    const findings = [];
    let compared = 0;
    for (const group of groups) {
      if (group.length < 3) continue;   // two units cannot establish a median
      compared += group.length;
      const rents = group.map((u) => num(u.monthly_rent));
      const mid = median(rents);
      for (const unit of group) {
        const rent = num(unit.monthly_rent);
        const gap = mid - rent;
        if (gap / mid < 0.1) continue;  // inside 10% is pricing, not a leak
        findings.push({
          checkId: 'UNIT_BELOW_INTERNAL_COMP',
          title: `Unit ${unit.unit_id} rents for ${money(rent)} against ${money(mid)} for identical units in the same building`,
          severity: Severity.BELOW_INTERNAL_COMP,
          evidence: EvidenceKind.INTERNAL_COMPARABLE,
          actionability: Actionability.AT_RENEWAL,
          basis: `Your own rent roll lists ${group.length} units of the same floorplan `
            + `(${unit.bedrooms}BD/${unit.bathrooms}BA, about ${unit.sqft} sq ft). The median rent among `
            + `them is ${money(mid)}. Unit ${unit.unit_id} is ${money(gap)} a month below that — `
            + `${pct(gap / mid)} below. This comparison is between units in your own building, not `
            + 'against the wider market, so it holds regardless of what the local market is doing. '
            + 'Condition may justify part of the gap.'
            + (unit.lease_end ? ` The lease runs to ${unit.lease_end}.` : ''),
          recommendedAction: unit.lease_end
            ? `Plan the renewal for ${unit.lease_end} now. Check your state and city notice period before sending anything.`
            : 'Plan the increase for the next renewal, after checking your state and city notice period.',
          charged: rent * 12,
          expected: mid * 12,
          dollarImpact: Math.round(gap * 12 * 100) / 100,
          impactKind: ImpactKind.EXCESS,
          detail: { unit: unit.unit_id, rent, median: mid, groupSize: group.length, leaseEnd: unit.lease_end || null },
        });
      }
    }

    if (findings.length) return findings;
    if (!compared) return null;
    return {
      checkId: 'UNIT_BELOW_INTERNAL_COMP',
      title: 'Every unit is priced in line with the identical units beside it',
      severity: Severity.WITHIN_NORMS,
      evidence: EvidenceKind.INTERNAL_COMPARABLE,
      actionability: Actionability.AT_RENEWAL,
      basis: `${compared} units compared against the median rent for their own floorplan; none sits more than 10% below it.`,
      dollarImpact: null,
    };
  },
);

// -- 5. Are management fees stacked on top of the percentage? ----------------
check(
  'MANAGEMENT_FEE_STACKING',
  'Management fee structure and any fees charged on top of it',
  (x) => {
    const m = x.management || {};
    return m.self_managed !== true && (num(m.fee_percent) !== null || num(m.fee_annual) !== null);
  },
  (x) => {
    const m = x.management || {};
    const extras = num(m.turnover_fees_annual);
    const feeAnnual = num(m.fee_annual);
    const feePct = num(m.fee_percent);
    const onGross = String(m.fee_basis || '').toLowerCase() === 'gross';

    const problems = [];
    if (extras !== null && extras > 0) problems.push(`${money(extras)} of leasing and turnover fees charged on top of it`);
    if (onGross) problems.push('the percentage is taken on scheduled rent rather than rent actually collected, so you pay it on months a unit sat empty');

    if (!problems.length) {
      return {
        checkId: 'MANAGEMENT_FEE_STACKING',
        title: 'The management fee is a single percentage of collected rent, with nothing stacked on top',
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.ACT_NOW,
        basis: (feePct !== null ? `${pct(feePct)} of collected rent` : 'A flat management fee')
          + (feeAnnual !== null ? `, ${money(feeAnnual)} for the period.` : '.'),
        dollarImpact: null,
      };
    }

    const total = (feeAnnual || 0) + (extras || 0);
    return {
      checkId: 'MANAGEMENT_FEE_STACKING',
      title: 'Management is billed as a percentage plus separate fees on top',
      severity: Severity.ABOVE_TYPICAL_RANGE,
      evidence: EvidenceKind.DOCUMENT_TERMS,
      actionability: Actionability.ACT_NOW,
      basis: 'The statement shows '
        + (feePct !== null ? `a ${pct(feePct)} management fee` : 'a management fee')
        + (feeAnnual !== null ? ` of ${money(feeAnnual)}` : '')
        + ', with ' + problems.join(', and ') + '. '
        + `Total management cost for the period is ${money(total)}. `
        + 'Stacked fees are common and are not improper; they are also the most negotiable line on a '
        + 'management agreement, particularly at renewal.',
      recommendedAction: 'Ask what the fee would be as a single percentage of collected rent with leasing '
        + 'and turnover included, and compare that against two other local managers before renewing.',
      charged: total,
      dollarImpact: extras || null,
      impactKind: ImpactKind.EXPOSURE,
      askManager: true,
      detail: { feePct, feeAnnual, extras, onGross },
    };
  },
);

// -- 6. Is an owner-paid utility going unrecovered on a master meter? --------
check(
  'OWNER_PAID_UTILITY',
  'Owner-paid utilities tested for tenant recovery',
  (x) => arr(x.utilities_owner_paid).length > 0 && num((x.property || {}).unit_count) !== null,
  (x) => {
    const unitCount = num((x.property || {}).unit_count);
    const findings = [];
    let passed = 0;

    for (const utility of arr(x.utilities_owner_paid)) {
      const annual = num(utility.annual_amount);
      const name = label(utility.utility) || 'utility';
      if (annual === null || annual <= 0) continue;
      const perUnitMonth = annual / unitCount / 12;

      // $45 per unit per month is where an owner-paid water and sewer bill on a
      // small multifamily stops looking like a cost of doing business. Below it
      // a billback program usually costs more to administer than it recovers.
      const recoverable = unitCount >= 2 && utility.submetered !== true && perUnitMonth >= 45;
      if (!recoverable) { passed += 1; continue; }

      findings.push({
        checkId: 'OWNER_PAID_UTILITY',
        title: `You pay ${money(annual)} a year for ${name} across ${unitCount} units, and none of it is billed back`,
        severity: Severity.UNRECOVERED_COST,
        evidence: EvidenceKind.INTERNAL_ARITHMETIC,
        actionability: Actionability.AT_RENEWAL,
        basis: `${money(annual)} a year over ${unitCount} units is ${money(perUnitMonth)} per unit per month, `
          + 'paid entirely by you on a single master meter with no sub-metering. The figure below is the '
          + 'amount currently unrecovered, not a saving — a ratio billing or sub-metering program recovers '
          + 'part of it, and what part depends on your state and on your leases, which have to be changed '
          + 'at renewal to allow it.',
        recommendedAction: 'Ask your manager or a local landlord association what ratio utility billing '
          + 'costs to run in your state, then add the clause at the next renewal cycle.',
        charged: annual,
        dollarImpact: annual,
        impactKind: ImpactKind.EXPOSURE,
        detail: { utility: name, annual, unitCount, perUnitMonth },
      });
    }

    if (findings.length) return findings;
    if (!passed) return null;
    return {
      checkId: 'OWNER_PAID_UTILITY',
      title: 'Owner-paid utilities are either sub-metered or small enough to leave alone',
      severity: Severity.WITHIN_NORMS,
      evidence: EvidenceKind.INTERNAL_ARITHMETIC,
      actionability: Actionability.AT_RENEWAL,
      basis: `${passed} owner-paid utility line(s) checked against a $45 per unit per month threshold.`,
      dollarImpact: null,
    };
  },
);

// -- 7. Does a utility spike above the property's own baseline? --------------
check(
  'UTILITY_SPIKE',
  'Monthly utility bills tested against the property\'s own baseline',
  (x) => arr(x.utility_months).length >= 6,
  (x) => {
    const byUtility = new Map();
    for (const row of arr(x.utility_months)) {
      const amount = num(row.amount);
      if (amount === null) continue;
      const key = row.utility || 'utility';
      if (!byUtility.has(key)) byUtility.set(key, []);
      byUtility.get(key).push({ month: row.month, amount });
    }

    const findings = [];
    let passed = 0;
    for (const [name, months] of byUtility) {
      if (months.length < 6) continue;
      const mid = median(months.map((m) => m.amount));
      const over = months.filter((m) => m.amount > mid * 1.4);
      const excess = sum(over.map((m) => m.amount - mid));
      if (!over.length || excess < 250) { passed += 1; continue; }

      findings.push({
        checkId: 'UTILITY_SPIKE',
        title: `Your ${label(name)} bill runs ${money(excess)} above its own baseline for ${over.length} months of the year`,
        severity: Severity.ABOVE_TYPICAL_RANGE,
        evidence: EvidenceKind.INTERNAL_ARITHMETIC,
        actionability: Actionability.ACT_NOW,
        basis: `The median month is ${money(mid)}. ${over.length} months exceed that by more than 40%: `
          + over.map((m) => `${m.month} ${money(m.amount)}`).join(', ')
          + `. The excess over your own median is ${money(excess)}. A sustained run above baseline on a `
          + 'residential meter is usually a leak, an irrigation tap, or a running fixture rather than '
          + 'tenant behaviour — this compares the property against itself, so seasonal usage is the one '
          + 'competing explanation.',
        recommendedAction: 'Have the meter read with every fixture off before assuming seasonal usage. '
          + 'A leak check costs less than one month of the excess above.',
        dollarImpact: Math.round(excess * 100) / 100,
        impactKind: ImpactKind.EXCESS,
        detail: { utility: name, median: mid, months: over },
      });
    }

    if (findings.length) return findings;
    if (!passed) return null;
    return {
      checkId: 'UTILITY_SPIKE',
      title: 'No utility bill runs materially above its own monthly baseline',
      severity: Severity.WITHIN_NORMS,
      evidence: EvidenceKind.INTERNAL_ARITHMETIC,
      actionability: Actionability.ACT_NOW,
      basis: `${passed} utility series compared month by month against their own median.`,
      dollarImpact: null,
    };
  },
);

// -- 8. Is repair spend piling up on one system? -----------------------------
check(
  'REPAIR_CONCENTRATION',
  'Repair spend grouped by unit and system',
  (x) => arr(x.maintenance_items).length >= 3,
  (x) => {
    // Only mechanical systems. "Exterior" and "landscaping" are buckets, not
    // systems: gutter cleaning, a coat of paint and a driveway seal are three
    // unrelated pieces of upkeep that happen to land in one category, and
    // grouping them produced a repair-vs-replace finding against a
    // well-maintained duplex — telling a landlord who is doing everything right
    // that something is failing. Repeat visits only mean anything when they are
    // repeat visits to the same thing.
    const REPEAT_SYSTEMS = ['hvac', 'plumbing', 'electrical', 'appliance', 'roof'];
    const groups = new Map();
    for (const item of arr(x.maintenance_items)) {
      const amount = num(item.amount);
      const system = item.system || null;
      if (amount === null || !REPEAT_SYSTEMS.includes(system)) continue;
      const key = `${item.unit_id || 'property'}::${system}`;
      if (!groups.has(key)) groups.set(key, { unit: item.unit_id || null, system, items: [] });
      groups.get(key).items.push({ ...item, amount });
    }

    const findings = [];
    for (const group of groups.values()) {
      const spend = sum(group.items.map((i) => i.amount));
      // Three visits to the same system in one period is a pattern, not bad
      // luck, and the dollar floor keeps a run of cheap filter changes out.
      if (group.items.length < 3 || spend < 900) continue;
      findings.push({
        checkId: 'REPAIR_CONCENTRATION',
        title: `${sentenceCase(label(group.system))} on ${group.unit ? `unit ${group.unit}` : 'the property'} took `
          + `${group.items.length} visits and ${money(spend)} in one period`,
        severity: Severity.CAPITAL_DECISION,
        evidence: EvidenceKind.INTERNAL_ARITHMETIC,
        actionability: Actionability.CAPITAL_DECISION,
        basis: `${group.items.length} separate ${label(group.system)} calls totalling ${money(spend)}: `
          + group.items.map((i) => `${i.date || '?'} ${money(i.amount)}${i.description ? ` (${i.description})` : ''}`).join('; ')
          + '. Repeat calls on one system in a single period are the pattern that precedes a failure, '
          + 'and the money above buys nothing durable.',
        recommendedAction: `Get a replacement quote for the ${label(group.system)} and compare it against this `
          + 'year\'s repair spend and the age of the equipment. Replacement is a cost first and a saving after.',
        charged: spend,
        dollarImpact: Math.round(spend * 100) / 100,
        impactKind: ImpactKind.EXCESS,
        detail: { unit: group.unit, system: group.system, visits: group.items.length, spend },
      });
    }
    if (findings.length) return findings;
    return {
      checkId: 'REPAIR_CONCENTRATION',
      title: 'No single system is absorbing repeat repair visits',
      severity: Severity.WITHIN_NORMS,
      evidence: EvidenceKind.INTERNAL_ARITHMETIC,
      actionability: Actionability.CAPITAL_DECISION,
      basis: `${arr(x.maintenance_items).length} repair items grouped by unit and system; none reached three visits and $900 in the period.`,
      dollarImpact: null,
    };
  },
);

// -- 9. Repairs as a share of collected rent ---------------------------------
check(
  'REPAIR_RATIO',
  'Repair and maintenance spend as a share of rent collected',
  (x) => num((x.income || {}).total_collected) !== null
    && arr(x.expenses).some((e) => e.category === 'repairs_maintenance'),
  (x) => {
    const collected = num((x.income || {}).total_collected);
    const spend = sum(arr(x.expenses)
      .filter((e) => e.category === 'repairs_maintenance')
      .map((e) => num(e.annual_amount)));
    const ratio = spend / collected;

    if (ratio <= 0.15) {
      return {
        checkId: 'REPAIR_RATIO',
        title: 'Repair spend sits inside the usual share of rent',
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.TYPICAL_RANGE,
        actionability: Actionability.ACT_NOW,
        basis: `${money(spend)} of repairs against ${money(collected)} collected is ${pct(ratio)}. `
          + 'Eight to fifteen per cent is the usual band for an older small multifamily.',
        dollarImpact: null,
        detail: { ratio, spend, collected },
      };
    }
    const excess = spend - collected * 0.15;
    return {
      checkId: 'REPAIR_RATIO',
      title: `Repairs took ${pct(ratio)} of the rent you collected`,
      severity: Severity.ABOVE_TYPICAL_RANGE,
      evidence: EvidenceKind.TYPICAL_RANGE,
      actionability: Actionability.ACT_NOW,
      basis: `${money(spend)} of repairs against ${money(collected)} collected. Eight to fifteen per cent `
        + 'is the usual band; above it, spend is normally either deferred maintenance being caught up or a '
        + 'system that needs replacing rather than repairing. This is a comparison against what is typical, '
        + 'not a rule — an old building catching up on a backlog can sit here for a year legitimately.',
      recommendedAction: 'Read the repair schedule for repeat visits before treating this as ordinary upkeep.',
      dollarImpact: Math.round(excess * 100) / 100,
      impactKind: ImpactKind.EXCESS,
      detail: { ratio, spend, collected },
    };
  },
);

// -- 10. Does the escrow payment match what it is meant to disburse? ---------
check(
  'ESCROW_RECONCILES',
  'Monthly escrow against the annual taxes and insurance it funds',
  (x) => {
    const l = x.loan || {};
    return num(l.escrow_monthly) !== null
      && (num(l.escrow_taxes_annual) !== null || num(l.escrow_insurance_annual) !== null);
  },
  (x) => {
    const l = x.loan || {};
    const monthly = num(l.escrow_monthly);
    const taxes = num(l.escrow_taxes_annual) || 0;
    const insurance = num(l.escrow_insurance_annual) || 0;
    const disbursed = taxes + insurance;
    const collected = monthly * 12;
    const gap = Math.round((collected - disbursed) * 100) / 100;

    // A cushion of up to one sixth of annual disbursements is permitted under
    // RESPA, so a small positive gap is normal and worth saying so.
    const cushionCap = disbursed / 6;
    if (gap >= -50 && gap <= cushionCap + 50) {
      return {
        checkId: 'ESCROW_RECONCILES',
        title: 'Your escrow payment matches the taxes and insurance it is collected to pay',
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.INTERNAL_ARITHMETIC,
        actionability: Actionability.ACT_NOW,
        basis: `${money(monthly)} a month is ${money(collected)} a year, against ${money(taxes)} of taxes `
          + `and ${money(insurance)} of insurance — ${money(disbursed)} disbursed. `
          + (Math.abs(gap) < 1 ? 'The two reconcile exactly.' : `A ${money(gap)} difference, inside the permitted cushion.`),
        charged: collected,
        expected: disbursed,
        dollarImpact: null,
        detail: { gap, cushionCap },
      };
    }
    return {
      checkId: 'ESCROW_RECONCILES',
      title: gap > 0
        ? 'Your escrow collects more than the taxes and insurance it is meant to fund'
        : 'Your escrow collects less than the taxes and insurance it is meant to fund',
      severity: Severity.CONFIRMED_ERROR,
      evidence: EvidenceKind.INTERNAL_ARITHMETIC,
      actionability: Actionability.ACT_NOW,
      basis: `${money(monthly)} a month is ${money(collected)} a year. The statement's own figures for `
        + `taxes (${money(taxes)}) and insurance (${money(insurance)}) come to ${money(disbursed)}. `
        + `The difference is ${money(gap)}` + (gap > 0
          ? ', more than the cushion a servicer may hold. An over-collection is your money, refundable on request.'
          : '. An under-collection becomes a shortage bill and a higher payment later.'),
      recommendedAction: gap > 0
        ? 'Request an escrow analysis and a refund of the surplus.'
        : 'Ask the servicer to re-run the escrow analysis now rather than meeting a shortage next year.',
      charged: collected,
      expected: disbursed,
      dollarImpact: Math.abs(gap),
      impactKind: gap > 0 ? ImpactKind.RECOVERABLE : ImpactKind.ERROR,
      askServicer: true,
      detail: { gap, cushionCap },
    };
  },
);

// -- 11. Is the building insured far above what it cost? ---------------------
check(
  'INSURANCE_LIMIT_RATIO',
  'Dwelling limit against the price paid for the property',
  (x) => num((x.insurance || {}).dwelling_limit) !== null && num((x.property || {}).purchase_price) !== null,
  (x) => {
    const limit = num((x.insurance || {}).dwelling_limit);
    const price = num((x.property || {}).purchase_price);
    const ratio = limit / price;

    if (ratio <= 1.5) {
      return {
        checkId: 'INSURANCE_LIMIT_RATIO',
        title: 'The dwelling limit is in a normal relationship to what you paid',
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.TYPICAL_RANGE,
        actionability: Actionability.AT_RENEWAL,
        basis: `A ${money(limit)} dwelling limit against a ${money(price)} purchase price is ${ratio.toFixed(2)}× — `
          + 'rebuilding cost normally exceeds purchase price, because the price included the land.',
        dollarImpact: null,
        detail: { ratio },
      };
    }
    return {
      checkId: 'INSURANCE_LIMIT_RATIO',
      title: `You are insuring the building for ${ratio.toFixed(2)}× what you paid for the whole property`,
      severity: Severity.ABOVE_TYPICAL_RANGE,
      evidence: EvidenceKind.TYPICAL_RANGE,
      actionability: Actionability.AT_RENEWAL,
      basis: `A ${money(limit)} dwelling limit against a ${money(price)} purchase price. Rebuilding cost `
        + 'legitimately exceeds purchase price, since the price included land — but past about 1.5× it is '
        + 'worth confirming the limit reflects a real replacement-cost estimate rather than an inflation '
        + 'factor applied year after year. You cannot collect more than it costs to rebuild.',
      recommendedAction: 'Ask your agent for the replacement-cost worksheet behind the dwelling limit, and '
        + 'what the premium would be at a limit matched to it.',
      dollarImpact: null,
      askInsurer: true,
      detail: { ratio, limit, price },
    };
  },
);

// -- 12. Is the deductible low enough to be costing premium? -----------------
check(
  'INSURANCE_DEDUCTIBLE',
  'Deductible against what is normal on a rental',
  (x) => num((x.insurance || {}).deductible_all_perils) !== null,
  (x) => {
    const deductible = num((x.insurance || {}).deductible_all_perils);
    if (deductible >= 2500) {
      return {
        checkId: 'INSURANCE_DEDUCTIBLE',
        title: 'Your deductible is set at a level that suits a rental',
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.TYPICAL_RANGE,
        actionability: Actionability.AT_RENEWAL,
        basis: `${money(deductible)} all perils.`,
        dollarImpact: null,
      };
    }
    return {
      checkId: 'INSURANCE_DEDUCTIBLE',
      title: `Your deductible is ${money(deductible)}, low for a property you do not live in`,
      severity: Severity.ABOVE_TYPICAL_RANGE,
      evidence: EvidenceKind.TYPICAL_RANGE,
      actionability: Actionability.AT_RENEWAL,
      basis: `${money(deductible)} all perils. On a rental, a claim small enough to sit near a `
        + 'deductible this size is usually one a landlord pays out of pocket anyway, because frequency '
        + 'of claims drives renewal pricing. Carrying a deductible you would never actually claim against '
        + 'is premium spent on nothing. The saving depends on the carrier and is not computed here.',
      recommendedAction: 'Ask your agent to quote the same coverage at $2,500 and $5,000 and compare the premiums.',
      dollarImpact: null,
      askInsurer: true,
      detail: { deductible },
    };
  },
);

// -- 13. How much did the renewal move? --------------------------------------
check(
  'INSURANCE_RENEWAL_JUMP',
  'Renewal premium against the prior term',
  (x) => num((x.insurance || {}).annual_premium) !== null && num((x.insurance || {}).prior_premium) !== null,
  (x) => {
    const now = num((x.insurance || {}).annual_premium);
    const prior = num((x.insurance || {}).prior_premium);
    const change = now - prior;
    const ratio = change / prior;

    if (ratio <= 0.1) {
      return {
        checkId: 'INSURANCE_RENEWAL_JUMP',
        title: 'Your insurance renewal moved by a normal amount',
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.INTERNAL_ARITHMETIC,
        actionability: Actionability.AT_RENEWAL,
        basis: `${money(prior)} to ${money(now)} — ${pct(ratio)}.`,
        dollarImpact: null,
      };
    }
    return {
      checkId: 'INSURANCE_RENEWAL_JUMP',
      title: `Your premium rose ${money(change)} at renewal, up ${pct(ratio)}`,
      severity: Severity.ABOVE_TYPICAL_RANGE,
      evidence: EvidenceKind.INTERNAL_ARITHMETIC,
      actionability: Actionability.AT_RENEWAL,
      basis: `${money(prior)} for the prior term against ${money(now)} now — an increase of ${money(change)}, `
        + `${pct(ratio)}. The increase is arithmetic from the declarations page. Whether it is competitive `
        + 'is not something this audit can tell you, because that needs a quote from another carrier.'
        + ((x.insurance || {}).discounts_applied === false ? ' The declarations page shows no discounts applied.' : ''),
      recommendedAction: 'Get one competing quote before the next renewal date. The increase above is the '
        + 'amount at stake if the policy has simply drifted.',
      charged: now,
      expected: prior,
      dollarImpact: Math.round(change * 100) / 100,
      impactKind: ImpactKind.EXCESS,
      askInsurer: true,
      detail: { now, prior, ratio },
    };
  },
);

// -- 14. Is a warranty plan being paid for alongside the repairs it covers? --
check(
  'WARRANTY_OVERLAP',
  'Home warranty cost against repairs paid separately',
  (x) => arr(x.expenses).some((e) => e.category === 'warranty' && num(e.annual_amount) > 0),
  (x) => {
    const cost = sum(arr(x.expenses).filter((e) => e.category === 'warranty').map((e) => num(e.annual_amount)));
    const covered = arr(x.maintenance_items)
      .filter((i) => ['hvac', 'plumbing', 'appliance', 'electrical'].includes(i.system))
      .map((i) => num(i.amount))
      .filter((n) => n !== null);
    const paidOutOfPocket = sum(covered);

    return {
      checkId: 'WARRANTY_OVERLAP',
      title: `You paid ${money(cost)} for a warranty plan and ${money(paidOutOfPocket)} for repairs it nominally covers`,
      severity: paidOutOfPocket > cost ? Severity.UNRECOVERED_COST : Severity.ABOVE_TYPICAL_RANGE,
      evidence: EvidenceKind.INTERNAL_ARITHMETIC,
      actionability: Actionability.ACT_NOW,
      basis: `${money(cost)} in warranty premium for the period. Over the same period the repair schedule `
        + `shows ${covered.length} items in categories a warranty normally covers — HVAC, plumbing, `
        + `appliances, electrical — totalling ${money(paidOutOfPocket)}, billed to you directly. `
        + 'This does not prove the plan paid nothing, because a claim it did pay would not appear on a '
        + 'schedule of what you were billed. It does mean the plan is worth pricing against its own record.',
      recommendedAction: 'Ask the provider for a claims-paid summary for the period, and compare it against '
        + `the ${money(cost)} premium before the plan renews.`,
      charged: cost,
      dollarImpact: cost,
      impactKind: ImpactKind.EXPOSURE,
      detail: { cost, paidOutOfPocket, coveredItems: covered.length },
    };
  },
);

// -- 15. Does the property cover its own debt? -------------------------------
check(
  'DEBT_COVERAGE',
  'Net operating income against debt service',
  (x) => num((x.income || {}).net_operating_income) !== null && num((x.debt_service || {}).total_annual) !== null,
  (x) => {
    const noi = num((x.income || {}).net_operating_income);
    const debt = num((x.debt_service || {}).total_annual);
    const dscr = noi / debt;
    const shortfall = debt - noi;

    if (dscr >= 1) {
      return {
        checkId: 'DEBT_COVERAGE',
        title: `The property covers its debt ${dscr.toFixed(2)} times over`,
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.INTERNAL_ARITHMETIC,
        actionability: Actionability.ACT_NOW,
        basis: `${money(noi)} of net operating income against ${money(debt)} of debt service.`,
        dollarImpact: null,
        detail: { dscr },
      };
    }
    return {
      checkId: 'DEBT_COVERAGE',
      title: `Operating income covers only ${pct(dscr, 0)} of the debt on this property`,
      severity: Severity.REQUIRES_DOCUMENTATION,
      evidence: EvidenceKind.INTERNAL_ARITHMETIC,
      actionability: Actionability.ACT_NOW,
      basis: `${money(noi)} of net operating income against ${money(debt)} of debt service leaves `
        + `${money(shortfall)} a year to be funded from outside the property. This is the gap the rest of `
        + 'this report is measured against — it is context for the findings above, not a finding of its own.',
      dollarImpact: null,
      detail: { dscr, shortfall },
    };
  },
);

// -- 16. Say plainly when the rent question cannot be answered ---------------
//
// The internal comparison in check 4 needs at least three like units. A single
// rental house has none, and that is the case the product page has always sold
// hardest. Before this engine existed the model filled the gap with prose —
// "likely below market… pull 3-5 current listings yourself" — which is the
// customer doing the work and being charged for it. Naming the limitation is
// worth more than dressing it up, and it tells them exactly what to bring.
check(
  'RENT_COMP_NOT_TESTABLE',
  'Rent tested against comparable units',
  (x) => arr(x.units).filter((u) => num(u.monthly_rent) !== null).length < 3,
  (x) => {
    const units = arr(x.units).filter((u) => num(u.monthly_rent) !== null);
    return {
      checkId: 'RENT_COMP_NOT_TESTABLE',
      title: 'Your rent could not be tested against comparable units',
      severity: Severity.REQUIRES_DOCUMENTATION,
      evidence: EvidenceKind.NONE,
      actionability: Actionability.NEEDS_DOCS,
      basis: `This audit compares a unit against identical units in the same property, which is a `
        + `comparison it can prove. That needs at least three like units and you have ${units.length}. `
        + 'It holds no live market rent data and will not estimate a market rent from general knowledge, '
        + 'because a rent figure that is wrong by $100 is worse than no rent figure at all — you would '
        + 'either leave money on the table or lose a paying tenant over it.',
      recommendedAction: 'Pull three to five current listings for the same bedroom count within a mile or '
        + 'two, or ask a local manager for a rental opinion of value, which most give free. Send that with '
        + 'your next audit and the comparison becomes testable.',
      dollarImpact: null,
      detail: { unitsWithRent: units.length },
    };
  },
  { silentSkip: true },
);

// --- runner -----------------------------------------------------------------

function rankFindings(findings) {
  return findings.slice().sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    return (b.dollarImpact || 0) - (a.dollarImpact || 0);
  });
}

// Returns every finding the documents support, plus the names of the checks
// that could not run. A landlord is owed both: the second list is why a report
// is shorter than it might have been, and saying nothing implies a pass.
function runRentalAudit(extraction) {
  const x = extraction || {};
  const findings = [];
  const skipped = [];

  for (const entry of CATALOG) {
    let ok = false;
    try { ok = !!entry.needs(x); } catch (err) { ok = false; }
    if (!ok) {
      if (!entry.silentSkip) skipped.push(entry.label);
      continue;
    }

    let result = null;
    try {
      result = entry.run(x);
    } catch (err) {
      // One check throwing on an odd document must not cost the customer the
      // other fourteen.
      skipped.push(`${entry.label} (could not be computed)`);
      continue;
    }
    if (!result) continue;
    for (const finding of (Array.isArray(result) ? result : [result])) {
      if (finding) findings.push(finding);
    }
  }

  // Coverage, returned as a pair rather than left for the reader to count.
  //
  // "We found nothing wrong" is two completely different results and the
  // report has to say which one the customer got. A duplex where thirteen
  // checks ran and passed has been examined and is fine. A single-family
  // rental where three ran and twelve could not is a statement about the
  // documents, not the property, and a landlord who reads the first sentence
  // and stops must not walk away believing the second was the first.
  //
  // It is also the number that tells them whether sending one more document
  // would change the answer, which is the only useful thing to do about a
  // thin result.
  const runnable = CATALOG.filter((entry) => !entry.silentSkip).length;
  return {
    findings: rankFindings(findings),
    skipped,
    checksRun: runnable - skipped.length,
    checksTotal: runnable,
  };
}

module.exports = {
  runRentalAudit,
  rankFindings,
  CATALOG,
  Severity,
  SEVERITY_ORDER,
  EvidenceKind,
  Actionability,
  ImpactKind,
  _internal: { num, money, pct, median, sum },
};
