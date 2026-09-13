// Statutory transfer and recordation taxes.
//
// This is the first data corpus in the product, and it is the highest-risk
// thing in it. Every other check reads the customer's own document and does
// arithmetic on it; this one asserts an external fact. A wrong rate is not a
// missing finding, it is a false accusation with a dollar figure, in a letter
// the customer sends their settlement agent.
//
// The error is also asymmetric, which is what most of these tests are about. A
// MISSING component understates the expected total, makes a correctly collected
// tax look excessive, and accuses someone. A component present that a locality
// does not levy overstates it, makes the charge look low, and reports a likely
// exemption — harmless. So the corpus errs toward including, and refuses to
// accuse at all wherever it cannot prove it enumerated everything.
//
// Rates read from the Code of Virginia, Title 58.1 Chapter 8, on 2026-09-13.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  lookupTransferTax, statutoryBenchmarks, normalizeCounty, perIncrement, MAX_SALE_PRICE,
} = require('../api/_lib/transfer-tax-rates');

// --- the rounding rule ------------------------------------------------------

test('"or fraction thereof" rounds up, it does not round to nearest', () => {
  // $100.01 of consideration is taxed as $200. Getting this wrong understates
  // every total by up to one increment.
  assert.equal(perIncrement(100, 100, 0.25), 0.25);
  assert.equal(perIncrement(100.01, 100, 0.25), 0.5);
  assert.equal(perIncrement(199.99, 100, 0.25), 0.5);
  assert.equal(perIncrement(200, 100, 0.25), 0.5);
});

// --- Virginia ---------------------------------------------------------------

const VA = (over = {}) => lookupTransferTax(Object.assign({
  state: 'VA', county: 'Richmond', salePrice: 375000, loanAmount: 300000,
}, over));

