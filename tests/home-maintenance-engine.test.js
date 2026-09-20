// The checks that make Home Maintenance Navigator a comparison rather than
// an opinion.
//
// docs/HOME-MAINTENANCE-AUDIT.md is the reason this engine exists: the
// product ran on a single model call told to weigh repair against
// replacement "using general knowledge of typical lifespans and typical
// cost ranges" — the exact phrase this codebase's own audits had already
// found and banned on Home Savings, Government Money, and Insurance. Every
// test below pins a known answer computed by hand.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../navigator-home-maintenance-engine');
const { Verdict } = E;

// --- safety always overrides cost, however lopsided the numbers ------------

test('a safety concern short-circuits straight to urgent guidance, even when repair is dramatically cheaper', () => {
  const r = E.analyze({
    category: 'HVAC', system_age_years: 5, symptoms: ['safety_concern', 'stopped_working'],
    repair_quote: 200, replacement_quote: 8000,
  });
  assert.equal(r.verdict, Verdict.URGENT_SAFETY);
  assert.equal(r.costComparison, null, 'cost must never be weighed once safety is flagged');
  assert.ok(r.cautions[0].includes('licensed professional'));
});

test('safety overrides even when no cost figures were given at all', () => {
  const r = E.analyze({ category: 'Water Heater', symptoms: ['safety_concern'], age_unknown: true });
  assert.equal(r.verdict, Verdict.URGENT_SAFETY);
});

// --- the disclosed 50% rule, on the customer's own numbers only ------------

test('a repair quote at or above 50% of replacement is a REPLACE verdict, with both figures cited', () => {
  // The FAQ's own placeholder example: a 14-year-old water heater, $1,400 to
  // repair vs $2,600 to replace.
  const r = E.analyze({
    category: 'Water Heater', system_age_years: 14, symptoms: ['leaking_or_damage'],
    repair_quote: 1400, replacement_quote: 2600,
  });
  assert.equal(r.verdict, Verdict.REPLACE);
  assert.match(r.reasons[0], /\$1,400/);
  assert.match(r.reasons[0], /\$2,600/);
  assert.equal(r.costComparison.ratio > 0.5, true);
});

test('a repair quote well under 50% of replacement is a REPAIR verdict', () => {
  const r = E.analyze({
    category: 'Roof', system_age_years: 3, symptoms: ['declining_performance'],
    repair_quote: 500, replacement_quote: 15000,
  });
  assert.equal(r.verdict, Verdict.REPAIR);
  assert.equal(r.cautions.length, 0, 'a young system repairing cheaply has nothing to caution about');
});

test('a cheap repair on a system already past its typical service life gets a caution, not a different verdict', () => {
  const r = E.analyze({
    category: 'Water Heater', system_age_years: 15, symptoms: ['declining_performance'],
    repair_quote: 300, replacement_quote: 2600,
  });
  assert.equal(r.verdict, Verdict.REPAIR, 'the cost math still says repair — the caution is additive, not a override');
  assert.ok(r.cautions.length, 'but the customer should be told this is likely a short-term fix');
});

test('the ratio threshold is exactly 50%, disclosed in the reason text', () => {
  const at = E.analyze({ category: 'Generator', symptoms: ['comparing_before_failure'], repair_quote: 500, replacement_quote: 1000 });
  assert.equal(at.verdict, Verdict.REPLACE, 'exactly 50% counts as at-or-above the threshold');
  assert.match(at.reasons[0], /50%/);
});

// --- missing quotes never get a financial verdict manufactured for them ----

test('only a repair quote: the verdict asks for the missing replacement quote, not a guess', () => {
  const r = E.analyze({ category: 'HVAC', symptoms: ['declining_performance'], repair_quote: 900 });
  assert.equal(r.verdict, Verdict.NEED_REPLACEMENT_QUOTE);
  assert.equal(r.costComparison, null);
});

test('only a replacement quote: the verdict asks for the missing repair quote', () => {
  const r = E.analyze({ category: 'HVAC', symptoms: ['declining_performance'], replacement_quote: 9000 });
  assert.equal(r.verdict, Verdict.NEED_REPAIR_QUOTE);
});

test('no quotes at all: the verdict says so plainly rather than estimating either figure', () => {
  const r = E.analyze({ category: 'Windows', system_age_years: 25, symptoms: ['comparing_before_failure'] });
  assert.equal(r.verdict, Verdict.NEED_BOTH_QUOTES);
  assert.equal(r.costComparison, null);
});

// --- the lifespan table is context, never a cost, and never for 'Other' ----

test('age context is given for a named category, with its own caveat', () => {
  const r = E.analyze({ category: 'Roof', system_age_years: 30, symptoms: ['comparing_before_failure'], repair_quote: 1, replacement_quote: 2 });
  assert.ok(r.ageContext);
  assert.equal(r.ageContext.pastTypicalRange, true);
  assert.ok(r.ageContext.range.caveat.length > 0, 'every lifespan statement must carry its own caveat');
});

test('"Other" carries no lifespan range — there is nothing to guess a number for', () => {
  const r = E.analyze({ category: 'Other', system_age_years: 10, symptoms: ['comparing_before_failure'] });
  assert.equal(r.ageContext, null);
});

test('unknown age produces no lifespan comparison, not a guessed one', () => {
  const r = E.analyze({ category: 'HVAC', age_unknown: true, symptoms: ['comparing_before_failure'] });
  assert.equal(r.ageContext.ageYears, null);
  assert.equal(r.ageContext.pastTypicalRange, null);
});

// --- sufficiency gate --------------------------------------------------

test('a completely empty submission is insufficient on every field', () => {
  const s = E.checkSufficiency({});
  assert.equal(s.sufficient, false);
  assert.deepEqual(s.missing.map((m) => m.key).sort(), ['category', 'quotes', 'symptoms', 'system_age_years']);
});

test('explicitly having no quotes yet is a valid, sufficient answer — not a block', () => {
  const s = E.checkSufficiency({
    category: 'Roof', age_unknown: true, symptoms: ['comparing_before_failure'], no_quotes_yet: true,
  });
  assert.equal(s.sufficient, true);
});

test('a single quote is enough to pass the gate, even though the verdict will ask for the other one', () => {
  const s = E.checkSufficiency({
    category: 'Roof', system_age_years: 10, symptoms: ['comparing_before_failure'], repair_quote: 500,
  });
  assert.equal(s.sufficient, true);
});
