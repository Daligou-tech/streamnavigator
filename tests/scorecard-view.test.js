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


// --- the add-documents buttons land on the upload box ------------------------
// Sending the customer to the top of a long marketing page they have already
// read, and making them find the upload box again, is the same failure as an
// upsell with nowhere to upload.

test('the default add-documents destination is the upload box', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'closing-scorecard-view.js'), 'utf8');
  assert.match(src, /\/closing#upload/);
});


// --- six copy defects found by rendering each upload combination -------------
// Each of these shipped. None was a crash: the page rendered cleanly and said
// something untrue, ungrammatical, or unhelpful to a customer who had done
// nothing wrong. That is the failure mode this file exists to catch.

const LE_MISMATCH = {
  ...BASE, loan_estimates_uploaded: 1, loan_estimates_read: 1, tolerance_tested: false,
  tolerance_blocked_reason: 'different_address',
  address_mismatch: { cd: '2526 Heath Place, Reston, VA 20191', le: '17709 Sunrise Dr, Lutz, FL 33558' },
  tier: { id: 'basic', downgraded_from_full: true, has_loan_estimate: true, upgrade_documents: 0 },
};

const CONTRACT_MISMATCH = {
  ...BASE, contract_uploaded: 1, contract_reconciled: false, contract_terms_read: 0,
  contract_low_confidence: 0,
  contract_mismatch: [{ field: 'property address', hard: true, cd: '2526 Heath Place, Reston, VA 20191', le: '88 Palm Ave, Tampa, FL 33602' }],
  tier: { id: 'basic', downgraded_from_full: true, has_purchase_contract: true, upgrade_documents: 0 },
};

test('the failed-upload panel does not point the customer in a direction', () => {
  // Said "the reason is above". The reason renders below it.
  const { html } = render(LE_MISMATCH);
  assert.equal(/reason is above/.test(html), false, 'still claims the reason is above it');
});

test('a single-field mismatch is described in the singular', () => {
  const { html } = render(CONTRACT_MISMATCH);
  assert.equal(/address differ\b/.test(html), false, 'reads "property address differ"');
  assert.match(html, /does not match/);
});

test('a contract for the wrong property names both addresses', () => {
  const { html } = render(CONTRACT_MISMATCH);
  assert.match(html, /2526 Heath Place/, 'the Closing Disclosure address is not named');
  assert.match(html, /88 Palm Ave/, 'the contract address is not named');
});

test('one Loan Estimate is not described as several', () => {
  const { html } = render({
    ...BASE, loan_estimates_uploaded: 1, loan_estimates_read: 1, tolerance_tested: true,
    cd_charge_lines: 22, tier: { id: 'full', has_loan_estimate: true, upgrade_documents: 1 },
  });
  assert.equal(/You uploaded Loan Estimates/.test(html), false, 'plural used for a single Loan Estimate');
  assert.match(html, /You uploaded a Loan Estimate/);
});

test('several Loan Estimates are still described in the plural', () => {
  const { html } = render({
    ...BASE, loan_estimates_uploaded: 3, loan_estimates_read: 3, tolerance_tested: true,
    cd_charge_lines: 22, tier: { id: 'full', has_loan_estimate: true, upgrade_documents: 1 },
  });
  assert.match(html, /You uploaded Loan Estimates/);
});

test('a clean result confirms the contract check ran, not just tolerance testing', () => {
  const { html } = render({
    ...BASE, loan_estimates_uploaded: 1, loan_estimates_read: 1, tolerance_tested: true,
    cd_charge_lines: 22, contract_uploaded: 1, contract_reconciled: true, contract_terms_read: 3,
    tier: { id: 'full', has_loan_estimate: true, has_purchase_contract: true, upgrade_documents: 2 },
  });
  assert.match(html, /purchase contract/, 'the contract check is never acknowledged');
  assert.match(html, /credits and concessions/);
});

// --- never advertise a document the customer has already supplied -----------
// Fixed once in the coverage panel. This closing sentence was written separately
// and kept the bug, so a customer who uploaded a contract was told to upload one.

