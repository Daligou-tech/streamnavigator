'use strict';

// Year-over-year: which costs rose faster than the rest, and by how much.
//
// This is the analysis a landlord actually wants annually and the one a chatbot
// cannot casually reproduce, because it needs last year's figures held
// somewhere. It is also the only check set here that can say a cost is too high
// without appealing to what is "typical" — the comparison is against the same
// property twelve months earlier, which is a fact about their building rather
// than an opinion about the market.
//
// Two ways a prior period arrives, and the first is preferred:
//
//   1. It is in the documents already. Owner statements and P&Ls routinely
//      print a prior-year column, and the extractor records it. Same document,
//      same property, no matching required, and it works on a customer's very
//      first purchase.
//
//   2. It is a completed earlier submission by the same email for the same
//      address. This is the one that makes coming back next year worth
//      something.
//
// The discipline is the same as everywhere else in this engine: if the two
// periods cannot be compared honestly — different lengths, overlapping,
// undated, a different building — nothing is reported except the reason why.
// A variance computed across a nine-month period and a twelve-month one is a
// number that looks like arithmetic and is not.

const {
  Severity, EvidenceKind, Actionability, ImpactKind, rankFindings,
} = require('./rental-audit');

// --- address matching -------------------------------------------------------
//
// Deliberately conservative. A false match compares two different buildings and
// reports every difference between them as a year-over-year change, which is
// worse than reporting nothing at all.

const TOKEN_ALIASES = {
  avenue: 'ave', av: 'ave', street: 'st', str: 'st', road: 'rd', drive: 'dr',
  boulevard: 'blvd', lane: 'ln', court: 'ct', place: 'pl', terrace: 'ter',
  circle: 'cir', parkway: 'pkwy', highway: 'hwy', trail: 'trl', way: 'way',
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
};

function tokenize(address) {
  return String(address || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => TOKEN_ALIASES[t] || t);
}

// The street number, the first real word of the street name, and the ZIP if one
// is printed. Three things that are cheap to read off any address and hard to
// coincide between two different buildings owned by the same person.
function addressKey(address) {
  const tokens = tokenize(address);
  if (!tokens.length) return null;

  const number = /^\d+[a-z]?$/.test(tokens[0]) ? tokens[0] : null;
  if (!number) return null;

  const directions = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  const name = tokens.slice(1).find((t) => /^[a-z][a-z0-9]*$/.test(t) && directions.indexOf(t) === -1);
  if (!name) return null;

  const zips = tokens.filter((t) => /^\d{5}$/.test(t) && t !== number);
  return { number, name, zip: zips.length ? zips[zips.length - 1] : null };
}

function sameProperty(a, b) {
  const ka = addressKey(a);
  const kb = addressKey(b);
  if (!ka || !kb) return false;
  if (ka.number !== kb.number || ka.name !== kb.name) return false;
  // A ZIP on both sides has to agree. A ZIP on only one side is not evidence
  // either way — plenty of rent rolls print the street and nothing else.
  if (ka.zip && kb.zip && ka.zip !== kb.zip) return false;
  return true;
}

// --- dates and periods ------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Tolerant of the three shapes these documents actually print, and null for
// anything else. Guessing a date is how a nine-month period gets compared to a
// twelve-month one.
function parseDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));

  m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));

  m = raw.match(/^([a-z]{3})[a-z]*\.?\s+(\d{4})$/i);
  if (m) {
    const idx = MONTHS.indexOf(m[1].toLowerCase());
    if (idx !== -1) return new Date(Date.UTC(+m[2], idx, 1));
  }
  return null;
}

function monthsBetween(start, end) {
  if (!start || !end) return null;
  return (end.getUTCFullYear() - start.getUTCFullYear()) * 12
    + (end.getUTCMonth() - start.getUTCMonth());
}

// Returns { ok: true } or { ok: false, reason } — the reason is customer-facing.
function periodsComparable(current, prior) {
  const cs = parseDate(current.period_start);
  const ce = parseDate(current.period_end);
  const ps = parseDate(prior.period_start);
  const pe = parseDate(prior.period_end);

  if (!cs || !ce || !ps || !pe) {
    return { ok: false, reason: 'one of the two statements does not print the period it covers, so there is no way to know the two describe comparable spans of time' };
  }

  const currentMonths = monthsBetween(cs, ce);
  const priorMonths = monthsBetween(ps, pe);
  if (currentMonths === null || priorMonths === null || currentMonths <= 0 || priorMonths <= 0) {
    return { ok: false, reason: 'the periods on the two statements do not read as valid date ranges' };
  }

  // Two annual statements, or two of anything, as long as they cover the same
  // length of time. Comparing totals across different spans produces a variance
  // that is mostly calendar.
  if (Math.abs(currentMonths - priorMonths) > 1) {
    return {
      ok: false,
      reason: `the two statements cover different lengths of time (${currentMonths} months against ${priorMonths}), `
        + 'so the totals are not comparable without pro-rating, which this audit will not do',
    };
  }

  if (ps < ce && cs < pe) {
    return { ok: false, reason: 'the two statements overlap, so they are not consecutive periods' };
  }

  if (pe > cs) {
    return { ok: false, reason: 'the statement offered as the earlier period is the later of the two' };
  }

  return { ok: true, currentMonths, priorMonths };
}

