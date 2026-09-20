#!/usr/bin/env node
// Live end-to-end test of Insurance Navigator's EXTRACTION half against a
// real model call.
//
// Unlike scripts/live-test-closing.js, this does not go through the
// deployed site, Stripe, or Supabase at all — it calls
// api/_lib/insurance-extract.js's extractInsuranceDocuments() directly, the
// same function api/_lib/navigator-engine.js calls during a real paid
// generation. That is deliberate: the open question this codebase cannot
// currently answer offline is narrow — "does the model read a real renewal
// notice and prior policy correctly?" — and answering it needs exactly one
// model call, not the two a full report costs (extraction + write-up), and
// no write access to production's database. docs/live-report-test-procedure
// notes that a local ANTHROPIC_API_KEY is "not an alternative" for running
// generation, because the full pipeline also needs Supabase — that limit
// does not apply here, since this script never touches Supabase.
//
// The documents come from scripts/make-test-documents.js, which prints
// tests/fixtures/insurance-fixtures.js's homeCoverageCutBehindTheRise() onto
// two realistic-looking PDFs — a renewal notice and a prior-policy
// declarations page — so the correct extraction is known in advance and this
// can ask the only question that matters: did the model read it right?
//
// Usage:
//   node scripts/make-test-documents.js         (if tmp-test-docs/ is empty)
//   ANTHROPIC_API_KEY=sk-... node scripts/live-test-insurance.js
//
// Spends one real model call against whatever account ANTHROPIC_API_KEY
// belongs to. Say so before running this against a shared key — see
// [[say-what-verification-costs]] in project memory.
//
// Writes the raw extraction to tmp-test-docs/insurance-live-extraction.json
// and prints the exact follow-up command to see it graded against ground
// truth:
//   node scripts/insurance-audit-harness.js --compare tmp-test-docs/insurance-live-extraction.json

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { extractInsuranceDocuments } = require('../api/_lib/insurance-extract');

const DOCS = path.join(__dirname, '..', 'tmp-test-docs');
const OUT = path.join(DOCS, 'insurance-live-extraction.json');
const RENEWAL = path.join(DOCS, 'insurance-renewal-notice.pdf');
const PRIOR = path.join(DOCS, 'insurance-prior-policy.pdf');

(async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set. Export it first — this call is billed to whichever key it holds.');
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(RENEWAL) || !fs.existsSync(PRIOR)) {
    console.error(`Missing test documents. Run this first:\n  node scripts/make-test-documents.js`);
    process.exitCode = 1;
    return;
  }

  console.log('Reading the two ground-truth PDFs from tmp-test-docs/ ...');
  const contentBlocks = [RENEWAL, PRIOR].map((file) => ({
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: fs.readFileSync(file).toString('base64'),
    },
  }));

  console.log('Calling extractInsuranceDocuments — one live model call, billed to ANTHROPIC_API_KEY...');
  const started = Date.now();
  let extraction;
  try {
    extraction = await extractInsuranceDocuments(apiKey, contentBlocks);
  } catch (err) {
    console.error(`\nFAILED after ${((Date.now() - started) / 1000).toFixed(1)}s: ${err.message}`);
    if (/credit balance/i.test(err.message)) {
      console.error('This is an account-balance error, not a bug — nothing was billed for a rejected call.');
    }
    process.exitCode = 1;
    return;
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Extraction returned in ${seconds}s.\n`);

  fs.writeFileSync(OUT, JSON.stringify(extraction, null, 2));
  console.log(`Raw extraction written to ${path.relative(process.cwd(), OUT)}`);

  console.log('\n--- what the model read ------------------------------------');
  console.log(`documents_seen: ${(extraction.documents_seen || []).join('; ') || '(none reported)'}`);
  if ((extraction.unreadable || []).length) console.log(`unreadable: ${extraction.unreadable.join('; ')}`);
  console.log(`renewal.premium_total: ${extraction.renewal && extraction.renewal.premium_total}`);
  console.log(`renewal.coverages: ${(extraction.renewal && extraction.renewal.coverages || []).length} lines`);
  console.log(`prior_policy present: ${Boolean(extraction.prior_policy)}`);
  if (extraction.prior_policy) {
    console.log(`prior_policy.premium_total: ${extraction.prior_policy.premium_total}`);
    console.log(`prior_policy.coverages: ${(extraction.prior_policy.coverages || []).length} lines`);
  }

  console.log('\n--- next ------------------------------------------------------');
  console.log('Grade this against ground truth and see what the deterministic audit makes of it:');
  console.log(`  node scripts/insurance-audit-harness.js --compare ${path.relative(process.cwd(), OUT)}`);
})();
