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
async function sendFailureAlert({ submissionId, product, error }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const to = process.env.ALERT_EMAIL_TO;
  if (!apiKey || !from || !to) return;

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
        subject: `StreamNavigator: a "${product}" submission failed`,
        text: `A "${product}" Navigator submission failed after exhausting every retry/repair attempt — a customer paid and did not receive their report.\n\nSubmission ID: ${submissionId}\nProduct: ${product}\nError: ${error}\n\nLook it up in Supabase (navigator_submissions table, id = ${submissionId}) to investigate or issue a refund.`,
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
