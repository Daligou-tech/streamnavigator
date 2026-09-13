#!/usr/bin/env node
'use strict';

// Prints a full Contractor Estimate Audit for each built-in fixture, without
// touching the network, a database, or a single API credit.
//
// Run: node scripts/contractor-harness.js
//      node scripts/contractor-harness.js --email     also print the drafted emails
//
// This exists so the report can be read as a customer reads it, rather than
// inferred from a test assertion. Everything below the write-up — the findings,
// the figures, the coverage count, the emails — is produced by the same code
// that runs in production, so what prints here is what a customer gets, minus
// the model-written opening paragraph.
//
// The one thing it cannot show you is the extraction. That is a model reading
// the customer's documents; the fixtures stand in for its output. If a real
// report looks wrong and the findings below look right, the extraction is where
// to look.

const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { runContractorAudit, Severity } = require(path.join(ROOT, 'api/_lib/contractor-audit'));
const { buildContractorEmails } = require(path.join(ROOT, 'api/_lib/contractor-emails'));
const fixtures = require(path.join(ROOT, 'tests/fixtures/contractor-fixtures'));

const showEmails = process.argv.includes('--email');

const CASES = [
  {
    name: 'pressured-hvac',
    note: 'One HVAC quote from an in-home sales visit in California. A deposit over the statutory cap, '
      + 'a labour line that does not multiply out, a dead tax credit, R-410A stock, an unmatched system, '
      + 'and a price that expires tonight.',
    extraction: fixtures.pressuredHvac(),
    context: { state: 'CA', homeSqft: 1850, signedAtHome: true },
  },
  {
    name: 'two-roofs',
    note: 'Two competing roofing quotes in Florida, $4,500 apart. The ordinary good case: the value is the '
      + 'comparison, and the cheaper bid is cheaper because it is a different job.',
    extraction: fixtures.twoRoofs(),
    context: { state: 'FL', signedAtHome: false },
  },
  {
    name: 'unreadable-scrap',
    note: 'A photograph of a handwritten note with no legible total. This is the case the automatic refund '
      + 'exists for — read the coverage line.',
    extraction: fixtures.unreadableScrap(),
    context: { state: 'OH', signedAtHome: false },
  },
];

const COVERAGE_FLOOR = 0.6;

function money(v) {
  if (v === null || v === undefined) return '';
  return `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function rule(char) {
  return char.repeat(78);
}

function wrap(text, indent) {
  const width = 78 - indent.length;
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > width) {
      lines.push(indent + line.trim());
      line = word;
    } else {
      line += ` ${word}`;
    }
  }
  if (line.trim()) lines.push(indent + line.trim());
  return lines.join('\n');
}

for (const testCase of CASES) {
  const audited = runContractorAudit(testCase.extraction, testCase.context);
  const emails = buildContractorEmails(audited.findings, { quotes: testCase.extraction.quotes });

  const ratio = audited.checksTotal ? audited.checksRun / audited.checksTotal : 0;
  const thin = ratio < COVERAGE_FLOOR;

  console.log(`\n${rule('=')}`);
  console.log(`${testCase.name}  —  ${audited.category}, ${testCase.context.state}`);
  console.log(rule('='));
  console.log(wrap(testCase.note, '  '));
  console.log('');

  const flagged = audited.findings.filter((f) => f.severity !== Severity.WITHIN_NORMS);
  const passed = audited.findings.filter((f) => f.severity === Severity.WITHIN_NORMS);

  // Only the figures somebody could actually be owed. A distance above a
  // published national range is not money in dispute and is never added here.
  const disputed = flagged
    .filter((f) => f.impactKind === 'arithmetic_discrepancy' || f.impactKind === 'amount_above_a_statutory_cap')
    .reduce((s, f) => s + (f.dollarImpact || 0), 0);

  console.log(`  coverage   ${audited.checksRun} of ${audited.checksTotal} checks`
    + `${thin ? '   *** BELOW THE FLOOR — this customer is refunded automatically ***' : ''}`);
  console.log(`  findings   ${flagged.length} flagged, ${passed.length} passed`);
  console.log(`  in dispute ${disputed ? money(disputed) : 'nothing proved against the estimate\'s own figures'}`);
  console.log('');

  for (const finding of flagged) {
    const amount = finding.dollarImpact ? `  ${money(finding.dollarImpact)}` : '';
    console.log(`  [${finding.severity}]${amount}`);
    console.log(wrap(finding.title, '    '));
    console.log(wrap(finding.basis, '      '));
    if (finding.recommendedAction) console.log(wrap(`-> ${finding.recommendedAction}`, '      '));
    if (finding.citation) console.log(wrap(`cite: ${finding.citation}`, '      '));
    console.log('');
  }

  if (passed.length) {
    console.log(`  ${rule('-').slice(2)}`);
    console.log('  passed:');
    for (const finding of passed) console.log(wrap(`· ${finding.title}`, '    '));
    console.log('');
  }

  if (audited.skipped.length) {
    console.log('  could not run:');
    for (const skipped of audited.skipped) console.log(wrap(`· ${skipped}`, '    '));
    console.log('');
  }

  console.log(`  drafted emails: ${emails.length || 'none — nothing to ask any of these contractors'}`);
  for (const email of emails) {
    console.log(`    to ${email.to || email.quote}: ${email.pointCount} points`
      + `${email.heldBack ? `, ${email.heldBack} held back` : ''}`);
    if (showEmails) {
      console.log('');
      console.log(email.body.split('\n').map((l) => `      ${l}`).join('\n'));
      console.log('');
    }
  }
}

console.log(`\n${rule('=')}`);
console.log(`${CASES.length} fixtures. Run with --email to print the drafted emails in full.`);
