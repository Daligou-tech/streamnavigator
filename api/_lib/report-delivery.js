'use strict';

// Getting the finished report to the customer when they are not watching.
//
// Ten product pages promise "Delivered automatically". What that meant until
// 2026-09-10 was: the report renders on the status page, and JavaScript on
// that page emails a PDF copy. Both halves need the customer's browser to be
// open on the status page at the moment generation completes.
//
// The ordinary thing to do after paying is close the tab. Do that, and
// api/generate-paid-navigator.js generates the report on its next sweep —
// correctly, completely, and into a database row nobody is told about. No
// email is sent, because nothing outside the browser sends one. The Stripe
// webhook sends nothing either. And the only route back to the report was
// localStorage in the one browser the purchase was made from, so clearing site
// data or opening the receipt on a phone lost it permanently.
//
// A paid report that reaches nobody is the most expensive defect a product
// like this can have, because it is invisible: the row says 'complete', the
// money is collected, and the customer simply never hears back.
//
// So the sweep — the path that by definition runs when the customer is NOT
// watching — now delivers the report itself, with a link that works on any
// device. The browser path is untouched; the marker written here is what stops
// the two sending twice.

const { buildReportPdfBuffer } = require('./pdf-report');

const SITE = 'https://streamnavigator.ai';

// Sent once per submission. Recorded in form_data rather than a new column so
// this needs no migration to go live — the marker is small, it belongs to the
// submission, and the alternative was shipping the fix a schema change later.
const MARKER = 'report_emailed_at';

function statusLink(submission) {
  const params = new URLSearchParams({
    id: submission.id,
    t: submission.access_token,
  });
  if (submission.product) params.set('p', submission.product);
  return `${SITE}/navigator-status?${params.toString()}`;
}

function body(submission, link) {
  return [
    'Your StreamNavigator report is ready.',
    '',
    'A PDF copy is attached. You can also open it here, on any device:',
    link,
    '',
    'Keep this link — it is the way back to your report if you clear your browser '
      + 'or switch devices.',
    '',
    'Questions about anything in it? Reply to this email or write to hello@streamnavigator.ai.',
  ].join('\n');
}

// Returns a short reason string rather than throwing, because every caller is
// in a path where the report has already been produced and stored. Failing to
// send the email is bad; losing the report because the email failed would be
// worse, and that is the trade this signature encodes.
async function deliverReportByEmail(admin, submissionId) {
  const { data: submission, error: subError } = await admin
    .from('navigator_submissions')
    .select('id, product, status, email, access_token, form_data, stripe_checkout_session_id')
    .eq('id', submissionId)
    .maybeSingle();

  if (subError || !submission) return 'submission_not_found';
  if (submission.status !== 'complete') return 'not_complete';
  if (!submission.email) return 'no_email_on_file';
  if (!submission.access_token) return 'no_access_token';
  if ((submission.form_data || {})[MARKER]) return 'already_sent';

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) return 'email_not_configured';

  const { data: reportRow } = await admin
    .from('navigator_reports')
    .select('report_json')
    .eq('submission_id', submissionId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!reportRow || !reportRow.report_json) return 'no_report_row';

  // Claimed BEFORE the send, not after.
  //
  // The sweep runs every five minutes and the same row can be picked up again
  // if anything after this point is slow. Between a customer missing one email
  // and a customer receiving the same report every five minutes until someone
  // notices, the first is recoverable and the second is not — this is the same
  // trade api/rental-reminders.js makes, for the same reason.
  await admin
    .from('navigator_submissions')
    .update({
      form_data: { ...(submission.form_data || {}), [MARKER]: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    })
    .eq('id', submissionId);

  let pdfBuffer;
  try {
    pdfBuffer = await buildReportPdfBuffer(reportRow.report_json, {
      generatedAt: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    });
  } catch (err) {
    console.error(`[report-delivery] PDF build failed for ${submissionId}:`, err.message);
    // The link still works without the attachment, and a customer who can read
    // their report on the web has not lost anything they paid for. Sending the
    // plain email beats sending nothing.
    pdfBuffer = null;
  }

  const link = statusLink(submission);
  const payload = {
    from: RESEND_FROM_EMAIL,
    to: submission.email,
    subject: 'Your StreamNavigator report is ready',
    text: body(submission, link),
  };
  if (pdfBuffer) {
    payload.attachments = [{
      filename: 'streamnavigator-report.pdf',
      content: pdfBuffer.toString('base64'),
    }];
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error(`[report-delivery] Resend rejected ${submissionId}: ${errText.slice(0, 200)}`);
      // Release the claim so the next sweep tries again. A rejection is the one
      // case we know the mail did not go, which is exactly when repeating is
      // safe — the ambiguous case, a request that never came back, keeps its
      // claim and stays sent-once.
      await admin
        .from('navigator_submissions')
        .update({ form_data: { ...(submission.form_data || {}) }, updated_at: new Date().toISOString() })
        .eq('id', submissionId);
      return 'send_rejected';
    }
  } catch (err) {
    console.error(`[report-delivery] send failed after the claim for ${submissionId}:`, err.message);
    return 'send_failed';
  }

  return 'sent';
}

// statusLink is exported rather than kept private because api/email-report-pdf.js
// needs the same URL. Two hand-written copies of one link is how the closing
// letters ended up with two different wordings for one letter — see
// docs/REPORT-CONSISTENCY-AUDIT.md. One builder, two callers.
module.exports = { deliverReportByEmail, statusLink, __internal: { statusLink, body, MARKER } };
