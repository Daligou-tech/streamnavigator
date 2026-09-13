#!/usr/bin/env node
// Live end-to-end test of the Closing Disclosure Audit against production.
//
// Runs the free scorecard on a real uploaded document, then reports what the
// engine found against what the document actually says. The documents come from
// scripts/make-test-documents.js, where every figure is known in advance — so
// this can ask the only question that matters: did the check fire, on a
// document it had to read for itself?
//
//   node scripts/live-test-closing.js
//
// Uses an @internal.invalid address so the row is marked is_test. Nothing is
// charged; this stops at the free scorecard unless --paid is passed, which
// requires flipping the row to paid in Supabase by hand.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SITE = process.env.SITE_URL || 'https://www.streamnavigator.ai';
const DOCS = path.join(__dirname, '..', 'tmp-test-docs');
const EMAIL = `closing-live+${Date.now()}@internal.invalid`;

const b64 = (f) => fs.readFileSync(path.join(DOCS, f)).toString('base64');

// What the documents actually say. Anything the engine reports that disagrees
// with this is the engine being wrong, not the test.
const TRUTH = {
  'PREPAID_INTEREST': 'billed 22 days; 15 April leaves 16 days to month end (~$339 over)',
  'RATE_VS_ESTIMATE': 'LE 6.5%, CD 6.875% — a rise of 0.375 points, NOT a violation',
  'TRID_ZERO_TOLERANCE': 'underwriting $795 -> $1,095, zero tolerance, $300',
  'TRID_TEN_PERCENT': 'survey $475 -> $700 in section C with a written list; allowed $522.50, excess $177.50',
  'TRANSFER_TAX_TOTAL': 'taxes total $2,625.00, which is exactly statutory for Richmond VA — must VERIFY',
};

async function post(pathname, body) {
  const resp = await fetch(`${SITE}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { /* keep the raw text */ }
  return { status: resp.status, json, text };
}

(async () => {
  console.log(`Site      ${SITE}`);
  console.log(`Email     ${EMAIL}\n`);

  console.log('Uploading the Closing Disclosure and the Loan Estimate...');
  const started = Date.now();
  const res = await post('/api/closing-scorecard', {
    email: EMAIL,
    files: [
      { name: 'closing-disclosure.pdf', dataBase64: b64('closing-disclosure.pdf') },
      { name: 'loan-estimate.pdf', dataBase64: b64('loan-estimate.pdf') },
    ],
    answers: { property_type: 'single_family', provider_list: 'yes', transaction_type: 'purchase' },
  });

  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`HTTP ${res.status} in ${seconds}s\n`);

  if (!res.json || !res.json.ok) {
    console.error('FAILED');
    console.error(res.text.slice(0, 1200));
    process.exitCode = 1;
    return;
  }

  const { id, token, scorecard, error_message } = res.json;
  console.log(`submission ${id}`);
  if (error_message) console.log(`message    ${error_message}`);
  if (!scorecard) {
    console.error('\nNo scorecard was produced.');
    process.exitCode = 1;
    return;
  }

  console.log('\n--- what the engine reported -------------------------------');
  const sc = scorecard;
  const show = (k) => (sc[k] === undefined ? '—' : sc[k]);
  console.log(`checks run/attempted/in scope   ${show('checks_run')} / ${show('checks_attempted')} / ${show('checks_in_scope')}`);
  console.log(`flags                           ${show('flag_count')}`);
  console.log(`priced flags / dollars          ${show('flags_with_dollars')} / ${show('flag_dollars')}`);
  console.log(`loan estimates read             ${show('loan_estimates_read')}`);
  console.log(`charge lines read               ${show('cd_charge_lines')}`);
  console.log(`total closing costs             ${show('total_closing_costs')}`);
  console.log(`verified checks returned        ${(sc.verified || []).length}`);

  if ((sc.verified || []).length) {
    console.log('\nverified (first three):');
    sc.verified.slice(0, 3).forEach((v) => console.log(`  · ${v.title}\n      ${v.basis}`));
  }

  if ((sc.unreadable_fields || []).length) {
    console.log(`\nunreadable fields: ${sc.unreadable_fields.join(', ')}`);
  }

  console.log('\n--- planted defects, against ground truth ------------------');
  const byGroup = sc.coverage_by_group || {};
  const seen = new Set();
  for (const group of Object.values(byGroup)) {
    for (const c of (group && group.checks) || []) seen.add(`${c.id}:${c.status}`);
  }
  for (const [checkId, expectation] of Object.entries(TRUTH)) {
    const hit = [...seen].find((s) => s.startsWith(checkId + ':'));
    console.log(`  ${checkId.padEnd(22)} ${hit ? hit.split(':')[1] : 'NOT IN COVERAGE'}`);
    console.log(`  ${''.padEnd(22)} expected: ${expectation}`);
  }

  console.log('\n--- next -----------------------------------------------------');
  console.log(`To take it through the paid report, flip the row to paid:`);
  console.log(`  update navigator_submissions set status='paid', generation_attempts=0, error=null where id='${id}';`);
  console.log(`then poll:  {"id":"${id}","token":"${token}"}`);

  fs.writeFileSync(path.join(DOCS, 'last-closing-run.json'),
    JSON.stringify({ id, token, scorecard: sc }, null, 2));
  console.log(`\nFull scorecard written to tmp-test-docs/last-closing-run.json`);
})();
