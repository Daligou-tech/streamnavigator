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

// --- the one price ---------------------------------------------------------

test('the price the page prints is the price the service charges', () => {
  // Two-tier pricing was retired. `basic` and `full` still exist as coverage
  // labels — which analysis ran — but they are not price points any more, so
  // they must carry the same number. A tier that reports $29 while the pay
  // button opens the $59 Stripe link is a billing dispute, not a copy bug.
  assert.equal(PRICES.full, 59);
  assert.equal(PRICES.basic, PRICES.full,
    'two-tier pricing was retired — a coverage tier must not carry its own price');
  assert.ok(page.includes(`$${PRICES.full}`), `closing.html never prints $${PRICES.full}`);

  // The retired price must not come back. It reappearing anywhere on the page
  // means someone restored the old pricing card without restoring the tier
  // logic behind it.
  assert.equal(/\$29\b/.test(page), false,
    'closing.html prints $29 — the retired second tier, which checkout does not charge');
});

test('the extra documents are backed by checks that actually need them', () => {
  // The page says a Loan Estimate and a purchase contract add TRID tolerance
  // testing and contract reconciliation "at no extra cost". They cost the
  // customer an upload, so they still have to unlock something.
  const le = CATALOG.filter((c) => c.needs === Needs.LE);
  const contract = CATALOG.filter((c) => c.needs === Needs.CONTRACT);
  assert.ok(le.length >= 5, `only ${le.length} Loan Estimate checks justify asking for one`);
  assert.ok(contract.length >= 1, 'nothing in the catalog uses the purchase contract');
});

test('the audit is backed by checks that need only the Closing Disclosure', () => {
  // Most customers upload the CD and nothing else. If this thins out, the
  // free scorecard has little to report and the $59 buys little to read.
  const cdOnly = CATALOG.filter((c) => c.needs === Needs.CD);
  assert.ok(cdOnly.length >= 15,
    `only ${cdOnly.length} CD-only checks — the audit is thinner than the page implies`);
});

// --- benchmark claims ------------------------------------------------------

test('the page never claims coverage without naming the gaps in the same breath', () => {
  // The corpus covers three states. Any sentence saying the audit checks
  // whether a fee is too high, without conditioning on held data, is a promise
  // to forty-seven states that cannot be kept.
  //
  // This used to grep for the literal hedge "where we hold them". That copy is
  // gone: the county-level claims were removed from the page entirely, which
  // satisfies the intent more completely than hedging ever did — and the file
  // header says a test that fails on ordinary copy edits gets deleted.
  //
  // What survives is the scorecard's coverage panel, rendered from the engine's
  // own describeCoverage sentences. The invariant is structural, not verbal: if
  // the page can print what WAS priced, it must also be able to print what was
  // not. A build that renders only the positive line reads as full coverage.
  const claimsPriced = /Priced against a published rate/i.test(page);
  const namesGaps = /Not priced/i.test(page);
  assert.equal(claimsPriced && !namesGaps, false,
    'closing.html renders the "priced against" line with no "not priced" counterpart, '
    + 'so a partially covered audit reads as a complete one');

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

test('benchmarking stays retired', () => {
  // The corpus held 51 rows -- 48 Maryland, 2 Florida, 1 Texas -- and reached
  // only paying customers, because the free scorecard filtered benchmark
  // findings out. The weakest evidence in the product was shown exclusively to
  // the people who paid for it.
  //
  // This test used to assert the corpus was healthy. It now asserts it is gone.
  // Dropping a data file back in must not silently switch fee benchmarking back
  // on: every other finding here is arithmetic, a legal limit, or a comparison
  // between two documents the customer holds, and one claim about a market
  // sample among them is the one that puts a wrong number in a customer's
  // letter to their lender.
  // Deliberately NOT asserting the corpus file is absent. A stale data file on
  // disk that nothing reads is inert; what matters is that no production code
  // loads it. Testing for absence would also force a pile of file deletions on
  // anyone shipping through the GitHub web UI, for no gain in safety.
  for (const rel of ['api/_lib/closing-extract.js', 'api/_lib/closing-service.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.equal(/require\((?:'|")[^'"]*benchmarks\.json(?:'|")\)/.test(src), false,
      rel + ' loads a benchmark corpus again');
  }

  // The suppliers must answer null for everything, not merely fail to find a row.
  const { runDocumentAudit: run } = require('../api/_lib/closing-service');
  assert.equal(typeof run, 'function');
});

test('the page does not advertise fee benchmarking', () => {
  // Nothing on the page promised it before -- the corpus was never advertised,
  // which is why removing it costs no copy. This keeps it that way.
  const forbidden = [
    /benchmark(?:ed|s)? against (?:published|state|county|market) (?:rate|data)/i,
    /fair(?:-| )market (?:price|rate) for (?:each|every) fee/i,
    /what this fee should cost/i,
  ];
  for (const re of forbidden) {
    assert.equal(re.test(page), false, 'closing.html advertises fee benchmarking: ' + re);
  }
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
