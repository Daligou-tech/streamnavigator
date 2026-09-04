// Executes the shared scorecard renderer against real payloads.
//
// closing-scorecard-view.js is loaded by two pages and touched by neither test
// suite that came before it. A renderer that throws leaves both pages blank
// with a clean CI run, which is the exact failure render-check.js exists for --
// except render-check only proves the file parses. This proves it runs.
'use strict';

const assert = require('node:assert/strict');
const path = require('path');

// Minimal DOM. Only the surface the renderer touches.
function makeDom() {
  const els = {};
  const el = (id) => {
    if (!els[id]) {
      els[id] = { id, style: {}, innerHTML: '', textContent: '',
        getAttribute: () => 'https://buy.stripe.com/x', setAttribute: () => {},
        addEventListener: () => {}, scrollIntoView: () => {}, querySelectorAll: () => [] };
    }
    return els[id];
  };
  global.window = global;
  global.document = { getElementById: el, querySelectorAll: () => [], addEventListener: () => {} };
  global.location = { href: '' };
  return els;
}

makeDom();
delete require.cache[require.resolve(path.join(__dirname, '..', 'closing-scorecard-view.js'))];
require(path.join(__dirname, '..', 'closing-scorecard-view.js'));

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push(name + ' -- ' + err.message); }
}

function render(sc, answers) {
  // els is populated lazily by the DOM stub, so ask for the node rather than
  // indexing a map that may not hold it yet.
  document.getElementById('scorecard-panel').innerHTML = '';
  const view = createScorecardView({ answers: answers || { transaction_type: 'purchase' } });
  view.renderScorecard(sc);
  return { html: document.getElementById('scorecard-panel').innerHTML, view };
}

const BASE = {
  total_closing_costs: 33825.53, closing_costs_pct_of_loan: 4,
  flag_count: 0, flag_dollars: null, flags_with_dollars: 0, unreadable_fields: [],
  checks_run: 11, checks_total: 27, checks_blocked: 7, checks_attempted: 20,
  checks_not_applicable: 0, unlocks: [], tier: { id: 'basic' },
  flag_severity: { high: 0, medium: 0 },
  cost_context: { typical_low: 2, typical_high: 5, band: 'within', small_loan: false, source: 'x' },
};

test('the renderer produces a panel rather than throwing', () => {
  const { html } = render(BASE);
  assert.ok(html.length > 200, 'panel is empty or near-empty');
  assert.match(html, /33,82[56]/, 'the headline figure is missing');
});

test('the retired $29 price never reaches the panel', () => {
  const { html } = render(BASE);
  assert.equal(/\$29\b/.test(html), false);
});

// --- regression: 2526 Heath Place vs 17709 Sunrise Dr ------------------------
// A Closing Disclosure for Reston VA uploaded alongside a Loan Estimate for
// Lutz FL. The estimate had no issue date, so it was dropped before the
// identity comparison ever ran and the page said we "could not read your Loan
// Estimate clearly enough" -- sending the customer to find a better scan of a
// document for somebody else's house.

const MISMATCH = {
  ...BASE,
  loan_estimates_uploaded: 1, cd_charge_lines: 40, tolerance_tested: false,
  tolerance_blocked_reason: 'different_address',
  address_mismatch: { cd: '2526 Heath Place, Reston, VA 20191', le: '17709 Sunrise Dr, Lutz, FL 33558' },
};

test('a differing address is stated as a differing address', () => {
  const { html } = render(MISMATCH);
  assert.match(html, /are not for the same address/);
});

test('both addresses are named so the customer knows which file is wrong', () => {
  const { html } = render(MISMATCH);
  assert.match(html, /2526 Heath Place/);
  assert.match(html, /17709 Sunrise Dr/);
});

test('a differing address is never blamed on readability', () => {
  const { html } = render(MISMATCH);
  assert.equal(/clearly enough/.test(html), false,
    'the page is telling the customer to rescan a document for the wrong property');
});

test('a genuinely unreadable estimate still says so', () => {
  const { html } = render({ ...BASE, loan_estimates_uploaded: 1, cd_charge_lines: 40,
    tolerance_tested: false, tolerance_blocked_reason: 'le_unreadable', address_mismatch: null });
  assert.match(html, /clearly enough/);
  assert.equal(/same address/.test(html), false);
});

test('unread figures are counted back through the returned view', () => {
  const { view } = render({ ...BASE, unreadable_fields: ['Loan amount', 'Closing date'] });
  assert.equal(view.unreadableCount(), 2);
  assert.equal(view.hasAcknowledged(), false);
  view.acknowledge();
  assert.equal(view.hasAcknowledged(), true);
});


// --- both "add documents" buttons must be clickable --------------------------
// The panel renders two of them: one beside the failure explanation and one at
// the bottom of the "what would unlock more" upsell. Both carried the same id,
// and getElementById returns the first match, so the lower one -- reached after
// the customer reads what they would gain -- did nothing when clicked.

test('every add-documents button is wired, not just the first', () => {
  const { html } = render({ ...BASE,
    tier: { id: 'basic', downgraded_from_full: true, has_purchase_contract: true },
    contract_uploaded: 1, contract_terms_read: 0, contract_low_confidence: 2,
    unlocks: [{ title: 'Loan Estimate', unlocks_count: 6, why: 'tolerance testing', accepts: 'loan_estimate' }],
  });
  const buttons = (html.match(/js-add-docs/g) || []).length;
  assert.ok(buttons >= 2, `expected both buttons, found ${buttons}`);
  assert.equal(/id="add-docs-btn"/.test(html), false,
    'a duplicate id is back; only the first button would respond to a click');
});

// --- regression: a contract that promises nothing is not an unreadable one ---
// A Virginia sales contract read cleanly and stated no seller credits. The page
// said we "could not read any credits, concessions or cost allocations from the
// contract -- it may be missing pages", sending the customer to re-scan a
// document that was perfectly legible.

const EMPTY_CONTRACT = {
  ...BASE,
  contract_uploaded: 1, contract_terms_read: 0, contract_low_confidence: 0,
  contract_mismatch: null, contract_reconciled: false,
  tier: { id: 'basic', downgraded_from_full: true, has_purchase_contract: true },
};

test('a readable contract with no credits is not called unreadable', () => {
  const { html } = render(EMPTY_CONTRACT);
  assert.equal(/could not read any credits/.test(html), false);
  assert.match(html, /states no seller credits or concessions/);
});

test('a readable contract with no credits is not called a document we could not use', () => {
  const { html } = render(EMPTY_CONTRACT);
  assert.equal(/could not use it/.test(html), false,
    'the summary contradicts the note below it');
});

test('a contract that truly could not be read still says so', () => {
  const { html } = render({ ...EMPTY_CONTRACT, contract_low_confidence: 3 });
  assert.match(html, /could not read any credits|could not be read reliably/);
});

test('a contract for the wrong property still names the mismatch', () => {
  const { html } = render({ ...EMPTY_CONTRACT,
    contract_mismatch: [{ field: 'property address' }] });
  assert.match(html, /does not match this Closing Disclosure/);
  assert.equal(/states no seller credits/.test(html), false);
});

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n${failures.length} of ${total} failed:\n`);
  failures.forEach((f) => console.error('  x ' + f + '\n'));
  process.exit(1);
}
console.log(`${passed}/${total} passed`);
