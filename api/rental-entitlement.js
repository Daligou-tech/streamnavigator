// What the rental page asks before offering a returning landlord a free
// re-audit: does the report already in this browser still carry a live year on
// it, and how many audits are left?
//
// Answers only for a caller holding the original submission's access token,
// which is the capability the customer's own browser stored when they bought
// the first report. Deliberately not answerable by email address — an
// entitlement anyone can claim by guessing a customer's email is a coupon.

const { getSupabaseAdmin } = require('./_lib/supabaseAdmin');
const { checkEntitlement } = require('./_lib/rental-entitlement');

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
  const status = await checkEntitlement(admin, id, token);

  // 200 either way. "You have nothing here" is a normal answer to this
  // question, not an error, and the page renders it as the ordinary paid flow.
  res.status(200).json({ ok: true, ...status });
};
