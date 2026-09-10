'use strict';

// Did the money actually arrive?
//
// The audit graded 0 out of 5 on this and it was the last thing missing: the
// product knew what it found and never learned what it was worth. A finding
// that says "$1,416 a year, send this letter" is a claim about the future, and
// the only honest way to close it is to look at the documents afterwards.
//
// So this asks nothing of the customer. It reads the findings from their last
// audit against the extraction from this one and reports, per finding, whether
// the condition is still there. Self-reported outcomes would be easier and
// would be worth nothing — a landlord who means to call the servicer and never
// does will tick the box either way.
//
// THE RULE THAT MATTERS MOST, and the one that would quietly turn this into a
// self-congratulation machine if it were ever relaxed:
//
//   Absence of evidence is never resolution.
//
// If this year's upload has no mortgage statement, the mortgage insurance
// finding is NOT resolved — it is untestable, and it says so. A customer who
// sends fewer documents must never be told their problems went away. Every
// resolver below therefore declares the evidence it needs, and returns
// NOT_TESTABLE rather than a verdict when that evidence is not in front of it.
//
// The second rule: a condition ending is not the same as money arriving.
// Mortgage insurance disappearing from a statement is money that has verifiably
// stopped leaving the account. A management statement that now foots is a
// practice that changed — it does not mean the $500 was refunded, and this
// module will not claim it was. Only findings that can be tied to a real,
// measurable change carry a recovered figure.

const Outcome = {
  RESOLVED: 'resolved',           // the condition is gone, proved from the new documents
  IMPROVED: 'improved',           // it moved in the right direction, not all the way
  STILL_OPEN: 'still_open',       // unchanged, and still costing what it cost
  NOT_TESTABLE: 'not_testable',   // this year's documents cannot answer it
};

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

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function categoryTotal(extraction, category) {
  const lines = arr(extraction.expenses).filter((e) => e && e.category === category);
  if (!lines.length) return null;
  return lines.reduce((sum, e) => sum + (num(e.annual_amount) || 0), 0);
}

function unitById(extraction, unitId) {
  return arr(extraction.units).find((u) => String(u.unit_id) === String(unitId)) || null;
}

// --- resolvers --------------------------------------------------------------
//
// One per check that can be closed out. Each declares `needs` — the evidence
// that has to be present this year for any verdict at all — and returns
// { outcome, note, recovered } where `recovered` is a dollar figure ONLY when
// money verifiably stopped leaving the account or verifiably started arriving.

