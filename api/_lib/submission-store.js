// Single owner of the `form_data` blob on `navigator_submissions`.
//
// Why this exists: `form_data` is one shared jsonb column that four endpoints
// write to. Each used to build the object by hand, so an endpoint could discard
// state it did not know about. That happened three times in one day:
//
//   * closing-corrections rebuilt `scorecard` from scratch, throwing away tier,
//     tolerance results and the Loan Estimates — a customer correcting one
//     unreadable figure silently lost the analysis they paid extra for.
//   * `contract_terms` was read in three places and written in none.
//   * `loan_estimates` was read in the report engine and written nowhere, so
//     TRID tolerance testing never ran on a paying customer's documents.
//
// Every key is declared here with the endpoint that owns it. Writes are merges,
// never replacements. `tests/wiring.test.js` fails if an endpoint reads a key
// that is not declared, or if a declared key has no writer.

'use strict';

// owner: the file responsible for producing this key. Informational, and
// checked by the wiring test.
//
// Scoped to the closing product. The other Navigators write their own shapes
// into the same `form_data` column — contractor uses `description`, `category`
// and `zip` — and those keys do not belong here. `description` was declared
// with a closing owner that never mentions it, which the wiring test caught
// only in its third check; the "written somewhere" check passed because
// closing-extract.js has `description:` on every JSON-schema property.
const FORM_DATA_KEYS = {
  stage: 'api/closing-scorecard.js',
  ip_hash: 'api/closing-scorecard.js',
  extraction: 'api/closing-scorecard.js',
  scorecard: 'api/closing-scorecard.js',
  documents: 'api/closing-scorecard.js',
  tier: 'api/closing-scorecard.js',
  loan_estimates: 'api/closing-scorecard.js',
  contract_terms: 'api/closing-scorecard.js',
  wrong_document: 'api/closing-scorecard.js',
  answers: 'api/closing-answers.js',
  original_extraction: 'api/closing-corrections.js',
  customer_values: 'api/closing-corrections.js',
  regeneration_count: 'api/closing-corrections.js',
};

const KNOWN_KEYS = Object.keys(FORM_DATA_KEYS);

// Merges a patch over the existing blob. Anything not mentioned survives.
//
// Pass `null` deliberately to clear a key; `undefined` is treated as "leave
// alone", so a caller that forgets a field cannot erase it.
function mergeFormData(existing, patch) {
  const base = existing && typeof existing === 'object' ? existing : {};
  const out = { ...base };

  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    if (!KNOWN_KEYS.includes(k)) {
      // Loud rather than silent: an undeclared key is either a typo that will
      // never be read, or a new field that belongs in FORM_DATA_KEYS.
      console.warn(`[submission-store] writing undeclared form_data key "${k}" — add it to FORM_DATA_KEYS`);
    }
    out[k] = v;
  }
  return out;
}

// Merges over the previous scorecard rather than replacing it. buildScorecard()
// returns only document-level fields; the endpoints add tier, tolerance results
// and charge counts on top, and rebuilding from scratch discards those.
function mergeScorecard(previous, fresh, extras = {}) {
  return { ...(previous || {}), ...(fresh || {}), ...extras };
}

// Reads a key with a default, so callers stop writing `formData.x || null` in
// five places with slightly different defaults.
function read(formData, key, fallback = null) {
  if (!KNOWN_KEYS.includes(key)) {
    throw new Error(`[submission-store] unknown form_data key "${key}"`);
  }
  const v = (formData || {})[key];
  return v === undefined || v === null ? fallback : v;
}

module.exports = { FORM_DATA_KEYS, KNOWN_KEYS, mergeFormData, mergeScorecard, read };
