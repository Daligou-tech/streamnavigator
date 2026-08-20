// Daily scheduled job (see vercel.json) that keeps two things fresh across
// EVERY customer's tracked subscriptions — this is the only part of the
// "show air-date monitoring" feature that has to run on a server instead of
// in the customer's browser, because it touches every customer's rows, not
// just the one currently logged in.
//
//   1. For any row where the customer told us what show they're waiting on,
//      re-check TVmaze (https://api.tvmaze.com — free, no key required, data
//      under CC BY-SA, attribution linked from the dashboard) for that
//      show's next air date, and move the "resume" check-in to that real
//      date once one is confirmed.
//   2. For any row whose routine (non-air-date) check-in date has already
//      passed, roll it forward so it never goes stale just because the
//      customer hasn't happened to visit the dashboard.
//
// Requires three Vercel project environment variables (Project Settings ->
// Environment Variables -> Production), none of which are ever sent to the
// browser:
//   SUPABASE_URL                same project URL already used in dashboard.html
//   SUPABASE_SERVICE_ROLE_KEY   Supabase Dashboard -> Settings -> API ->
//                                "service_role" secret key (NOT the anon key —
//                                this one bypasses row-level security, which
//                                is required here since the job updates every
//                                customer's rows, not just one)
//   CRON_SECRET                 any random string, 16+ characters. Vercel
//                                automatically sends this back as the
//                                Authorization header on every cron
//                                invocation, so this function can confirm
//                                the request really came from Vercel Cron
//                                and not a random visitor hitting the URL.

module.exports = async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    res.status(500).json({ ok: false, error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars' });
    return;
  }

  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };

  const listRes = await fetch(
    `${SUPABASE_URL}/rest/v1/tracked_subscriptions?select=id,status,status_changed_at,show_query,tvmaze_show_id,show_next_air_date,next_reminder_date,reminder_type,reminder_source`,
    { headers }
  );
  if (!listRes.ok) {
    res.status(502).json({ ok: false, error: 'Could not read subscriptions from Supabase' });
    return;
  }
  const rows = await listRes.json();

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);

  let showsChecked = 0;
  let remindersAdvanced = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      const patch = {};

      // 1) Refresh the show's next air date, if this row has a show to check.
      if (row.show_query) {
        const found = await fetchNextAirDate(row.tvmaze_show_id, row.show_query);
        showsChecked++;
        patch.show_checked_at = new Date().toISOString();
        if (found) {
          patch.show_next_air_date = found.date;
          if (found.id) patch.tvmaze_show_id = found.id;
          if (row.status === 'paused' && found.date && found.date >= todayStr) {
            patch.next_reminder_date = found.date;
            patch.reminder_type = 'resume';
            patch.reminder_source = 'air_date';
          }
        }
        // Be polite to TVmaze's rate limit (at least 20 calls / 10s per IP).
        await sleep(150);
      }

      // 2) Roll forward any routine (non-air-date) check-in that's overdue,
      //    so reminders keep advancing even if the customer doesn't visit.
      const stillCadence = !patch.reminder_source && row.reminder_source !== 'air_date';
      if (stillCadence && row.next_reminder_date && row.next_reminder_date < todayStr) {
        const days = row.status === 'active' ? 60 : 30;
        const base = row.status_changed_at ? new Date(row.status_changed_at) : new Date();
        patch.next_reminder_date = addDaysStr(base, days);
        patch.reminder_type = row.status === 'active' ? 'pause' : 'resume';
        patch.reminder_source = 'cadence';
        remindersAdvanced++;
      }

      if (Object.keys(patch).length) {
        const upRes = await fetch(`${SUPABASE_URL}/rest/v1/tracked_subscriptions?id=eq.${row.id}`, {
          method: 'PATCH',
          headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify(patch),
        });
        if (!upRes.ok) errors++;
      }
    } catch (err) {
      errors++;
    }
  }

  res.status(200).json({ ok: true, rowsProcessed: rows.length, showsChecked, remindersAdvanced, errors });
};

async function fetchNextAirDate(tvmazeId, showQuery) {
  try {
    const url = tvmazeId
      ? `https://api.tvmaze.com/shows/${tvmazeId}?embed=nextepisode`
      : `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(showQuery)}&embed=nextepisode`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const airdate = data && data._embedded && data._embedded.nextepisode ? data._embedded.nextepisode.airdate : null;
    return { date: airdate || null, id: data.id || null };
  } catch (err) {
    return null;
  }
}

function addDaysStr(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
