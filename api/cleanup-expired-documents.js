// Deletes uploaded documents once a submission passes the retention period in
// privacy-policy.html.
//
// api/cleanup-staging-uploads.js already sweeps staging/, but that only catches
// uploads that never became a submission. The moment a customer presses the
// button their file is MOVED out of staging into <product>/<submission id>/,
// and from that point nothing in this codebase ever deleted it. The privacy
// policy says uploads are kept "for as long as reasonably needed to deliver
// your report, respond to follow-up questions, and comply with our legal and
// accounting obligations, after which we delete or anonymize it" — and until
// this file existed, the "after which" had no implementation. Every Closing
// Disclosure and HOA reserve study ever uploaded was being kept forever.
//
// These are the worst documents to hold indefinitely for no reason: a Closing
// Disclosure carries the borrower's name, property address, loan number, and
// every figure in the transaction. The reason to delete them is not tidiness,
// it is that a breach three years from now would expose documents the company
// had no remaining use for.
//
// What is deleted and what is kept:
//
//   deleted  the uploaded documents themselves, from Storage
//   kept     the submission row, the generated report, and the payment record
//
// That split is deliberate. The report is derived text the customer paid for
// and may want to re-read; the row is needed to reconcile against Stripe. Only
// the source documents go, and file_paths is emptied at the same moment so no
// row is left pointing at objects that are not there.
//
// Nothing in the codebase reads file_paths after the report is generated —
// the four engines (contractor, hoa, navigator, purchase) read it during
// generation and nothing else touches it — so deleting documents cannot break
// report delivery, a retry, or a customer re-reading their report.
//
// Protected by CRON_SECRET exactly as api/cleanup-staging-uploads.js is, so it
// cannot be triggered from a browser.

'use strict';

const { getSupabaseAdmin } = require('./_lib/supabaseAdmin');

const BUCKET = 'navigator-uploads';

// 90 days.
//
// The floor is set by the closing product, not by an accounting rule: a
// borrower has 60 days after closing to ask their lender to cure a tolerance
// violation, and a customer who finds one in our report may come back during
// that window wanting the document they sent us. 90 gives that window a month
// of slack and is still a period short enough to mean something.
//
// Override with DOCUMENT_RETENTION_DAYS to shorten it — a customer asking for
// earlier deletion is handled by hand under "Your choices & rights", not here.
const DEFAULT_RETENTION_DAYS = 90;

// Rows per run. Generous against current volume (161 submissions total as of
// September 2026) and bounded so one sweep cannot run past the function
// timeout if a backlog ever builds up. Anything left over is picked up an hour
// later.
const BATCH = 200;

function retentionDays() {
  const raw = Number(process.env.DOCUMENT_RETENTION_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS;
}

module.exports = async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  const days = retentionDays();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const admin = getSupabaseAdmin();

  let submissionsSwept = 0;
  let filesDeleted = 0;
  const problems = [];

  try {
    const { data: rows, error: selectError } = await admin
      .from('navigator_submissions')
      .select('id, product, file_paths, created_at')
      .lt('created_at', cutoff)
      .is('files_deleted_at', null)
      .limit(BATCH);

    if (selectError) throw selectError;

    for (const row of rows || []) {
      const paths = Array.isArray(row.file_paths) ? row.file_paths.filter(Boolean) : [];

      // A row with no attachments still gets stamped. Otherwise every
      // document-free submission is re-selected on every run forever, and the
      // sweep spends its whole batch on rows it has nothing to do to.
      if (paths.length) {
        const { error: removeError } = await admin.storage.from(BUCKET).remove(paths);
        if (removeError) {
          problems.push(`${row.id}: ${removeError.message}`);
          // Leave files_deleted_at null so the next run tries again. Stamping
          // a row whose objects are still in the bucket would be a false
          // record of deletion, which is worse than no record.
          continue;
        }
        filesDeleted += paths.length;
      }

      const { error: updateError } = await admin
        .from('navigator_submissions')
        .update({ file_paths: [], files_deleted_at: new Date().toISOString() })
        .eq('id', row.id);

      if (updateError) { problems.push(`${row.id}: ${updateError.message}`); continue; }
      submissionsSwept += 1;
    }
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err.message || err).slice(0, 300),
      submissionsSwept,
      filesDeleted,
    });
    return;
  }

  res.status(200).json({
    ok: true,
    retentionDays: days,
    cutoff,
    submissionsSwept,
    filesDeleted,
    problems,
  });
};
