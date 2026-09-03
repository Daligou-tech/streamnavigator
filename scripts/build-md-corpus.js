// Generates data/benchmarks.json for Maryland.
//
// The rate table below is transcribed ONCE, from the FY2026 columns of the
// Maryland Department of Legislative Services table cited in DLS_URL. Every
// row in the output is derived from it programmatically, so a county cannot
// pick up a neighbour's rate through a copy-paste slip.
//
// Run: node build-md-corpus.js > data/benchmarks.json

'use strict';

const DLS_URL = 'https://dls.maryland.gov/pubs/prod/NoPblTabPDF/2026CountyLocalTaxRates.pdf';
const DLS_NAME =
  'Maryland Department of Legislative Services, "Other Local Tax Rates in Maryland" '
  + '(2026 edition), FY 2026 recordation and transfer tax columns';

const COURTS_URL = 'https://www.courts.state.md.us/clerks/wicomico/recordingfees';
const COURTS_NAME =
  'Maryland Judiciary, Clerk of the Circuit Court — Recording Fees and Taxes '
  + '(statutory schedule under Real Property Article and the $40 Chapter 538 surcharge)';

const STATUTE_URL = 'https://law.justia.com/codes/maryland/tax-property/title-12/section-12-108/';

// FY 2026 began 1 July 2025. Charles County's recordation rate rose from $5.00
// to $7.00 at that boundary, so that is the correct effective date.
const EFFECTIVE = '2025-07-01';
const VERIFIED = '2026-09-02';

// Short window on purpose. FY 2027 began 1 July 2026 and DLS has not yet
// published an FY 2027 column, so these rows are the latest PUBLISHED figures
// but may already be superseded by county budget ordinances. They expire at
// the end of 2026 and must be re-verified against each county's FY 2027
// ordinance before then.
const STALE_AFTER_DAYS = 120;

// county -> [recordation $ per $500, local transfer tax %]
// null means "varies / not a single rate" and is deliberately not shipped.
const FY2026 = {
  'Allegany':        [3.50, 0.5],
  'Anne Arundel':    [3.50, null],  // 1.0%, +0.5% surcharge at $1M — tiered below
  'Baltimore City':  [5.00, 1.5],
  'Baltimore':       [2.50, 1.5],
  'Calvert':         [5.00, 0.0],
  'Caroline':        [5.00, 0.5],
  'Carroll':         [6.50, 0.0],
  'Cecil':           [4.10, 0.5],
  'Charles':         [7.00, 0.5],
  'Dorchester':      [5.00, 0.75],
  'Frederick':       [7.00, 0.0],
  'Garrett':         [3.50, 1.0],
  'Harford':         [3.30, 1.0],
  'Howard':          [2.50, 1.25],
  'Kent':            [3.30, 0.5],
  'Montgomery':      [null, null],  // both "Varies" in the DLS table — omitted
  "Prince George's": [2.75, 1.4],
  "Queen Anne's":    [4.95, 0.5],
  "St. Mary's":      [4.00, 1.0],
  'Somerset':        [3.30, 0.0],
  'Talbot':          [6.00, 1.0],
  'Washington':      [3.80, 0.5],
  'Wicomico':        [3.50, 0.0],
  'Worcester':       [3.30, 0.5],
};

// Notes that must travel with a finding built on the row. These are reductions
// that would make a correctly reduced charge look like an undercharge.
const TRANSFER_NOTES = {
  'Baltimore City':
    'The first $22,000 is exempt for owner-occupied residential property where the '
    + 'buyer signs the required affidavit. A yield tax surcharge applies above '
    + '$1,000,000 and is not modelled here.',
  "Prince George's":
    "Prince George's is the only Maryland county that also imposes its local transfer "
    + 'tax on security instruments, so a deed of trust attracts county transfer tax here '
    + 'and nowhere else.',
};

const ZERO_NOTE =
  'This county imposes no local transfer tax. A county transfer tax line on a '
  + 'settlement statement for this jurisdiction is charged without authority.';

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const rows = [];

// --- state transfer tax ------------------------------------------------------
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
  source_name: COURTS_NAME + ' — state transfer tax at 0.5% of consideration (Tax-Property Article §13-207)',
  source_url: COURTS_URL,
  effective_date: EFFECTIVE,
  verified_at: VERIFIED,
  stale_after_days: STALE_AFTER_DAYS,
  exemption_note:
    'Reduced to 0.25% and payable by the seller where the buyer is a first-time '
    + 'Maryland homebuyer occupying the property as a principal residence.',
});

