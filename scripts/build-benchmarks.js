#!/usr/bin/env node
// Generates data/benchmarks.json from the published schedules transcribed below.
//
// The corpus is generated rather than hand-written because the Texas table is
// 151 brackets and Maryland is 24 jurisdictions x 2 taxes. Hand-keying that
// once is a bad afternoon; hand-keying it again every time a county moves its
// rate is how a stale figure ends up in a customer's email to their lender.
//
// Re-verification workflow:
//   1. Open the source_url on each SOURCES entry below. Read the figures.
//   2. Correct the tables here and bump the matching `verified` date.
//   3. npm run build-benchmarks && npm test
//
// Rows stop answering 400 days after verified_at, so an un-rerun corpus goes
// quiet rather than going wrong.

'use strict';

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'data', 'benchmarks.json');

// Date this data was last read off the publishing authority's own page.
const VERIFIED = '2026-09-02';

const SOURCES = {
  TX: {
    name: 'Texas Department of Insurance, Texas Title Insurance Basic Premium Rates, effective 1 March 2026 (Commissioner Order 2025-9697, −6.2% adjustment)',
    url: 'https://tdi.texas.gov/title/titlerates2026.html',
    effective: '2026-03-01',
  },
  FL: {
    name: 'Fla. Admin. Code R. 69O-186.003, Title Insurance Rates (original owner/leasehold and mortgage risk rate premiums)',
    url: 'https://flrules.org/gateway/ChapterHome.asp?Chapter=69O-186',
    effective: '2002-07-01',
  },
  MD_TAX: {
    name: "Maryland Department of Legislative Services, Other Local Tax Rates in Maryland, FY 2026 (recordation tax per $500; county transfer tax rate)",
    url: 'https://dls.maryland.gov/pubs/prod/NoPblTabPDF/2026CountyLocalTaxRates.pdf',
    effective: '2025-07-01',
  },
  MD_STATE_TT: {
    name: 'Md. Code, Tax-Property Article, Title 13 — State transfer tax at 0.5% of consideration (0.25% and payable by the seller for a first-time Maryland homebuyer)',
    url: 'https://www.mdcourts.gov/clerks/harford/landrecords',
    effective: '2025-07-01',
  },
  MD_RECORDING: {
    name: 'Maryland Judiciary, Clerk of the Circuit Court recording fee schedule (Chapter 642 / HB 1179 instrument fees; Chapter 538 (2020) $40 land records surcharge)',
    url: 'https://www.mdcourts.gov/clerks/worcester/recordingfees',
    effective: '2020-07-01',
  },
};

const rows = [];

// ---------------------------------------------------------------------------
// Texas — promulgated basic premium, effective 1 March 2026
// ---------------------------------------------------------------------------
// Policies up to $100,000 are a flat lookup in $500 steps. Transcribed from the
// TDI table, read left-to-right across its four column pairs.
const TX_FLAT = [
  [25000, 308], [25500, 310], [26000, 314], [26500, 317], [27000, 319],
  [27500, 322], [28000, 325], [28500, 328], [29000, 333], [29500, 336],
  [30000, 339], [30500, 341], [31000, 345], [31500, 348], [32000, 351],
  [32500, 355], [33000, 357], [33500, 361], [34000, 364], [34500, 368],
  [35000, 371], [35500, 373], [36000, 376], [36500, 380], [37000, 383],
  [37500, 386], [38000, 390], [38500, 393], [39000, 395], [39500, 399],
  [40000, 401], [40500, 406], [41000, 408], [41500, 412], [42000, 415],
  [42500, 418], [43000, 420], [43500, 424],
  [44000, 428], [44500, 431], [45000, 434], [45500, 437], [46000, 440],
  [46500, 444], [47000, 446], [47500, 448], [48000, 453], [48500, 457],
  [49000, 460], [49500, 462], [50000, 465], [50500, 468], [51000, 470],
  [51500, 474], [52000, 478], [52500, 482], [53000, 484], [53500, 488],
  [54000, 491], [54500, 493], [55000, 496], [55500, 499], [56000, 504],
  [56500, 507], [57000, 509], [57500, 513], [58000, 517], [58500, 519],
  [59000, 522], [59500, 525], [60000, 529], [60500, 533], [61000, 536],
  [61500, 537], [62000, 541], [62500, 545],
  [63000, 547], [63500, 551], [64000, 554], [64500, 557], [65000, 560],
  [65500, 563], [66000, 567], [66500, 571], [67000, 574], [67500, 575],
  [68000, 579], [68500, 582], [69000, 585], [69500, 588], [70000, 592],
  [70500, 596], [71000, 599], [71500, 601], [72000, 604], [72500, 608],
  [73000, 611], [73500, 613], [74000, 617], [74500, 621], [75000, 625],
  [75500, 627], [76000, 629], [76500, 632], [77000, 636], [77500, 639],
  [78000, 643], [78500, 646], [79000, 650], [79500, 651], [80000, 655],
  [80500, 658], [81000, 662], [81500, 664],
  [82000, 667], [82500, 672], [83000, 675], [83500, 677], [84000, 680],
  [84500, 684], [85000, 687], [85500, 689], [86000, 692], [86500, 697],
  [87000, 701], [87500, 703], [88000, 705], [88500, 709], [89000, 713],
  [89500, 715], [90000, 718], [90500, 721], [91000, 725], [91500, 729],
  [92000, 731], [92500, 734], [93000, 737], [93500, 741], [94000, 742],
  [94500, 747], [95000, 751], [95500, 754], [96000, 755], [96500, 759],
  [97000, 763], [97500, 766], [98000, 769], [98500, 773], [99000, 776],
  [99500, 779], [100000, 780],
];

