// Admin-only manual trigger for Contractor Navigator's report pipeline —
// lets you test the whole AI analysis end-to-end (upload -> Supabase ->
// Claude -> structured report) using a real submission id, WITHOUT needing
// live Stripe Payment Links wired up yet. Not linked from anywhere on the
// site; call it directly.
//
// Usage, once ANTHROPIC_API_KEY and NAVIGATOR_ADMIN_SECRET are set in this
// Vercel project's environment variables:
//
//   curl -X POST https://streamnavigator.ai/api/generate-contractor-report \
//     -H "content-type: application/json" \
//     -H "x-admin-secret: <your NAVIGATOR_ADMIN_SECRET value>" \
//     -d '{"submission_id":"<uuid from navigator_submissions>"}'
//
// To get a submission id to test with: submit a real estimate through
// /contractor.html (it will get stuck at "waiting for payment" — that's
// fine, this endpoint bypasses that check on purpose for testing), then
// look up its id in Supabase Table Editor -> navigator_submissions.

const { generateContractorReport } = require('./_lib/contractor-engine');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const ADMIN_SECRET = process.env.NAVIGATOR_ADMIN_SECRET;
  if (!ADMIN_SECRET) {
    res.status(500).json({ ok: false, error: 'Missing NAVIGATOR_ADMIN_SECRET env var — set one in Vercel to enable this test endpoint.' });
    return;
  }
  if (req.headers['x-admin-secret'] !== ADMIN_SECRET) {
    res.status(401).json({ ok: false, error: 'Missing or wrong x-admin-secret header' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (err) { body = {}; }
  }
  const submissionId = body && body.submission_id;
  if (!submissionId) {
    res.status(400).json({ ok: false, error: 'Missing submission_id' });
    return;
  }

  try {
    const report = await generateContractorReport(submissionId);
    res.status(200).json({ ok: true, report });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Report generation failed' });
  }
};