// --- county recordation tax --------------------------------------------------
// Its OWN category, not folded into transfer_tax.
//
// A Maryland deed does carry all three taxes, and stacking them was tempting.
// But the extraction schema has no recordation_tax category, so a "State
// Recordation Tax" line lands in transfer_tax on one document and recording_fee
// on the next. Adding recordation to the statutory DENOMINATOR while the
// NUMERATOR only sometimes contains it invents a shortfall on one document and
// hides an overcharge on another. tests/closing-scorecard.test.js caught this.
//
// These rows stack among themselves and stay dormant until the extractor can
// identify a recordation line reliably. The data is verified and ready.
for (const [county, [rec]] of Object.entries(FY2026)) {
  if (rec === null) continue;
  rows.push({
    id: `md-${slug(county)}-recordation-tax`,
    fee_category: 'recordation_tax',
    kind: 'per_unit',
    unit_amount: rec,
    unit_size: 500,
    basis: 'sale_price',
    jurisdiction_type: 'county',
    state: 'MD',
    county,
    stackable: true,
    component_label: `${county} recordation tax ($${rec.toFixed(2)} per $500)`,
    evidence: 'hard_rule:statute_or_regulation',
    source_name: DLS_NAME,
    source_url: DLS_URL,
    effective_date: EFFECTIVE,
    verified_at: VERIFIED,
    stale_after_days: STALE_AFTER_DAYS,
    exemption_note:
      'Charged on the deed only. A purchase money deed of trust delivered in the '
      + 'same transaction is exempt from recordation tax under Tax-Property Article '
      + `§12-108(i)(3) (${STATUTE_URL}), so the loan amount is not taxed again. Where `
      + 'the loan exceeds the purchase price, the excess is taxable and is not '
      + 'modelled here. Several counties reduce or exempt the first tranche for '
      + 'owner-occupied or first-time buyers.',
  });
}

// --- county transfer tax -----------------------------------------------------
for (const [county, [, pct]] of Object.entries(FY2026)) {
  if (pct === null) continue;
  rows.push({
    id: `md-${slug(county)}-transfer-tax`,
    fee_category: 'transfer_tax',
    kind: 'percent',
    rate_pct: pct,
    basis: 'sale_price',
    jurisdiction_type: 'county',
    state: 'MD',
    county,
    stackable: true,
    // Keeps the substring "<County> transfer tax" intact -- the report copy and
    // tests/closing-scorecard.test.js both match on it -- while still showing
    // the customer the rate the figure came from.
    component_label:
      pct === 0
        ? `${county} transfer tax (none imposed)`
        : `${county} transfer tax (${pct}%)`,
    evidence: 'hard_rule:statute_or_regulation',
    source_name: DLS_NAME,
    source_url: DLS_URL,
    effective_date: EFFECTIVE,
    verified_at: VERIFIED,
    stale_after_days: STALE_AFTER_DAYS,
    exemption_note: pct === 0 ? ZERO_NOTE : (TRANSFER_NOTES[county] || null),
  });
}

// --- Anne Arundel transfer tax (graduated) -----------------------------------
// 1.0%, with a 0.5% surcharge on transactions of $1,000,000 or more. The top
// bracket is deliberately absent: whether the surcharge applies to the whole
// consideration or only the excess is not settled by the DLS footnote, so at
// $1M and above the row returns nothing and the audit reports cannot-benchmark.
rows.push({
  id: 'md-anne-arundel-transfer-tax',
  fee_category: 'transfer_tax',
  kind: 'tiered',
  basis: 'sale_price',
  tiers: [
    { up_to: 999999.99, from: 0, base: 0, rate_per_unit: 0.01, unit_size: 1 },
  ],
  jurisdiction_type: 'county',
  state: 'MD',
  county: 'Anne Arundel',
  stackable: true,
  component_label: 'Anne Arundel transfer tax (1.0%)',
  evidence: 'hard_rule:statute_or_regulation',
  source_name: DLS_NAME + ' — 1.0% with a 0.5% surcharge at $1,000,000 and above (footnote 3)',
  source_url: DLS_URL,
  effective_date: EFFECTIVE,
  verified_at: VERIFIED,
  stale_after_days: STALE_AFTER_DAYS,
  exemption_note:
    'A 0.5% surcharge applies to transactions of $1,000,000 or more and is not '
    + 'modelled: this row covers consideration below $1,000,000 only.',
});

