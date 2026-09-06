// Admin-only manual trigger for HOA Navigator's report pipeline — the live
// smoke test for api/_lib/hoa-engine.js. Runs the whole thing end to end
// (Supabase download -> Files API upload -> evidence pass with citations
// and code execution -> structuring pass -> citation validation -> stored
// report) against a real submission id, bypassing the paid-status check.
//
// Same shape and same admin-secret gate as generate-contractor-report.js.
// Not linked from anywhere on the site; call it directly.
//
// This costs real money per run — two Claude Opus 5 passes at xhigh effort
// over the submission's documents. It is deliberately manual for that
// reason. The mocked unit tests in tests/hoa-engine.test.js cover the
// deterministic plumbing (citation harvesting, evidence-index validation,
// schema shape) and cost nothing; use this endpoint when you want to see
// what an actual report looks like before shipping a prompt change.
//
// Usage, once ANTHROPIC_API_KEY and NAVIGATOR_ADMIN_SECRET are set:
//
//   curl -X POST https://streamnavigator.ai/api/generate-hoa-report \
//     -H "content-type: application/json" \
//     -H "x-admin-secret: <your NAVIGATOR_ADMIN_SECRET value>" \
//     -d '{"submission_id":"<uuid from navigator_submissions>"}'
//
// To get a submission id: submit a real HOA package through /hoa.html (it
// will sit at "waiting for payment" — that's fine, this endpoint bypasses
// that on purpose), then look up its id in Supabase Table Editor ->
// navigator_submissions.
//
// The response includes the full report plus an evidence array. Check that
// array first: every citation in it was produced by the API from the
// source document, so if it is empty or thin, the report's findings are
// not actually page-cited and something upstream needs looking at.

const { generateHoaReport } = require('./_lib/hoa-engine');

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
    const report = await generateHoaReport(submissionId);
    res.status(200).json({
      ok: true,
      report,
      // Surfaced separately so a smoke run makes the citation coverage
      // obvious without digging through the report body.
      evidence_count: Array.isArray(report.evidence) ? report.evidence.length : 0,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Report generation failed' });
  }
};
