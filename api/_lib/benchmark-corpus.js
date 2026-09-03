// Benchmark corpus — the data layer behind "is this fee higher than it should be?"
//
// The audit engine asks for a benchmark and gets one or gets null. This file
// decides which. Its job is as much about REFUSING to answer as answering:
// a wrong benchmark becomes a dollar figure in an email a customer sends their
// lender, so every guard here fails toward "cannot benchmark".
//
// Structural guarantees (enforced by validateRow, not by discipline):
//   * No row without source_url and effective_date is ever loaded.
//   * A market range can never carry an exact amount, and an exact amount can
//     never be labelled a market range. Hard rules and norms cannot be confused
//     because the shapes are mutually exclusive.
//   * A row past its staleness window stops answering. A county schedule that
//     changed on 1 January must not keep quoting last year's fee.
//   * A market range with too small a sample does not answer at all.

'use strict';

const { EvidenceKind } = require('./closing-audit');
const { canonicalizeMdCounty, cityFromAddress, isMaryland } = require('./md-jurisdiction');

const HARD_EVIDENCE = new Set([
  EvidenceKind.HARD_RATE_TABLE,
  EvidenceKind.HARD_FEE_SCHEDULE,
  EvidenceKind.HARD_STATUTE,
]);
const SOFT_EVIDENCE = new Set([EvidenceKind.MARKET_RANGE, EvidenceKind.COMPARABLES]);

// Government schedules move annually. After this long unverified, a row is
// treated as unknown rather than current.
const DEFAULT_STALE_AFTER_DAYS = 400;
const MIN_RANGE_SAMPLE = 30;

// 'unavailable' is an admitted hole. Montgomery County levies both taxes but
// at rates the published sources do not agree on, so it is deliberately out of
// the corpus. Absence alone cannot say that: stacked() cannot tell "this county
// levies nothing" from "we have not entered it yet", and would quote a
// state-only sum as the whole statutory charge in the highest-dollar county in
// Maryland. An unavailable row never answers a lookup and always blocks a
// stacked total, so the omission is stated rather than inferred.
const ROW_KINDS = new Set(['exact', 'tiered', 'per_unit', 'per_instrument', 'percent', 'range', 'unavailable']);

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