// --- statewide clerk recording fee -------------------------------------------
// DORMANT BY DESIGN. per_instrument returns null unless instrumentCount is
// supplied in the lookup context, and nothing supplies it yet. See NOTES.md —
// this must not go live until the extractor distinguishes a Maryland
// "recordation tax" line from a clerk recording fee.
rows.push({
  id: 'md-clerk-recording-fee-principal-residence',
  fee_category: 'recording_fee',
  kind: 'per_instrument',
  unit_amount: 60,
  jurisdiction_type: 'state',
  state: 'MD',
  evidence: 'hard_rule:government_fee_schedule',
  source_name: COURTS_NAME,
  source_url: COURTS_URL,
  effective_date: '2020-07-01',
  verified_at: VERIFIED,
  exemption_note:
    'Maryland sets clerk recording fees by statute statewide: $20 for an instrument '
    + 'involving solely a principal residence regardless of length, plus the $40 '
    + 'Chapter 538 surcharge on every instrument recorded in the land records, so $60 '
    + 'per instrument. A purchase with a mortgage normally records two instruments. '
    + 'This is the clerk fee only and is entirely separate from the recordation tax.',
});

const out = {
  _README:
    'Benchmark corpus. EVERY row must carry source_name, source_url, effective_date '
    + 'and verified_at, or the corpus refuses to load — see api/_lib/benchmark-corpus.js '
    + 'validateRow(). Do not add a row from memory or from a secondary source: open the '
    + "publishing authority's own page, read the figure, and paste that URL. A wrong "
    + "benchmark becomes a dollar figure in a customer's email to their lender.",
  _KINDS:
    'exact | tiered | per_unit | per_instrument | percent | range. Hard rules must NOT '
    + "use kind 'range'; market norms MUST use 'range' and need sample_size >= 30. "
    + 'per_instrument returns nothing unless instrumentCount is supplied.',
  _STALENESS:
    'Rows stop answering after stale_after_days from verified_at (default 400), or on '
    + 'superseded_date. The Maryland tax rows carry a 120-day window because they are '
    + 'FY 2026 figures and FY 2027 began 1 July 2026 — see _FY2027_RISK.',
  _FY2027_RISK:
    'The recordation and county transfer tax rows are transcribed from the DLS 2026 '
    + 'edition, whose most recent column is FY 2026. FY 2027 rates took effect '
    + '1 July 2026 and DLS has not yet tabulated them. Before these rows drive paid '
    + "findings, spot-check each county's adopted FY 2027 budget ordinance. Charles "
    + 'moved $5.00 -> $7.00 at the FY 2026 boundary, so movement is not rare.',
  _STACKABLE:
    'A transfer tax is levied at two levels at once — state and county — and both appear '
    + 'on a settlement statement. Rows marked stackable:true are summed across '
    + 'jurisdiction levels rather than the most specific one winning.',
  _RECORDATION_IS_SEPARATE:
    'Maryland recordation tax is a THIRD tax on the same deed, kept in its own '
    + 'fee_category and deliberately dormant. The extraction schema has no '
    + 'recordation_tax category, so a recordation line is classified as transfer_tax on '
    + 'one document and recording_fee on the next. Give the extractor a recordation_tax '
    + 'category first, then wire these rows in.',
  _EXEMPTIONS:
    'exemption_note is displayed with any finding built on the row. Maryland has '
    + 'first-time-buyer and owner-occupied reductions that would make a correctly '
    + 'reduced charge look like an undercharge. The audit only flags a charge EXCEEDING '
    + 'the unexempted statutory amount; a charge below it is informational, never an error.',
  _ALLOCATION:
    'Transfer taxes are split between buyer and seller by contract, so a single '
    + 'settlement-statement line is one party\'s share, not the tax. These are tested '
    + 'against the SUM of all lines in the category.',
  _OMITTED:
    'Montgomery County is deliberately absent for both recordation and transfer tax. '
    + 'The DLS table records both as "Varies". Montgomery recordation is a base rate '
    + 'plus a school increment plus a premium that steps at $500k/$600k/$750k/$1M, and '
    + 'the published sources do not agree on whether the premium brackets are marginal. '
    + 'Montgomery is high-volume and high-dollar, so a wrong row there is the most '
    + 'expensive row in the corpus. It stays out until someone reads the county code.',
  rows,
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