// Above $100,000: subtract the bracket floor, multiply, round to the nearest
// dollar, add the bracket base.
const TX_BRACKETS = [
  { up_to: 1000000, from: 100000, base: 780, rate_per_unit: 0.00494, unit_size: 1 },
  { up_to: 5000000, from: 1000000, base: 5226, rate_per_unit: 0.00406, unit_size: 1 },
  { up_to: 15000000, from: 5000000, base: 21466, rate_per_unit: 0.00335, unit_size: 1 },
  { up_to: 25000000, from: 15000000, base: 54966, rate_per_unit: 0.00238, unit_size: 1 },
  { up_to: 50000000, from: 25000000, base: 78766, rate_per_unit: 0.00143, unit_size: 1 },
  { up_to: 100000000, from: 50000000, base: 114516, rate_per_unit: 0.00129, unit_size: 1 },
  { up_to: null, from: 100000000, base: 179016, rate_per_unit: 0.00116, unit_size: 1 },
];

const txTiers = TX_FLAT.map(([upTo, premium]) => (
  { up_to: upTo, from: 0, base: premium, rate_per_unit: 0, unit_size: 1 }
)).concat(TX_BRACKETS);

rows.push({
  id: 'tx-title-basic-premium-owners',
  fee_category: 'title_insurance_owners',
  kind: 'tiered',
  tiers: txTiers,
  basis: 'sale_price',
  product_rounding: 'nearest_dollar',
  jurisdiction_type: 'state',
  state: 'TX',
  evidence: 'hard_rule:promulgated_or_filed_rate',
  source_name: SOURCES.TX.name,
  source_url: SOURCES.TX.url,
  effective_date: SOURCES.TX.effective,
  verified_at: VERIFIED,
  exemption_note: "Texas premiums are promulgated: every title company must charge this figure for the same coverage, so any difference is an error rather than a matter of shopping. The basic premium is the policy only — endorsements (T-19, T-30, survey deletion) and the escrow or closing fee are charged separately and are not part of this figure. Discounted rates exist for a reissue within seven years (R-3) and for a residential refinance (R-8); a charge BELOW this figure is very likely one of those and is not an error.",
});

// ---------------------------------------------------------------------------
// Florida — promulgated risk rate premium, 69O-186.003
// ---------------------------------------------------------------------------
// Owner's and mortgage policies share one schedule. Liability is rounded up to
// the next $100 and then charged as an exact fraction of a thousand.
const FL_TIERS = [
  { up_to: 100000, from: 0, base: 0, rate_per_unit: 5.75, unit_size: 1000 },
  { up_to: 1000000, from: 100000, base: 575, rate_per_unit: 5.00, unit_size: 1000 },
  { up_to: 5000000, from: 1000000, base: 5075, rate_per_unit: 2.50, unit_size: 1000 },
  { up_to: 10000000, from: 5000000, base: 15075, rate_per_unit: 2.25, unit_size: 1000 },
  { up_to: null, from: 10000000, base: 26325, rate_per_unit: 2.00, unit_size: 1000 },
];

