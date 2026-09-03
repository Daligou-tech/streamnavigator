// What the page sells must be what the catalog runs.
//
// scripts/fix-overpromises.js exists because this drifted once already: the
// page described work the engine did not do. A patch script fixes it once; a
// test keeps it fixed. The customer decides to pay based on the words on the
// pricing card, so a promise the catalog cannot honour is not a copy bug, it is
// the thing they paid for missing from the report.
//
// These checks are deliberately mechanical and few. This file is a contract,
// not a style guide, and a test that fails on ordinary copy edits gets deleted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'closing.html'), 'utf8');
const service = require('../api/_lib/closing-service');
const corpus = require('../data/benchmarks.json');

// The service exports the catalog and the prices, so read those rather than
// scraping the source. A regex over source would keep passing after a refactor
// that broke the real thing.
const { CATALOG, PRICES, Needs, runDocumentAudit } = service;
const catalogIds = CATALOG.map((c) => c.id);

test('the catalog is non-empty and every check declares what it needs', () => {
  assert.ok(catalogIds.length > 20, `only ${catalogIds.length} checks in the catalog`);
  const undeclared = CATALOG.filter((c) => !c.needs).map((c) => c.id);
  assert.deepEqual(undeclared, [],
    'a check has no `needs` — it can never be priced or counted in "X of Y checks run"');
  const unlabelled = CATALOG.filter((c) => !c.label).map((c) => c.id);
  assert.deepEqual(unlabelled, [],
    'a check has no label — the scorecard would show the customer a blank row');
  assert.equal(new Set(catalogIds).size, catalogIds.length, 'duplicate check id in the catalog');
});

// --- the two prices --------------------------------------------------------

test('the prices the page prints are the prices the service charges', () => {
  // The page prints these in five places. If PRICES moves, the page keeps
  // selling the old number until someone notices it in Stripe.
  assert.equal(PRICES.basic, 29);
  assert.equal(PRICES.full, 59);
  assert.ok(page.includes(`$${PRICES.basic}`), `closing.html never prints $${PRICES.basic}`);
  assert.ok(page.includes(`$${PRICES.full}`), `closing.html never prints $${PRICES.full}`);
});

test('the $59 tier is backed by checks that actually need the extra documents', () => {
  // The page says the higher price "adds TRID tolerance testing and
  // purchase-contract reconciliation". Charging more for documents that unlock
  // nothing is the specific failure the tier logic was built to prevent.
  const le = CATALOG.filter((c) => c.needs === Needs.LE);
  const contract = CATALOG.filter((c) => c.needs === Needs.CONTRACT);
  assert.ok(le.length >= 5, `only ${le.length} Loan Estimate checks back the $59 tier`);
  assert.ok(contract.length >= 1, 'nothing in the catalog uses the purchase contract');
});

test('the $29 tier is backed by checks that need only the Closing Disclosure', () => {
  const cdOnly = CATALOG.filter((c) => c.needs === Needs.CD);
  assert.ok(cdOnly.length >= 15,
    `only ${cdOnly.length} CD-only checks — the $29 audit is thinner than the page implies`);
});

// --- benchmark claims ------------------------------------------------------

test('the page never promises benchmarking without the "where we hold them" hedge', () => {
  // The corpus covers one state. Any sentence that says the audit checks
  // whether a fee is too high, without conditioning on held data, is a promise
  // to 49 states that cannot be kept.
  //
  // The page's own wording is "published tax rates where we hold them" and
  // "Where we hold a published rate ... we say so; where we do not, we tell you
  // which charges that applies to". This asserts those hedges survive edits.
  assert.match(page, /where we (hold|do not)/i,
    'the conditional hedge on benchmark coverage has been edited out of closing.html');

  // Unconditional claims that would be false outside the covered states.
  const forbidden = [
    /we tell you (?:if|whether) (?:any|each|every) fee is (?:too high|overpriced)/i,
    /compare(?:d|s)? every fee (?:against|to) (?:market|local) rates/i,
    /nationwide fee benchmark/i,
  ];
  for (const re of forbidden) {
    assert.equal(re.test(page), false, `closing.html makes an unconditional benchmark claim: ${re}`);
  }
});

test('the free scorecard names its gaps rather than counting them', () => {
  // "a few", "several", "various" were the words that made the gap list
  // useless. The customer needs to know WHICH charges are unpriced before
  // paying, by name.
  const vague = /(?:a few|several|various|some) (?:charges|fees) (?:could not|cannot) be/i;
  assert.equal(vague.test(page), false, 'the scorecard describes gaps vaguely instead of naming them');
});

// --- coverage the page implies ---------------------------------------------

test('every state the page could serve is either covered or hedged', () => {
  // Not a coverage requirement — one state is the current reality. This asserts
  // the corpus has not silently emptied, which is the case where the hedged
  // copy becomes technically true and practically a lie.
  const rows = corpus.rows || [];
  const states = new Set(rows.map((r) => r.state).filter(Boolean));
  assert.ok(states.size >= 1, 'the benchmark corpus covers no states at all');
  assert.ok(rows.length >= 20, `the corpus has collapsed to ${rows.length} rows`);
});

test('the single entry point the endpoints call still exists', () => {
  // Endpoints no longer call runClosingAudit directly; everything goes through
  // this. A rename here is the class of bug wiring.test.js exists for.
  assert.equal(typeof runDocumentAudit, 'function',
    'closing-service.js no longer exports runDocumentAudit');
});

test('the suppressed-finding list still names findings the engine emits', () => {
  // BENCHMARK_CHECK_IDS is a suppression list, not catalog entries: the service
  // strips those findings before counting, because the scorecard NAMES unpriced
  // charges rather than counting them. So they must NOT be in the catalog, and
  // they MUST still be ids the engine actually produces. If someone renames a
  // checkId in closing-audit.js, this filter silently stops matching and
  // "cannot benchmark" findings leak back into the customer's issue count.
  const suppressed = [...(service.BENCHMARK_CHECK_IDS || [])];
  assert.ok(suppressed.length > 0, 'the suppression list is empty');

  const inCatalog = suppressed.filter((id) => new Set(catalogIds).has(id));
  assert.deepEqual(inCatalog, [],
    `suppressed ids must not also be catalog checks: ${inCatalog.join(', ')}`);

  const engineSrc = ['closing-audit.js', 'closing-extract.js']
    .map((f) => fs.readFileSync(path.join(ROOT, 'api/_lib', f), 'utf8')).join('\n');
  const orphans = suppressed.filter((id) => !engineSrc.includes(`checkId: '${id}'`));
  assert.deepEqual(orphans, [],
    `suppression list names findings no engine emits, so it suppresses nothing: ${orphans.join(', ')}`);
});
