// Daily scheduled job (see vercel.json) that keeps things fresh across EVERY
// customer's tracked subscriptions — this is the only part of the "real
// data instead of marketing mockups" work that has to run on a server
// instead of in the customer's browser, because it touches every
// customer's rows, not just the one currently logged in.
//
//   1. For any row where the customer told us what show they're waiting on,
//      re-check TVmaze (https://api.tvmaze.com — free, no key required, data
//      under CC BY-SA, attribution linked from the dashboard) for that
//      show's next air date, and move the "resume" check-in to that real
//      date once one is confirmed.
//   2. For any row whose routine (non-air-date) check-in date has already
//      passed, roll it forward so it never goes stale just because the
//      customer hasn't happened to visit the dashboard.
//   3. Write one savings_history row per customer per day (their current
//      monthly spend, paused savings, and active/paused counts), which is
//      what powers the real "money saved over time" chart on the dashboard.
//      This has no back-filled/fake history — it only ever logs today, so
//      the chart starts empty and fills in one real point per day from
//      whenever the savings_history migration is run.
//   4. For any favorite show a customer has tagged to a subscription (the
//      "Shows & sports you like to watch" panel), re-check TVmaze the same
//      way as step 1, so the dashboard's "worth activating" suggestion stays
//      correct even if the customer hasn't visited in a while. Favorite
//      sports don't need a network check — their in-season/off-season state
//      is computed live from a fixed seasonal calendar, not stored here.
//
//   5. For every Pro/Family customer, mirror the exact same "Suggested:
//      Activate/pause" logic dashboard.html shows on each subscription row
//      (favorites-driven first, routine check-in cadence as fallback), and
//      email them the moment that recommendation changes — never a daily
//      repeat nag for something that was already true yesterday. Free-plan
//      customers don't get emails, matching "real-time pause & resume
//      reminders" being a paid feature on the dashboard itself.
//
// Requires six Vercel project environment variables (Project Settings ->
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
//   RESEND_API_KEY              Resend Dashboard (resend.com) -> API Keys ->
//                                Create API Key. Free tier is enough for a
//                                once-a-day cron sending a handful of emails.
//   RESEND_FROM_EMAIL           the "from" address emails are sent as, e.g.
//                                "StreamNavigator <notifications@yourdomain.com>".
//                                Requires verifying that domain in Resend's
//                                dashboard first (Domains -> Add Domain,
//                                then add the DNS records they give you).
//                                Until you've verified a domain, you can test
//                                with Resend's sandbox address
//                                "onboarding@resend.dev" — it only delivers
//                                to the email you signed up to Resend with.
//   PUBLIC_DASHBOARD_URL        the live dashboard URL to link to in emails,
//                                e.g. "https://streamnavigator.ai/dashboard.html"

