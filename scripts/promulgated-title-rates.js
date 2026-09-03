// Promulgated title insurance rates for the three states that set them.
//
// Texas, Florida and New Mexico fix title premiums by regulation: every agent
// must charge the same figure for the same coverage, so a difference is an
// error rather than a matter of shopping. That makes these the only fee
// benchmarks outside recording and tax that can be stated as hard rules.
//
// Transcribed from the publishing authority's own page, not from a rate
// calculator or a title company summary. Re-verification is: open the two URLs
// below, read the tables, correct the constants here, bump VERIFIED.
//
// Consumed by build-md-corpus.js, which owns data/benchmarks.json.

'use strict';

const VERIFIED = '2026-09-02';

// Texas rates changed on 1 March 2026 (Commissioner Order 2025-9697, a 6.2%
// reduction). Anything transcribed from the 2019 table is wrong by that much
// on every Texas policy.
const TX_URL = 'https://tdi.texas.gov/title/titlerates2026.html';
const TX_NAME =
  'Texas Department of Insurance, Texas Title Insurance Basic Premium Rates, '
  + 'effective 1 March 2026 (Commissioner Order No. 2025-9697, Docket 2858)';

const FL_URL = 'https://flrules.org/gateway/ChapterHome.asp?Chapter=69O-186';
const FL_NAME =
  'Fla. Admin. Code R. 69O-186.003, Title Insurance Rates — original owner, '
  + 'leasehold and mortgage risk rate premiums';

// --- Texas -----------------------------------------------------------------
// Policies up to $100,000 are a flat lookup in $500 steps, read left to right
// across the four column pairs of the TDI table.
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

// Above $100,000: subtract the bracket floor, multiply, round the product to
// the nearest dollar, then add the bracket base.
const TX_BRACKETS = [
  { up_to: 1000000, from: 100000, base: 780, rate_per_unit: 0.00494, unit_size: 1 },
  { up_to: 5000000, from: 1000000, base: 5226, rate_per_unit: 0.00406, unit_size: 1 },
  { up_to: 15000000, from: 5000000, base: 21466, rate_per_unit: 0.00335, unit_size: 1 },
  { up_to: 25000000, from: 15000000, base: 54966, rate_per_unit: 0.00238, unit_size: 1 },
  { up_to: 50000000, from: 25000000, base: 78766, rate_per_unit: 0.00143, unit_size: 1 },
  { up_to: 100000000, from: 50000000, base: 114516, rate_per_unit: 0.00129, unit_size: 1 },
  { up_to: null, from: 100000000, base: 179016, rate_per_unit: 0.00116, unit_size: 1 },
];

// --- Florida ---------------------------------------------------------------
// One schedule serves owner's and mortgage policies. Liability rounds up to the
// next $100, then the rate applies to the true fraction of a thousand.
const FL_TIERS = [
  { up_to: 100000, from: 0, base: 0, rate_per_unit: 5.75, unit_size: 1000 },
  { up_to: 1000000, from: 100000, base: 575, rate_per_unit: 5.00, unit_size: 1000 },
  { up_to: 5000000, from: 1000000, base: 5075, rate_per_unit: 2.50, unit_size: 1000 },
  { up_to: 10000000, from: 5000000, base: 15075, rate_per_unit: 2.25, unit_size: 1000 },
  { up_to: null, from: 10000000, base: 26325, rate_per_unit: 2.00, unit_size: 1000 },
];

const FL_COMMON = {
  kind: 'tiered',
  tiers: FL_TIERS,
  basis_round_up_to: 100,
  unit_rounding: 'exact',
  minimum: 100,
  jurisdiction_type: 'state',
  state: 'FL',
  evidence: 'hard_rule:promulgated_or_filed_rate',
  source_name: FL_NAME,
  source_url: FL_URL,
  effective_date: '2002-07-01',
  verified_at: VERIFIED,
};

const rows = [
  {
    id: 'tx-title-basic-premium-owners',
    fee_category: 'title_insurance_owners',
    kind: 'tiered',
    tiers: TX_FLAT
      .map(([upTo, premium]) => ({ up_to: upTo, from: 0, base: premium, rate_per_unit: 0, unit_size: 1 }))
      .concat(TX_BRACKETS),
    basis: 'sale_price',
    product_rounding: 'nearest_dollar',
    jurisdiction_type: 'state',
    state: 'TX',
    evidence: 'hard_rule:promulgated_or_filed_rate',
    source_name: TX_NAME,
    source_url: TX_URL,
    effective_date: '2026-03-01',
    verified_at: VERIFIED,
    exemption_note:
      'Texas premiums are promulgated, so every title company must charge this '
      + 'figure for the same coverage and a difference is an error rather than a '
      + 'matter of shopping. This is the policy alone: endorsements (T-19, T-30, '
      + 'survey deletion) and the escrow or closing fee are charged separately. '
      + 'Discounted rates exist for a reissue within seven years (R-3) and for a '
      + 'residential refinance (R-8), so a charge BELOW this figure is very likely '
      + 'one of those and is not an error.',
  },
  {
    ...FL_COMMON,
    id: 'fl-title-risk-premium-owners',
    fee_category: 'title_insurance_owners',
    basis: 'sale_price',
    exemption_note:
      'Florida premiums are promulgated, so every agent must charge the same '
      + "figure for the same coverage. The owner's policy is written for the full "
      + "insurable value. A reissue rate applies where the seller's own policy is "
      + 'presented and can cut this materially, so a charge below this figure is '
      + 'very likely a reissue and is not an error. Search, examination and closing '
      + 'fees are separate and are not part of the promulgated premium.',
  },
  {
    ...FL_COMMON,
    id: 'fl-title-risk-premium-lenders',
    fee_category: 'title_insurance_lenders',
    basis: 'loan_amount',
    exemption_note:
      'This is the FULL mortgage-policy rate. Where the lender\u2019s and owner\u2019s '
      + 'policies are issued simultaneously by the same insurer in the same '
      + "transaction, the lender's policy costs $25 for coverage up to the owner's "
      + 'policy amount — so on a purchase closing showing both policies the correct '
      + 'lender charge is usually $25, not this figure. Treat anything between $25 '
      + 'and this amount as a simultaneous-issue question for the settlement agent '
      + 'rather than an overcharge against this row.',
  },
];

module.exports = { rows, VERIFIED };