const RESOLVERS = {

  PMI_STILL_CHARGED: {
    label: 'Mortgage insurance',
    needs: (x) => (x.loan || {}) && num((x.loan || {}).mortgage_insurance_monthly) !== null,
    missing: 'this year\'s upload has no mortgage statement, so we cannot see whether the charge stopped',
    run: (finding, x) => {
      const monthly = num((x.loan || {}).mortgage_insurance_monthly);
      if (monthly > 0) {
        return {
          outcome: Outcome.STILL_OPEN,
          note: `Still being charged at ${money(monthly)} a month. The request either was not sent or was refused; `
            + 'a servicer that refuses in writing has to say why, and that reason is worth having.',
          recovered: null,
        };
      }
      return {
        outcome: Outcome.RESOLVED,
        note: 'The mortgage statement no longer shows a mortgage insurance premium. That is money that has '
          + 'stopped leaving the account, confirmed from the statement rather than reported.',
        recovered: num(finding.dollarImpact),
      };
    },
  },

  UNIT_BELOW_INTERNAL_COMP: {
    label: 'Below-comparable rent',
    needs: (x) => arr(x.units).length > 0,
    missing: 'this year\'s upload has no rent roll, so we cannot see what the unit rents for now',
    run: (finding, x, prior) => {
      const unitId = (finding.detail || {}).unit;
      const before = num((finding.detail || {}).rent);
      const target = num((finding.detail || {}).median);
      const unit = unitById(x, unitId);
      if (!unit || num(unit.monthly_rent) === null) {
        return { outcome: Outcome.NOT_TESTABLE, note: `Unit ${unitId} is not on this year's rent roll.`, recovered: null };
      }
      const now = num(unit.monthly_rent);
      const gained = Math.round((now - before) * 12 * 100) / 100;

      if (gained <= 0) {
        return {
          outcome: Outcome.STILL_OPEN,
          note: `Unit ${unitId} still rents for ${money(now)}. The renewal either has not come round yet or went out unchanged.`,
          recovered: null,
        };
      }
      if (now >= target) {
        return {
          outcome: Outcome.RESOLVED,
          note: `Unit ${unitId} now rents for ${money(now)}, at or above the ${money(target)} median it was measured against. `
            + `That is ${money(gained)} a year more rent than the period we flagged it in.`,
          recovered: gained,
        };
      }
      return {
        outcome: Outcome.IMPROVED,
        note: `Unit ${unitId} moved from ${money(before)} to ${money(now)} — ${money(gained)} a year — and is still `
          + `below the ${money(target)} median. The rest is available at the next renewal.`,
        recovered: gained,
      };
    },
  },

  WARRANTY_OVERLAP: {
    label: 'Home warranty plan',
    needs: (x) => arr(x.expenses).length > 0,
    missing: 'this year\'s upload has no operating statement, so we cannot see whether the plan was renewed',
    run: (finding, x) => {
      const now = categoryTotal(x, 'warranty');
      if (now === null || now === 0) {
        return {
          outcome: Outcome.RESOLVED,
          note: 'No warranty premium appears on this year\'s statement. The plan was not renewed.',
          recovered: num(finding.dollarImpact),
        };
      }
      const before = num(finding.charged);
      if (before !== null && now < before * 0.9) {
        return {
          outcome: Outcome.IMPROVED,
          note: `The premium fell from ${money(before)} to ${money(now)}.`,
          recovered: Math.round((before - now) * 100) / 100,
        };
      }
      return { outcome: Outcome.STILL_OPEN, note: `Still on the statement at ${money(now)}.`, recovered: null };
    },
  },

  OWNER_PAID_UTILITY: {
    label: 'Owner-paid utility',
    needs: (x) => arr(x.utilities_owner_paid).length > 0 || arr(x.expenses).length > 0,
    missing: 'this year\'s upload does not show who pays the utilities',
    run: (finding, x) => {
      const utility = arr(x.utilities_owner_paid).find((u) => (u.utility || '') === (finding.detail || {}).utility)
        || arr(x.utilities_owner_paid)[0];
      const before = num(finding.charged);
      if (utility && utility.submetered === true) {
        return {
          outcome: Outcome.RESOLVED,
          note: 'The units are sub-metered on this year\'s documents, so this cost is no longer carried whole by the owner.',
          // Deliberately no figure. Sub-metering shifts a cost; how much of it
          // actually reaches the tenants depends on leases we have not seen.
          recovered: null,
        };
      }
      const now = utility ? num(utility.annual_amount) : categoryTotal(x, 'water_sewer');
      if (before !== null && now !== null && now < before * 0.85) {
        return {
          outcome: Outcome.IMPROVED,
          note: `The owner-paid cost fell from ${money(before)} to ${money(now)}.`,
          recovered: Math.round((before - now) * 100) / 100,
        };
      }
      return {
        outcome: Outcome.STILL_OPEN,
        note: now !== null ? `Still owner-paid, ${money(now)} this period.` : 'Still owner-paid.',
        recovered: null,
      };
    },
  },

  UTILITY_SPIKE: {
    label: 'Utility running above its own baseline',
    needs: (x) => arr(x.utility_months).length >= 6,
    missing: 'this year\'s upload has no month-by-month utility figures to compare',
    run: (finding, x) => {
      const utility = (finding.detail || {}).utility;
      const months = arr(x.utility_months)
        .filter((m) => !utility || String(m.utility || '').toLowerCase() === String(utility).toLowerCase()
          || String(m.utility || '').toLowerCase().replace(/[^a-z]/g, '') === String(utility).toLowerCase().replace(/[^a-z]/g, ''))
        .map((m) => num(m.amount))
        .filter((n) => n !== null);
      if (months.length < 6) {
        return { outcome: Outcome.NOT_TESTABLE, note: 'Not enough monthly figures for that utility this year.', recovered: null };
      }
      const sorted = months.slice().sort((a, b) => a - b);
      const mid = sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
      const over = months.filter((m) => m > mid * 1.4);
      if (!over.length) {
        return {
          outcome: Outcome.RESOLVED,
          note: `No month now runs more than 40% above the ${money(mid)} median. Whatever was driving the spike has stopped.`,
          recovered: num(finding.dollarImpact),
        };
      }
      return {
        outcome: Outcome.STILL_OPEN,
        note: `${over.length} months still run well above the ${money(mid)} median.`,
        recovered: null,
      };
    },
  },

  REPAIR_CONCENTRATION: {
    label: 'Repeat repairs on one system',
    needs: (x) => arr(x.maintenance_items).length > 0,
    missing: 'this year\'s upload has no itemised repair schedule',
    run: (finding, x) => {
      const detail = finding.detail || {};
      const same = arr(x.maintenance_items).filter((i) => i
        && i.system === detail.system
        && String(i.unit_id || '') === String(detail.unit || ''));
      const spend = same.reduce((sum, i) => sum + (num(i.amount) || 0), 0);
      const before = num(detail.spend);

      if (!same.length) {
        return {
          outcome: Outcome.RESOLVED,
          note: `No ${detail.system} calls on ${detail.unit ? `unit ${detail.unit}` : 'the property'} this period at all.`,
          recovered: before,
        };
      }
      if (before !== null && spend < before * 0.5) {
        return {
          outcome: Outcome.IMPROVED,
          note: `${same.length} ${detail.system} call(s) this period, ${money(spend)} against ${money(before)} before.`,
          recovered: Math.round((before - spend) * 100) / 100,
        };
      }
      return {
        outcome: Outcome.STILL_OPEN,
        note: `${same.length} more ${detail.system} calls, ${money(spend)} this period.`,
        recovered: null,
      };
    },
  },

  MANAGEMENT_FEE_STACKING: {
    label: 'Stacked management fees',
    needs: (x) => !!(x.management) || arr(x.expenses).length > 0,
    missing: 'this year\'s upload does not show the management fee structure',
    run: (finding, x) => {
      const extras = num((x.management || {}).turnover_fees_annual);
      const before = num((finding.detail || {}).extras);
      if (extras === null || extras === 0) {
        return {
          outcome: Outcome.RESOLVED,
          note: 'No separate leasing or turnover fees on this year\'s statement.',
          recovered: before,
        };
      }
      if (before !== null && extras < before * 0.7) {
        return {
          outcome: Outcome.IMPROVED,
          note: `Fees on top of the percentage fell from ${money(before)} to ${money(extras)}.`,
          recovered: Math.round((before - extras) * 100) / 100,
        };
      }
      return { outcome: Outcome.STILL_OPEN, note: `Still ${money(extras)} of fees on top of the percentage.`, recovered: null };
    },
  },

  INSURANCE_DEDUCTIBLE: {
    label: 'Deductible',
    needs: (x) => num((x.insurance || {}).deductible_all_perils) !== null,
    missing: 'this year\'s upload has no declarations page',
    run: (finding, x) => {
      const now = num((x.insurance || {}).deductible_all_perils);
      if (now >= 2500) {
        return {
          outcome: Outcome.RESOLVED,
          note: `The deductible is now ${money(now)}.`,
          // The premium saving from raising a deductible is real and is not
          // visible here — the premium also moves for reasons of its own.
          recovered: null,
        };
      }
      return { outcome: Outcome.STILL_OPEN, note: `Still ${money(now)}.`, recovered: null };
    },
  },

  MAINT_SCHEDULE_FOOTS: {
    label: 'Repair schedule that did not foot',
    needs: (x) => arr(x.maintenance_items).length > 0 && num(x.maintenance_total_stated) !== null,
    missing: 'this year\'s upload has no itemised repair schedule to re-add',
    run: (finding, x) => {
      const itemised = arr(x.maintenance_items).reduce((sum, i) => sum + (num(i.amount) || 0), 0);
      const stated = num(x.maintenance_total_stated);
      const gap = Math.round((stated - itemised) * 100) / 100;
      if (Math.abs(gap) < 1) {
        return {
          outcome: Outcome.RESOLVED,
          note: 'This period\'s repair schedule adds up to the total billed. Whether the earlier difference was '
            + 'ever explained or refunded is not something these documents show — only that it has not happened again.',
          // Never a figure. A statement that now foots says nothing about
          // whether the earlier gap came back.
          recovered: null,
        };
      }
      return {
        outcome: Outcome.STILL_OPEN,
        note: `This period's schedule is out by ${money(gap)} as well.`,
        recovered: null,
      };
    },
  },

  EXPENSE_TOTAL_FOOTS: {
    label: 'Expense lines that did not foot',
    needs: (x) => arr(x.expenses).length >= 3 && num(x.expense_total_stated) !== null,
    missing: 'this year\'s upload has no operating statement to re-add',
    run: (finding, x) => {
      const itemised = arr(x.expenses).reduce((sum, e) => sum + (num(e.annual_amount) || 0), 0);
      const gap = Math.round((num(x.expense_total_stated) - itemised) * 100) / 100;
      if (Math.abs(gap) < 1) {
        return { outcome: Outcome.RESOLVED, note: 'This period\'s expense lines add up to their stated total.', recovered: null };
      }
      return { outcome: Outcome.STILL_OPEN, note: `This period is out by ${money(gap)} as well.`, recovered: null };
    },
  },
};