function validateRow(row, index = 0) {
  const errors = [];
  const at = (m) => errors.push(`row ${index} (${row && row.id ? row.id : 'no id'}): ${m}`);

  if (!row || typeof row !== 'object') return [`row ${index}: not an object`];
  if (!row.id) at('missing id');
  if (!row.fee_category) at('missing fee_category');
  if (!ROW_KINDS.has(row.kind)) at(`kind must be one of ${[...ROW_KINDS].join(', ')}`);

  // Provenance is not optional. A benchmark nobody can trace is a rumour.
  if (!row.source_url || !/^https?:\/\//.test(String(row.source_url))) {
    at('missing or malformed source_url — a benchmark with no citable source must not be loaded');
  }
  if (!row.source_name) at('missing source_name');
  if (row.stackable && !row.component_label) at('stackable rows need a component_label for the report');
  if (!row.effective_date) at('missing effective_date');
  if (!row.verified_at) at('missing verified_at');

  if (!HARD_EVIDENCE.has(row.evidence) && !SOFT_EVIDENCE.has(row.evidence)) {
    at('evidence must be a valid EvidenceKind');
  }

  // Jurisdiction
  if (!['state', 'county', 'municipality', 'national'].includes(row.jurisdiction_type)) {
    at('jurisdiction_type must be state, county, municipality or national');
  }
  if (row.jurisdiction_type !== 'national' && !row.state) at('missing state');
  if (row.jurisdiction_type === 'county' && !row.county) at('missing county');

  // The shapes are mutually exclusive on purpose — this is what stops a market
  // average being presented to a customer as a legal requirement.
  const isRange = row.kind === 'range';
  if (isRange && HARD_EVIDENCE.has(row.evidence)) {
    at('a range cannot be a hard rule — ranges are market norms');
  }
  if (!isRange && row.kind !== 'unavailable' && SOFT_EVIDENCE.has(row.evidence)) {
    at('a market norm must be expressed as a range, not as an exact or computed value');
  }
  if (row.kind === 'unavailable' && !row.unavailable_reason) {
    at('unavailable rows need an unavailable_reason — it is displayed instead of a figure');
  }

  switch (row.kind) {
    case 'exact':
      if (typeof row.amount !== 'number') at('exact rows need a numeric amount');
      break;
    case 'range':
      if (typeof row.low !== 'number' || typeof row.high !== 'number') at('range rows need numeric low and high');
      else if (row.low > row.high) at('low is greater than high');
      if (typeof row.sample_size !== 'number') at('range rows need a sample_size');
      else if (row.sample_size < MIN_RANGE_SAMPLE) {
        at(`sample_size ${row.sample_size} is below the ${MIN_RANGE_SAMPLE} minimum — too few observations to quote a range`);
      }
      break;
    case 'percent':
      if (typeof row.rate_pct !== 'number') at('percent rows need rate_pct');
      if (!['loan_amount', 'sale_price'].includes(row.basis)) at('percent rows need basis of loan_amount or sale_price');
      break;
    case 'per_instrument':
      // A statutory fee charged once per recorded instrument. No basis: it does
      // not scale with the loan or the price.
      if (typeof row.unit_amount !== 'number') at('per_instrument rows need unit_amount');
      break;

    case 'per_unit':
      if (typeof row.unit_amount !== 'number') at('per_unit rows need unit_amount');
      if (typeof row.unit_size !== 'number' || row.unit_size <= 0) at('per_unit rows need a positive unit_size');
      if (!['loan_amount', 'sale_price'].includes(row.basis)) at('per_unit rows need basis of loan_amount or sale_price');
      break;
    case 'tiered':
      if (!Array.isArray(row.tiers) || !row.tiers.length) at('tiered rows need a non-empty tiers array');
      else {
        row.tiers.forEach((t, i) => {
          if (typeof t.up_to !== 'number' && t.up_to !== null) at(`tier ${i}: up_to must be a number or null for the top tier`);
          if (typeof t.base !== 'number') at(`tier ${i}: missing numeric base`);
          if (typeof t.rate_per_unit !== 'number') at(`tier ${i}: missing numeric rate_per_unit`);
          if (typeof t.unit_size !== 'number' || t.unit_size <= 0) at(`tier ${i}: unit_size must be positive`);
          // `from` is the bracket floor the marginal rate is charged above. It
          // defaulted to 0, so omitting it silently charged the marginal rate
          // on the WHOLE basis instead of the excess — a Texas $268,500 policy
          // computes as $2,106 against a published $1,612, presented to the
          // customer as a promulgated rate. A missing floor is now a load
          // failure rather than a 31% overstatement.
          if (typeof t.from !== 'number' || t.from < 0) {
            at(`tier ${i}: missing numeric from (the bracket floor the marginal rate applies above)`);
          }
          if (i > 0 && row.tiers[i - 1] && row.tiers[i - 1].up_to === null) {
            at(`tier ${i}: follows an open-ended tier — the null up_to tier must be last`);
          }
          // A tier with no marginal rate is a flat lookup (Texas prices every
          // policy under $100,000 straight off a table) so its floor is unused.
          // A tier that DOES charge a marginal rate must start where the last
          // rated one ended, or the excess is measured from the wrong place.
          if (i > 0 && t.rate_per_unit !== 0) {
            const prevRated = row.tiers.slice(0, i).reverse().find((x) => x.rate_per_unit !== 0);
            const floor = prevRated && typeof prevRated.up_to === 'number' ? prevRated.up_to : null;
            if (floor !== null && t.from !== floor) {
              at(`tier ${i}: from ${t.from} does not meet the previous rated bracket ending at ${floor}`);
            }
          }
        });
      }
      break;
    default:
      break;
  }

  // Rounding conventions. Every promulgated schedule rounds, and they do not
  // round alike: Texas rounds the product to the nearest dollar before adding
  // the bracket base, Florida rounds liability up to the next $100 and then
  // charges an exact fraction of a thousand, Maryland charges a whole unit for
  // each part of $500. Left unmodelled these leave small permanent
  // disagreements with the settlement statement, which is worse than no
  // benchmark: every correct charge looks off by a few dollars.
  if (row.basis_round_up_to !== undefined
      && (typeof row.basis_round_up_to !== 'number' || row.basis_round_up_to <= 0)) {
    at('basis_round_up_to must be a positive number when present');
  }
  if (row.unit_rounding !== undefined && !['ceil', 'exact'].includes(row.unit_rounding)) {
    at("unit_rounding must be 'ceil' (default: a part unit is charged as a whole one) or 'exact'");
  }
  if (row.product_rounding !== undefined && !['none', 'nearest_dollar'].includes(row.product_rounding)) {
    at("product_rounding must be 'none' (default) or 'nearest_dollar'");
  }
  if (row.minimum !== undefined && (typeof row.minimum !== 'number' || row.minimum < 0)) {
    at('minimum must be a non-negative number when present');
  }
  if (row.minimum !== undefined && row.kind === 'range') {
    at('a range cannot carry a minimum — it is a market norm, not a schedule');
  }

  return errors;
}

