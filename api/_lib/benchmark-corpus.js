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

const ROW_KINDS = new Set(['exact', 'tiered', 'per_unit', 'percent', 'range']);

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
  if (!isRange && SOFT_EVIDENCE.has(row.evidence)) {
    at('a market norm must be expressed as a range, not as an exact or computed value');
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
        });
      }
      break;
    default:
      break;
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

const norm = (s) => String(s || '').toLowerCase().replace(/\s+county$|\s+parish$/, '').trim();

function amountFor(row, ctx) {
  const basisValue = row.basis === 'sale_price' ? ctx.salePrice : ctx.loanAmount;

  switch (row.kind) {
    case 'exact':
      return { exact: row.amount };

    case 'range':
      return { low: row.low, high: row.high };

    case 'percent':
      if (typeof basisValue !== 'number') return null;
      return { exact: round2((basisValue * row.rate_pct) / 100) };

    case 'per_unit': {
      // Transfer taxes are typically "$X per $500 of consideration, rounded up".
      if (typeof basisValue !== 'number') return null;
      const units = Math.ceil(basisValue / row.unit_size);
      return { exact: round2(units * row.unit_amount) };
    }

    case 'tiered': {
      if (typeof basisValue !== 'number') return null;
      const tier = row.tiers.find((t) => t.up_to === null || basisValue <= t.up_to);
      if (!tier) return null;
      const over = Math.max(0, basisValue - (tier.from || 0));
      const units = Math.ceil(over / tier.unit_size);
      return { exact: round2(tier.base + units * tier.rate_per_unit) };
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

  return function getBenchmark(ctx = {}) {
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