// --- helpers ----------------------------------------------------------------

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

function arr(v) {
  return Array.isArray(v) ? v : [];
}

const CATEGORY_LABELS = {
  management: 'management fees',
  leasing_turnover: 'leasing and turnover fees',
  repairs_maintenance: 'repairs and maintenance',
  water_sewer: 'water and sewer',
  trash: 'trash service',
  electric: 'electricity',
  gas: 'gas',
  landscaping: 'landscaping',
  snow: 'snow removal',
  warranty: 'the warranty plan',
  insurance: 'insurance',
  taxes: 'property taxes',
  pest: 'pest control',
  admin: 'accounting and admin',
  hoa: 'HOA dues',
  other: 'other costs',
};

function categoryTotals(expenses) {
  const totals = new Map();
  for (const line of arr(expenses)) {
    const amount = num(line && line.annual_amount);
    if (amount === null) continue;
    const key = (line && line.category) || 'other';
    totals.set(key, (totals.get(key) || 0) + amount);
  }
  return totals;
}

// A line has to move by a real proportion AND a real amount. Fifteen per cent of
// a $200 pest control contract is $30, which is not worth a landlord's attention
// and would crowd out the findings that are.
const MATERIAL_RATIO = 0.15;
const MATERIAL_DOLLARS = 250;
const MAX_LINE_FINDINGS = 6;

// --- the comparison ---------------------------------------------------------