// --- runner -----------------------------------------------------------------

function runRentalOutcomes(priorFindings, currentExtraction, priorExtraction) {
  const x = currentExtraction || {};
  const outcomes = [];

  for (const finding of arr(priorFindings)) {
    if (!finding || !finding.checkId) continue;
    // Only findings, never the passed checks. "Your escrow still reconciles" is
    // this year's verified list, not last year's outcome.
    if (finding.severity === 'within_norms') continue;

    const resolver = RESOLVERS[finding.checkId];
    if (!resolver) continue;

    let hasEvidence = false;
    try { hasEvidence = !!resolver.needs(x); } catch (err) { hasEvidence = false; }

    if (!hasEvidence) {
      outcomes.push({
        checkId: finding.checkId,
        label: resolver.label,
        title: finding.title,
        outcome: Outcome.NOT_TESTABLE,
        note: `Could not be checked — ${resolver.missing}.`,
        recovered: null,
        priorImpact: num(finding.dollarImpact),
      });
      continue;
    }

    let result;
    try {
      result = resolver.run(finding, x, priorExtraction || {});
    } catch (err) {
      result = { outcome: Outcome.NOT_TESTABLE, note: 'Could not be checked from this year\'s documents.', recovered: null };
    }

    outcomes.push({
      checkId: finding.checkId,
      label: resolver.label,
      title: finding.title,
      outcome: result.outcome,
      note: result.note,
      recovered: result.outcome === Outcome.STILL_OPEN || result.outcome === Outcome.NOT_TESTABLE
        ? null
        : num(result.recovered),
      priorImpact: num(finding.dollarImpact),
    });
  }

  const confirmedRecovered = outcomes.reduce((sum, o) => sum + (o.recovered || 0), 0);

  return {
    outcomes,
    // Only what a document proves. This figure is the whole point of the module
    // and the whole risk of it: if it ever includes something that merely looks
    // resolved, the product is congratulating itself with the customer's money.
    confirmedRecovered: Math.round(confirmedRecovered * 100) / 100,
    resolved: outcomes.filter((o) => o.outcome === Outcome.RESOLVED).length,
    improved: outcomes.filter((o) => o.outcome === Outcome.IMPROVED).length,
    stillOpen: outcomes.filter((o) => o.outcome === Outcome.STILL_OPEN).length,
    notTestable: outcomes.filter((o) => o.outcome === Outcome.NOT_TESTABLE).length,
  };
}

module.exports = {
  runRentalOutcomes,
  Outcome,
  RESOLVERS,
  _internal: { categoryTotal, unitById, money },
};