function validateCorpus(rows) {
  const errors = [];
  const seen = new Set();
  (rows || []).forEach((r, i) => {
    errors.push(...validateRow(r, i));
    if (r && r.id) {
      if (seen.has(r.id)) errors.push(`row ${i}: duplicate id "${r.id}"`);
      seen.add(r.id);
    }
  });
  return errors;
}

// ---------------------------------------------------------------------------
// staleness
// ---------------------------------------------------------------------------

function isStale(row, now = new Date(), staleAfterDays = DEFAULT_STALE_AFTER_DAYS) {
  if (row.superseded_date && new Date(row.superseded_date) <= now) return true;
  const verified = new Date(row.verified_at);
  const ageDays = (now - verified) / 86400000;
  return ageDays > (row.stale_after_days || staleAfterDays);
}

// ---------------------------------------------------------------------------
// computing a benchmark from a row
// ---------------------------------------------------------------------------

// A distribution row is only comparable within its loan-size band. Without
// this, a $200,000 loan would be measured against the $300k-$500k spread and
// look cheap, or the reverse. A row with a band and no loanAmount in context
// does not answer at all.
const LOAN_BANDS = {
  lt150k: [0, 150000],
  '150k-300k': [150000, 300000],
  '300k-500k': [300000, 500000],
  '500k-750k': [500000, 750000],
  gte750k: [750000, Infinity],
};

function bandMatches(row, ctx) {
  if (!row.loan_band) return true;
  const band = LOAN_BANDS[row.loan_band];
  if (!band) return false;
  const basis = row.basis === 'sale_price' ? ctx.salePrice : ctx.loanAmount;
  if (typeof basis !== 'number') return false;
  return basis >= band[0] && basis < band[1];
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+county$|\s+parish$/, '').trim();

// Some schedules round the insured amount up before any rate applies.
// Florida: "considering any fraction of $100.00 as a full $100.00".
function roundBasis(value, row) {
  const step = row.basis_round_up_to;
  if (typeof step !== 'number' || step <= 0) return value;
  return Math.ceil(value / step) * step;
}

// Whether a part unit is charged as a whole one. Maryland charges a full $500
// unit for each part of $500; Florida charges the true fraction of a thousand.
function unitsFor(value, unitSize, row) {
  return row.unit_rounding === 'exact' ? value / unitSize : Math.ceil(value / unitSize);
}

// Texas rounds the multiplication to the nearest dollar BEFORE adding the
// bracket base. Rounding the total instead leaves every Texas premium a few
// cents adrift of the published figure.
function applyProductRounding(product, row) {
  return row.product_rounding === 'nearest_dollar' ? Math.round(product) : product;
}

function applyMinimum(amount, row) {
  return typeof row.minimum === 'number' ? Math.max(amount, row.minimum) : amount;
}

function amountFor(row, ctx) {
  const rawBasis = row.basis === 'sale_price' ? ctx.salePrice : ctx.loanAmount;
  const basisValue = typeof rawBasis === 'number' ? roundBasis(rawBasis, row) : rawBasis;

  switch (row.kind) {
    case 'exact':
      return { exact: row.amount };

    case 'range':
      return { low: row.low, high: row.high };

    // A jurisdiction we know levies something we cannot compute. Never answers.
    case 'unavailable':
      return null;

    case 'percent':
      if (typeof basisValue !== 'number') return null;
      return { exact: applyMinimum(round2((basisValue * row.rate_pct) / 100), row) };

    case 'per_instrument': {
      // Returns nothing unless the caller knows how many instruments were
      // recorded. Guessing two because most purchases record a deed and a deed
      // of trust would silently misprice every cash sale and every closing with
      // a subordinate lien.
      const n = ctx.instrumentCount;
      if (!Number.isInteger(n) || n < 1) return null;
      return { exact: round2(n * row.unit_amount) };
    }

    case 'per_unit': {
      // Transfer taxes are typically "$X per $500 of consideration, rounded up".
      if (typeof basisValue !== 'number') return null;
      const units = unitsFor(basisValue, row.unit_size, row);
      return { exact: applyMinimum(round2(applyProductRounding(units * row.unit_amount, row)), row) };
    }

    case 'tiered': {
      if (typeof basisValue !== 'number') return null;
      const tier = row.tiers.find((t) => t.up_to === null || basisValue <= t.up_to);
      if (!tier) return null;
      const over = Math.max(0, basisValue - tier.from);
      const units = unitsFor(over, tier.unit_size, row);
      const product = applyProductRounding(units * tier.rate_per_unit, row);
      return { exact: applyMinimum(round2(tier.base + product), row) };
    }

    default:
      return null;
  }
}