function runRentalTrend(current, prior) {
  const x = current || {};
  const p = prior || {};
  if (!p || !p.income || !arr(p.expenses).length) {
    return { findings: [], skipped: [], comparedTo: null };
  }

  const currentIncome = x.income || {};
  const priorIncome = p.income || {};

  // Same building, when both sides name one. A prior period lifted out of the
  // customer's own statement carries no address of its own and needs no check —
  // it came from the same document.
  if (p.source === 'earlier_submission') {
    const currentAddress = (x.property || {}).address;
    if (!sameProperty(currentAddress, p.address)) {
      return {
        findings: [],
        skipped: [`Year-over-year comparison — an earlier report was found for this email, but its property `
          + 'address could not be matched to this one with enough confidence to compare them'],
        comparedTo: null,
      };
    }
  }

  const comparable = periodsComparable(currentIncome, priorIncome);
  if (!comparable.ok) {
    return {
      findings: [],
      skipped: [`Year-over-year comparison — ${comparable.reason}`],
      comparedTo: null,
    };
  }

  const label = `${priorIncome.period_start} to ${priorIncome.period_end}`;
  const findings = [];

  const currentTotals = categoryTotals(x.expenses);
  const priorTotals = categoryTotals(p.expenses);

  // --- line by line ---------------------------------------------------------
  const moved = [];
  const held = [];
  for (const [category, currentAmount] of currentTotals) {
    if (!priorTotals.has(category)) continue;      // a cost that did not exist last year is not a rise
    const priorAmount = priorTotals.get(category);
    if (priorAmount <= 0) continue;
    const change = currentAmount - priorAmount;
    const ratio = change / priorAmount;
    if (change >= MATERIAL_DOLLARS && ratio >= MATERIAL_RATIO) {
      moved.push({ category, currentAmount, priorAmount, change, ratio });
    } else {
      held.push({ category, currentAmount, priorAmount, change, ratio });
    }
  }

  moved.sort((a, b) => b.change - a.change);

  // Overall operating expense movement, used as the yardstick each line is
  // described against — "rose faster than the rest" only means something
  // relative to what the rest did.
  const currentOpex = Array.from(currentTotals.values()).reduce((a, b) => a + b, 0);
  const priorOpex = Array.from(priorTotals.values()).reduce((a, b) => a + b, 0);
  const opexRatio = priorOpex > 0 ? (currentOpex - priorOpex) / priorOpex : null;

  for (const line of moved.slice(0, MAX_LINE_FINDINGS)) {
    const name = CATEGORY_LABELS[line.category] || line.category.replace(/_/g, ' ');
    const outpaced = opexRatio !== null && line.ratio > opexRatio;
    findings.push({
      checkId: `TREND_${line.category.toUpperCase()}`,
      title: `Your spend on ${name} rose ${money(line.change)} against last period, up ${pct(line.ratio)}`,
      severity: Severity.COST_ROSE,
      evidence: EvidenceKind.INTERNAL_ARITHMETIC,
      actionability: Actionability.ACT_NOW,
      basis: `${money(line.priorAmount)} in the ${label} period against ${money(line.currentAmount)} now — `
        + `an increase of ${money(line.change)}, ${pct(line.ratio)}. `
        + (opexRatio !== null
          ? (outpaced
            ? `Your operating costs overall moved ${pct(opexRatio)} over the same period, so this line rose faster than the rest of the building.`
            : `Your operating costs overall moved ${pct(opexRatio)}, so this line moved roughly in step with everything else.`)
          : '')
        + ' This is a comparison of your own two statements, not against what is typical elsewhere.',
      recommendedAction: `Ask what changed on ${name} between the two periods before renewing or paying the next invoice. `
        + 'A supplier increase, a change of scope, and a billing error all look identical in a total.',
      charged: line.currentAmount,
      expected: line.priorAmount,
      dollarImpact: Math.round(line.change * 100) / 100,
      impactKind: ImpactKind.EXCESS,
      askManager: line.category === 'management' || line.category === 'leasing_turnover' || line.category === 'repairs_maintenance',
      askInsurer: line.category === 'insurance',
      detail: { category: line.category, ...line, opexRatio, period: label },
    });
  }

  // --- the income side ------------------------------------------------------
  const currentRent = num(currentIncome.gross_scheduled_rent);
  const priorRent = num(priorIncome.gross_scheduled_rent);
  if (currentRent !== null && priorRent !== null && priorRent > 0) {
    const change = currentRent - priorRent;
    const ratio = change / priorRent;
    // Costs rising while rent stands still is the shape of a property quietly
    // becoming unprofitable, and it is invisible in any single year.
    if (opexRatio !== null && opexRatio > 0.05 && ratio < opexRatio / 2) {
      findings.push({
        checkId: 'TREND_RENT_LAGGING_COSTS',
        title: `Your costs rose ${pct(opexRatio)} while scheduled rent moved ${pct(ratio)}`,
        severity: Severity.COST_ROSE,
        evidence: EvidenceKind.INTERNAL_ARITHMETIC,
        actionability: Actionability.AT_RENEWAL,
        basis: `Scheduled rent went from ${money(priorRent)} to ${money(currentRent)} (${pct(ratio)}) while `
          + `operating costs went from ${money(priorOpex)} to ${money(currentOpex)} (${pct(opexRatio)}). `
          + 'Both figures are from your own statements. A gap in one year is ordinary; the same gap repeated '
          + 'is the arithmetic behind a property that used to cash-flow and no longer does.',
        recommendedAction: 'Take this gap into the next renewal cycle rather than the one after it.',
        // Deliberately no dollar figure. The obvious one — costs up minus rent
        // up — is the same money already counted in the line findings above,
        // and a ranked list that carries both tells a landlord they have found
        // it twice. This is the shape of the year, not a sum to recover.
        dollarImpact: null,
        detail: {
          rentRatio: ratio,
          opexRatio,
          rentChange: Math.round(change * 100) / 100,
          opexChange: Math.round((currentOpex - priorOpex) * 100) / 100,
          period: label,
        },
      });
    }
  }

  // --- what held steady -----------------------------------------------------
  //
  // A landlord who is shown four costs that rose and nothing else has been told
  // their building is out of control. Naming what did not move is the context
  // that makes the rises legible, and it is the same work.
  if (held.length) {
    const flat = held.filter((h) => Math.abs(h.ratio) < MATERIAL_RATIO || Math.abs(h.change) < MATERIAL_DOLLARS);
    if (flat.length) {
      findings.push({
        checkId: 'TREND_HELD_STEADY',
        title: `${flat.length} of your cost lines held steady against last period`,
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.INTERNAL_ARITHMETIC,
        actionability: Actionability.ACT_NOW,
        basis: flat
          .sort((a, b) => b.currentAmount - a.currentAmount)
          .slice(0, 8)
          .map((h) => `${CATEGORY_LABELS[h.category] || h.category} ${money(h.priorAmount)} to ${money(h.currentAmount)}`)
          .join('; ') + '.',
        dollarImpact: null,
        detail: { count: flat.length, period: label },
      });
    }
  }

  return {
    // Ranked here as well as in the engine, so the module hands back a list
    // that reads correctly on its own rather than one that only makes sense
    // after somebody else sorts it.
    findings: rankFindings(findings),
    skipped: [],
    comparedTo: {
      label,
      source: p.source || 'prior_period_in_documents',
      currentOpex,
      priorOpex,
      opexRatio,
      months: comparable.currentMonths,
    },
  };
}

module.exports = {
  runRentalTrend,
  sameProperty,
  _internal: { addressKey, parseDate, monthsBetween, periodsComparable, categoryTotals },
};