const { createClient } = require('@supabase/supabase-js');

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
    `${SUPABASE_URL}/rest/v1/tracked_subscriptions?select=id,user_id,service_name,status,status_changed_at,monthly_price,show_query,tvmaze_show_id,show_next_air_date,next_reminder_date,reminder_type,reminder_source,last_notified_action,last_notified_at,next_renewal_date,billing_period`,
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

      // 2) Keep the renewal date in the future so "renews in N days" stays
      //    true without the customer re-entering it every cycle.
      const rolled = rollRenewal(row, todayStr);
      if (rolled) patch.next_renewal_date = rolled;

      // 3) Roll forward an overdue routine check-in, so reminders keep
      //    advancing even if the customer never visits. Active rows only:
      //    a paused row has nothing to roll forward to. Waking a paused
      //    subscription now requires a real air date (see step 1), and a
      //    paused row with no date simply stays quiet rather than being
      //    nagged back into paying every 30 days.
      const stillCadence = !patch.reminder_source && row.reminder_source !== 'air_date';
      if (stillCadence && row.status === 'active' && row.next_reminder_date && row.next_reminder_date < todayStr) {
        const base = row.status_changed_at ? new Date(row.status_changed_at) : new Date();
        patch.next_reminder_date = addDaysStr(base, 60);
        patch.reminder_type = 'pause';
        patch.reminder_source = 'cadence';
        remindersAdvanced++;
      }
      // Clear any stale calendar-only resume left over from before that
      // change, so it can never fire.
      if (row.status === 'paused' && row.reminder_type === 'resume'
          && row.reminder_source === 'cadence' && !patch.reminder_source) {
        patch.next_reminder_date = null;
        patch.reminder_type = null;
        patch.reminder_source = null;
      }

      if (Object.keys(patch).length) {
        const upRes = await fetch(`${SUPABASE_URL}/rest/v1/tracked_subscriptions?id=eq.${row.id}`, {
          method: 'PATCH',
          headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify(patch),
        });
        if (!upRes.ok) errors++;
        // Keep the in-memory row current so step 5 (email notifications),
        // later in this same run, reasons about today's real data instead
        // of what this row looked like before this run started.
        Object.assign(row, patch);
      }
    } catch (err) {
      errors++;
    }
  }

  // 3) Log today's savings snapshot, one row per customer.
  let usersSnapshotted = 0;
  let snapshotErrors = 0;
  const byUser = {};
  for (const row of rows) {
    if (!row.user_id) continue;
    if (!byUser[row.user_id]) {
      byUser[row.user_id] = { monthly_spend: 0, paused_monthly_savings: 0, active_count: 0, paused_count: 0 };
    }
    const bucket = byUser[row.user_id];
    const price = Number(row.monthly_price) || 0;
    if (row.status === 'active') {
      bucket.monthly_spend += price;
      bucket.active_count++;
    } else {
      bucket.paused_monthly_savings += price;
      bucket.paused_count++;
    }
  }

  const snapshotRows = Object.keys(byUser).map((user_id) => ({
    user_id,
    snapshot_date: todayStr,
    monthly_spend: round2(byUser[user_id].monthly_spend),
    paused_monthly_savings: round2(byUser[user_id].paused_monthly_savings),
    active_count: byUser[user_id].active_count,
    paused_count: byUser[user_id].paused_count,
  }));

  if (snapshotRows.length) {
    try {
      const snapRes = await fetch(
        `${SUPABASE_URL}/rest/v1/savings_history?on_conflict=user_id,snapshot_date`,
        {
          method: 'POST',
          headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(snapshotRows),
        }
      );
      if (snapRes.ok) {
        usersSnapshotted = snapshotRows.length;
      } else {
        snapshotErrors = snapshotRows.length;
      }
    } catch (err) {
      snapshotErrors = snapshotRows.length;
    }
  }

  // 4) Refresh next_air_date on favorite shows tagged in the "Shows & sports
  //    you like to watch" panel — same TVmaze lookup as step 1, just against
  //    a different table. Favorite sports (kind = 'sport') are skipped here;
  //    they carry no air date to refresh.
  let favoriteShowsChecked = 0;
  let favoriteErrors = 0;
  let favoriteRows = []; // all favorites (shows AND sports), kept for step 5 below
  try {
    const favRes = await fetch(
      `${SUPABASE_URL}/rest/v1/favorite_watches?select=id,user_id,kind,title,service_name,tvmaze_show_id,next_air_date,currently_airing`,
      { headers }
    );
    if (favRes.ok) {
      favoriteRows = await favRes.json();
      for (const fav of favoriteRows) {
        if (fav.kind !== 'show') continue; // sports carry no air date to refresh
        try {
          const found = await fetchNextAirDate(fav.tvmaze_show_id, fav.title);
          favoriteShowsChecked++;
          const patch = { checked_at: new Date().toISOString() };
          if (found) {
            patch.next_air_date = found.date;
            patch.currently_airing = !!found.currentlyAiring;
            if (found.id) patch.tvmaze_show_id = found.id;
          }
          const upRes = await fetch(`${SUPABASE_URL}/rest/v1/favorite_watches?id=eq.${fav.id}`, {
            method: 'PATCH',
            headers: { ...headers, Prefer: 'return=minimal' },
            body: JSON.stringify(patch),
          });
          if (!upRes.ok) favoriteErrors++;
          Object.assign(fav, patch); // keep in-memory copy current for step 5
          await sleep(150);
        } catch (err) {
          favoriteErrors++;
        }
      }
    } else {
      // Table may not exist yet if this migration hasn't been run — that's
      // fine, just skip this step rather than failing the whole cron run.
    }
  } catch (err) {
    // Same as above: don't let a missing/unreachable favorite_watches table
    // take down the rest of the daily job.
  }

  // 5) Email Pro/Family customers when a subscription's recommendation
  //    changes. Mirrors dashboard.html's computeSuggestion() (favorites
  //    airing/in-season) and computeCadencePrompt() (routine check-in
  //    fallback) exactly, so an email only ever says what the dashboard
  //    itself would say. Deliberately does NOT mirror computeUntaggedPrompt
  //    (the "tag a show" nudge) — that's a soft suggestion to add data, not
  //    a confident pause/activate call, and emailing it would mean every
  //    untagged subscription gets an email on day one.
  let emailsSent = 0;
  let emailErrors = 0;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
  const PUBLIC_DASHBOARD_URL = process.env.PUBLIC_DASHBOARD_URL || 'https://streamnavigator.ai/dashboard.html';
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    // Notifications are optional infrastructure — a fresh deployment
    // without Resend configured yet should still run steps 1-4 fine, just
    // skip emailing rather than failing the whole cron run.
  } else {
    try {
      const subsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/subscribers?select=user_id,plan&plan=in.(pro,family)`,
        { headers }
      );
      const paidUserIds = new Set(subsRes.ok ? (await subsRes.json()).map((s) => s.user_id) : []);

      const favoritesByUser = {};
      for (const fav of favoriteRows) {
        if (!fav.user_id) continue;
        (favoritesByUser[fav.user_id] = favoritesByUser[fav.user_id] || []).push(fav);
      }

      const emailCache = {}; // user_id -> email, so a user with several flagged rows is looked up once
      const admin = createClient(SUPABASE_URL, SERVICE_KEY);

      for (const row of rows) {
        if (!row.user_id || !paidUserIds.has(row.user_id)) continue;
        try {
          const decision = computeDesiredAction(row, favoritesByUser[row.user_id] || [], todayStr);
          if (!decision) {
            // Nothing to recommend right now. If we'd previously emailed
            // about this row, clear the memory so a future recommendation
            // (even the same type, e.g. pause again later) is treated as
            // new rather than silently suppressed forever.
            if (row.last_notified_action) {
              await fetch(`${SUPABASE_URL}/rest/v1/tracked_subscriptions?id=eq.${row.id}`, {
                method: 'PATCH',
                headers: { ...headers, Prefer: 'return=minimal' },
                body: JSON.stringify({ last_notified_action: null }),
              });
            }
            continue;
          }
          if (decision.action === row.last_notified_action) continue; // already emailed about this exact recommendation
          // ...and never more than one email per service per 30 days, even
          // when the recommendation genuinely changed.
          if (row.last_notified_at) {
            const since = Math.round((new Date(todayStr + 'T00:00:00') - new Date(row.last_notified_at)) / 86400000);
            if (since >= 0 && since < MIN_DAYS_BETWEEN_EMAILS) continue;
          }

          if (!(row.user_id in emailCache)) {
            const { data, error } = await admin.auth.admin.getUserById(row.user_id);
            emailCache[row.user_id] = (!error && data && data.user) ? data.user.email : null;
          }
          const toEmail = emailCache[row.user_id];
          if (!toEmail) { emailErrors++; continue; }

          const sent = await sendActionEmail({
            apiKey: RESEND_API_KEY,
            from: RESEND_FROM_EMAIL,
            to: toEmail,
            dashboardUrl: PUBLIC_DASHBOARD_URL,
            serviceName: row.service_name,
            action: decision.action,
            reason: decision.reason,
            price: row.monthly_price,
          });
          if (sent) {
            emailsSent++;
            await fetch(`${SUPABASE_URL}/rest/v1/tracked_subscriptions?id=eq.${row.id}`, {
              method: 'PATCH',
              headers: { ...headers, Prefer: 'return=minimal' },
              body: JSON.stringify({ last_notified_action: decision.action, last_notified_at: new Date().toISOString() }),
            });
          } else {
            emailErrors++;
          }
        } catch (err) {
          emailErrors++;
        }
      }
    } catch (err) {
      // Don't let notification failures take down the rest of the daily job.
    }
  }

  res.status(200).json({
    ok: true,
    rowsProcessed: rows.length,
    showsChecked,
    remindersAdvanced,
    usersSnapshotted,
    snapshotErrors,
    favoriteShowsChecked,
    favoriteErrors,
    emailsSent,
    emailErrors,
    errors,
  });
};

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Step 5 helpers — deliberate, exact mirrors of dashboard.html's client-side
// computeSuggestion()/computeCadencePrompt()/FAV_SPORT_SEASONS, so an email
// never recommends something the dashboard itself wouldn't also say.
// ---------------------------------------------------------------------------

const FAV_SPORT_SEASONS = {
  nfl: { startMonth: 9, endMonth: 2 },
  nba: { startMonth: 10, endMonth: 6 },
  mlb: { startMonth: 4, endMonth: 10 },
  nhl: { startMonth: 10, endMonth: 6 },
  epl: { startMonth: 8, endMonth: 5 },
  laliga: { startMonth: 8, endMonth: 5 },
  bundesliga: { startMonth: 8, endMonth: 5 },
  mls: { startMonth: 2, endMonth: 12 },
  other_soccer: { startMonth: 8, endMonth: 5 },
  college: { startMonth: 9, endMonth: 1 },
};
const FAV_SPORT_LABELS = {
  nfl: 'NFL', nba: 'NBA', mlb: 'MLB', nhl: 'NHL', epl: 'Premier League',
  laliga: 'La Liga', bundesliga: 'Bundesliga', mls: 'MLS', other_soccer: 'Other Soccer', college: 'College Football',
};
function isSportInSeason(sportKey) {
  const season = FAV_SPORT_SEASONS[sportKey];
  if (!season) return false;
  const month = new Date().getMonth() + 1; // 1-12
  const { startMonth, endMonth } = season;
  return startMonth <= endMonth ? (month >= startMonth && month <= endMonth) : (month >= startMonth || month <= endMonth);
}
// The cron does not decide anything itself any more. dashboard.html and this
// job used to carry separate implementations of "should this be on?", and a
// customer could open the dashboard and read something different from the
// email it had just sent them. Both now call the same decide().
const ENGINE = require('../navigator-streaming-engine.js');

// How close to the next charge a pause email is allowed to land, and how far
// ahead of a confirmed air date a restart email goes out. Both come from the
// engine so the page and the email quote the same numbers.
const RESTART_LEAD_DAYS = ENGINE.RESTART_LEAD_DAYS;

// One email per service per 30 days, whatever happens. The change-detection
// below already suppresses repeats of the SAME recommendation, but a row that
// flips between two states (a show gets a date, the date slips, it goes away
// again) could otherwise mail someone every few days about one subscription.
const MIN_DAYS_BETWEEN_EMAILS = 30;

function favoritesForService(favorites, serviceName) {
  const want = String(serviceName || '').trim().toLowerCase();
  return (favorites || []).filter(
    (f) => String(f.service_name || '').trim().toLowerCase() === want,
  );
}

// Keeps next_renewal_date in the future without asking the customer to
// re-enter it every cycle. Everything else about renewal timing — the
// window, the annual-plan hold — now lives in the engine's decide().
function rollRenewal(row, todayStr) {
  if (!row.next_renewal_date || row.next_renewal_date >= todayStr) return null;
  const d = new Date(row.next_renewal_date + 'T00:00:00');
  const today = new Date(todayStr + 'T00:00:00');
  let guard = 0;
  while (d < today && guard < 400) {
    guard++;
    if (row.billing_period === 'annual') d.setFullYear(d.getFullYear() + 1);
    else d.setMonth(d.getMonth() + 1);
  }
  return d.toISOString().slice(0, 10);
}

// Row + that customer's favorites -> the same decision the dashboard shows.
// Returns the shape the mailer already expects: { action, reason } or null.
function computeDesiredAction(row, favorites, todayStr) {
  const sub = ENGINE.rowToSubscription(row);
  const items = favoritesForService(favorites, row.service_name).map(ENGINE.favoriteToItem);
  const d = ENGINE.decide(sub, items, todayStr);

  if (d.action === 'suspend') {
    // The dashboard shows a suspend as soon as it is true, because that is
    // useful to read. An EMAIL is an interruption, so it waits for the
    // moment acting on it actually saves the money: d.actionable is the
    // week before the charge (a fortnight for a prepaid annual plan).
    if (!d.actionable) return null;
    return { action: 'pause', reason: d.why, decision: d };
  }
  if (d.action === 'restart') {
    return { action: 'activate', reason: d.why, decision: d };
  }
  // 'watch' means paused with nothing scheduled: stay off, say nothing.
  // 'keep' and 'untracked' are not worth an email either.
  return null;
}

// Kept as its own export purely so the timing suite can assert on it: a
// restart must never be sent without a real, confirmed date behind it.
function computeCadenceAction(row, todayStr) {
  if (!row.next_reminder_date || row.next_reminder_date > todayStr) return null;
  if (row.reminder_type === 'resume') {
    if (row.reminder_source !== 'air_date') return null;
    return { action: 'activate', reason: 'a new season just started' };
  }
  return null;
}

// Sends the actual "time to pause/activate" email via Resend's REST API
// (https://resend.com/docs/api-reference/emails/send-email). Returns true on
// success so the caller knows whether it's safe to record last_notified_*.
async function sendActionEmail({ apiKey, from, to, dashboardUrl, serviceName, action, reason, price }) {
  const verb = action === 'activate' ? 'Activate' : 'Pause';
  const subject = `StreamNavigator: time to ${verb.toLowerCase()} ${serviceName}`;
  const priceLine = action === 'pause'
    ? `Pausing it saves you $${Number(price || 0).toFixed(2)}/mo.`
    : `Worth turning back on.`;
  const html = `
    <div style="font-family:sans-serif; font-size:15px; color:#201A14; max-width:480px;">
      <p style="font-size:17px; font-weight:700; margin-bottom:4px;">${verb} ${escapeHtmlEmail(serviceName)}?</p>
      <p style="color:#5B5347;">${escapeHtmlEmail(reason)}. ${priceLine}</p>
      <p><a href="${dashboardUrl}" style="display:inline-block; background:#4FB6E8; color:#1F1B16; font-weight:700; padding:10px 18px; border-radius:999px; text-decoration:none; margin-top:8px;">Open StreamNavigator →</a></p>
      <p style="color:#7A7163; font-size:12.5px; margin-top:24px;">StreamNavigator never pauses, cancels, or activates anything on your behalf — click through and do it yourself in one tap. You're getting this because real-time reminders are on for your Pro/Family account.</p>
    </div>
  `;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
    return res.ok;
  } catch (err) {
    return false;
  }
}
function escapeHtmlEmail(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// TVmaze's "next episode" field only ever points to a FUTURE, unaired
// episode — it goes blank once a show has released its most recent episode
// and TVmaze doesn't have a confirmed date for the next one posted yet, even
// if the show is actively airing weekly. So this also embeds "previous
// episode" and the show's own status, and derives a real, non-fabricated
// "currently airing" signal from them: an episode aired in roughly the last
// 10 days and the show's status is still "Running" (more episodes expected).
// Mirrors the same logic in dashboard.html's client-side lookupShow().
async function fetchNextAirDate(tvmazeId, showQuery) {
  try {
    const url = tvmazeId
      ? `https://api.tvmaze.com/shows/${tvmazeId}?embed[]=nextepisode&embed[]=previousepisode`
      : `https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(showQuery)}&embed[]=nextepisode&embed[]=previousepisode`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const airdate = data && data._embedded && data._embedded.nextepisode ? data._embedded.nextepisode.airdate : null;
    const prevAirdate = data && data._embedded && data._embedded.previousepisode ? data._embedded.previousepisode.airdate : null;
    let currentlyAiring = false;
    if (prevAirdate && data.status === 'Running') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const prevDate = new Date(prevAirdate + 'T00:00:00');
      const daysSince = Math.round((today - prevDate) / 86400000);
      if (daysSince >= 0 && daysSince <= 10) currentlyAiring = true;
    }
    return { date: airdate || null, id: data.id || null, currentlyAiring };
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

// Exposed for tests/refresh-shows-timing.test.js. These four decide whether a
// customer gets an email telling them to stop paying for something, or to
// start again — the two messages that cost real money if they are wrong — so
// they are worth asserting on directly rather than only through the handler.
module.exports.computeDesiredAction = computeDesiredAction;
module.exports.computeCadenceAction = computeCadenceAction;
module.exports.MIN_DAYS_BETWEEN_EMAILS = MIN_DAYS_BETWEEN_EMAILS;
module.exports.rollRenewal = rollRenewal;
