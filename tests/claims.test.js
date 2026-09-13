// Run: node tests/claims.test.js
//
// The page makes promises; this asserts the code keeps them.
//
// This product does not compare a charge against any outside figure. It never
// consulted a market range, and as of 2026-09-13 it does not consult a statutory
// rate table either — benchmarking was removed in full, machinery included.
//
// So any sentence on the customer-facing surface offering published rates for
// their county is a claim the product does not deliver, and it is the first
// claim a sceptical customer checks. This suite exists because that sentence
// shipped once and sat there.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}\n    ${err.message.split('\n')[0]}`); }
}

const root = path.join(__dirname, '..');
// The customer-facing surface is three files now, not one. The scorecard
// renderer moved to closing-scorecard-view.js when the scorecard got its own
// URL, and a promise is a promise wherever it is printed -- scoping these
// assertions to closing.html alone would let every claim below move one file
// to the left and stop being checked.
const SURFACE = ['closing.html', 'closing-scorecard-view.js', 'closing-scorecard.html'];
const page = SURFACE.map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
const service = fs.readFileSync(path.join(root, 'api', '_lib', 'closing-service.js'), 'utf8');
const { CATALOG, PRICES } = require('../api/_lib/closing-service');

// There is no corpus and no way to wire one in. Benchmarking was removed in
// full on 2026-09-13 — market rates and statutory rates alike.
test('the engine has no benchmark supplier at all', () => {
  // Comments explaining the removal are allowed to name the thing removed;
  // code is not. Strip line comments before looking.
  const code = (src) => src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/getBenchmark/.test(code(service)),
    'closing-service.js accepts a benchmark supplier again');
  const extract = fs.readFileSync(path.join(root, 'api', '_lib', 'closing-extract.js'), 'utf8');
  assert.ok(!/getBenchmark|compareToBenchmark/.test(code(extract)),
    'the engine consults a benchmark again');
});

test('the page never sells rate data', () => {
  // This used to run only when a corpus was detected as absent, so wiring one
  // in would have quietly made the claim fair game again. That escape hatch is
  // gone: the product does not compare charges against outside figures, so the
  // page may not say it does, unconditionally.
  const claim = /published (tax )?rates?|rate table|statutes for your county/i;
  const offenders = page.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => claim.test(line));
  assert.strictEqual(
    offenders.length, 0,
    `the customer-facing surface promises published rates on line(s) `
    + `${offenders.map(([i]) => i).join(', ')} of the joined files, and this product `
    + 'does not compare a charge against any outside figure',
  );
});

test('the $29 panel names checks the catalog can actually run', () => {
  // Each promise below must correspond to a real CD-only check. A bullet with
  // no check behind it is the same failure in a new sentence.
  // The escrow CUSHION used to be on this list and is deliberately not any
  // more. A Closing Disclosure states Section G, the whole opening escrow
  // deposit — months of funding plus any cushion — and the RESPA cap applies to
  // the cushion alone. The engine has always declined to test it from the CD,
  // correctly, while this panel and the marketing sample both promised it. The
  // check now needs the initial escrow account statement, so what this panel
  // may claim is the monthly escrow collection, which genuinely does run on the
  // document alone.
  const promised = [
    [/Loan Calculations box/, 'LOAN_MATH_APR'],
    [/[Mm]onthly escrow/, 'LOAN_MATH_ESCROW_MONTHLY'],
    [/[Pp]er-diem interest/, 'PREPAID_INTEREST'],
    [/prorations/, 'PRORATION'],
    [/[Dd]uplicate and stacked fees/, 'DUPLICATE_CANDIDATE'],
    [/Cash to Close/, 'ARITH_CASH_TO_CLOSE'],
  ];
  const cdOnly = new Set(
    CATALOG.filter((c) => c.needs === 'closing_disclosure').map((c) => c.id),
  );
  for (const [claim, checkId] of promised) {
    assert.ok(claim.test(page), `the $29 panel no longer mentions ${checkId}`);
    assert.ok(cdOnly.has(checkId), `${checkId} is promised on the page but is not a CD-only check`);
  }
});

test('the $29 tier is backed by a substantial number of CD-only checks', () => {
  // The price is defensible because the document-only catalog is deep, not
  // because a corpus fills it out. If that stops being true the price needs
  // revisiting, so assert the premise rather than trusting it.
  const cdOnly = CATALOG.filter((c) => c.needs === 'closing_disclosure');
  assert.ok(
    cdOnly.length >= 15,
    `only ${cdOnly.length} checks run on the CD alone — $${PRICES.basic} was priced against a deeper catalog`,
  );
});

test('the page states the checks-run count from data, not from copy', () => {
  // A hardcoded "20 checks" in the panel drifts silently the moment a check is
  // added or retired, and an overstated count is a false claim.
  assert.ok(
    /sc\.checks_run/.test(page),
    'the $29 panel should render sc.checks_run rather than a literal count',
  );
});

test('the free scorecard discloses coverage before the customer pays', () => {
  // "N of M" must be visible pre-payment. Charging first and disclosing the
  // denominator afterwards is the chargeback logic already rejected for $59.
  assert.ok(/checks_run.*of.*checks_total|Checks run/.test(page), 'no pre-payment checks-run disclosure');
  assert.ok(/checks_blocked/.test(page), 'the page does not disclose checks blocked by a missing document');
});

if (failures.length) {
  console.log(`\n${failures.length} of ${passed + failures.length} failed:\n`);
  failures.forEach((f) => console.log(`  x ${f}\n`));
  process.exit(1);
}
console.log(`${passed}/${passed} passed`);