const round2 = (n) => Math.round(n * 100) / 100;

function toBenchmark(row, ctx) {
  const amounts = amountFor(row, ctx);
  if (!amounts) return null;
  return {
    exact: amounts.exact !== undefined ? amounts.exact : null,
    low: amounts.low !== undefined ? amounts.low : null,
    high: amounts.high !== undefined ? amounts.high : null,
    evidence: row.evidence,
    source: row.source_name,
    sourceUrl: row.source_url,
    effectiveDate: row.effective_date,
    jurisdiction: row.county ? `${row.county}, ${row.state}` : (row.state || 'US'),
    sampleSize: typeof row.sample_size === 'number' ? row.sample_size : null,
    loanBandLabel: row.loan_band_label || null,
    caveat: row.exemption_note || null,
  };
}

// ---------------------------------------------------------------------------
// lookup
// ---------------------------------------------------------------------------

// Most specific jurisdiction wins: municipality, then county, then state, then
// national. A county schedule is always a better answer than a state average.
const SPECIFICITY = { municipality: 3, county: 2, state: 1, national: 0 };

// ---------------------------------------------------------------------------
// jurisdiction resolution
// ---------------------------------------------------------------------------

// Open issue #2: extraction returns "Baltimore" on one run and "Baltimore City"
// on the next, and those are different tax tables. norm() below only lowercases
// and strips a "county" suffix, so bare "Baltimore" quietly matched Baltimore
// COUNTY -- half the recordation rate of Baltimore City. Canonicalising here
// makes the lookup deterministic regardless of which spelling arrived, and an
// unresolvable name yields no benchmark instead of the wrong one.
function resolveCounty(ctx) {
  if (!ctx.county || !isMaryland(ctx.state)) return { county: ctx.county, blocked: false };
  const city = ctx.city || cityFromAddress(ctx.propertyAddress);
  const r = canonicalizeMdCounty(ctx.county, { city });
  if (r.ok) return { county: r.county, blocked: false };
  return { county: null, blocked: true, reason: r.reason, ambiguous: r.ambiguous };
}

