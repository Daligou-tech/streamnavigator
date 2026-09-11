// How much room the write-up gets.
//
// The ceiling was a flat 8000, and the comment beside it already conceded that
// a closing audit with twenty findings and two drafted emails "runs close to
// that ceiling". Landlord Navigator made the concession concrete: twelve
// properties — the most the intake accepts, and precisely the customer a flat
// $149 suits best — produce 73 deterministic findings. There is no honest way
// to write those up in 8000 tokens, so the report truncates; truncation throws;
// and the throw exited the retry loop, so the largest-paying portfolio was the
// one certain to fail, on the first attempt, every time.
//
// Found by arithmetic rather than by a customer, which is the only reason it
// costs nothing.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  __internal: { maxTokensForWork, BASE_MAX_TOKENS, HARD_MAX_TOKENS },
} = require('../api/_lib/navigator-engine');
const { runLandlordAudit } = require('../api/_lib/landlord-audit');

// What a finding costs to write up properly: what it is, why, and what to do.
// Deliberately conservative — if the real figure is higher, this test should
// fail before a customer's report does.
const TOKENS_A_FINDING_NEEDS = 120;

function landlordBlock(propertyCount) {
  const cities = [['Seattle', 'WA'], ['Minneapolis', 'MN'], ['Philadelphia', 'PA'],
    ['Baltimore', 'MD'], ['Boston', 'MA'], ['Washington', 'DC'], ['New York', 'NY'],
    ['Los Angeles', 'CA'], ['Denver', 'CO'], ['Kansas City', 'MO'], ['Detroit', 'MI'],
    ['Chicago', 'IL']];
  const properties = cities.slice(0, propertyCount).map(([city, state], i) => ({
    label: `Unit ${i + 1}`, city, state,
    year_built: i % 2 ? 1958 : 1994,
    units: 2, registered: 'no',
    child_under_six: i % 3 === 0 ? 'yes' : 'no',
    lead_disclosure_on_file: 'no', deposit_held: 'commingled',
    lease_ends: '2026-12-15', registration_expires: '2026-10-10',
  }));
  const audited = runLandlordAudit({ properties, asOf: '2026-09-10' });
  return { findings: audited.findings.length, block: JSON.stringify(audited.findings, null, 1) };
}

test('the largest portfolio the intake accepts has room to be written up', () => {
  const { findings, block } = landlordBlock(12);
  assert.ok(findings > 60, `only ${findings} findings on a twelve-property portfolio — the fixture drifted`);

  const ceiling = maxTokensForWork(block);
  const needed = findings * TOKENS_A_FINDING_NEEDS;

  assert.ok(ceiling >= needed,
    `${findings} findings need about ${needed} output tokens and the ceiling is ${ceiling}. `
    + 'This is the defect the file header describes: the report truncates, the truncation '
    + 'throws, and the biggest-paying customer is the one who never gets a report.');

  // And the old flat ceiling really would have failed, so this test is testing
  // something rather than restating a passing condition.
  assert.ok(BASE_MAX_TOKENS < needed,
    'the flat ceiling now covers this portfolio, so this test no longer proves anything — '
    + 'raise the fixture or delete it');
});

test('every portfolio size from one property upward has headroom', () => {
  const short = [];
  for (const n of [1, 2, 4, 6, 8, 10, 12]) {
    const { findings, block } = landlordBlock(n);
    const ceiling = maxTokensForWork(block);
    const needed = findings * TOKENS_A_FINDING_NEEDS;
    if (ceiling < needed) short.push(`${n} properties: ${findings} findings need ~${needed}, ceiling ${ceiling}`);
  }
  assert.deepEqual(short, [], short.join('\n  '));
});

test('a product with no deterministic half keeps exactly what it had', () => {
  // property-tax, home-savings, subscriptions and the rest pass an empty audit
  // block. Nothing about this change should move them.
  assert.equal(maxTokensForWork(''), BASE_MAX_TOKENS);
  assert.equal(maxTokensForWork(null), BASE_MAX_TOKENS);
  assert.equal(maxTokensForWork(undefined), BASE_MAX_TOKENS);
});

test('the ceiling is bounded', () => {
  const absurd = Array(5000).fill('"checkId"').join(',');
  assert.equal(maxTokensForWork(absurd), HARD_MAX_TOKENS,
    'an unbounded ceiling turns one malformed submission into an unbounded bill');
});

test('the ceiling rises with the work, and never falls below the old flat one', () => {
  const small = maxTokensForWork(landlordBlock(1).block);
  const large = maxTokensForWork(landlordBlock(12).block);
  assert.ok(large > small, 'a twelve-property portfolio must get more room than a one-property one');
  assert.ok(small >= BASE_MAX_TOKENS, 'nothing that fits today may get less room than it has now');
});

// --- the retry ---------------------------------------------------------------

test('a truncated report retries with more room instead of giving up', () => {
  // The throw was correct about not shipping a truncated report and wrong about
  // everything else: `throw` exits the retry loop, so MAX_ATTEMPTS was 2 and a
  // truncation got 1. Retrying at the same ceiling would truncate identically,
  // so the retry has to raise it.
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', '_lib', 'navigator-engine.js'), 'utf8');
  const guard = src.slice(src.indexOf("stop_reason === 'max_tokens'"));
  const body = guard.slice(0, guard.indexOf('\n      }') + 8);

  assert.equal(/throw /.test(body), false,
    'a bare throw here exits the retry loop — the first truncation becomes fatal');
  assert.ok(/maxTokens\s*=/.test(body),
    'the retry must raise the ceiling; retrying at the same one truncates identically');
  assert.ok(/continue/.test(body), 'and it has to actually reach the next attempt');
  assert.ok(/lastError\s*=/.test(body),
    'the cause has to survive to the final throw, or a truncated report reports as something else');
});

test('the request sends the computed ceiling, not a literal', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', '_lib', 'navigator-engine.js'), 'utf8');
  const call = src.slice(src.indexOf('https://api.anthropic.com/v1/messages'));
  const field = call.slice(call.indexOf('max_tokens:'), call.indexOf('max_tokens:') + 40);
  assert.equal(/max_tokens:\s*\d/.test(field), false,
    `max_tokens is hard-coded again (${field.split('\n')[0].trim()}) — it has to scale with the findings`);
});