const flCommon = {
  kind: 'tiered',
  tiers: FL_TIERS,
  basis_round_up_to: 100,
  unit_rounding: 'exact',
  minimum: 100,
  jurisdiction_type: 'state',
  state: 'FL',
  evidence: 'hard_rule:promulgated_or_filed_rate',
  source_name: SOURCES.FL.name,
  source_url: SOURCES.FL.url,
  effective_date: SOURCES.FL.effective,
  verified_at: VERIFIED,
};

rows.push({
  ...flCommon,
  id: 'fl-title-risk-premium-owners',
  fee_category: 'title_insurance_owners',
  basis: 'sale_price',
  exemption_note: "Florida premiums are promulgated: every agent must charge the same figure for the same coverage. The owner's policy is written for the full insurable value. A reissue rate applies where the seller's own policy is presented and can cut this materially, so a charge below this figure is very likely a reissue and is not an error. Search, examination and closing fees are separate charges and are not part of the promulgated premium.",
});

rows.push({
  ...flCommon,
  id: 'fl-title-risk-premium-lenders',
  fee_category: 'title_insurance_lenders',
  basis: 'loan_amount',
  exemption_note: "This is the FULL mortgage-policy rate. Where the lender's and owner's policies are issued simultaneously by the same insurer in the same transaction, the lender's policy costs $25 for coverage up to the owner's policy amount — so on a purchase closing that shows both policies, the correct lender's charge is usually $25, not this figure. Treat any charge between $25 and this amount as a simultaneous-issue question for the settlement agent rather than as an overcharge against this row.",
});

// ---------------------------------------------------------------------------
// Maryland — recording fees (statewide statutory schedule)
// ---------------------------------------------------------------------------
rows.push({
  id: 'md-land-records-recording-fee-purchase',
  fee_category: 'recording_fee',
  kind: 'exact',
  amount: 120,
  jurisdiction_type: 'state',
  state: 'MD',
  evidence: 'hard_rule:government_fee_schedule',
  source_name: SOURCES.MD_RECORDING.name,
  source_url: SOURCES.MD_RECORDING.url,
  effective_date: SOURCES.MD_RECORDING.effective,
  verified_at: VERIFIED,
  exemption_note: "The clerk's statutory charge for a financed purchase of a principal residence: $20 per instrument plus the $40 land records surcharge, for the deed and the deed of trust — $120 in total, at any page count, because an instrument involving solely a principal residence is $20 regardless of length. Each ADDITIONAL instrument recorded (a power of attorney, a release of an existing lien, an HOA document) adds its own fee, so a higher total is not automatically an overcharge; it is a question about what else was recorded. A settlement agent's own 'recording service' or e-recording charge is a separate service fee and is not part of this statutory figure.",
});

// ---------------------------------------------------------------------------
// Maryland — state transfer tax (stackable component)
// ---------------------------------------------------------------------------
rows.push({
  id: 'md-state-transfer-tax',
  fee_category: 'transfer_tax',
  kind: 'percent',
  rate_pct: 0.5,
  basis: 'sale_price',
  jurisdiction_type: 'state',
  state: 'MD',
  stackable: true,
  component_label: 'Maryland state transfer tax',
  evidence: 'hard_rule:statute_or_regulation',
  source_name: SOURCES.MD_STATE_TT.name,
  source_url: SOURCES.MD_STATE_TT.url,
  effective_date: SOURCES.MD_STATE_TT.effective,
  verified_at: VERIFIED,
  exemption_note: 'Reduced to 0.25% and payable by the seller where the buyer is a first-time Maryland homebuyer occupying the property as a principal residence.',
});

