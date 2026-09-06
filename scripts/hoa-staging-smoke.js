#!/usr/bin/env node
// Cheap end-to-end check of the staged HOA job (api/hoa-job.js).
//
// Builds two small but genuinely contradictory documents, uploads them the
// way a browser does, and creates a real submission. The point is to exercise
// the part that is new and expensive to get wrong — two evidence stages
// across separate invocations, then a synthesis stage that has to notice the
// contradiction — without paying for a full reserve study.
//
// The planted facts, and what a correct report must find:
//
//   reserve balance 412,500 / fully funded 1,650,000       -> 25% funded
//   study recommends 198,000/yr, budget funds 96,000/yr    -> ~102,000 short
//   roof due 2028 at 940,000 against 412,500 in reserves   -> unfunded project
//   88 units                                               -> per-unit maths
//
// Neither document contains those conclusions. They only exist in the
// comparison between the two, which is precisely what the synthesis stage was
// added to do, and what the old single-pass engine could not have reached
// once a real package stopped fitting in one invocation.
//
// Usage:  node scripts/hoa-staging-smoke.js [https://www.streamnavigator.ai]
//
// Prints the submission id. Flip it to 'paid' and the cron takes it from
// there, one stage per minute.

'use strict';

const PDFDocument = require('pdfkit');

const BASE = process.argv[2] || 'https://www.streamnavigator.ai';
const EMAIL = 'qa-test+staged@streamnavigator.ai';

const DOCS = [
  {
    name: 'Oak Grove Reserve Study 2026.pdf',
    lines: [
      'OAK GROVE CONDOMINIUM ASSOCIATION',
      'Reserve Study Summary - January 2026',
      '',
      'Total units: 88',
      'Current reserve balance: $412,500',
      'Fully funded balance: $1,650,000',
      'Recommended annual reserve contribution: $198,000',
      '',
      'Major components:',
      'Roof replacement, scheduled 2028, estimated cost $940,000',
      'Elevator modernization, scheduled 2035, estimated cost $310,000',
      '',
      'This study does not review the association operating budget and does',
      'not confirm what is actually being contributed.',
    ],
  },
  {
    name: 'Oak Grove 2026 Operating Budget.pdf',
    lines: [
      'OAK GROVE CONDOMINIUM ASSOCIATION',
      '2026 Adopted Operating Budget',
      '',
      'Monthly assessment per unit: $385',
      'Annual assessment revenue: $406,560',
      'Annual transfer to reserve fund: $96,000',
      'Operating expenses: $402,000',
      'Allowance for delinquent accounts: $12,000',
      '',
      'No special assessment is contemplated in this budget year.',
    ],
  },
];

function makePdf(lines) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 54 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(11);
    for (const line of lines) doc.text(line || ' ');
    doc.end();
  });
}

async function uploadOne(name, buffer) {
  const signed = await fetch(`${BASE}/api/navigator-upload-url`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product: 'hoa',
      filename: name,
      contentType: 'application/pdf',
      size: buffer.length,
    }),
  }).then((r) => r.json());

  if (!signed.ok) throw new Error(`upload-url failed: ${signed.error}`);

  const put = await fetch(signed.signedUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/pdf' },
    body: buffer,
  });
  if (!put.ok) throw new Error(`PUT failed for ${name}: ${put.status}`);

  console.log(`  uploaded ${name} (${(buffer.length / 1024).toFixed(1)} KB)`);
  return signed.path;
}

(async () => {
  console.log(`Base: ${BASE}`);
  const uploadedPaths = [];
  for (const d of DOCS) {
    uploadedPaths.push(await uploadOne(d.name, await makePdf(d.lines)));
  }

  const intake = await fetch(`${BASE}/api/navigator-intake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product: 'hoa',
      email: EMAIL,
      formData: { description: 'QA: staged-job smoke test. 88-unit condo.' },
      uploadedPaths,
    }),
  }).then((r) => r.json());

  if (!intake.ok) throw new Error(`intake failed: ${intake.error}`);

  console.log(`\nsubmission_id: ${intake.id}`);
  console.log('Set status to paid and the cron will advance one stage per minute.');
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
