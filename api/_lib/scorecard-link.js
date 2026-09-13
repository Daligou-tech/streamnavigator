// Emails the customer a way back into their own free scorecard.
//
// The scorecard lived in one browser tab. Close it to think, or open the page
// on a phone to show a spouse, and it was gone — and the only way back was to
// re-upload the largest document they will sign this decade. That is the
// costliest friction in the product, because it sits exactly where someone
// pauses before deciding to pay.
//
// Sent at most once per submission, and only when the customer actually gave an
// address. A scorecard run without one stays tab-only, which is the behaviour
// they chose by not typing an email.
//
// The link carries the submission's access token, so it is a private address
// rather than a guessable one — the same property the old copy claimed and the
// same token the paid report already relies on.

'use strict';

const SITE = process.env.SITE_URL || 'https://streamnavigator.ai';

// In form_data rather than a column, for the reason report-delivery.js gives
// for its own marker: the flag belongs to the submission, it is small, and it
// needs no migration to ship.
const MARKER = 'scorecard_link_emailed_at';

function scorecardLink(submission) {
  const params = new URLSearchParams({
    id: submission.id,
    t: submission.access_token,
  });
  return `${SITE}/closing-scorecard?${params.toString()}`;
}

function body(link) {
  return [
    'Here is the way back into the free scorecard you just ran.',
    '',
    link,
    '',
    'It reopens on any device, and nothing has been charged. The full audit is still',
    'there to buy if you want it, and the scorecard is yours either way.',
    '',
    'One thing worth knowing: this link is private to your closing figures, so treat it',
    'the way you would the document itself.',
    '',
    'Questions? Reply to this email or write to hello@streamnavigator.ai.',
  ].join('\n');
}

// Returns a short reason string rather than throwing. Every caller is in a path
// where the scorecard has already been produced and shown; failing to send this
// email is a missed convenience, and losing the scorecard because the email
// failed would be the actual harm.
async function emailScorecardLink(admin, submission) {
  if (!submission || !submission.email) return 'no_email';
  if (!submission.access_token) return 'no_access_token';

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) return 'email_not_configured';

  const formData = submission.form_data || {};
  if (formData[MARKER]) return 'already_sent';

  // Claim before sending. A request that never comes back keeps its claim and
  // stays sent-once, which is the right side to err on for an unsolicited
  // email — a duplicate reads as spam from a brand the customer has not paid.
  const { error: claimError } = await admin
    .from('navigator_submissions')
    .update({
      form_data: { ...formData, [MARKER]: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    })
    .eq('id', submission.id);
  if (claimError) return 'claim_failed';

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: submission.email,
        subject: 'Your free Closing Disclosure scorecard',
        text: body(scorecardLink(submission)),
      }),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error(`[scorecard-link] Resend rejected ${submission.id}: ${errText.slice(0, 200)}`);
      return 'send_failed';
    }
  } catch (err) {
    console.error(`[scorecard-link] send failed for ${submission.id}: ${err.message}`);
    return 'send_failed';
  }

  return 'sent';
}

module.exports = { emailScorecardLink, scorecardLink, __internal: { body, MARKER } };
