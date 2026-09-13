// The HOA tool schemas must satisfy what `strict: true` requires.
//
// hoa-engine.js relies on strict mode instead of a tag-leak regex and a retry
// loop: schema-invalid output is rejected server-side rather than detected here
// after the fact. That only holds if the schema itself is valid, and strict has
// two rules a hand-written schema breaks easily — every object needs
// `additionalProperties: false`, and every property must appear in `required`.
//
// A schema that violates either is rejected at request time, which on the paid
// path means a customer waiting through a failure that no amount of retrying
// fixes. Worth catching here rather than on somebody's $79 run.
//
// Written on 2026-09-13 after adding risk_signals and restrictions took the
// report tool from three sibling object-valued top-level fields to five. Six
// was the shape that correlated with the /buying tag leak, so the count is
// asserted too — not because five is a limit, but so that crossing six is a
// decision somebody makes on purpose.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { REPORT_TOOL } = require('../api/_lib/hoa-engine');

// Walks every object schema, including through array items.
function eachObjectSchema(node, pathStr, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'object') {
    visit(node, pathStr);
    for (const [key, child] of Object.entries(node.properties || {})) {
      eachObjectSchema(child, `${pathStr}.${key}`, visit);
    }
  }
  if (node.type === 'array' && node.items) {
    eachObjectSchema(node.items, `${pathStr}[]`, visit);
  }
}

test('the report tool is declared strict', () => {
  assert.equal(REPORT_TOOL.strict, true);
});

test('every object in the schema forbids additional properties', () => {
  const offenders = [];
  eachObjectSchema(REPORT_TOOL.input_schema, 'input', (schema, where) => {
    if (schema.additionalProperties !== false) offenders.push(where);
  });
  assert.deepEqual(offenders, [],
    'strict mode requires additionalProperties:false on every object, including array items');
});

test('every property is listed in its own required array', () => {
  const offenders = [];
  eachObjectSchema(REPORT_TOOL.input_schema, 'input', (schema, where) => {
    const props = Object.keys(schema.properties || {});
    const required = new Set(schema.required || []);
    for (const p of props) {
      if (!required.has(p)) offenders.push(`${where}.${p}`);
    }
  });
  assert.deepEqual(offenders, [],
    'strict mode requires every property to be required — use an empty string or empty array '
    + 'to mean "nothing here", never omit the field');
});

test('nothing is required that is not a declared property', () => {
  const offenders = [];
  eachObjectSchema(REPORT_TOOL.input_schema, 'input', (schema, where) => {
    const props = new Set(Object.keys(schema.properties || {}));
    for (const r of schema.required || []) {
      if (!props.has(r)) offenders.push(`${where}.${r}`);
    }
  });
  assert.deepEqual(offenders, []);
});

test('the new blocks are actually in the schema and required at the top level', () => {
  const top = REPORT_TOOL.input_schema;
  const required = new Set(top.required);
  for (const field of ['risk_signals', 'restrictions', 'risk_score', 'findings']) {
    assert.ok(top.properties[field], `${field} is missing from the schema`);
    assert.ok(required.has(field), `${field} is not required`);
  }
});

test('the restrictions block carries every part the page now promises', () => {
  const rx = REPORT_TOOL.input_schema.properties.restrictions.properties;
  for (const part of ['leasing', 'fees_at_closing', 'use_restrictions', 'financeability']) {
    assert.ok(rx[part], `restrictions.${part} is missing`);
  }
  const leasing = rx.leasing.properties;
  for (const field of ['restricted', 'cap', 'current_status', 'minimum_lease_term',
    'owner_occupancy_requirement', 'short_term_rentals']) {
    assert.ok(leasing[field], `restrictions.leasing.${field} is missing`);
  }
});

test('the risk signals the score reads are all present', () => {
  // scoreRisk() reads these by name. A rename here that is not made there
  // silently stops a rule from ever firing, and the score would still look
  // computed.
  const sig = REPORT_TOOL.input_schema.properties.risk_signals.properties;
  for (const field of ['special_assessment_announced', 'association_borrowing',
    'material_litigation', 'insurance_red_flag', 'delinquency_rate_pct',
    'largest_component_due_months', 'largest_component_cost', 'reserve_study_year',
    'unit_count']) {
    assert.ok(sig[field], `risk_signals.${field} is missing but scoreRisk reads it`);
  }
});

test('the count of sibling object-valued top-level fields is a deliberate number', () => {
  // Six sibling objects was the shape that correlated with the /buying tag
  // leak. This tool uses strict mode and has never leaked, so five is not a
  // problem — but crossing six should be somebody's decision rather than a
  // side effect of adding a field.
  const top = REPORT_TOOL.input_schema.properties;
  const objectFields = Object.entries(top)
    .filter(([, v]) => v && v.type === 'object')
    .map(([k]) => k);

  assert.deepEqual(objectFields.sort(), [
    'mid_term_risk', 'reserve_health', 'restrictions', 'risk_signals', 'short_term_risk',
  ], 'if this list changed, read the note in buying-whole-response-tag-leak before shipping it');
});
