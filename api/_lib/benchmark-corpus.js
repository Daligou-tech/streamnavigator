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

// 'unavailable' is a deliberate hole. Montgomery County's transfer tax varies
// by property value and Anne Arundel's carries a surcharge over $1m; neither is
// a single rate we can quote. Without a marker for that, stacked() cannot tell
// "this county levies no local transfer tax" from "we have not entered it yet",
// and would quote a state-only total as though it were the whole statutory
// charge — turning a correct settlement statement into a false overcharge
// finding in the two counties with the highest prices in the state. An
// unavailable row never answers a lookup and always blocks a stacked total.
const ROW_KINDS = new Set(['exact', 'tiered', 'per_unit', 'percent', 'range', 'unavailable']);

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

  // An admitted hole still has to say why, because the reason is shown to the
  // customer in place of a number.
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
          // used to be optional and defaulted to 0, which silently charged the
          // marginal rate on the WHOLE basis instead of the excess: a Texas
          // $268,500 policy came out at $2,106 instead of $1,612, presented to
          // the customer as a promulgated rate. A missing floor is now a load
          // failure, not a 30% overstatement.
          if (typeof t.from !== 'number' || t.from < 0) at(`tier ${i}: missing numeric from (the bracket floor the marginal rate applies above)`);
          if (i > 0 && row.tiers[i - 1] && row.tiers[i - 1].up_to === null) {
            at(`tier ${i}: follows an open-ended tier — the null up_to tier must be last`);
          }
          // A tier with no marginal rate is a flat lookup — Texas prices every
          // policy under $100,000 straight off a table — so its floor is not
          // used and need not line up with the bracket below it. A tier that
          // DOES charge a marginal rate must start where the last one ended, or
          // the excess is measured from the wrong place.
          if (i > 0 && t.rate_per_unit !== 0) {
            const prev = row.tiers[i - 1];
            const prevMarginal = [...row.tiers.slice(0, i)].reverse().find((p) => p.rate_per_unit !== 0);
            const floor = prevMarginal && typeof prevMarginal.up_to === 'number' ? prevMarginal.up_to : null;
            if (floor !== null && t.from !== floor) {
              at(`tier ${i}: from ${t.from} does not meet the previous rated bracket ending at ${floor}`);
            }
            if (prev && typeof prev.up_to === 'number' && typeof t.up_to === 'number' && t.up_to < prev.up_to) {
              at(`tier ${i}: up_to ${t.up_to} is below the previous tier — tiers must ascend`);
            }
          }
        });
      }
      break;
    default:
      break;
  }

  // Rounding conventions. Every promulgated schedule rounds, and they do not
  // round the same way: Texas rounds the product to the nearest dollar before
  // adding the bracket base, Florida rounds the liability up to the next $100
  // and then charges an exact fraction of a thousand, Maryland charges a whole
  // unit for each part of $500. Left unmodelled these produce small, permanent
  // disagreements with the settlement statement, which is worse than no
  // benchmark: it makes every correct charge look off by a few dollars.
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

const { canonicaliseState, canonicaliseCounty, normaliseCountyToken } = require('./jurisdiction');

const norm = normaliseCountyToken;

// A lookup context is only allowed to name a county the canonicaliser can
// resolve to exactly one jurisdiction. An ambiguous name — "Baltimore" in
// Maryland, which is both a county and an independent city at different
// recordation rates — is dropped, so county rows stop matching and the state
// row answers instead. Quoting a state rate is a smaller error than quoting
// the wrong county's; quoting the wrong county's is a wrong dollar figure with
// a citation attached.
//
// But "Baltimore" is ALSO the canonical name of Baltimore County, and the name
// this corpus files its rows under. So the same string is a guess when the
// extractor infers it from a postal address and an answer when
// resolveJurisdiction() reads it off a line paid to the County Director of
// Finance. The string cannot tell those apart; only provenance can. A caller
// that has resolved the jurisdiction passes countySource along with it, and a
// resolved county is taken as given — resolveJurisdiction never returns a
// county it could not pin down, so there is nothing left to second-guess.
//
// Without this, the level_marker path is dead: the resolver identifies the
// county correctly off the document and the lookup discards it, silently, as
// a state-rate fallback that looks like ordinary missing coverage.
const RESOLVED_COUNTY_SOURCES = new Set(['named', 'named_and_agreed', 'level_marker', 'stated']);

