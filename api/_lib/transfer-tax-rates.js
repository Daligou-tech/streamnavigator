// Statutory transfer and recordation taxes, by jurisdiction.
//
// Why this exists: closing.html tells the customer "we do not say a fee is too
// expensive. Nobody publishes what an underwriting or settlement fee should
// cost, so we check arithmetic and federal rules instead of guessing." That is
// true of an underwriting fee and false of a transfer tax. Transfer and
// recordation taxes are statute. They are published, they are exact, and on a
// $375,000 purchase they run into thousands — the largest number on the
// settlement statement that has a provably correct value.
//
// The audit of 2026-09-12 found the machinery for checking them fully built and
// switched off: compareToBenchmark(), an aggregate transfer-tax check with
// exemption handling, and a NO_BENCHMARKS supplier returning null to both. No
// rate corpus had ever existed. This is that corpus.
//
// ---------------------------------------------------------------------------
// THE RULE THAT SHAPES EVERYTHING HERE
// ---------------------------------------------------------------------------
//
// Getting a rate wrong is not a missing finding. It is a false accusation with
// a dollar figure attached, in a letter the customer sends their settlement
// agent — the same failure class as the tolerance bug fixed in e9996a9.
//
// And the dangerous direction is asymmetric. If a component is MISSING from an
// entry, the expected total comes out too low, the charged amount looks
// excessive, and the report accuses someone of overcharging for a tax they
// collected correctly. If a component is present that a locality does not
// actually levy, the total comes out too high, the charged amount looks low,
// and the engine reports a likely exemption — which is harmless.
//
// So every entry carries `complete`: true only where every component that can
// apply in that jurisdiction is enumerated here. Where completeness cannot be
// established — most often because the county was never read off the document,
// and the regional fees are county-dependent — the figures are still returned
// and still reconciled, but the result may only VERIFY. It may never accuse.
//
// Adding a jurisdiction: cite the statute, record the date the rate was read,
// and set complete:false unless you have enumerated every local and regional
// component. A partial entry is useful. A partial entry marked complete is
// dangerous.

'use strict';

// Taxes of this kind round UP to the next whole increment — "$0.25 on every
// $100 or fraction thereof" means $100.01 of consideration is taxed as $200.
const perIncrement = (base, increment, rate) =>
  Math.ceil(Number(base) / increment) * rate;

const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Virginia
// ---------------------------------------------------------------------------
//
// Read from the Code of Virginia, Title 58.1 Chapter 8, on 2026-09-13.
//
// The universal components are the four below. Two more apply only in
// Northern Virginia and in specific planning districts, which is exactly why
// an unknown county cannot be treated as complete.

const VA_SOURCE = 'Code of Virginia § 58.1-801 to § 58.1-814';
const VA_READ_ON = '2026-09-13';

// Localities in the Northern Virginia Transportation Authority, where the
// WMATA capital fee (§ 58.1-802.3) and the regional congestion relief fee
// (§ 58.1-802.4) both apply. Normalised to lower case without the words county
// or city, because a Closing Disclosure writes these a dozen ways.
const VA_NOVA = new Set([
  'arlington', 'fairfax', 'loudoun', 'prince william',
  'alexandria', 'falls church', 'fairfax city', 'manassas', 'manassas park',
  'dumfries', 'herndon', 'leesburg', 'purcellville', 'vienna',
]);

