#!/usr/bin/env node
'use strict';

/**
 * check-suppression.js — run this over a contact CSV before every send.
 *
 * Apollo's own opt-out handling is a paid feature (its unsubscribe link is a
 * tracked link, and the free plan answers "Your current plan does not support
 * email tracking"), so opt-outs are collected by unsubscribe.html /
 * api/unsubscribe.js into public.suppression_list instead. That table is only
 * worth having if something actually reads it, and this is that something.
 *
 * CAN-SPAM gives ten business days to honor an opt-out. In practice that means
 * this has to run immediately before a batch goes out, not once at the start of
 * a campaign — somebody who unsubscribes on day 2 must not receive the day 4
 * follow-up.
 *
 * Reads nothing but the CSV and the table. Writes only the file you name with
 * --out. It cannot send anything and cannot modify the suppression list.
 *
 * Usage:
 *   node scripts/check-suppression.js <contacts.csv>
 *   node scripts/check-suppression.js <contacts.csv> --out clean.csv
 *
 * Exit code 0 = safe to send (nothing suppressed, or a cleaned file was
 *               written).
 *            1 = suppressed addresses are still in the list you passed.
 */

const fs = require('fs');
const path = require('path');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);

// ---------- CSV ----------
// The prospect lists carry firm names like "Impact Real Estate, LLC", so a
// split(',') would silently shift every column after it and read an email
// address out of the wrong field. Small parser, correct quoting.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += ch;
      continue;
    }

    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

function toCsvLine(values) {
  return values
    .map((v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    })
    .join(',');
}

// ---------- the decision ----------
// Pure, so the part that decides who gets emailed can be tested without a
// database. Everything else in this file is I/O and printing.
//
// `suppressed` is a Set of lowercased addresses. Matching is case-insensitive
// because "Genevieve@kwdulles.com" in a CSV and "genevieve@kwdulles.com" typed
// into the unsubscribe form are the same person, and treating them as two would
// mail somebody who asked not to be mailed.
function partitionBySuppression(rows, suppressed) {
  const header = rows[0].map((h) => h.trim());
  const emailCol = header.findIndex((h) => h.toLowerCase() === 'email');
  if (emailCol === -1) return { header, emailCol: -1, hits: [], clean: [], noEmail: [] };

  const contacts = rows.slice(1).map((r) => ({
    row: r,
    email: (r[emailCol] || '').trim().toLowerCase(),
  }));

  return {
    header,
    emailCol,
    // A row with no email address cannot be matched against the list, so it is
    // kept rather than dropped — losing a contact to a blank cell is silent
    // data loss, and a blank cell is not an opt-out either.
    hits: contacts.filter((e) => e.email && suppressed.has(e.email)),
    clean: contacts.filter((e) => !e.email || !suppressed.has(e.email)),
    noEmail: contacts.filter((e) => !e.email),
  };
}

module.exports = { parseCsv, toCsvLine, partitionBySuppression };

// ---------- CLI ----------
async function main(csvPath, outPath) {
  const { createClient } = require('@supabase/supabase-js');

  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  if (rows.length < 2) {
    console.error(`\n  ${csvPath} has no data rows.\n`);
    process.exit(1);
  }

  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Pull the whole list rather than querying per contact. It is a few hundred
  // rows at most, and one round trip cannot half-succeed the way 115 of them
  // can — a network blip mid-loop would otherwise report an opted-out person
  // as safe to email.
  const suppressed = new Set();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from('suppression_list')
      .select('email')
      .range(from, from + PAGE - 1);

    if (error) {
      console.error('\n  ' + red('Could not read the suppression list: ') + error.message);
      console.error('  ' + dim('Nothing has been checked. Do not send.') + '\n');
      process.exit(1);
    }
    for (const r of data) suppressed.add(String(r.email).trim().toLowerCase());
    if (data.length < PAGE) break;
  }

  const { header, emailCol, hits, clean, noEmail } = partitionBySuppression(rows, suppressed);

  if (emailCol === -1) {
    console.error(`\n  No "email" column in ${csvPath}. Columns found: ${header.join(', ')}\n`);
    process.exit(1);
  }

  console.log('');
  console.log(`  ${bold(path.basename(csvPath))}`);
  console.log(`  ${rows.length - 1} contacts · ${suppressed.size} addresses on the suppression list`);
  console.log('');

  if (noEmail.length) {
    console.log(`  ${yellow('!')} ${noEmail.length} row(s) have no email address and were left in place.`);
    console.log('');
  }

  if (!hits.length) {
    console.log(`  ${green('OK')}  Nobody in this file has opted out.`);
    console.log('');
    if (outPath) {
      fs.writeFileSync(outPath, rows.map(toCsvLine).join('\n') + '\n');
      console.log(`  Wrote ${outPath} (unchanged — nothing to remove).`);
      console.log('');
    }
    process.exit(0);
  }

  console.log(`  ${red('STOP')}  ${hits.length} contact(s) in this file have opted out:`);
  console.log('');
  for (const h of hits) console.log(`      ${h.email}`);
  console.log('');

  if (!outPath) {
    console.log('  Re-run with --out to write a copy with these rows removed:');
    console.log(`      node scripts/check-suppression.js ${csvPath} --out cleaned.csv`);
    console.log('');
    console.log('  ' + bold(red('Do not send this file as it stands.')));
    console.log('');
    process.exit(1);
  }

  fs.writeFileSync(outPath, [header, ...clean.map((e) => e.row)].map(toCsvLine).join('\n') + '\n');
  console.log(`  ${green('Wrote')} ${outPath} — ${clean.length} contacts, ${hits.length} removed.`);
  console.log('  Send that file, not the original.');
  console.log('');
  process.exit(0);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const outPath = outIdx !== -1 ? argv[outIdx + 1] : null;
  const csvPath = argv.find((a, i) => !a.startsWith('--') && i !== outIdx + 1);

  if (!csvPath) {
    console.error('');
    console.error('  Usage: node scripts/check-suppression.js <contacts.csv> [--out clean.csv]');
    console.error('');
    process.exit(1);
  }
  if (outIdx !== -1 && !outPath) {
    console.error('\n  --out needs a filename.\n');
    process.exit(1);
  }
  if (!fs.existsSync(csvPath)) {
    console.error(`\n  No such file: ${csvPath}\n`);
    process.exit(1);
  }

  // Same two variables the deployed functions use. They are not in the repo and
  // should not be: SUPABASE_SERVICE_ROLE_KEY bypasses RLS.
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('');
    console.error('  ' + bold('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set.'));
    console.error('');
    console.error('  Both are in the Vercel project under Settings -> Environment Variables,');
    console.error('  or in the Supabase dashboard under Project Settings -> API.');
    console.error('');
    console.error('  PowerShell:');
    console.error('    $env:SUPABASE_URL = "https://xxxx.supabase.co"');
    console.error('    $env:SUPABASE_SERVICE_ROLE_KEY = "eyJ..."');
    console.error('');
    console.error('  ' + dim('Nothing has been checked. Do not send.'));
    console.error('');
    process.exit(1);
  }

  main(csvPath, outPath).catch((err) => {
    console.error('\n  ' + red(err && err.stack ? err.stack : String(err)) + '\n');
    process.exit(1);
  });
}
