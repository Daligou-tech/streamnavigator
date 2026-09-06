// Sends a plain-text email alert whenever a Navigator submission is
// permanently marked 'failed' (exhausted every retry/repair attempt) —
// added 2026-09-01 after a full day of the 'buying' pipeline failing
// silently: nobody found out a customer had paid and gotten nothing until
// someone went looking. This closes that gap for every product, not just
// buying, since any of them can hit the same "ran out of attempts" path.
//
// Uses Resend's HTTP API directly (https://resend.com) via plain fetch —
// the same service and pattern api/refresh-shows.js already uses for
// customer-facing pause/resume emails (see sendActionEmail there), reusing
// its RESEND_API_KEY / RESEND_FROM_EMAIL environment variables rather than
// inventing new ones — if that feature is already configured, this one
// works immediately with no extra setup. Requires:
//   RESEND_API_KEY   — from the Resend dashboard (shared with refresh-shows.js)
//   RESEND_FROM_EMAIL — the verified "from" address (shared with refresh-shows.js)
//   ALERT_EMAIL_TO   — where THIS alert (to the site owner, not a customer)
//                       should be sent; refresh-shows.js has no equivalent
//                       since its emails go to individual customers instead.
//
// Deliberately fails silently (logs, never throws): a broken alert should
// never be the thing that turns a handled failure into an unhandled one.
// Also deliberately does nothing at all if the env vars aren't set yet,
// so this is safe to deploy before Resend is configured.
// `refundQueued` says whether the money is already on its way back. Products
// differ: HOA marks refund_state='due' the moment it gives up and
// api/process-refunds.js returns the payment within ten minutes, while the
// others still need a person. Telling an operator to "issue a refund" for a
// payment that has already been returned is how a customer gets refunded
// twice, so the closing line has to follow the product's actual behaviour.
// Defaults to false, which keeps the original wording for every existing
// caller.
async function sendFailureAlert({ submissionId, product, error, refundQueued = false, paused = false }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const to = process.env.ALERT_EMAIL_TO;
  if (!apiKey || !from || !to) return;

  // A paused submission has not failed, so the subject and opening line must
  // not say it has. An operator who reads "failed — a customer paid and did
  // not receive their report" will go and refund someone whose report is
  // still on its way.
  const subject = paused
    ? `StreamNavigator: a "${product}" submission is paused (not failed)`
    : `StreamNavigator: a "${product}" submission failed`;

  const lead = paused
    ? `A "${product}" Navigator submission has been paused and will resume by itself. It has NOT failed and the customer will still get their report.`
    : `A "${product}" Navigator submission failed after exhausting every retry/repair attempt — a customer paid and did not receive their report.`;

  let closing;
  if (paused) {
    // Not a failure at all. Saying "issue a refund" here would be actively
    // wrong — the customer is still getting their report.
    closing = `NOTHING IS OWED and no action is needed. This report has not failed, it is waiting, and it resumes on its own. The row stays at status 'processing' and keeps every document already read.\n\nSubmission: ${submissionId}`;
  } else if (refundQueued) {
    closing = `A refund has ALREADY been queued automatically. api/process-refunds.js returns the payment within ten minutes and records the outcome in this row's refund_state. Do not refund this by hand unless refund_state reads 'failed' — doing so would refund the customer twice.\n\nLook it up in Supabase (navigator_submissions table, id = ${submissionId}) if you want to see what happened.`;
  } else {
    closing = `Look it up in Supabase (navigator_submissions table, id = ${submissionId}) to investigate or issue a refund.`;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to,
        subject,
        text: `${lead}\n\nSubmission ID: ${submissionId}\nProduct: ${product}\nError: ${error}\n\n${closing}`,
      }),
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      console.warn(`[alerts] Resend API returned ${response.status} for submission ${submissionId}: ${bodyText.slice(0, 300)}`);
    }
  } catch (err) {
    console.warn(`[alerts] Failed to send failure alert for submission ${submissionId}: ${String((err && err.message) || err)}`);
  }
}

module.exports = { sendFailureAlert };
