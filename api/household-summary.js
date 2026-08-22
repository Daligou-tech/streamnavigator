// Returns ONE combined number for a Family household: total monthly spend
// across every member's tracked subscriptions. This is the "Household
// usage breakdown" bullet on the Family plan card — built as a combined
// total only, deliberately not a per-person breakdown, per the privacy
// stance already built into this feature: a household member's individual
// subscriptions are never visible to the owner or to anyone else in the
// household. A combined total doesn't expose who has what, only what the
// household adds up to.
//
// Callable by the household owner or by any active member — both are
// legitimate household participants. Neither the browser nor the caller's
// own claims about their plan are trusted: this always re-verifies against
// Supabase directly with the service_role key before returning anything.
//
// Requires the same SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment
// variables already used by the other api/*.js functions in this project.

const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
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
  const caller = callerData.user;

  // Find the household this caller belongs to — either as the owner, or as
  // an active member of someone else's household.
  let ownerUserId = null;
  const { data: ownedHousehold } = await admin
    .from('households')
    .select('id, owner_user_id')
    .eq('owner_user_id', caller.id)
    .maybeSingle();

  if (ownedHousehold) {
    ownerUserId = ownedHousehold.owner_user_id;
  } else {
    const { data: memberRow } = await admin
      .from('household_members')
      .select('household_id')
      .eq('user_id', caller.id)
      .eq('status', 'active')
      .maybeSingle();
    if (memberRow) {
      const { data: household } = await admin
        .from('households')
        .select('owner_user_id')
        .eq('id', memberRow.household_id)
        .maybeSingle();
      if (household) ownerUserId = household.owner_user_id;
    }
  }

  if (!ownerUserId) {
    res.status(404).json({ ok: false, error: "You're not part of a household." });
    return;
  }

  // Re-verify the owner's plan directly — never assume the household is
  // still on Family just because it exists (they may have downgraded).
  const { data: ownerPlanRow } = await admin
    .from('subscribers')
    .select('plan')
    .eq('user_id', ownerUserId)
    .maybeSingle();
  if (!ownerPlanRow || ownerPlanRow.plan !== 'family') {
    res.status(403).json({ ok: false, error: 'This household is not on an active Family plan.' });
    return;
  }

  const { data: household } = await admin
    .from('households')
    .select('id')
    .eq('owner_user_id', ownerUserId)
    .maybeSingle();
  if (!household) {
    res.status(404).json({ ok: false, error: 'Household not found.' });
    return;
  }

  const { data: activeMembers, error: membersError } = await admin
    .from('household_members')
    .select('user_id')
    .eq('household_id', household.id)
    .eq('status', 'active');
  if (membersError) {
    res.status(500).json({ ok: false, error: 'Could not load household members.' });
    return;
  }

  const memberUserIds = (activeMembers || []).map(m => m.user_id).filter(Boolean);
  const allUserIds = [ownerUserId, ...memberUserIds];

  const { data: subs, error: subsError } = await admin
    .from('tracked_subscriptions')
    .select('user_id, monthly_price, status')
    .in('user_id', allUserIds);
  if (subsError) {
    res.status(500).json({ ok: false, error: 'Could not load household spend.' });
    return;
  }

  let activeMonthly = 0;
  let pausedMonthly = 0;
  let activeCount = 0;
  let pausedCount = 0;
  const peopleWithSubs = new Set();
  (subs || []).forEach(s => {
    peopleWithSubs.add(s.user_id);
    const price = Number(s.monthly_price) || 0;
    if (s.status === 'active') { activeMonthly += price; activeCount++; }
    else { pausedMonthly += price; pausedCount++; }
  });

  res.status(200).json({
    ok: true,
    peopleInHousehold: allUserIds.length,
    peopleTracking: peopleWithSubs.size,
    activeMonthly: Math.round(activeMonthly * 100) / 100,
    pausedMonthly: Math.round(pausedMonthly * 100) / 100,
    activeCount,
    pausedCount,
  });
};
