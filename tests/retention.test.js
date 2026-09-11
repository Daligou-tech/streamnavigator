// Run: node tests/retention.test.js
//
// privacy-policy.html tells customers their uploaded documents are deleted
// after a fixed number of days. That sentence is only true while three
// separate things stay in agreement:
//
//   1. the policy names a retention period,
//   2. api/cleanup-expired-documents.js enforces that same period,
//   3. vercel.json actually schedules it.
//
// Any one of them can be changed without the other two and nothing else would
// notice. Drop the cron entry and the page keeps promising a deletion that
// never runs — which is the state the site was in until this job was written,
// with every Closing Disclosure ever uploaded still sitting in the bucket.
//
// A promise nobody enforces is the failure this suite exists to catch.

'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}\n    ${err.message.split('\n')[0]}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const root = path.join(__dirname, '..');
const policy = fs.readFileSync(path.join(root, 'privacy-policy.html'), 'utf8');
const job = fs.readFileSync(path.join(root, 'api', 'cleanup-expired-documents.js'), 'utf8');
const staging = fs.readFileSync(path.join(root, 'api', 'cleanup-staging-uploads.js'), 'utf8');
const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const uploadLimits = require('../api/_lib/upload-limits');

const CRON_PATH = '/api/cleanup-expired-documents';

// ------------------------------------------------- the three stay in agreement

test('the privacy policy names a retention period in days', () => {
  assert(/deleted automatically (\d+) days/.test(policy),
    'privacy-policy.html no longer states a number of days for document deletion');
});

test('the job enforces exactly the period the policy promises', () => {
  const promised = Number(/deleted automatically (\d+) days/.exec(policy)[1]);
  const enforced = Number(/DEFAULT_RETENTION_DAYS = (\d+)/.exec(job)[1]);
  assert(promised === enforced,
    `policy promises ${promised} days, cleanup-expired-documents.js deletes after ${enforced}`);
});

test('the job is actually scheduled', () => {
  const entry = (vercel.crons || []).find((c) => c.path === CRON_PATH);
  assert(entry, `${CRON_PATH} is not in vercel.json crons — the policy promises a deletion that never runs`);
  assert(typeof entry.schedule === 'string' && entry.schedule.trim(),
    `${CRON_PATH} has no schedule`);
});

// Two sweeps writing to the same bucket at the same minute is not a
// correctness problem, but it is a pointless way to discover a rate limit.
test('the two cleanup sweeps do not run in the same minute', () => {
  const mine = (vercel.crons || []).find((c) => c.path === CRON_PATH);
  const other = (vercel.crons || []).find((c) => c.path === '/api/cleanup-staging-uploads');
  if (!mine || !other) return;
  assert(mine.schedule !== other.schedule,
    `both cleanup jobs are scheduled at "${mine.schedule}"`);
});

// The policy also promises that an abandoned upload goes within 24 hours. That
// one is api/cleanup-staging-uploads.js, and its TTL is a shared constant.
test('the 24-hour claim for abandoned uploads matches STAGING_TTL_HOURS', () => {
  assert(/deleted within 24 hours/.test(policy),
    'privacy-policy.html no longer makes the 24-hour claim for abandoned uploads');
  assert(uploadLimits.STAGING_TTL_HOURS === 24,
    `policy says 24 hours, STAGING_TTL_HOURS is ${uploadLimits.STAGING_TTL_HOURS}`);
});

// --------------------------------------------------------------- the job itself

// Unauthenticated, this endpoint deletes customers' financial documents.
test('the job refuses a request without the cron secret', () => {
  assert(/CRON_SECRET/.test(job), 'cleanup-expired-documents.js does not check CRON_SECRET');
  assert(/401/.test(job), 'the unauthorized path does not return 401');
  assert(/Bearer \$\{cronSecret\}/.test(job), 'the secret is not compared against the Authorization header');
  // Same guard as the sweep that already existed, so one cannot be hardened
  // without noticing the other.
  assert(/CRON_SECRET/.test(staging), 'cleanup-staging-uploads.js lost its CRON_SECRET check');
});

test('only rows past the cutoff are selected', () => {
  assert(/\.lt\('created_at', cutoff\)/.test(job),
    'the sweep does not filter on created_at — it would delete documents inside the retention window');
  assert(/\.is\('files_deleted_at', null\)/.test(job),
    'the sweep does not skip rows it has already swept');
});

// file_paths pointing at objects that are gone is a row that lies about what
// it has, and the engines read that column.
test('file_paths is emptied in the same update that stamps the deletion', () => {
  assert(/file_paths: \[\][\s\S]{0,80}files_deleted_at/.test(job),
    'file_paths and files_deleted_at are not written together');
});

// Stamping a row whose objects are still in the bucket records a deletion that
// did not happen — worse than recording nothing, because it is never retried.
// Sliced by index rather than matched with a lazy regex: the body contains
// `${row.id}`, so a non-greedy scan for the closing brace stops inside the
// template literal and never reaches the `continue`.
test('a failed storage delete does not get stamped as deleted', () => {
  const start = job.indexOf('if (removeError)');
  assert(start !== -1, 'no error branch around the storage remove');
  const end = job.indexOf('filesDeleted +=', start);
  assert(end !== -1, 'the success path does not count deleted files');
  assert(job.slice(start, end).includes('continue'),
    'a failed remove falls through to the update instead of leaving the row for the next run');
});

// The report is what the customer paid for. Deleting it along with the source
// documents would turn a retention policy into data loss.
test('the sweep touches only navigator_submissions', () => {
  const tables = [...job.matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1]);
  const unexpected = tables.filter((t) => t !== 'navigator_submissions' && t !== 'navigator-uploads');
  assert(unexpected.length === 0,
    `the sweep also writes to ${unexpected.join(', ')} — reports and payment records must survive it`);
  assert(!/navigator_reports/.test(job), 'the sweep references the reports table');
});

// ------------------------------------------------------------------- results

if (failures.length) {
  console.log(`\n${passed}/${passed + failures.length} passed\n`);
  for (const f of failures) console.log('  x ' + f);
  console.log('');
  process.exit(1);
}
console.log(`${passed}/${passed} passed`);
