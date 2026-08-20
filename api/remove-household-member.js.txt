// Removes someone from a Family plan's household (revokes their access).
// Called from dashboard.html's "Manage your household" panel — only the
// household owner can do this, verified server-side from their own login
// session, same as api/invite-household-member.js.
//
// Requires the same SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment
// variables already used elsewhere in this project.

const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    res.status(500).json({ ok: false, error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars' });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!accessToken) {
    res.status(401).json({ ok: false, error: 'Missing session — log in and try again.' });
    return;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: callerData, error: callerError } = await admin.auth.getUser(accessToken);
  if (callerError || !callerData || !callerData.user) {
    res.status(401).json({ ok: false, error: 'Invalid or expired session — log in again.' });
    return;
  }
  const owner = callerData.user;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (err) { body = {}; }
  }
  const memberId = (body && body.memberId) || '';
  if (!memberId) {
    res.status(400).json({ ok: false, error: 'Missing memberId.' });
    return;
  }

  // Only delete a member row that actually belongs to a household this
  // caller owns — never trust a memberId alone.
  const { data: member, error: memberError } = await admin
    .from('household_members')
    .select('id, household_id, households!inner(owner_user_id)')
    .eq('id', memberId)
    .single();
  if (memberError || !member || member.households.owner_user_id !== owner.id) {
    res.status(403).json({ ok: false, error: 'Not found, or not yours to remove.' });
    return;
  }

  const { error: deleteError } = await admin.from('household_members').delete().eq('id', memberId);
  if (deleteError) {
    res.status(500).json({ ok: false, error: 'Could not remove that member.' });
    return;
  }

  res.status(200).json({ ok: true });
};
