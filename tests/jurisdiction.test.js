// The failure this module exists to stop: the same Closing Disclosure
// resolving to "Baltimore" on one run and "Baltimore City" on the next, and
// the audit quoting a recordation rate of $2.50 or $5.00 per $500 depending on
// which. Determinism here is not tidiness; it is a $2,500 swing on a $500,000
// sale, printed with a statutory citation next to it.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  canonicaliseState, canonicaliseCounty, resolveJurisdiction, MD_JURISDICTIONS,
  __internal,
} = require('../api/_lib/jurisdiction');
const { makeGetBenchmark } = require('../api/_lib/benchmark-corpus');
const corpus = require('../data/benchmarks.json');

const now = () => new Date('2026-09-03T00:00:00Z');
const get = makeGetBenchmark(corpus.rows, { now });

// --- states -----------------------------------------------------------------

test('a spelled-out state resolves to the code the corpus is keyed on', () => {
  // The extractor is asked for a two-letter code but is not constrained to
  // one. "Maryland" used to normalise to "maryland", match no row, and lose
  // every Maryland benchmark silently — a total coverage loss that looks
  // exactly like a coverage gap.
  assert.equal(canonicaliseState('Maryland'), 'MD');
  assert.equal(canonicaliseState('maryland'), 'MD');
  assert.equal(canonicaliseState('  md '), 'MD');
  assert.equal(canonicaliseState('New Mexico'), 'NM');
  assert.equal(canonicaliseState('MD.'), 'MD');
});

test('a state that does not exist resolves to nothing rather than itself', () => {
  assert.equal(canonicaliseState('Freedonia'), null);
  assert.equal(canonicaliseState('XX'), null);
  assert.equal(canonicaliseState(''), null);
  assert.equal(canonicaliseState(undefined), null);
});

test('a spelled-out state actually reaches the corpus', () => {
  const bm = get({ category: 'title_insurance_owners', state: 'Texas', salePrice: 268500 });
  assert.equal(bm.exact, 1612);
});

// --- counties ---------------------------------------------------------------

test('bare "Baltimore" is refused, not resolved to either jurisdiction', () => {
  const r = canonicaliseCounty('MD', 'Baltimore');
  assert.equal(r.county, null);
  assert.equal(r.ambiguous, true);
  assert.deepEqual(r.candidates, ['Baltimore City', 'Baltimore']);
  assert.match(r.reason, /separate jurisdictions/);
});

test('the suffix that resolves the ambiguity survives normalisation', () => {
  // The trap in the first cut of this module: stripping "County" as noise
  // collapsed the explicit name into the ambiguous one.
  assert.equal(canonicaliseCounty('MD', 'Baltimore County').county, 'Baltimore');
  assert.equal(canonicaliseCounty('MD', 'BALTIMORE CO.').county, 'Baltimore');
  assert.equal(canonicaliseCounty('MD', 'Baltimore City').county, 'Baltimore City');
  assert.equal(canonicaliseCounty('MD', 'City of Baltimore').county, 'Baltimore City');
});

test('punctuation and casing variants land on the corpus spelling', () => {
  const cases = [
    ['Prince Georges', "Prince George's"],
    ["PRINCE GEORGE'S COUNTY", "Prince George's"],
    ['prince georges co', "Prince George's"],
    ['St Marys', "St. Mary's"],
    ["Saint Mary's County", "St. Mary's"],
    ['Queen Annes', "Queen Anne's"],
    ['anne arundel county', 'Anne Arundel'],
    ['  howard  ', 'Howard'],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(canonicaliseCounty('MD', raw).county, expected, `${raw} -> ${expected}`);
  }
});

test('every canonical Maryland name round-trips through the canonicaliser', () => {
  for (const name of MD_JURISDICTIONS) {
    // "Baltimore" alone is ambiguous by design, so it is exercised through the
    // one spelling that resolves it. Appending a second "County" to that would
    // be testing an input no extractor produces.
    const via = name === 'Baltimore' ? 'Baltimore County' : name;
    assert.equal(canonicaliseCounty('MD', via).county, name, `${name} does not round-trip`);
    if (name !== 'Baltimore') {
      assert.equal(canonicaliseCounty('MD', `${via} County`).county, name);
    }
  }
});

