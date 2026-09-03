// Jurisdiction identity — which tax table applies to this property.
//
// A Closing Disclosure states the property ADDRESS. It does not state the
// county. So `property_county` coming back from extraction is not a
// transcription, it is the model's inference from a postal address, and the
// model is entitled to change its mind between two runs of the same document.
// That is the whole of the "Baltimore vs Baltimore City" non-determinism: not
// sampling variance, but a question the document does not answer being asked
// of something that will always answer.
//
// This module does three things, in decreasing order of confidence:
//
//   1. Canonicalises. "Maryland" -> "MD", "PRINCE GEORGES CO." -> "Prince
//      George's". A near-miss here is a silent total loss of coverage, because
//      a county row only matches on an exact normalised name.
//   2. Reads the jurisdiction off the document where the document names it.
//      Maryland transfer tax lines are paid to a named authority — "Circuit
//      Court for Baltimore City", "Howard County Director of Finance" — and
//      that IS a transcription.
//   3. Refuses. Where the name is ambiguous and the document offers no
//      evidence, this returns no county and says why, so the audit quotes the
//      state rate or nothing rather than picking a table by coin flip.
//
// Postal addresses cannot substitute for step 2. USPS assigns addresses by
// delivery route, not by government boundary: thousands of Baltimore COUNTY
// properties have a "Baltimore, MD" mailing address, and 13 of Baltimore
// City's ZIP codes extend into adjacent counties. A ZIP-based tiebreak would
// be wrong for exactly the properties nearest the line.

'use strict';

// ---------------------------------------------------------------------------
// states
// ---------------------------------------------------------------------------

const STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO',
  'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
  'PR', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'VI', 'WA', 'WV', 'WI',
  'WY',
]);

const STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
  'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'puerto rico': 'PR', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX',
  utah: 'UT', vermont: 'VT', virginia: 'VA', 'virgin islands': 'VI',
  washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

function canonicaliseState(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const upper = s.toUpperCase().replace(/[^A-Z ]/g, '');
  if (upper.length === 2 && STATE_CODES.has(upper)) return upper;
  const named = STATE_NAMES[s.toLowerCase().replace(/\s+/g, ' ').trim()];
  return named || null;
}

// ---------------------------------------------------------------------------
// counties
// ---------------------------------------------------------------------------

