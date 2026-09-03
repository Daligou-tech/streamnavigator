// Maryland jurisdiction canonicalisation.
//
// Open issue #2: the same CD extracts as "Baltimore" on one run and
// "Baltimore City" on another. Those are two different taxing jurisdictions
// with different fee tables — Baltimore City recordation is $5.00 per $500,
// Baltimore County is $2.50 — so a coin-flip between them is a 2x error on a
// four-figure line. Temperature cannot fix this; a lookup table can.
//
// The design rule here is that a wrong county is much worse than no county.
// "Baltimore" on its own is genuinely ambiguous: Baltimore County has no town
// called Baltimore, but USPS assigns the mailing city "Baltimore, MD" to large
// parts of the county, so the mailing address does not settle it either.
// Rather than guess, this returns ambiguous and the benchmark lookup declines
// to answer. A visible gap is a bug report; a silent 2x error is a refund.
//
// Returns: { ok, county, ambiguous, reason, matchedVia }

'use strict';

// The 24 taxing jurisdictions: 23 counties plus Baltimore City, which is an
// independent city and not part of Baltimore County.
const CANONICAL = [
  'Allegany', "Anne Arundel", 'Baltimore City', 'Baltimore', 'Calvert',
  'Caroline', 'Carroll', 'Cecil', 'Charles', 'Dorchester', 'Frederick',
  'Garrett', 'Harford', 'Howard', 'Kent', 'Montgomery', "Prince George's",
  "Queen Anne's", "St. Mary's", 'Somerset', 'Talbot', 'Washington',
  'Wicomico', 'Worcester',
];

