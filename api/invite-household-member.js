// Sends a real invite to join a Family plan's household. Called from
// dashboard.html's "Manage your household" panel, which only Family-plan
// account owners see.
//
// Why this needs a server function instead of running straight from the
// browser: inviting someone requires Supabase's Admin API (to actually send
// a signup email), which only works with the service_role/secret key — a
// key that must never reach the browser. This function verifies the caller
// really is a paying Family-plan owner (using their own login session, not
// anything the browser could fake) before it will send an invite or touch
// the household tables.
//
// Requires the same SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment
// variables already used by api/refresh-shows.js and api/stripe-webhook.js.
//
// NOTE: this depends on Supabase's built-in invite email actually being
// configured and deliverable for your project (Authentication -> Emails in
// the Supabase dashboard). That's a live setting on your project this code
// can't verify — send yourself a test invite once this is deployed to
// confirm the email arrives.

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

  // Identify the caller from their own session token — this is what proves
  // "you are who you say you are," not anything sent in the request body.
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
  const inviteEmail = ((body && body.email) || '').trim().toLowerCase();
  if (!inviteEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail)) {
    res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
    return;
  }
  if (owner.email && inviteEmail === owner.email.toLowerCase()) {
    res.status(400).json({ ok: false, error: "That's your own email." });
    return;
  }

  // Confirm this caller actually has an active Family plan — never trust
  // anything the browser claims about its own plan.
  const { data: subRow, error: subError } = await admin
    .from('subscribers')
    .select('plan')
    .eq('user_id', owner.id)
    .maybeSingle();
  if (subError || !subRow || subRow.plan !== 'family') {
    res.status(403).json({ ok: false, error: 'Only Family-plan accounts can invite members.' });
    return;
  }

  // Get-or-create this owner's household row.
  const { data: household, error: houseError } = await admin
    .from('households')
    .upsert({ owner_user_id: owner.id }, { onConflict: 'owner_user_id' })
    .select('id')
    .single();
  if (houseError || !household) {
    res.status(500).json({ ok: false, error: 'Could not set up your household.' });
    return;
  }

  // Family covers up to 6 people total: the owner plus up to 5 members.
  const { data: existingMembers, error: membersError } = await admin
    .from('household_members')
    .select('id, email')
    .eq('household_id', household.id);
  if (membersError) {
    res.status(500).json({ ok: false, error: 'Could not check your current members.' });
    return;
  }
  if (existingMembers.some(m => (m.email || '').toLowerCase() === inviteEmail)) {
    res.status(400).json({ ok: false, error: 'That email is already invited.' });
    return;
  }
  if (existingMembers.length >= 5) {
    res.status(400).json({ ok: false, error: 'Family plan covers up to 6 people total (you + 5 members) — remove someone first.' });
    return;
  }

  const redirectTo = process.env.PUBLIC_APP_URL
    ? `${process.env.PUBLIC_APP_URL.replace(/\/$/, '')}/dashboard.html`
    : `https://${req.headers.host}/dashboard.html`;

  const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(inviteEmail, { redirectTo });
  if (inviteError) {
    // A common case: this email already has an account. They can still be
    // added as a household member — they'll just log in normally instead
    // of following an invite link — so don't hard-fail here.
    if (!/already registered|already exists/i.test(inviteError.message || '')) {
      res.status(502).json({ ok: false, error: `Could not send invite email: ${inviteError.message}` });
      return;
    }
  }

  const { error: insertError } = await admin
    .from('household_members')
    .insert({ household_id: household.id, email: inviteEmail, status: 'invited' });
  if (insertError) {
    res.status(500).json({ ok: false, error: 'Invite sent, but could not save the member record.' });
    return;
  }

  res.status(200).json({ ok: true });
};