// Lowercase, strip punctuation and the County/Parish/City-and-Borough suffix
// words, collapse whitespace. "Prince George's Co." and "PRINCE GEORGES
// COUNTY" both land on "prince georges".
function normaliseCountyToken(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[.,'’`]/g, '')
    .replace(/\b(co|cnty|cty)\b/g, 'county')
    .replace(/\s+(county|parish|borough|census area|municipality)\b/g, '')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Same cleanup, but keeps the County/City suffix. For most jurisdictions the
// suffix is noise; for "Baltimore County" against "Baltimore City" it is the
// only thing that distinguishes two different tax schedules.
function withSuffix(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[.,'’`]/g, '')
    .replace(/\b(co|cnty|cty)\b/g, 'county')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Maryland's 23 counties plus Baltimore City, which is an independent city and
// not part of Baltimore County. These are the only jurisdictions the corpus
// carries county-level rows for; every other state's rows are state-level, so
// only the token normalisation above matters there.
const MD_JURISDICTIONS = [
  'Allegany', 'Anne Arundel', 'Baltimore', 'Baltimore City', 'Calvert',
  'Caroline', 'Carroll', 'Cecil', 'Charles', 'Dorchester', 'Frederick',
  'Garrett', 'Harford', 'Howard', 'Kent', 'Montgomery', "Prince George's",
  "Queen Anne's", "St. Mary's", 'Somerset', 'Talbot', 'Washington', 'Wicomico',
  'Worcester',
];

const MD_ALIASES = {
  'baltimore city': 'Baltimore City',
  'city of baltimore': 'Baltimore City',
  'baltimore county': 'Baltimore',
  'prince georges': "Prince George's",
  'prince george': "Prince George's",
  'queen annes': "Queen Anne's",
  'queen anne': "Queen Anne's",
  'st marys': "St. Mary's",
  'saint marys': "St. Mary's",
  'st mary': "St. Mary's",
  'saint mary': "St. Mary's",
};

// A token that names more than one real jurisdiction in the state, so it must
// never be resolved to either without document evidence.
//
// "Baltimore" is the whole problem. It is the correct, complete name of
// Baltimore County AND the everyday name of Baltimore City, and the two levy
// recordation tax at $5.00 and $2.50 per $500 — a $2,500 difference on a
// $500,000 sale. An extractor that returns the bare word has told us nothing.
const AMBIGUOUS_TOKENS = {
  MD: {
    baltimore: {
      candidates: ['Baltimore City', 'Baltimore'],
      reason: 'In Maryland, "Baltimore" names both Baltimore City and Baltimore County. '
        + 'They are separate jurisdictions with different recordation tax rates, and a '
        + '"Baltimore, MD" mailing address is used by properties in both.',
    },
  },
};

const MD_BY_TOKEN = new Map(MD_JURISDICTIONS.map((n) => [normaliseCountyToken(n), n]));

const REGISTRIES = { MD: { byToken: MD_BY_TOKEN, aliases: MD_ALIASES } };

// Resolve a raw county string to a canonical jurisdiction name, or explain why
// it cannot be resolved. Never guesses between candidates.
function canonicaliseCounty(state, raw) {
  const token = normaliseCountyToken(raw);
  if (!token) return { county: null, ambiguous: false, reason: 'no county was stated' };

  const st = canonicaliseState(state);
  const registryEarly = st && REGISTRIES[st];

  // Aliases are matched BEFORE the County/City suffix is stripped, because for
  // the Baltimore pair the suffix is the entire distinction: "Baltimore
  // County" is explicit and unambiguous, and normalising it down to
  // "baltimore" would throw away the one word that resolves it.
  if (registryEarly) {
    const explicit = registryEarly.aliases[withSuffix(raw)];
    if (explicit) return { county: explicit, ambiguous: false };
  }

  const ambiguous = st && AMBIGUOUS_TOKENS[st] && AMBIGUOUS_TOKENS[st][token];
  if (ambiguous) {
    return {
      county: null,
      ambiguous: true,
      candidates: ambiguous.candidates.slice(),
      reason: ambiguous.reason,
    };
  }

  const registry = st && REGISTRIES[st];
  if (registry) {
    const viaAlias = registry.aliases[token];
    if (viaAlias) return { county: viaAlias, ambiguous: false };
    const exact = registry.byToken.get(token);
    if (exact) return { county: exact, ambiguous: false };
    return {
      county: null,
      ambiguous: false,
      reason: `"${String(raw).trim()}" is not a ${st} jurisdiction`,
    };
  }

  // No registry for this state: pass the normalised token through with its
  // original casing preserved, so lookups still work for state-level rows.
  return { county: String(raw).trim(), ambiguous: false };
}

// ---------------------------------------------------------------------------
// reading the jurisdiction off the document
// ---------------------------------------------------------------------------

// Only tax, stamp and recording lines are considered. These are paid to the
// recording authority, so the authority named on them IS the jurisdiction. A
// title company's own name on a settlement fee tells us where the company is,
// not where the property is.
const RECORDING_LINE = /\b(tax|taxes|stamp|stamps|recordation|recording)\b/i;

function evidenceStrings(lineItems) {
  return (lineItems || [])
    .filter((li) => RECORDING_LINE.test(`${li.label || ''} ${li.payee || ''}`))
    .map((li) => `${li.label || ''} | ${li.payee || ''}`);
}

// A canonical jurisdiction named verbatim on a recording line.
function namedJurisdiction(state, lineItems) {
  const st = canonicaliseState(state);
  const registry = st && REGISTRIES[st];
  if (!registry) return null;

  const hits = new Set();
  for (const text of evidenceStrings(lineItems)) {
    const token = ` ${normaliseCountyToken(text.replace(/\|/g, ' '))} `;
    for (const [name] of registry.byToken) {
      // Require the multi-word or explicitly suffixed forms. A bare
      // "baltimore" inside a payee string is the same ambiguity again, and
      // "Frederick" alone could be a person's name on a settlement line.
      if (name.includes(' ') && token.includes(` ${name} `)) hits.add(registry.byToken.get(name));
    }
    for (const [alias, canonical] of Object.entries(registry.aliases)) {
      if (alias.includes(' ') && token.includes(` ${alias} `)) hits.add(canonical);
    }
  }
  if (hits.size === 1) return [...hits][0];
  return null; // nothing named, or two jurisdictions named — neither is evidence
}

// The Baltimore pair only. Maryland settlement statements label the local
// transfer tax by the level that levies it: "City Transfer Tax to City
// Director of Finance" against "County Transfer Tax". A line carrying BOTH
// words — "City/County Tax/Stamps" — is a preprinted form field and is
// evidence of nothing.
function baltimoreLevelMarker(lineItems) {
  let city = false;
  let county = false;
  for (const text of evidenceStrings(lineItems)) {
    const hasCity = /\bcity\b/i.test(text);
    const hasCounty = /\bcounty\b/i.test(text);
    if (hasCity && !hasCounty) city = true;
    if (hasCounty && !hasCity) county = true;
  }
  if (city && !county) return 'Baltimore City';
  if (county && !city) return 'Baltimore';
  return null;
}

/**
 * Resolve the jurisdiction whose tax tables apply, from everything the
 * document offers. Returns a canonical state and county, the evidence class
 * the county rests on, and — when it cannot be resolved — a reason written for
 * the customer rather than the log.
 */
function resolveJurisdiction({ state, county, lineItems } = {}) {
  const st = canonicaliseState(state);
  if (!st) {
    return {
      state: null,
      county: null,
      source: 'none',
      reason: 'the property state could not be read from the document',
    };
  }

  const stated = canonicaliseCounty(st, county);
  const named = namedJurisdiction(st, lineItems);

  // Strongest: the document names a jurisdiction on a line paid to it.
  if (named) {
    if (stated.county && stated.county !== named) {
      // The extractor's inference contradicts what the document says it paid.
      // Trusting either would be a coin flip with a paper trail against it.
      return {
        state: st,
        county: null,
        source: 'conflict',
        candidates: [named, stated.county],
        reason: `the settlement charges name ${named}, but the property was read as `
          + `${stated.county}. These have different tax schedules, so no rate is quoted.`,
      };
    }
    return { state: st, county: named, source: stated.county ? 'named_and_agreed' : 'named' };
  }

  if (stated.ambiguous) {
    const marker = st === 'MD' ? baltimoreLevelMarker(lineItems) : null;
    if (marker && stated.candidates.includes(marker)) {
      return { state: st, county: marker, source: 'level_marker' };
    }
    return {
      state: st,
      county: null,
      source: 'ambiguous',
      candidates: stated.candidates,
      reason: `${stated.reason} Nothing on this Closing Disclosure identifies which. `
        + 'Confirm the recording jurisdiction with your settlement agent before relying '
        + 'on any tax figure.',
    };
  }

  if (stated.county) return { state: st, county: stated.county, source: 'stated' };
  return { state: st, county: null, source: 'none', reason: stated.reason };
}

/**
 * Turn a resolveJurisdiction() result into a benchmark lookup context.
 *
 * The benchmark corpus re-checks any county name it is handed, because most of
 * them arrive as the extractor's inference from a postal address. This carries
 * the resolution's provenance across that boundary so an answer that was read
 * off the document is not re-litigated and thrown away. Build the context with
 * this rather than by hand: `{ state, county }` alone silently loses Baltimore
 * County.
 */
function benchmarkContext(resolution, extras = {}) {
  const r = resolution || {};
  const ctx = { ...extras, state: r.state || null };
  if (r.county) {
    ctx.county = r.county;
    ctx.countySource = r.source;
  }
  return ctx;
}

module.exports = {
  canonicaliseState,
  canonicaliseCounty,
  normaliseCountyToken,
  resolveJurisdiction,
  benchmarkContext,
  MD_JURISDICTIONS,
  __internal: { namedJurisdiction, baltimoreLevelMarker },
};
