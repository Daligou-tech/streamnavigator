// Status/report endpoint polled by every Navigator product page after a
// customer returns from Stripe. Takes { id, token } (both handed back by
// api/navigator-intake.js and stashed in the browser's localStorage), and
// returns where things stand.
//
// For Contractor Navigator specifically: the first time this is called for
// a submission that Stripe has marked "paid" and that doesn't have a
// report yet, it triggers the actual analysis (api/_lib/contractor-engine)
// right here and waits for it — a lazy trigger, rather than doing that
// work inside the Stripe webhook, so the webhook stays fast and simple and
// Stripe never has to wait on an AI call. Subsequent polls just return the
// finished report.

const { getSupabaseAdmin } = require('./_lib/supabaseAdmin');
const { generateContractorReport } = require('./_lib/contractor-engine');

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
  if (!id || !token) {
    res.status(400).json({ ok: false, error: 'Missing id or token' });
    return;
  }

  const admin = getSupabaseAdmin();

  const { data: submission, error } = await admin
    .from('navigator_submissions')
    .select('id, product, status, access_token, error, created_at')
    .eq('id', id)
    .maybeSingle();

  if (error || !submission || submission.access_token !== token) {
    res.status(404).json({ ok: false, error: 'Not found' });
    return;
  }

  if (submission.product === 'contractor' && submission.status === 'paid') {
    try {
      await generateContractorReport(submission.id);
    } catch (err) {
      // Swallow here — the submission row now carries status:'failed' and
      // an error message via contractor-engine's own catch block, which is
      // what the response below reports back to the browser.
    }
  }

  const { data: fresh } = await admin
    .from('navigator_submissions')
    .select('id, product, status, error')
    .eq('id', id)
    .single();

  const result = { ok: true, status: fresh.status, product: fresh.product, error: fresh.error || null };

  if (fresh.product === 'contractor' && fresh.status === 'complete') {
    const { data: report } = await admin
      .from('contractor_reports')
      .select('report_json, negotiation_email, created_at')
      .eq('submission_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (report) {
      result.report = report.report_json;
      result.negotiation_email = report.negotiation_email;
    }
  }

  res.status(200).json(result);
};
