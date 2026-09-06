// Structural checks on the extraction tool schemas.
//
// The rule this file exists to enforce: IF AN OBJECT CARRIES A CONFIDENCE
// SCORE, THAT SCORE MUST BE REQUIRED.
//
// The audit gates almost every check on confident(x), and confident() is
//
//     o && typeof o.confidence === 'number' && o.confidence >= 0.85
//
// which is false when confidence is ABSENT, not merely low. A confidence field
// that the schema leaves optional is therefore a silent off switch: the model
// omits it on some runs, a perfectly good reading is discarded, and the check
// never runs.
//
// That happened. `prepaid_interest` had no `required` array. On a one-document
// upload the model returned confidence 0.97 and a $320 prepaid-interest
// overcharge was caught; on a three-document upload of the SAME Closing
// Disclosure it returned {days:22, amount:1175.24, per_diem:53.42} with no
// confidence at all, and the overcharge went unreported. The customer who
// uploaded more documents got a worse audit, and nothing on the page said so.
//
// A test that ran the audit over a fixture would not have caught this: the
// fixtures all carry confidence, because they were written by hand. The defect
// lives in the schema's contract with the model, so that is what is checked.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EXTRACTION_TOOL,
  LE_EXTRACTION_TOOL,
  CONTRACT_TOOL,
} = require('../api/_lib/closing-extract');

// Walks every object node in a JSON schema, reporting a dotted path for each.
function walk(node, path, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'object' && node.properties) {
    visit(node, path);
    for (const [key, child] of Object.entries(node.properties)) {
      walk(child, path ? `${path}.${key}` : key, visit);
    }
  }
  if (node.type === 'array' && node.items) {
    walk(node.items, `${path}[]`, visit);
  }
}

const TOOLS = [
  ['EXTRACTION_TOOL', EXTRACTION_TOOL],
  ['LE_EXTRACTION_TOOL', LE_EXTRACTION_TOOL],
  ['CONTRACT_TOOL', CONTRACT_TOOL],
];

for (const [name, tool] of TOOLS) {
  test(`${name}: every confidence score is required`, () => {
    const schema = tool.input_schema || tool.inputSchema || tool.parameters;
    assert.ok(schema, `${name} has no input schema`);

    const offenders = [];
    walk(schema, '', (node, path) => {
      const hasConfidence = Object.prototype.hasOwnProperty.call(node.properties, 'confidence');
      if (!hasConfidence) return;
      const required = Array.isArray(node.required) ? node.required : [];
      if (required.indexOf('confidence') === -1) {
        offenders.push(path || '(root)');
      }
    });

    assert.deepEqual(offenders, [],
      `these objects carry a confidence score the model may omit, which silently `
      + `disables the checks that depend on them: ${offenders.join(', ')}`);
  });

  test(`${name}: an object that requires confidence also requires its value`, () => {
    // A confidence score attached to nothing is not a reading. Whatever the
    // object's payload field is called, requiring confidence without it lets
    // the model return a bare score.
    const schema = tool.input_schema || tool.inputSchema || tool.parameters;
    const PAYLOAD_KEYS = ['value', 'amount', 'annual_amount', 'charged_amount'];
    const offenders = [];
    walk(schema, '', (node, path) => {
      const required = Array.isArray(node.required) ? node.required : [];
      if (required.indexOf('confidence') === -1) return;
      const payload = PAYLOAD_KEYS.filter((k) =>
        Object.prototype.hasOwnProperty.call(node.properties, k));
      if (payload.length && !payload.some((k) => required.indexOf(k) !== -1)) {
        offenders.push(`${path || '(root)'} (has ${payload.join('/')}, requires neither)`);
      }
    });
    assert.deepEqual(offenders, []);
  });
}

test('the specific field that shipped broken is now pinned', () => {
  const props = EXTRACTION_TOOL.input_schema.properties;
  const pi = props.prepaid_interest;
  assert.ok(pi, 'prepaid_interest is missing from the extraction schema');
  assert.ok(Array.isArray(pi.required), 'prepaid_interest has no required array');
  assert.ok(pi.required.includes('confidence'));
  assert.ok(pi.required.includes('amount'));
});