// ---------------------------------------------------------------------------
// Maryland — county recordation tax and county transfer tax
// ---------------------------------------------------------------------------
// recordation: dollars per $500 of consideration or debt secured, rounded up to
// the next whole $500. transfer: percent of consideration. FY 2026.
//
// A null means the county levies the tax but not at a single quotable rate; it
// becomes an 'unavailable' row so the total refuses rather than understates.
const MD_COUNTIES = [
  ['Allegany',        3.50, 0.5],
  ['Anne Arundel',    3.50, null],
  ['Baltimore City',  5.00, 1.5],
  ['Baltimore',       2.50, 1.5],
  ['Calvert',         5.00, 0.0],
  ['Caroline',        5.00, 0.5],
  ['Carroll',         6.50, 0.0],
  ['Cecil',           4.10, 0.5],
  ['Charles',         7.00, 0.5],
  ['Dorchester',      5.00, 0.75],
  ['Frederick',       7.00, 0.0],
  ['Garrett',         3.50, 1.0],
  ['Harford',         3.30, 1.0],
  ['Howard',          2.50, 1.25],
  ['Kent',            3.30, 0.5],
  ['Montgomery',      null, null],
  ["Prince George's", 2.75, 1.4],
  ["Queen Anne's",    4.95, 0.5],
  ["St. Mary's",      4.00, 1.0],
  ['Somerset',        3.30, 0.0],
  ['Talbot',          6.00, 1.0],
  ['Washington',      3.80, 0.5],
  ['Wicomico',        3.50, 0.0],
  ['Worcester',       3.30, 0.5],
];

const VARIES_REASON = {
  Montgomery: 'Montgomery County levies a recordation tax surcharge above $500,000 and a transfer tax that varies with property value, so neither is a single rate that can be quoted here. The statutory total for this property has to be confirmed with the Montgomery County Department of Finance.',
  'Anne Arundel': 'Anne Arundel County levies a county transfer tax of 1.0%, plus a further 0.5% surcharge on transactions of $1,000,000 or more, so a single rate would be wrong at one end or the other. Confirm the applicable rate with the Anne Arundel County Office of Finance.',
};

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Maryland recordation tax is a tax, and closing-audit.js already buckets a
// "recordation" label as zero-tolerance alongside transfer taxes. On the merits
// it belongs in the stacked transfer_tax total.
//
// It is NOT stacked yet, deliberately. The extractor's category enum has no
// recordation_tax, so a recordation line lands in transfer_tax or recording_fee
// depending on how the model reads it, and folding it into the stacked total
// today would raise the statutory bar on every Maryland document — including
// the ones whose CD never listed a recordation line. On the Baltimore City test
// document that moves the bar from $1,800 to $2,700 and stops a real $250
// overcharge from being flagged at all. Sensitivity lost quietly is worse than
// coverage missing loudly.
//
// To switch it on, once the extractor reliably emits recordation lines as
// transfer_tax: set this true, rebuild, and update the three Baltimore City
// expectations in tests/closing-scorecard.test.js to the 3-component totals.
const STACK_RECORDATION_INTO_TRANSFER_TAX = false;

const MD_RECORDATION_NOTE = "Charged per $500 of consideration or part thereof. On a normal financed purchase the deed of trust is a purchase money deed of trust and is exempt under Md. Code, Tax-Property §12-108(i), so the tax falls on the sale price once and not again on the loan — but the exemption reaches only the purchase money portion, so a loan larger than the price is taxed on the excess. Many counties halve or waive this rate for a first-time Maryland homebuyer, so a charge below this figure is very likely an exemption and is not an error.";