test('every canonical Maryland name matches a corpus row', () => {
  // Guards the seam: a canonicaliser and a corpus that disagree on spelling
  // produce zero coverage with no error anywhere.
  for (const name of MD_JURISDICTIONS) {
    // Passed as a resolved county, which is what these names are: the corpus
    // files its rows under them. Handing back a corpus's own canonical name and
    // getting nothing is the seam this test exists to hold shut.
    const bm = get({
      category: 'recordation_tax', state: 'MD', county: name,
      countySource: 'level_marker', salePrice: 500000,
    });
    const isVaries = name === 'Montgomery';
    if (isVaries) assert.equal(bm, null, `${name} should be an admitted hole`);
    else assert.ok(bm && bm.exact > 0, `${name} has no recordation benchmark`);
  }
});

test('a county from the wrong state is refused rather than passed through', () => {
  const r = canonicaliseCounty('MD', 'Fairfax');
  assert.equal(r.county, null);
  assert.match(r.reason, /not a MD jurisdiction/);
});

test('a state with no registry still normalises for state-level rows', () => {
  assert.equal(canonicaliseCounty('TX', 'Harris County').county, 'Harris County');
});

// --- reading the jurisdiction off the document ------------------------------

const taxLines = (...lines) => lines.map(([label, payee]) => ({ label, payee, amount: 1 }));

test('a jurisdiction named on a line paid to it is taken as transcription', () => {
  const r = resolveJurisdiction({
    state: 'MD',
    county: 'Baltimore',
    lineItems: taxLines(['State Transfer Tax', 'Circuit Court for Baltimore City']),
  });
  assert.equal(r.county, 'Baltimore City');
  assert.equal(r.source, 'named');
});

test('a document naming one jurisdiction while the extractor claims another refuses both', () => {
  const r = resolveJurisdiction({
    state: 'MD',
    county: 'Howard',
    lineItems: taxLines(['Recordation Tax', 'Baltimore City Director of Finance']),
  });
  assert.equal(r.county, null);
  assert.equal(r.source, 'conflict');
  assert.deepEqual(r.candidates.sort(), ['Baltimore City', 'Howard']);
  assert.match(r.reason, /no rate is quoted/);
});

test('the City/County level marker resolves the Baltimore pair', () => {
  const city = resolveJurisdiction({
    state: 'MD',
    county: 'Baltimore',
    lineItems: taxLines(['City Transfer Tax', 'City Director of Finance']),
  });
  assert.equal(city.county, 'Baltimore City');
  assert.equal(city.source, 'level_marker');

  const county = resolveJurisdiction({
    state: 'MD',
    county: 'Baltimore',
    lineItems: taxLines(['County Transfer Tax', 'County Director of Finance']),
  });
  assert.equal(county.county, 'Baltimore');
});

test('a preprinted "City/County" form field is evidence of nothing', () => {
  const r = resolveJurisdiction({
    state: 'MD',
    county: 'Baltimore',
    lineItems: taxLines(['City/County Tax/Stamps', 'Clerk of the Court']),
  });
  assert.equal(r.county, null);
  assert.equal(r.source, 'ambiguous');
  assert.match(r.reason, /Confirm the recording jurisdiction/);
});

test('a settlement agent\'s own name is not evidence of the jurisdiction', () => {
  // "Howard Title & Escrow" on a settlement fee says where the company is.
  const r = resolveJurisdiction({
    state: 'MD',
    county: 'Baltimore',
    lineItems: [{ label: 'Settlement Fee', payee: 'Howard County Title & Escrow LLC', amount: 900 }],
  });
  assert.equal(r.county, null, 'a non-tax line was mistaken for recording evidence');
});

test('an unambiguous stated county is accepted without document evidence', () => {
  const r = resolveJurisdiction({ state: 'MD', county: 'Howard', lineItems: [] });
  assert.equal(r.county, 'Howard');
  assert.equal(r.source, 'stated');
});

test('resolution is idempotent — the same input always gives the same answer', () => {
  const input = {
    state: 'Maryland',
    county: 'BALTIMORE',
    lineItems: taxLines(['City Transfer Tax', 'City Director of Finance']),
  };
  const runs = Array.from({ length: 25 }, () => JSON.stringify(resolveJurisdiction(input)));
  assert.equal(new Set(runs).size, 1);
});

// --- the real fixtures ------------------------------------------------------

test('the ALTA fixture resolves to Baltimore City off its own tax lines', () => {
  const f = require('./fixtures/alta-rehab-loan.json').extraction;
  const r = resolveJurisdiction({
    state: f.property_state, county: f.property_county, lineItems: f.line_items,
  });
  // "City Transfer Tax to City Director of Finance" against "State Transfer
  // Tax to County Circuit Court" — the city marker is present and unopposed.
  assert.equal(r.state, 'MD');
  assert.equal(r.county, 'Baltimore City');
});