// Fold to a comparison key: lowercase, strip punctuation and possessives,
// collapse whitespace. "St. Mary's" / "St Marys" / "SAINT MARYS" all collapse
// to the same key. Deliberately does NOT strip "county" or "city" — those two
// words are the entire difference between two Baltimores.
function fold(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\bsaint\b/g, 'st')
    .replace(/[.,'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Drop a trailing "county" / "co" so "Harford County" matches "Harford".
// Applied only after the Baltimore ambiguity has been resolved.
function stripCountySuffix(key) {
  return key.replace(/\s+(county|co)$/, '').trim();
}

const BY_KEY = new Map();
for (const name of CANONICAL) BY_KEY.set(fold(name), name);
// "Baltimore" on its own must never resolve by exact match — it is the one
// canonical name that is also a genuine ambiguity. It is reachable only through
// the explicit "Baltimore County" alias or a city hint.
BY_KEY.delete('baltimore');

// Spellings that appear on real documents and in model output.
const ALIASES = {
  'pg': "Prince George's",
  'pg county': "Prince George's",
  'prince georges': "Prince George's",
  'prince george': "Prince George's",
  'queen annes': "Queen Anne's",
  'queen anne': "Queen Anne's",
  'st marys': "St. Mary's",
  'st mary': "St. Mary's",
  'anne arundel': 'Anne Arundel',
  'baltimore city': 'Baltimore City',
  'city of baltimore': 'Baltimore City',
  'baltimore county': 'Baltimore',
  'allegheny': 'Allegany', // common misspelling; the PA county is Allegheny
};

// Municipalities that unambiguously sit in exactly one county, for when the
// extractor puts a town in the county field. Deliberately short: every entry
// is a place whose county assignment is not in dispute. Baltimore is NOT here.
const MUNICIPALITY_TO_COUNTY = {
  'annapolis': 'Anne Arundel',
  'glen burnie': 'Anne Arundel',
  'severna park': 'Anne Arundel',
  'towson': 'Baltimore',
  'catonsville': 'Baltimore',
  'dundalk': 'Baltimore',
  'columbia': 'Howard',
  'ellicott city': 'Howard',
  'rockville': 'Montgomery',
  'bethesda': 'Montgomery',
  'silver spring': 'Montgomery',
  'gaithersburg': 'Montgomery',
  'germantown': 'Montgomery',
  'takoma park': 'Montgomery',
  'bowie': "Prince George's",
  'hyattsville': "Prince George's",
  'college park': "Prince George's",
  'laurel': "Prince George's",
  'upper marlboro': "Prince George's",
  'waldorf': 'Charles',
  'salisbury': 'Wicomico',
  'hagerstown': 'Washington',
  'cumberland': 'Allegany',
  'ocean city': 'Worcester',
  'westminster': 'Carroll',
  'bel air': 'Harford',
  'elkton': 'Cecil',
  'easton': 'Talbot',
  'chestertown': 'Kent',
  'leonardtown': "St. Mary's",
  'prince frederick': 'Calvert',
  'oakland': 'Garrett',
  'denton': 'Caroline',
  'cambridge': 'Dorchester',
  'princess anne': 'Somerset',
  'centreville': "Queen Anne's",
};

const AMBIGUOUS_BALTIMORE =
  'The name "Baltimore" alone does not identify a Maryland taxing jurisdiction. '
  + 'Baltimore City is an independent city with its own recordation and transfer '
  + 'tax rates, separate from Baltimore County. The extracted value must say '
  + 'which one.';

/**
 * Canonicalise a Maryland county / jurisdiction name.
 *
 * @param {string} input        value from the CD, e.g. "BALTIMORE CITY"
 * @param {object} [opts]
 * @param {string} [opts.city]  property address city, used only to break ties
 * @returns {{ok: boolean, county: string|null, ambiguous: boolean,
 *            reason: string|null, matchedVia: string|null}}
 */
function canonicalizeMdCounty(input, opts = {}) {
  const raw = fold(input);
  const fail = (reason, ambiguous = false) => ({
    ok: false, county: null, ambiguous, reason, matchedVia: null,
  });
  const hit = (county, matchedVia) => ({
    ok: true, county, ambiguous: false, reason: null, matchedVia,
  });

  if (!raw) return fail('No jurisdiction value was supplied.');

  // 1. Explicit alias, checked before the county suffix is stripped so that
  //    "Baltimore County" resolves and bare "Baltimore" does not.
  if (ALIASES[raw]) return hit(ALIASES[raw], 'alias');

  // 2. Exact canonical match ("Baltimore City", "Anne Arundel").
  if (BY_KEY.has(raw)) return hit(BY_KEY.get(raw), 'canonical');

  // 3. The Baltimore trap. Bare "Baltimore", "Baltimore MD", "Baltimore City
  //    County" and similar are refused unless the city field settles it.
  if (/^baltimore\b/.test(raw) && !ALIASES[raw]) {
    const cityKey = fold(opts.city);
    if (cityKey === 'baltimore city') return hit('Baltimore City', 'city-hint');
    if (MUNICIPALITY_TO_COUNTY[cityKey] === 'Baltimore') {
      return hit('Baltimore', 'city-hint');
    }
    return fail(AMBIGUOUS_BALTIMORE, true);
  }

  // 4. Strip a trailing "County"/"Co" and retry.
  const stripped = stripCountySuffix(raw);
  if (ALIASES[stripped]) return hit(ALIASES[stripped], 'alias');
  if (BY_KEY.has(stripped)) return hit(BY_KEY.get(stripped), 'canonical');

  // 5. Municipality in the county field.
  if (MUNICIPALITY_TO_COUNTY[stripped]) {
    return hit(MUNICIPALITY_TO_COUNTY[stripped], 'municipality');
  }

  return fail(`"${input}" is not a recognised Maryland jurisdiction.`);
}

const isMaryland = (state) => /^(md|maryland)$/.test(fold(state));

// Pull the city token out of a one-line property address so the Baltimore
// tie-breaker has something to read. There is no property_city field on the
// extraction; the address arrives as a single string like
// "1234 Main St, Towson, MD 21204". Takes the segment before the state/ZIP
// segment. Returns null rather than a guess when the shape is unfamiliar.
function cityFromAddress(address) {
  const parts = String(address || '').split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  // Trailing segment is normally "MD 21204" or "MD". If it is not a state+ZIP
  // tail, the format is not one we understand and we decline.
  if (!/^[A-Za-z]{2}(\s+\d{5}(-\d{4})?)?$/.test(last)) return null;
  return parts[parts.length - 2] || null;
}

module.exports = {
  CANONICAL_MD_JURISDICTIONS: CANONICAL,
  canonicalizeMdCounty,
  cityFromAddress,
  isMaryland,
  _fold: fold,
};
