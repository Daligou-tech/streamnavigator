// Reading dollar figures out of prose, and deciding whether two of them agree.
//
// This exists because the same parser was written twice and was wrong five
// times. docs/REPORT-CONSISTENCY-AUDIT.md lists the five: it read the `7` out
// of "Total over 7 years - $50,100" as money; it read `-$11,000` as positive,
// the minus sitting before the `$`; it read the hyphen in `$49,500-$64,500` as
// a minus sign; it treated a prose sentence containing an em-dash as a line
// item; and it lacked the field-level exemption the engine has, so it flagged
// the customer's own quoted price. Two of those were the same mistakes the
// engine had made earlier the same day, in its own copy of this logic.
//
// A checker is not exempt from the thing it is checking for. So there is now
// one home for it, and every product's consistency check reads from here.
//
// The default behaviour is deliberately identical to the copy that lived in
// purchase-engine.js, which these functions were lifted from: a figure must
// carry a `$`, and a leading minus is NOT read. Signed parsing is opt-in
// (`parseMoneyRange(text, { signed: true })`) because the products that need it
// are the ones whose documents carry credits and deficits -- a Closing
// Disclosure's seller credit, an HOA's operating shortfall -- and reading
// "-$11,000" as +11,000 there is not a rounding error, it is the wrong sign on
// the customer's money.

'use strict';

// $12,000 or $12,000-$15,000 or $12,000 - $15,000. The inner hyphen is a range
// separator, never a minus: a minus inside a figure that already opened with
// `$` cannot be anything else.
const MONEY_RE = /\$\s?\d+(?:,\d{3})*(?:\.\d+)?(?:\s*(?:[–—-]|to)\s*\$?\s?\d+(?:,\d{3})*(?:\.\d+)?)?/g;

// The same figure with an optional sign in front of the dollar mark, and the
// parenthesised accounting form real documents use.
//
// The sign must be TIGHT against the `$`, and an em- or en-dash is never a
// sign. Both rules are the audit's fourth bug, and it reappeared the first time
// this module was exercised: "Total over 7 years - $50,100" written with an
// em-dash has a dash introducing a clause, and reading it as a minus turns a
// report's headline figure into its own negation. A minus that means minus is
// written `-$11,000` or `($11,000)`. A dash with a space after it is
// punctuation.
const SIGNED_MONEY_RE = new RegExp(
  String.raw`(?:\((?=\s*\$)|[-−](?=\$))?` + MONEY_RE.source + String.raw`\)?`,
  'g'
);

// Requiring the `$` is what keeps "over 7 years" out of the money stream. Bare
// integers in prose are years, day counts, unit counts and page numbers far
// more often than they are dollars, and the one time a report writes a dollar
// amount without its sign is not worth reading all of them wrong.
function moneyMatches(text, { signed = false } = {}) {
  const re = signed ? SIGNED_MONEY_RE : MONEY_RE;
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    if (!m[0].includes('$')) continue;
    out.push({ raw: m[0], index: m.index });
  }
  return out;
}

// Returns { low, high } in dollars, or null. Both ends carry the same sign:
// "-$15,000 to -$11,000" is a range of credits, and its low end is the more
// negative one.
function parseMoneyRange(text, { signed = false } = {}) {
  const raw = String(text);
  const numbers = raw.replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
  if (!numbers || !numbers.length) return null;
  let values = numbers.map(Number).filter((n) => Number.isFinite(n));
  if (!values.length) return null;

  if (signed) {
    // A minus immediately before the `$`, or the whole figure parenthesised.
    // The hyphen BETWEEN two figures is never consulted -- that is the range
    // separator, and reading it as a minus is the audit's third bug.
    const head = raw.slice(0, raw.indexOf('$'));
    const negative = /[-−]$/.test(head) || (/^\s*\(/.test(raw) && /\)\s*$/.test(raw));
    if (negative) values = values.map((n) => -n);
  }

  return { low: Math.min(...values), high: Math.max(...values) };
}

// Three percent, with a small absolute floor so figures of a few dollars do not
// trip it. The floor has been wrong twice in the same direction: it started at
// $200, which is rounding noise on a $49,000 car and the entire quantity on a
// $155/yr running cost, then $25, which still accepted $40-$60 as matching
// $100. Five dollars is enough for what the floor is actually for.
function withinProseTolerance(actual, expected) {
  return Math.abs(actual - expected) <= Math.max(Math.abs(expected) * 0.03, 5);
}

// Prose quotes a range two ways and they need judging differently. A range
// ("$51,000-$65,000") is compared end to end. A single figure ("around
// $2,900") is a summary OF the range, so it is right if it lands inside it --
// requiring it to match both ends at once made a perfectly honest headline
// fail, which is how this function came to exist.
function proseFigureMatches(stated, target) {
  if (!stated || !target) return false;
  if (stated.low !== stated.high) {
    return withinProseTolerance(stated.low, target.low) && withinProseTolerance(stated.high, target.high);
  }
  if (stated.low >= target.low && stated.low <= target.high) return true;
  return withinProseTolerance(stated.low, target.low) || withinProseTolerance(stated.low, target.high);
}

// Every dollar figure in a block of prose, parsed. The fifth bug was not in the
// parsing at all: the checker had no way to say "this field is allowed to
// contain this figure", so it flagged the customer's own quoted price as an
// invention. Callers get the figures and decide; this function never judges.
function figuresIn(text, { signed = false } = {}) {
  return moneyMatches(text, { signed })
    .map((m) => ({ raw: m.raw, index: m.index, value: parseMoneyRange(m.raw, { signed }) }))
    .filter((f) => f.value);
}

// True when `stated` is any of the figures this report is allowed to contain.
// The set is the caller's -- one source of truth per quantity means the caller
// computed them.
function matchesAnyKnown(stated, known) {
  return known.some((k) => proseFigureMatches(stated, k));
}

// Wraps a bare dollar amount into { low, high } so a computed scalar and a
// parsed range compare through the same path.
const point = (n) => (Number.isFinite(Number(n)) && n !== null && n !== ''
  ? { low: Number(n), high: Number(n) }
  : null);

module.exports = {
  MONEY_RE, SIGNED_MONEY_RE,
  moneyMatches, parseMoneyRange, figuresIn,
  withinProseTolerance, proseFigureMatches, matchesAnyKnown, point,
};
