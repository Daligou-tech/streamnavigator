#!/usr/bin/env node
// Offline decision harness for Home Maintenance Navigator.
//
// Unlike scripts/insurance-audit-harness.js, this product needs no model call
// to reach a verdict at all — navigator-home-maintenance-engine.js's
// analyze() is pure arithmetic on structured form fields, so there is no
// extraction step to verify and no --compare mode to build. This script
// exists for the same reason scripts/audit-harness.js does: a fast, readable
// look at what the engine actually decides across a set of scenarios,
// without reading test assertions one by one.
//
// What it catches:      a verdict, a cost figure, or a caution that changes
//                       unexpectedly across the named scenarios.
// What it cannot catch: whether the WRITE-UP model, given the computed
//                       verdict as data during a real paid generation,
//                       presents it without inventing a figure or softening
//                       a safety verdict. That needs a live model call — see
//                       docs/HOME-MAINTENANCE-AUDIT.md, "What Remains
//                       Unverifiable."
//
// Usage:
//   node scripts/home-maintenance-audit-harness.js
//   node scripts/home-maintenance-audit-harness.js --json

'use strict';

const E = require('../navigator-home-maintenance-engine');

const asJson = process.argv.includes('--json');

const SCENARIOS = [
  {
    name: 'safety concern overrides a dramatically cheap repair',
    formData: {
      category: 'HVAC', system_age_years: 5, symptoms: ['safety_concern', 'stopped_working'],
      repair_quote: 200, replacement_quote: 8000,
    },
  },
  {
    name: "the FAQ's own example — 14yo water heater, $1,400 vs $2,600",
    formData: {
      category: 'Water Heater', system_age_years: 14, symptoms: ['leaking_or_damage'],
      repair_quote: 1400, replacement_quote: 2600,
    },
  },
  {
    name: 'cheap repair, young roof — no caution needed',
    formData: {
      category: 'Roof', system_age_years: 3, symptoms: ['declining_performance'],
      repair_quote: 500, replacement_quote: 15000,
    },
  },
  {
    name: 'cheap repair, but the system is already past its typical range',
    formData: {
      category: 'Water Heater', system_age_years: 15, symptoms: ['declining_performance'],
      repair_quote: 300, replacement_quote: 2600,
    },
  },
  {
    name: 'only a repair quote given — no verdict manufactured',
    formData: { category: 'HVAC', age_unknown: true, symptoms: ['declining_performance'], repair_quote: 900 },
  },
  {
    name: 'no quotes at all, age unknown — honestly scoped, not blocked',
    formData: { category: 'Windows', age_unknown: true, symptoms: ['comparing_before_failure'], no_quotes_yet: true },
  },
  {
    name: "'Other' category — no lifespan range exists to guess at",
    formData: { category: 'Other', system_age_years: 10, symptoms: ['comparing_before_failure'], repair_quote: 1, replacement_quote: 2 },
  },
];

function printOne(name, formData) {
  const sufficiency = E.checkSufficiency(formData);
  const bar = '='.repeat(72);
  console.log(`\n${bar}\n${name}\n${bar}`);
  console.log(`  sufficient: ${sufficiency.sufficient}${sufficiency.missing.length ? ` (missing: ${sufficiency.missing.map((m) => m.key).join(', ')})` : ''}`);
  if (!sufficiency.sufficient) return;

  const r = E.analyze(formData);
  console.log(`  verdict: ${r.verdict}`);
  r.reasons.forEach((x) => console.log(`  reason:  ${x}`));
  if (r.costComparison) {
    console.log(`  cost:    repair $${r.costComparison.repairQuote} / replace $${r.costComparison.replacementQuote} `
      + `(${Math.round(r.costComparison.ratio * 100)}%, threshold ${Math.round(r.costComparison.threshold * 100)}%)`);
  }
  if (r.ageContext) {
    console.log(`  age:     ${r.ageContext.ageYears ?? 'unknown'} yrs vs typical `
      + `${r.ageContext.range.low}-${r.ageContext.range.high} (past range: ${r.ageContext.pastTypicalRange})`);
  } else {
    console.log('  age:     no lifespan range for this category');
  }
  r.cautions.forEach((c) => console.log(`  CAUTION: ${c}`));
}

if (asJson) {
  console.log(JSON.stringify(SCENARIOS.map((s) => ({
    name: s.name,
    sufficiency: E.checkSufficiency(s.formData),
    result: E.checkSufficiency(s.formData).sufficient ? E.analyze(s.formData) : null,
  })), null, 2));
} else {
  SCENARIOS.forEach((s) => printOne(s.name, s.formData));
  console.log(`\n${'='.repeat(72)}\n${SCENARIOS.length} scenarios run.`);
}