function makeGetBenchmark(rows, options = {}) {
  const { now = () => new Date(), staleAfterDays = DEFAULT_STALE_AFTER_DAYS } = options;

  const errors = validateCorpus(rows);
  if (errors.length) {
    // Refuse to load a bad corpus rather than serve part of it. A half-loaded
    // corpus produces confident answers for some counties and silence for
    // others, with no way to tell which is which.
    throw new Error(`Benchmark corpus failed validation:\n  ${errors.join('\n  ')}`);
  }

  const loaded = rows.slice();

  function getBenchmark(ctx = {}) {
    const { category, state, municipality } = ctx;
    if (!category) return null;

    const resolved = resolveCounty(ctx);
    if (resolved.blocked) return null;
    const county = resolved.county;

    const when = now();
    const candidates = loaded.filter((r) => {
      if (r.fee_category !== category) return false;
      if (!bandMatches(r, ctx)) return false;
      if (isStale(r, when, staleAfterDays)) return false;
      if (r.effective_date && new Date(r.effective_date) > when) return false;
      if (r.jurisdiction_type === 'national') return true;
      if (!state || norm(r.state) !== norm(state)) return false;
      if (r.jurisdiction_type === 'county') return county && norm(r.county) === norm(county);
      if (r.jurisdiction_type === 'municipality') return municipality && norm(r.municipality) === norm(municipality);
      return true; // state-level
    });

    if (!candidates.length) return null;

    candidates.sort((a, b) => {
      const s = SPECIFICITY[b.jurisdiction_type] - SPECIFICITY[a.jurisdiction_type];
      if (s !== 0) return s;
      // then hard rules over market norms
      const h = (HARD_EVIDENCE.has(b.evidence) ? 1 : 0) - (HARD_EVIDENCE.has(a.evidence) ? 1 : 0);
      if (h !== 0) return h;
      return new Date(b.effective_date) - new Date(a.effective_date);
    });

    for (const row of candidates) {
      const bm = toBenchmark(row, ctx);
      if (bm) return bm;
    }
    return null;
  };

  // Some charges are the SUM of taxes levied at several levels at once — a
  // Maryland deed carries a state transfer tax and a local one, and both appear
  // on the settlement statement. The normal lookup returns the most specific
  // single row, which would understate the true statutory figure. Rows marked
  // stackable are added together across jurisdiction levels instead.
  getBenchmark.stacked = function stacked(ctx = {}) {
    const { category, state, municipality } = ctx;
    if (!category) return { total: null, components: [] };

    const resolved = resolveCounty(ctx);
    if (resolved.blocked) {
      return { total: null, components: [], unresolvedJurisdiction: resolved.reason };
    }
    const county = resolved.county;

    const when = now();
    const rows = loaded.filter((r) => {
      if (r.fee_category !== category || !r.stackable) return false;
      if (!bandMatches(r, ctx)) return false;
      if (isStale(r, when, staleAfterDays)) return false;
      if (r.effective_date && new Date(r.effective_date) > when) return false;
      if (r.jurisdiction_type === 'national') return true;
      if (!state || norm(r.state) !== norm(state)) return false;
      if (r.jurisdiction_type === 'county') return county && norm(r.county) === norm(county);
      if (r.jurisdiction_type === 'municipality') return municipality && norm(r.municipality) === norm(municipality);
      return true;
    });

    if (!rows.length) return { total: null, components: [] };

    // Completeness guard. Without this, a county the corpus does not model
    // still matches the STATE-level rows and returns a partial total -- e.g.
    // Maryland's 0.5% state transfer tax alone, with the county transfer and
    // recordation taxes silently missing. Every real charge would then exceed
    // that total and be reported as an overcharge. If the corpus models county
    // rows for this category anywhere in this state, the requested county must
    // be among them or the whole stack refuses.
    if (county) {
      const modelsCounties = loaded.some(
        (r) => r.fee_category === category && r.stackable
          && r.jurisdiction_type === 'county' && norm(r.state) === norm(state)
      );
      const haveThisCounty = rows.some(
        (r) => r.jurisdiction_type === 'county' && norm(r.county) === norm(county)
      );
      if (modelsCounties && !haveThisCounty) {
        return {
          total: null,
          components: [],
          unresolvedJurisdiction:
            `No county-level rates are on file for ${county}, ${state}. `
            + 'Returning the state portion alone would understate the statutory total '
            + 'and report a correct charge as an overcharge.',
        };
      }
    }

    const components = [];
    let total = 0;
    for (const row of rows) {
      const bm = toBenchmark(row, ctx);
      if (!bm || bm.exact === null) return { total: null, components: [] }; // incomplete: refuse
      total += bm.exact;
      components.push({
        label: row.component_label || row.jurisdiction_type,
        amount: bm.exact,
        source: row.source_name,
        sourceUrl: row.source_url,
        note: row.exemption_note || null,
      });
    }
    return { total: round2(total), components, evidence: rows[0].evidence };
  };

  return getBenchmark;
}

// ---------------------------------------------------------------------------
// coverage reporting
// ---------------------------------------------------------------------------

// What share of a given jurisdiction's benchmarkable fees we can actually
// answer. Drives the honest paywall and tells you which county to buy next.
const BENCHMARKABLE_CATEGORIES = [
  'title_insurance_owners', 'title_insurance_lenders', 'recording_fee',
  'transfer_tax', 'appraisal', 'survey', 'attorney', 'settlement_service',
];

function coverageFor(getBenchmark, ctx) {
  const covered = [];
  const missing = [];
  for (const category of BENCHMARKABLE_CATEGORIES) {
    const bm = getBenchmark({ ...ctx, category });
    (bm ? covered : missing).push(category);
  }
  return {
    covered,
    missing,
    pct: Math.round((covered.length / BENCHMARKABLE_CATEGORIES.length) * 100),
  };
}

module.exports = {
  LOAN_BANDS,
  bandMatches,
  DEFAULT_STALE_AFTER_DAYS,
  MIN_RANGE_SAMPLE,
  BENCHMARKABLE_CATEGORIES,
  validateRow,
  validateCorpus,
  isStale,
  makeGetBenchmark,
  coverageFor,
};