function resolveLookupContext(ctx) {
  const state = canonicaliseState(ctx.state) || ctx.state;
  if (!ctx.county) return { ...ctx, state };
  if (ctx.countySource && RESOLVED_COUNTY_SOURCES.has(ctx.countySource)) {
    return { ...ctx, state };
  }
  const { county } = canonicaliseCounty(state, ctx.county);
  return { ...ctx, state, county: county || undefined };
}

// Some schedules round the insured amount up before any rate is applied.
// Florida: "considering any fraction of $100.00 as a full $100.00".
function roundBasis(value, row) {
  const step = row.basis_round_up_to;
  if (typeof step !== 'number' || step <= 0) return value;
  return Math.ceil(value / step) * step;
}

// Whether a part unit is charged as a whole one. Maryland charges a full $500
// unit for each part of $500; Florida charges an exact fraction of a thousand.
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

  switch (row.kind) {
    case 'exact':
      return { exact: row.amount };

    case 'range':
      return { low: row.low, high: row.high };

    case 'percent':
      if (typeof rawBasis !== 'number') return null;
      return { exact: applyMinimum(round2((rawBasis * row.rate_pct) / 100), row) };

    case 'per_unit': {
      // Transfer taxes are typically "$X per $500 of consideration, rounded up".
      if (typeof rawBasis !== 'number') return null;
      const basisValue = roundBasis(rawBasis, row);
      const units = unitsFor(basisValue, row.unit_size, row);
      return { exact: applyMinimum(round2(applyProductRounding(units * row.unit_amount, row)), row) };
    }

    case 'tiered': {
      if (typeof rawBasis !== 'number') return null;
      const basisValue = roundBasis(rawBasis, row);
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
  };
}

// ---------------------------------------------------------------------------
// lookup
// ---------------------------------------------------------------------------

// Most specific jurisdiction wins: municipality, then county, then state, then
// national. A county schedule is always a better answer than a state average.
const SPECIFICITY = { municipality: 3, county: 2, state: 1, national: 0 };

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

  function getBenchmark(rawCtx = {}) {
    const ctx = resolveLookupContext(rawCtx);
    const { category, state, county, municipality } = ctx;
    if (!category) return null;

    const when = now();
    const candidates = loaded.filter((r) => {
      if (r.fee_category !== category) return false;
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
  getBenchmark.stacked = function stacked(rawCtx = {}) {
    const ctx = resolveLookupContext(rawCtx);
    const { category, state, county, municipality } = ctx;
    if (!category) return { total: null, components: [] };

    const when = now();
    const rows = loaded.filter((r) => {
      if (r.fee_category !== category || !r.stackable) return false;
      if (isStale(r, when, staleAfterDays)) return false;
      if (r.effective_date && new Date(r.effective_date) > when) return false;
      if (r.jurisdiction_type === 'national') return true;
      if (!state || norm(r.state) !== norm(state)) return false;
      if (r.jurisdiction_type === 'county') return county && norm(r.county) === norm(county);
      if (r.jurisdiction_type === 'municipality') return municipality && norm(r.municipality) === norm(municipality);
      return true;
    });

    if (!rows.length) return { total: null, components: [] };

    // A jurisdiction we know levies something we cannot compute must not be
    // summed from its remaining parts.
    const hole = rows.find((r) => r.kind === 'unavailable');
    if (hole) {
      return { total: null, components: [], unavailableReason: hole.unavailable_reason };
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
  DEFAULT_STALE_AFTER_DAYS,
  MIN_RANGE_SAMPLE,
  BENCHMARKABLE_CATEGORIES,
  validateRow,
  validateCorpus,
  isStale,
  makeGetBenchmark,
  coverageFor,
};
