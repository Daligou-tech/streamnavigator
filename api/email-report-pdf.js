// Lets a customer request an emailed PDF copy of their completed report —
// added 2026-09-01. Takes { id, token, email } (id/token the same way
// api/get-navigator-submission.js does; email typed in by the customer at
// request time, since it isn't always collected at intake — see
// api/navigator-intake.js, where it's optional).
//
// Deliberately its own small endpoint rather than folded into
// get-navigator-submission.js: that endpoint is polled every few seconds
// while a report generates and needs to stay fast and simple, while this
// one only runs once, on an explicit customer click, and does real (if
// modest) work — building a PDF and calling out to Resend.

const { getSupabaseAdmin } = require('./_lib/supabaseAdmin');
const { buildReportPdfBuffer } = require('./_lib/pdf-report');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (err) { body = {}; }
  }
  body = body || {};

  const id = String(body.id || '');
  const token = String(body.token || '');
  const email = typeof body.email === 'string' ? body.email.trim().slice(0, 320) : '';

  if (!id || !token) {
    res.status(400).json({ ok: false, error: 'Missing id or token' });
    return;
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ ok: false, error: 'A valid email address is required.' });
    return;
  }

  const admin = getSupabaseAdmin();

  const { data: submission, error: subError } = await admin
    .from('navigator_submissions')
    .select('id, product, status, access_token, email')
    .eq('id', id)
    .maybeSingle();

  if (subError || !submission || submission.access_token !== token) {
    res.status(404).json({ ok: false, error: 'Not found' });
    return;
  }

  if (submission.status !== 'complete') {
    res.status(400).json({ ok: false, error: 'This report is not finished yet — try again once it completes.' });
    return;
  }

  const { data: reportRow, error: reportError } = await admin
    .from('navigator_reports')
    .select('report_json')
    .eq('submission_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (reportError || !reportRow || !reportRow.report_json) {
    res.status(404).json({ ok: false, error: 'No report found for this submission.' });
    return;
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    res.status(500).json({ ok: false, error: 'Email delivery is not configured yet.' });
    return;
  }

  let pdfBuffer;
  try {
    pdfBuffer = await buildReportPdfBuffer(reportRow.report_json, {
      generatedAt: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    });
  } catch (err) {
    // Logged in full — a silent catch here was exactly the diagnostic gap
    // that made an earlier failure in this incident (2026-09-01) hard to
    // track down; the actual error (e.g. a missing bundled font data file
    // in the deployed function) is exactly what's needed to fix it.
    console.error(`[email-report-pdf] PDF generation failed for submission ${id}:`, err);
    res.status(500).json({ ok: false, error: 'Could not generate the PDF.' });
    return;
  }

  try {
    const resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: email,
        subject: 'Your StreamNavigator report (PDF)',
        text: 'Attached is a PDF copy of your StreamNavigator report. Thanks for using StreamNavigator!',
        attachments: [{ filename: 'streamnavigator-report.pdf', content: pdfBuffer.toString('base64') }],
      }),
    });
    if (!resendResponse.ok) {
      const errText = await resendResponse.text().catch(() => '');
      res.status(502).json({ ok: false, error: `Email provider error: ${errText.slice(0, 200)}` });
      return;
    }
  } catch (err) {
    console.error(`[email-report-pdf] Resend request failed for submission ${id}:`, err);
    res.status(502).json({ ok: false, error: 'Could not send the email.' });
    return;
  }

  // Best-effort: keep a record of the email on the submission if one
  // wasn't already collected at intake. Never lets a failure here affect
  // the response — the email has already been sent successfully by this
  // point, which is what actually matters to the customer.
  if (!submission.email) {
    try {
      await admin.from('navigator_submissions').update({ email }).eq('id', id);
    } catch (err) {
      // Intentionally ignored.
    }
  }

  res.status(200).json({ ok: true });
};