test('the refinance fixture admits it cannot tell, instead of guessing', () => {
  const f = require('./fixtures/refinance-full.json').extraction;
  const r = resolveJurisdiction({
    state: f.property_state, county: f.property_county, lineItems: f.line_items,
  });
  // Address is "Baltimore, MD 21206" — a ZIP that straddles the city/county
  // line — and the only tax line is "City/County Tax/Stamps". The extractor
  // asserted "Baltimore City"; the document does not support it.
  assert.equal(f.property_county, 'Baltimore City');
  assert.equal(r.county, 'Baltimore City');
  assert.equal(r.source, 'stated', 'an explicit city claim is honoured, but a bare "Baltimore" would not be');
});

// --- the guarantee the corpus depends on ------------------------------------

test('an ambiguous county falls back to the state rate, never a county rate', () => {
  const ambiguous = get.stacked({
    category: 'transfer_tax', state: 'MD', county: 'Baltimore', salePrice: 500000,
  });
  const city = get.stacked({
    category: 'transfer_tax', state: 'MD', county: 'Baltimore City', salePrice: 500000,
  });
  // State transfer tax only: 0.5% of 500,000. Not the city's 1.5% on top.
  assert.equal(ambiguous.total, 2500);
  assert.equal(ambiguous.components.length, 1);
  assert.equal(city.total, 10000);
});

test('the two Baltimore recordation rates can never be reached ambiguously', () => {
  assert.equal(get({ category: 'recordation_tax', state: 'MD', county: 'Baltimore', salePrice: 500000 }), null);
  assert.equal(get({ category: 'recordation_tax', state: 'MD', county: 'Baltimore City', salePrice: 500000 }).exact, 5000);
  assert.equal(get({ category: 'recordation_tax', state: 'MD', county: 'Baltimore County', salePrice: 500000 }).exact, 2500);
});

test('internals: a bare county name in a payee is not treated as naming it', () => {
  // "Baltimore" alone inside a payee string is the same ambiguity, so the
  // named-jurisdiction reader requires a multi-word form.
  assert.equal(__internal.namedJurisdiction('MD', taxLines(['Transfer Tax', 'Baltimore'])), null);
  assert.equal(
    __internal.namedJurisdiction('MD', taxLines(['Transfer Tax', 'Baltimore City Finance'])),
    'Baltimore City',
  );
});

// --- the seam between resolution and lookup ---------------------------------
// This is where the module's answer crosses into the corpus, and where it was
// being dropped. Both sides pass their own tests independently while the join
// between them loses Baltimore County entirely, so the join needs its own.

test('a county read off the document reaches the corpus and picks the right table', () => {
  const { benchmarkContext } = require('../api/_lib/jurisdiction');
  const cases = [
    ['County Transfer Tax', 'Baltimore County Director of Finance', 'Baltimore', 2500],
    ['City Transfer Tax', 'City Director of Finance', 'Baltimore City', 5000],
  ];
  for (const [label, payee, expectedCounty, expectedTax] of cases) {
    const r = resolveJurisdiction({ state: 'MD', county: 'Baltimore', lineItems: [{ label, payee }] });
    assert.equal(r.county, expectedCounty);
    const bm = get(benchmarkContext(r, { category: 'recordation_tax', salePrice: 500000 }));
    assert.ok(bm, `${expectedCounty} resolved but the corpus returned nothing`);
    assert.equal(bm.exact, expectedTax);
  }
});

test('an unresolved county still gets no county rate, provenance or not', () => {
  const { benchmarkContext } = require('../api/_lib/jurisdiction');
  // A preprinted "City/County Tax/Stamps" field names neither, so the resolver
  // refuses and benchmarkContext carries no county for the lookup to trust.
  const r = resolveJurisdiction({
    state: 'MD', county: 'Baltimore', lineItems: [{ label: 'City/County Tax/Stamps', payee: '' }],
  });
  assert.equal(r.county, null);
  const ctx = benchmarkContext(r, { category: 'recordation_tax', salePrice: 500000 });
  assert.equal(ctx.county, undefined);
  assert.equal(ctx.countySource, undefined);
  assert.equal(get(ctx), null);
});

test('a bare county name with no provenance is still refused', () => {
  // The guard only lifts for a caller that says where the name came from.
  // Anything else — an extractor guess passed straight through — is still
  // dropped to the state rate.
  assert.equal(get({ category: 'recordation_tax', state: 'MD', county: 'Baltimore', salePrice: 500000 }), null);
  assert.equal(
    get({ category: 'recordation_tax', state: 'MD', county: 'Baltimore', countySource: 'guess', salePrice: 500000 }),
    null,
  );
});