test('a supplied contract is not offered back to the customer', () => {
  const { html } = render({
    ...BASE, contract_uploaded: 1, contract_reconciled: false, contract_terms_read: 0,
    contract_low_confidence: 0, contract_mismatch: null, checks_total: 26,
    tier: { id: 'basic', has_purchase_contract: true, upgrade_documents: 0 },
  });
  assert.equal(/Add your.*purchase contract/.test(html), false, 'offers a contract already uploaded');
  assert.match(html, /Add your Loan Estimate/, 'should still ask for the document it does not have');
});

test('a supplied Loan Estimate is not offered back to the customer', () => {
  const { html } = render(LE_MISMATCH);
  assert.equal(/Add your Loan Estimate/.test(html), false, 'offers a Loan Estimate already uploaded');
  assert.match(html, /Add your purchase contract/);
});

test('nothing is offered when both documents are already in', () => {
  const { html } = render({
    ...BASE, loan_estimates_uploaded: 1, loan_estimates_read: 1, contract_uploaded: 1,
    cd_charge_lines: 22, tolerance_blocked_reason: null,
    tier: { id: 'basic', has_loan_estimate: true, has_purchase_contract: true, upgrade_documents: 0 },
  });
  assert.equal(/Add your/.test(html), false, 'asks for a document when both are already supplied');
});


// --- the denominator the customer can actually reach ------------------------
// "20 of 27" described a completely audited Closing Disclosure as a 74% job:
// the other 7 needed a Loan Estimate nobody had asked for. Completeness and
// upsell were sharing one fraction, and the fraction read as a shortfall.

const CD_ONLY = {
  ...BASE, checks_attempted: 20, checks_reachable: 20, checks_run: 11,
  checks_blocked: 7, checks_blocked_by: [{ document: 'your Loan Estimate', count: 7 }],
  document_label: 'Closing Disclosure',
};

test('the denominator is what the uploaded documents can reach', () => {
  const { html } = render(CD_ONLY);
  assert.match(html, /20 of 20 checks that apply/);
  assert.equal(/20 of 27/.test(html), false, 'still counts checks no document can reach');
});

test('a complete audit says so in words', () => {
  const { html } = render(CD_ONLY);
  assert.match(html, /That is all of them/);
});

test('blocked checks are an addition, not a shortfall', () => {
  const { html } = render(CD_ONLY);
  assert.match(html, /7 more if you add your Loan Estimate/);
  assert.equal(/Checks needing another document/.test(html), false,
    'the old deficit-framed row is back');
});

test('the fraction is not printed twice', () => {
  const { html } = render(CD_ONLY);
  const hits = (html.match(/20 of 20/g) || []).length;
  assert.equal(hits, 1, `the same fraction appears ${hits} times`);
});

test('each blocking document is named with its own count', () => {
  const { html } = render({
    ...CD_ONLY, checks_attempted: 18, checks_reachable: 18, checks_blocked: 9,
    checks_blocked_by: [
      { document: 'your Loan Estimate', count: 7 },
      { document: 'answer two quick questions', count: 2 },
    ],
  });
  assert.match(html, /7 more if you add your Loan Estimate/);
  // Documents get "add"; questions get answered. "add two quick answers" was
  // what the first version produced.
  assert.match(html, /2 more if you answer two quick questions/);
  assert.equal(/add answer two quick/.test(html), false, 'verb does not agree with the noun');
});

test('nothing is offered when every check has already run', () => {
  const { html } = render({
    ...CD_ONLY, checks_attempted: 27, checks_reachable: 27, checks_blocked: 0, checks_blocked_by: [],
  });
  assert.match(html, /27 of 27 checks that apply/);
  assert.equal(/more if you/.test(html), false, 'offers an upgrade with nothing left to unlock');
});

const total = passed + failures.length;
if (failures.length) {
  console.error(`\n${failures.length} of ${total} failed:\n`);
  failures.forEach((f) => console.error('  x ' + f + '\n'));
  process.exit(1);
}
console.log(`${passed}/${total} passed`);
