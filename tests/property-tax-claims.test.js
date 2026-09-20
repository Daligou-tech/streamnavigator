// docs/PROPERTY-TAX-AUDIT.md's first and widest finding was a page promising
// "AI pulls comparable properties" and "the specific comparable properties
// used as evidence" against an engine (and a prompt) that both refuse to
// invent one. That was fixed once already, in property-tax.html's rebuild
// (commit 636136b) — this pins it so it cannot quietly come back the way it
// got there in the first place: a copy edit made without checking what the
// engine actually does.
//
// Required Changes (Medium) #4 and #6 from docs/PROPERTY-TAX-AUDIT.md.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'property-tax.html'), 'utf8');
// Developer comments are allowed to record price history (e.g. the setup
// comment documenting the $99 -> $79 repricing); only customer-facing markup
// needs to be free of the old price.
const CUSTOMER_FACING = PAGE.replace(/<!--[\s\S]*?-->/g, '');

const BANNED_PHRASES = [
  /AI pulls/i,
  /the specific comparable properties used as evidence/i,
  /recent assessments and sales of similar homes nearby are gathered/i,
];

test('property-tax.html never claims to pull or gather comparable properties itself', () => {
  for (const re of BANNED_PHRASES) {
    assert.doesNotMatch(CUSTOMER_FACING, re, `found banned phrase matching ${re}`);
  }
});

test('property-tax.html advertises the current price, $79, not a stale one', () => {
  assert.match(CUSTOMER_FACING, /\$79/, 'the $79 price should appear on the page');
  assert.doesNotMatch(CUSTOMER_FACING, /\$99/, 'the old $99 price should not appear in customer-facing markup');
});

test("the write-up prompt hedges every deadline regardless of the model's own confidence", () => {
  const { PRODUCT_CONFIGS } = require('../api/_lib/navigator-engine');
  const task = PRODUCT_CONFIGS['property-tax'].task;
  assert.match(task, /confirm the exact date directly with their assessor's office/);
  assert.match(task, /not conditional on your confidence level/);
});
