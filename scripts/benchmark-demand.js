#!/usr/bin/env node
// Which county should we benchmark next?
//
// Building coverage for a county you have no customers in is wasted work. Every
// scorecard already extracts the property's state and county, so the answer is
// sitting in the database — this ranks jurisdictions by how many real customers
// you have there, crossed against how much of the corpus already covers them.
//
// Usage:
//   node scripts/benchmark-demand.js
//   node scripts/benchmark-demand.js --days 90 --top 30
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment, the same
// two the API functions use. Pull them with `vercel env pull` or export them.

const path = require('path');
const { getSupabaseAdmin } = require(path.join(__dirname, '..', 'api', '_lib', 'supabaseAdmin'));
const { makeGetBenchmark, coverageFor } = require(path.join(__dirname, '..', 'api', '_lib', 'benchmark-corpus'));
const corpus = require(path.join(__dirname, '..', 'data', 'benchmarks.json'));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const days = Number(arg('days', 180));
  const top = Number(arg('top', 25));
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const getBenchmark = makeGetBenchmark(corpus.rows);
  const admin = getSupabaseAdmin();

  const { data, error } = await admin
    .from('navigator_submissions')
    .select('id, created_at, form_data')
    .eq('product', 'closing')
    .gte('created_at', since)
    .limit(10000);

  if (error) throw error;

  const byJurisdiction = new Map();
  let noExtraction = 0;

  for (const row of data || []) {
    const e = (row.form_data || {}).extraction;
    if (!e || !e.property_state) { noExtraction++; continue; }
    const key = `${e.property_county || '(county unknown)'}|${e.property_state}`;
    const entry = byJurisdiction.get(key) || {
      state: e.property_state,
      county: e.property_county || null,
      count: 0,
      loanAmounts: [],
    };
    entry.count++;
    if (typeof e.loan_amount === 'number') entry.loanAmounts.push(e.loan_amount);
    byJurisdiction.set(key, entry);
  }

  const ranked = [...byJurisdiction.values()]
    .map((j) => {
      const medianLoan = j.loanAmounts.length
        ? j.loanAmounts.slice().sort((a, b) => a - b)[Math.floor(j.loanAmounts.length / 2)]
        : null;
      const cov = coverageFor(getBenchmark, {
        state: j.state, county: j.county, loanAmount: medianLoan, salePrice: medianLoan,
      });
      return { ...j, medianLoan, coverage: cov.pct, missing: cov.missing };
    })
    // Highest volume with the worst coverage first — that is where a day's work
    // buys the most answered questions.
    .sort((a, b) => (b.count * (100 - b.coverage)) - (a.count * (100 - a.coverage)))
    .slice(0, top);

  const total = (data || []).length;
  console.log(`\nClosing submissions in the last ${days} days: ${total}`);
  console.log(`Without usable extraction (unreadable or wrong document): ${noExtraction}`);
  console.log(`Distinct jurisdictions: ${byJurisdiction.size}\n`);

  if (!ranked.length) {
    console.log('No jurisdictions yet — run some scorecards first.\n');
    return;
  }

  console.log('Build these next (volume x coverage gap):\n');
  console.log('  ' + 'JURISDICTION'.padEnd(34) + 'N'.padStart(5) + '  COV'.padStart(6) + '   MISSING');
  console.log('  ' + '-'.repeat(90));
  for (const j of ranked) {
    const name = `${j.county || '?'}, ${j.state}`.slice(0, 33);
    console.log(
      '  ' + name.padEnd(34) +
      String(j.count).padStart(5) +
      `${j.coverage}%`.padStart(6) + '   ' +
      j.missing.slice(0, 4).join(', ') + (j.missing.length > 4 ? ` +${j.missing.length - 4}` : '')
    );
  }

  const states = new Map();
  for (const j of byJurisdiction.values()) {
    states.set(j.state, (states.get(j.state) || 0) + j.count);
  }
  console.log('\nBy state:\n');
  for (const [st, n] of [...states].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${st.padEnd(6)}${String(n).padStart(5)}`);
  }
  console.log('');
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  console.error('Make sure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.\n');
  process.exit(1);
});