const normalizeCounty = (s) => String(s || '')
  .toLowerCase()
  .replace(/\b(county|city|of|the)\b/g, '')
  .replace(/[^a-z\s]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

function virginia({ county, salePrice, loanAmount }) {
  const components = [];

  // § 58.1-801 — state recordation tax on the deed. 25 cents per $100 of the
  // greater of consideration or value.
  components.push({
    label: 'State recordation tax on the deed',
    amount: round2(perIncrement(salePrice, 100, 0.25)),
    source: `${VA_SOURCE} (§ 58.1-801)`,
  });

  // § 58.1-814 — local recordation tax, one third of the state tax. Optional
  // for a locality to impose, and almost universally imposed. Included because
  // omitting it would understate the total, which is the direction that
  // produces a false accusation; a locality that does not levy it simply makes
  // the charged amount look low, which reports as a likely exemption.
  components.push({
    label: 'Local recordation tax (one third of the state tax)',
    amount: round2(perIncrement(salePrice, 100, 0.25) / 3),
    source: `${VA_SOURCE} (§ 58.1-814)`,
    note: 'Localities may impose this and almost all do.',
  });

  // § 58.1-802 — grantor's tax, 50 cents per $500. Paid by the seller unless
  // the contract says otherwise, and it appears on the same settlement
  // statement, which is why the total is tested rather than either share.
  components.push({
    label: "Grantor's tax",
    amount: round2(perIncrement(salePrice, 500, 0.5)),
    source: `${VA_SOURCE} (§ 58.1-802)`,
    note: 'Normally the seller\'s, though the contract may reallocate it.',
  });

  // § 58.1-803 — recordation tax on the deed of trust, on the amount secured.
  // The rate steps down above $10m; this corpus refuses anything near it.
  if (typeof loanAmount === 'number' && loanAmount > 0) {
    components.push({
      label: 'Recordation tax on the deed of trust',
      amount: round2(perIncrement(loanAmount, 100, 0.25)),
      source: `${VA_SOURCE} (§ 58.1-803)`,
    });
    components.push({
      label: 'Local recordation tax on the deed of trust',
      amount: round2(perIncrement(loanAmount, 100, 0.25) / 3),
      source: `${VA_SOURCE} (§ 58.1-814)`,
    });
  }

  // The two regional fees. Both are $0.10 per $100, both are county-dependent,
  // and both are the reason an unknown county cannot be complete.
  const key = normalizeCounty(county);
  const knownCounty = Boolean(key);
  const isNova = knownCounty && VA_NOVA.has(key);

  if (isNova) {
    components.push({
      label: 'WMATA capital fee',
      amount: round2(perIncrement(salePrice, 100, 0.10)),
      source: `${VA_SOURCE} (§ 58.1-802.3)`,
      note: 'Northern Virginia localities only.',
    });
    components.push({
      label: 'Regional congestion relief fee',
      amount: round2(perIncrement(salePrice, 100, 0.10)),
      source: `${VA_SOURCE} (§ 58.1-802.4)`,
      note: 'Applies in the Northern Virginia planning district.',
    });
  }

  return {
    total: round2(components.reduce((a, c) => a + c.amount, 0)),
    components,
    evidence: 'hard_rule:statute_or_regulation',
    // Complete only when the county is known. Without it we cannot tell whether
    // the two regional fees apply, and a total missing them would read as an
    // overcharge of exactly their size.
    complete: knownCounty,
    incompleteReason: knownCounty
      ? null
      : 'The county was not readable on the document, and two Virginia regional fees apply only in '
        + 'certain localities. The figures below are the statewide components only, so they are '
        + 'reported as a reconciliation rather than as a finding.',
    jurisdiction: knownCounty ? `${county}, VA` : 'Virginia (county not established)',
    readOn: VA_READ_ON,
  };
}

// ---------------------------------------------------------------------------
// District of Columbia
// ---------------------------------------------------------------------------
//
// Read from the D.C. Code on 2026-09-13. DC is the easiest jurisdiction in the
// country to model completely, and worth doing early for that reason: it is a
// single jurisdiction with no county layer, so there is nothing county-
// dependent to be uncertain about and the entry can honestly be complete.
//
// Two taxes of the same shape land on an ordinary residential purchase:
//
//   § 42-1103  recordation tax on the deed      1.1%, or 1.45% from $400,000
//   § 47-903   transfer tax                     1.1%, or 1.45% from $400,000
//
// Both are a flat percentage of consideration — no "or fraction thereof"
// rounding, unlike Virginia — and the step at $400,000 applies to the WHOLE
// consideration rather than only the part above it. Customarily the buyer pays
// the recordation and the seller the transfer, but the contract decides and the
// audit tests the total, so the split is not modelled.
//
// THE DEED OF TRUST IS THE PART WORTH GETTING RIGHT. DC's definition of "deed"
// at § 42-1101 expressly includes a security interest instrument, so a deed of
// trust is taxable here where in many states it is not — except that
// § 42-1102(5) exempts "a purchase money mortgage or purchase money deed of
// trust that is recorded simultaneously with the deed conveying the real
// property", which is every ordinary purchase. So a purchase carries no tax on
// the financing, and a REFINANCE does, at the same rates.
//
// That asymmetry is why this function refuses anything without a sale price:
// no sale price means it is not the purchase this model describes, and guessing
// would be exactly the kind of near-miss the completeness rule exists to stop.
//
// Not modelled, and safe not to be: the reduced 0.725% first-time DC homebuyer
// recordation rate. A transaction claiming it pays LESS than computed here,
// which reads as a likely exemption — the harmless direction.

const DC_SOURCE = 'D.C. Code § 42-1103 and § 47-903';
const DC_READ_ON = '2026-09-13';
const DC_STEP = 400000;

function districtOfColumbia({ salePrice }) {
  // § 47-903: the additional 0.35% applies to everything except residential
  // consideration under $400,000. Closing Navigator audits residential
  // purchases and refuses anything over $1m, so the rule reduces to the step.
  const rate = salePrice >= DC_STEP ? 0.0145 : 0.011;
  const band = salePrice >= DC_STEP ? 'from $400,000' : 'under $400,000';
  const amount = round2(salePrice * rate);

  const components = [
    {
      label: 'Recordation tax on the deed',
      amount,
      source: `${DC_SOURCE} (§ 42-1103)`,
      note: `${(rate * 100).toFixed(2)}% of consideration, the rate ${band}.`,
    },
    {
      label: 'Transfer tax',
      amount,
      source: `${DC_SOURCE} (§ 47-903)`,
      note: 'Customarily the seller\'s, though the contract may reallocate it.',
    },
  ];

  return {
    total: round2(components.reduce((a, c) => a + c.amount, 0)),
    components,
    evidence: 'hard_rule:statute_or_regulation',
    // No county layer, and the purchase money deed of trust is exempt, so
    // there is nothing further that can apply to an ordinary purchase here.
    complete: true,
    incompleteReason: null,
    jurisdiction: 'Washington, DC',
    readOn: DC_READ_ON,
  };
}

// ---------------------------------------------------------------------------
// the corpus
// ---------------------------------------------------------------------------
//
// One entry per state. Everything not listed returns null, and the audit then
// behaves exactly as it did before this file existed — no finding, no mention,
// no "we could not benchmark" row. A jurisdiction we have not done the work for
// is silent rather than apologetic.
// Maryland is the obvious third and is deliberately absent. Both its county
// transfer tax and its recordation tax vary across twenty-four jurisdictions,
// and a statewide entry carrying only the 0.5% state transfer tax would
// understate every total by the county's share — the direction that accuses
// someone of overcharging for a tax they collected correctly. It is worth
// doing properly, county by county, or not at all.
const STATES = {
  VA: virginia,
  DC: districtOfColumbia,
};

// Sale prices above this are refused outright. Several states step their rates
// at thresholds this corpus does not model, and a luxury transaction is exactly
// where an unmodelled tier would produce the largest wrong number.
const MAX_SALE_PRICE = 1000000;
const MAX_LOAN = 10000000;

function lookupTransferTax({ state, county, salePrice, loanAmount } = {}) {
  const fn = STATES[String(state || '').toUpperCase().trim()];
  if (!fn) return null;
  if (typeof salePrice !== 'number' || !Number.isFinite(salePrice) || salePrice <= 0) return null;
  if (salePrice > MAX_SALE_PRICE) return null;
  if (typeof loanAmount === 'number' && loanAmount > MAX_LOAN) return null;
  return fn({ county, salePrice, loanAmount });
}

// The shape closing-extract.js calls: a getBenchmark function carrying a
// .stacked() for taxes tested in aggregate. Per-line benchmarking stays
// retired — this corpus holds statutes, not market rates, and the distinction
// is the one closing.html makes to the customer.
function statutoryBenchmarks() {
  const get = () => null;
  get.stacked = ({ category, state, county, salePrice, loanAmount }) => {
    if (category !== 'transfer_tax') return { total: null, components: [] };
    const found = lookupTransferTax({ state, county, salePrice, loanAmount });
    return found || { total: null, components: [] };
  };
  return get;
}

module.exports = {
  lookupTransferTax,
  statutoryBenchmarks,
  normalizeCounty,
  perIncrement,
  MAX_SALE_PRICE,
  __test: { virginia, VA_NOVA },
};
