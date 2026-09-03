#!/usr/bin/env node
// Adds the page 1 loan-terms and page 5 loan-calculations fields to the CD
// extraction schema.
//
// Written as a patch rather than a replacement file on purpose: your working
// copy of closing-extract.js is ahead of main, and handing you a whole file
// would silently discard those edits.
//
// Safe to run twice. Verifies each anchor exists before touching anything, and
// writes nothing at all if any anchor is missing.
//
// Run from the repo root:
//   node scripts/add-loan-calculations-schema.js
//   node scripts/add-loan-calculations-schema.js --dry-run

'use strict';

const fs = require('fs');
const path = require('path');

const TARGET = path.join(process.cwd(), 'api', '_lib', 'closing-extract.js');
const DRY = process.argv.includes('--dry-run');

const MARKER = 'loan_calculations:';

// --- anchor 1: page 1 loan terms + page 5 loan calculations ----------------

const ANCHOR_TERMS = "      loan_term_years: { type: 'number' },\n";

const INSERT_TERMS = ANCHOR_TERMS + `
      monthly_principal_interest: amountField(
        'The monthly Principal & Interest figure from the Projected Payments table on '
        + 'page 1, for the FIRST payment period only. Not the total monthly payment: '
        + 'exclude escrow and mortgage insurance.'),

      loan_terms_features: {
        type: 'object',
        description:
          'The Loan Terms box on page 1. Each field answers "Can this amount increase '
          + 'after closing?" or "Does the loan have these features?". Report false only '
          + 'when the document says NO. Omit any field whose box you cannot read — an '
          + 'omitted field causes a check to decline, a wrong one causes it to misfire.',
        properties: {
          rate_can_increase:        { type: 'boolean' },
          payment_can_increase:     { type: 'boolean' },
          loan_amount_can_increase: { type: 'boolean' },
          has_balloon_payment:      { type: 'boolean' },
          has_prepayment_penalty:   { type: 'boolean' },
          has_interest_only_period: { type: 'boolean' },
        },
      },

      loan_calculations: {
        type: 'object',
        description:
          'The five figures in the Loan Calculations box on page 5. Transcribe them '
          + 'exactly as printed. NEVER compute one that is missing or unreadable — these '
          + 'are checked against each other, so a computed value would make an '
          + 'inconsistent document look consistent.',
        properties: {
          total_of_payments: amountField('Total of Payments, page 5.'),
          finance_charge:    amountField('Finance Charge, page 5.'),
          amount_financed:   amountField('Amount Financed, page 5.'),
          annual_percentage_rate_pct: {
            type: 'number',
            description: 'Annual Percentage Rate as printed, e.g. 6.665 for 6.665%.',
          },
          total_interest_percentage_pct: {
            type: 'number',
            description: 'Total Interest Percentage as printed, e.g. 71.2 for 71.2%.',
          },
        },
      },

      points_lines: {
        type: 'array',
        description:
          'Any Section A line whose printed label states a percentage of the loan '
          + 'amount, such as "0.75% of Loan Amount (Points)". One entry per such line. '
          + 'Omit the array if no line states a percentage.',
        items: {
          type: 'object',
          properties: {
            points_pct:     { type: 'number', description: 'The percentage as printed, e.g. 0.75.' },
            charged_amount: { type: 'number', description: 'The dollar amount on that line.' },
          },
          required: ['points_pct', 'charged_amount'],
        },
      },
`;

// --- anchor 2: escrow additions --------------------------------------------

const ANCHOR_ESCROW = "        description: 'Section G, initial escrow payment at closing, plus page 4 escrow detail.',\n        properties: {\n";

const INSERT_ESCROW = ANCHOR_ESCROW + `          monthly_escrow_payment: amountField(
            'The monthly Escrow figure from the Projected Payments table on page 1.'),
          escrowed_property_costs_year1: amountField(
            'Estimated Escrowed Property Costs over Year 1, from the escrow account '
            + 'section on page 4.'),
`;

// ---------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(TARGET)) {
    console.error(`Not found: ${TARGET}`);
    console.error('Run this from the repository root.');
    process.exit(1);
  }

  const original = fs.readFileSync(TARGET, 'utf8');

  if (original.includes(MARKER)) {
    console.log('Already patched — loan_calculations is present. Nothing to do.');
    return;
  }

  const problems = [];
  if (!original.includes(ANCHOR_TERMS)) {
    problems.push('could not find the loan_term_years line in the CD schema');
  }
  if (!original.includes(ANCHOR_ESCROW)) {
    problems.push('could not find the escrow properties block');
  }
  if (!original.includes('const amountField =')) {
    problems.push('could not find the amountField helper this patch depends on');
  }
  if ((original.match(new RegExp(ANCHOR_TERMS.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length > 1) {
    problems.push('the loan_term_years anchor appears more than once — placement is ambiguous');
  }

  if (problems.length) {
    console.error('Refusing to patch. Nothing was written.\n');
    problems.forEach((p) => console.error('  - ' + p));
    console.error('\nThe file has moved on from what this patch expects. Apply the two blocks '
      + 'by hand, or send me the current file.');
    process.exit(1);
  }

  const patched = original
    .replace(ANCHOR_TERMS, INSERT_TERMS)
    .replace(ANCHOR_ESCROW, INSERT_ESCROW);

  // Cheap structural check before writing: the file must still parse.
  try {
    // eslint-disable-next-line no-new-func
    new Function(patched);
  } catch (err) {
    console.error('Refusing to patch: the result would not parse.');
    console.error('  ' + err.message);
    process.exit(1);
  }

  const added = patched.split('\n').length - original.split('\n').length;

  if (DRY) {
    console.log(`Dry run: would add ${added} lines to api/_lib/closing-extract.js.`);
    console.log('  + monthly_principal_interest, loan_terms_features, loan_calculations, points_lines');
    console.log('  + escrow.monthly_escrow_payment, escrow.escrowed_property_costs_year1');
    return;
  }

  fs.writeFileSync(TARGET + '.bak', original);
  fs.writeFileSync(TARGET, patched);
  console.log(`Patched api/_lib/closing-extract.js (+${added} lines).`);
  console.log('Backup written to api/_lib/closing-extract.js.bak');
  console.log('\nNext: node test/closing-service.test.js');
}

main();