test('Virginia returns the four universal components plus the deed of trust pair', () => {
  const r = VA();
  const labels = r.components.map((c) => c.label);
  assert.ok(labels.some((l) => /State recordation tax on the deed/.test(l)));
  assert.ok(labels.some((l) => /Local recordation tax \(one third/.test(l)));
  assert.ok(labels.some((l) => /Grantor's tax/.test(l)));
  assert.ok(labels.some((l) => /Recordation tax on the deed of trust/.test(l)));
});

test('the Virginia deed tax is 25 cents per $100 of the sale price', () => {
  // § 58.1-801. $375,000 / $100 = 3,750 increments x $0.25 = $937.50
  const deed = VA().components.find((c) => c.label === 'State recordation tax on the deed');
  assert.equal(deed.amount, 937.5);
});

test("the Virginia grantor's tax is 50 cents per $500", () => {
  // § 58.1-802. $375,000 / $500 = 750 increments x $0.50 = $375.00
  const grantor = VA().components.find((c) => /Grantor's tax/.test(c.label));
  assert.equal(grantor.amount, 375);
});

test('the deed of trust is taxed on the loan amount, not the sale price', () => {
  // § 58.1-803. $300,000 / $100 = 3,000 x $0.25 = $750.00
  const dot = VA().components.find((c) => c.label === 'Recordation tax on the deed of trust');
  assert.equal(dot.amount, 750);
});

test('a cash purchase carries no deed of trust tax', () => {
  const r = VA({ loanAmount: null });
  assert.ok(!r.components.some((c) => /deed of trust/i.test(c.label)));
});

test('Northern Virginia adds the two regional fees and the rest of the state does not', () => {
  const fairfax = VA({ county: 'Fairfax County' });
  const richmond = VA({ county: 'Richmond' });

  const regional = (r) => r.components.filter(
    (c) => /WMATA|congestion/i.test(c.label)
  );
  assert.equal(regional(fairfax).length, 2, 'NoVa levies the WMATA and congestion relief fees');
  assert.equal(regional(richmond).length, 0);
  assert.ok(fairfax.total > richmond.total);

  // $0.10 per $100 on $375,000 = $375.00 each.
  regional(fairfax).forEach((c) => assert.equal(c.amount, 375));
});

test('county naming variations resolve to the same jurisdiction', () => {
  assert.equal(normalizeCounty('Fairfax County'), 'fairfax');
  assert.equal(normalizeCounty('COUNTY OF FAIRFAX'), 'fairfax');
  assert.equal(normalizeCounty('City of Alexandria'), 'alexandria');
  assert.equal(normalizeCounty('Prince William County'), 'prince william');
});

// --- the completeness gate, which is the whole safety story -----------------

test('an unknown county is returned but marked incomplete', () => {
  const r = VA({ county: null });
  assert.equal(r.complete, false);
  assert.ok(r.total > 0, 'the figures are still useful for reconciliation');
  assert.match(r.incompleteReason, /regional fees apply only in certain localities/i);
});

test('a known county is complete', () => {
  assert.equal(VA({ county: 'Fairfax' }).complete, true);
  assert.equal(VA({ county: 'Richmond' }).complete, true);
});

// --- District of Columbia ---------------------------------------------------

const DC = (salePrice, loanAmount = 300000) =>
  lookupTransferTax({ state: 'DC', salePrice, loanAmount });

test('DC is 2.2% of consideration below $400,000', () => {
  // § 42-1103 recordation at 1.1% plus § 47-903 transfer at 1.1%.
  const r = DC(350000);
  assert.equal(r.total, 7700);
  assert.equal(r.components.length, 2);
});

test('DC steps to 2.9% at $400,000, on the whole consideration', () => {
  // The additional 0.35% applies to the entire amount, not only the part above
  // the threshold. Applying it marginally would understate the total by
  // thousands — the direction that accuses someone of overcharging.
  assert.equal(DC(400000).total, 11600);
  assert.equal(DC(850000).total, 24650);
});

test('the DC step is a cliff, and it lands on exactly $400,000', () => {
  // A dollar either side of the threshold is a $1,400 difference on a $400,000
  // purchase. Getting the boundary wrong by one dollar is the whole error.
  assert.equal(DC(399999).total, 8799.98);
  assert.equal(DC(400000).total, 11600);
  assert.ok(DC(400000).total - DC(399999).total > 2500);
});

test('a DC purchase carries no tax on the deed of trust', () => {
  // DC's definition of "deed" at § 42-1101 expressly includes a security
  // interest instrument, so a deed of trust IS taxable here — except that
  // § 42-1102(5) exempts a purchase money deed of trust recorded
  // simultaneously with the deed, which is every ordinary purchase. Including
  // it would overstate the total by 1.1% of the loan.
  const withLoan = DC(500000, 400000);
  const cash = DC(500000, null);
  assert.equal(withLoan.total, cash.total);
  assert.ok(!withLoan.components.some((c) => /deed of trust/i.test(c.label)));
});

test('DC is complete, because there is no county layer to be unsure about', () => {
  const r = DC(500000);
  assert.equal(r.complete, true);
  assert.equal(r.incompleteReason, null);
  assert.equal(r.jurisdiction, 'Washington, DC');
});

test('every DC component cites its section', () => {
  for (const c of DC(500000).components) {
    assert.match(c.source, /D\.C\. Code/, `${c.label} has no citation`);
  }
});

test('DC refuses a transaction with no sale price', () => {
  // A refinance is not the purchase this entry models: there is no deed to tax,
  // and the deed of trust stops being exempt. Guessing would be the near-miss
  // the completeness rule exists to stop.
  assert.equal(lookupTransferTax({ state: 'DC', loanAmount: 400000 }), null);
});

// --- refusing everything the corpus has not done the work for ---------------

test('a state not in the corpus returns null, not a guess', () => {
  assert.equal(lookupTransferTax({ state: 'CA', salePrice: 375000 }), null);
  assert.equal(lookupTransferTax({ state: 'TX', salePrice: 375000 }), null);
  assert.equal(lookupTransferTax({ state: '', salePrice: 375000 }), null);
  assert.equal(lookupTransferTax({ salePrice: 375000 }), null);
});

test('Maryland is absent on purpose, not by oversight', () => {
  // Both its county transfer tax and its recordation tax vary across
  // twenty-four jurisdictions. A statewide entry carrying only the 0.5% state
  // transfer tax would understate every total by the county's share, which is
  // the direction that accuses someone of overcharging for a tax they
  // collected correctly. Pinned so adding a partial entry has to be a decision.
  assert.equal(lookupTransferTax({ state: 'MD', county: 'Montgomery', salePrice: 375000 }), null);
});

test('a sale price above the modelled ceiling is refused', () => {
  // Several states step their rates at thresholds this corpus does not model,
  // and a luxury transaction is where an unmodelled tier would produce the
  // largest wrong number.
  assert.equal(lookupTransferTax({ state: 'VA', county: 'Fairfax', salePrice: MAX_SALE_PRICE + 1 }), null);
  assert.ok(lookupTransferTax({ state: 'VA', county: 'Fairfax', salePrice: MAX_SALE_PRICE }));
});

test('a missing or nonsensical sale price is refused', () => {
  assert.equal(lookupTransferTax({ state: 'VA', county: 'Fairfax' }), null);
  assert.equal(lookupTransferTax({ state: 'VA', county: 'Fairfax', salePrice: 0 }), null);
  assert.equal(lookupTransferTax({ state: 'VA', county: 'Fairfax', salePrice: -1 }), null);
});

test('every component carries a statutory citation', () => {
  // A figure without a source is exactly the "fact asserted from memory" the
  // consistency audit classes as a contradiction in its own right.
  for (const c of VA({ county: 'Fairfax' }).components) {
    assert.match(c.source, /Code of Virginia/, `${c.label} has no citation`);
    assert.ok(typeof c.amount === 'number' && c.amount > 0, `${c.label} has no amount`);
  }
});

// --- the adapter the audit calls -------------------------------------------

test('the supplier answers only for transfer tax, and never per line', () => {
  const get = statutoryBenchmarks();
  assert.equal(get({ category: 'title_insurance_owners' }), null,
    'per-line market benchmarking stays retired — no corpus exists for it');

  const stacked = get.stacked({
    category: 'transfer_tax', state: 'VA', county: 'Fairfax',
    salePrice: 375000, loanAmount: 300000,
  });
  assert.ok(stacked.total > 0);
  assert.equal(stacked.evidence, 'hard_rule:statute_or_regulation');
});

test('the supplier returns a null total for a category that is not a transfer tax', () => {
  const stacked = statutoryBenchmarks().stacked({ category: 'recording_fee', state: 'VA', salePrice: 375000 });
  assert.equal(stacked.total, null);
});

test('the supplier returns a null total for a state outside the corpus', () => {
  const stacked = statutoryBenchmarks().stacked({
    category: 'transfer_tax', state: 'MD', salePrice: 375000,
  });
  assert.equal(stacked.total, null);
});