for (const [county, recordation, transferPct] of MD_COUNTIES) {
  const base = {
    jurisdiction_type: 'county',
    state: 'MD',
    county,
    stackable: true,
    evidence: 'hard_rule:statute_or_regulation',
    source_name: SOURCES.MD_TAX.name,
    source_url: SOURCES.MD_TAX.url,
    effective_date: SOURCES.MD_TAX.effective,
    verified_at: VERIFIED,
  };

  const recCategory = STACK_RECORDATION_INTO_TRANSFER_TAX ? 'transfer_tax' : 'recordation_tax';
  const recBase = { ...base, stackable: STACK_RECORDATION_INTO_TRANSFER_TAX };

  if (recordation === null) {
    rows.push({
      ...recBase,
      id: `md-${slug(county)}-recordation-tax`,
      fee_category: recCategory,
      kind: 'unavailable',
      component_label: `${county} County recordation tax`,
      unavailable_reason: VARIES_REASON[county],
    });
  } else {
    rows.push({
      ...recBase,
      id: `md-${slug(county)}-recordation-tax`,
      fee_category: recCategory,
      kind: 'per_unit',
      unit_amount: recordation,
      unit_size: 500,
      basis: 'sale_price',
      component_label: county === 'Baltimore City'
        ? 'Baltimore City recordation tax'
        : `${county} County recordation tax`,
      exemption_note: MD_RECORDATION_NOTE,
    });
  }

  if (transferPct === null) {
    rows.push({
      ...base,
      id: `md-${slug(county)}-transfer-tax`,
      fee_category: 'transfer_tax',
      kind: 'unavailable',
      component_label: `${county} County transfer tax`,
      unavailable_reason: VARIES_REASON[county],
    });
  } else {
    rows.push({
      ...base,
      id: `md-${slug(county)}-transfer-tax`,
      fee_category: 'transfer_tax',
      kind: 'percent',
      rate_pct: transferPct,
      basis: 'sale_price',
      component_label: county === 'Baltimore City'
        ? 'Baltimore City transfer tax'
        : `${county} County transfer tax`,
      exemption_note: transferPct === 0
        ? `${county} County levies no local transfer tax. A county transfer tax line on a ${county} County settlement statement is a charge with no statutory basis and should be questioned directly.`
        : `Several counties exempt or reduce the local transfer tax for an owner-occupied purchase or a first-time Maryland homebuyer — Baltimore City exempts the first $22,000 on qualifying owner-occupied property — so a charge below this figure is very likely an exemption and is not an error. Above $1,000,000 Baltimore City also applies a yield tax surcharge that is not modelled here.`,
    });
  }
}

// ---------------------------------------------------------------------------

const doc = {
  _README: "Benchmark corpus. GENERATED — edit scripts/build-benchmarks.js and re-run `npm run build-benchmarks`, do not hand-edit this file. EVERY row must carry source_name, source_url, effective_date and verified_at, or the corpus refuses to load — see api/_lib/benchmark-corpus.js validateRow(). Do not add a row from memory or from a secondary source: open the publishing authority's own page, read the figure, and paste that URL. A wrong benchmark becomes a dollar figure in a customer's email to their lender.",
  _KINDS: "exact | tiered | per_unit | percent | range | unavailable. Hard rules must NOT use kind 'range'; market norms MUST use 'range' and need sample_size >= 30. 'unavailable' is an admitted hole: it never answers a lookup and it blocks a stacked total, so a jurisdiction we cannot fully compute stays silent instead of quoting a partial sum as the whole statutory charge.",
  _ROUNDING: "Schedules do not round alike. basis_round_up_to rounds the insured amount up before any rate applies (Florida: any fraction of $100 is a full $100). unit_rounding 'ceil' (default) charges a whole unit for each part unit (Maryland: each part of $500); 'exact' charges the true fraction. product_rounding 'nearest_dollar' rounds the multiplication before the bracket base is added (Texas). minimum floors the result (Florida: $100).",
  _STALENESS: 'Rows stop answering 400 days after verified_at, or on superseded_date. Schedules typically change 1 January, 1 March or 1 July — re-verify and bump verified_at.',
  _STACKABLE: 'Transfer and recordation taxes are levied at several levels at once and both appear on a settlement statement. Rows marked stackable:true are summed across jurisdiction levels rather than the most specific one winning. They need a component_label because the report shows the customer the breakdown.',
  _EXEMPTIONS: 'exemption_note is displayed with any finding built on the row. Maryland has first-time-buyer and owner-occupied reductions that would make a correctly reduced charge look like an undercharge. The audit only flags a charge EXCEEDING the unexempted statutory amount; a charge below it is informational, never an error.',
  _ALLOCATION: 'Transfer taxes are split between buyer and seller by contract, so a single settlement-statement line is one party\u2019s share, not the tax. These are tested against the SUM of all lines in the category.',
  rows,
};

fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);

const byKind = rows.reduce((acc, r) => ({ ...acc, [r.kind]: (acc[r.kind] || 0) + 1 }), {});
console.log(`Wrote ${rows.length} rows to ${path.relative(process.cwd(), OUT)}`);
console.log('  by kind:', byKind);
console.log('  jurisdictions:', [...new Set(rows.map((r) => r.state))].join(', '));
