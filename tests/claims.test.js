// Run: node tests/claims.test.js
//
// The page makes promises; this asserts the code keeps them.
//
// closing-service.js runs the audit with NO_BENCHMARKS — it consults no rate
// table at all. While that is true, any sentence on closing.html offering
// published rates for the customer's county is a claim the product does not
// deliver, and it is the first claim a sceptical customer checks. This suite
// exists because that sentence shipped and sat there.
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
const page = fs.readFileSync(path.join(root, 'closing.html'), 'utf8');
const service = fs.readFileSync(path.join(root, 'api', '_lib', 'closing-service.js'), 'utf8');
const { CATALOG, PRICES } = require('../api/_lib/closing-service');

// Does the shipped service actually consult a corpus?
const benchmarksDisabled = /getBenchmark:\s*NO_BENCHMARKS|NO_BENCHMARKS\s*\)/.test(service);

test('the page does not sell rate data while the service runs without a corpus', () => {
  if (!benchmarksDisabled) return; // corpus wired in: the claim becomes fair game
  const claim = /published (tax )?rates?|rate table|statutes for your county/i;
  const offenders = page.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => claim.test(line));
  assert.strictEqual(
    offenders.length, 0,
    `closing.html promises published rates on line(s) ${offenders.map(([i]) => i).join(', ')} `
    + 'but closing-service.js runs with NO_BENCHMARKS',
  );
});

test('the $29 panel names checks the catalog can actually run', () => {
  // Each promise below must correspond to a real CD-only check. A bullet with
  // no check behind it is the same failure in a new sentence.
  const promised = [
    [/Loan Calculations box/, 'LOAN_MATH_APR'],
    [/[Ee]scrow cushion/, 'ESCROW_CUSHION'],
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
