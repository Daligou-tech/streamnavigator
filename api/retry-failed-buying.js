// Scheduled recovery sweep (see vercel.json's crons) for 'buying' Navigator
// submissions that ran out of ordinary attempts. Added 2026-09-01: after a
// full day of manually re-testing failures by hand, the site owner
// explicitly asked for the problem to just fix itself instead of being
// notified and having to act on it every time.
//
// Gives each newly-failed submission its OWN fresh attempt budget
// automatically (no site-owner action needed), and — since a single
// recovered attempt can itself come back "still needs another try" rather
// than an immediate final failure — keeps nudging it forward on each sweep
// until it either completes or genuinely exhausts MAX_ATTEMPTS a second
// time. Only that final, post-recovery failure sends the email alert (see
// api/_lib/alerts.js and the auto_recovery_attempted gating in
// api/_lib/purchase-engine.js) — an ordinary first-time exhaustion stays
// silent from the owner's perspective and is handled here instead.
//
// Runs on a schedule, authenticated via Vercel's auto-provisioned
// CRON_SECRET the same way api/refresh-shows.js already is, so this can't
// be triggered by an arbitrary public request and rack up API costs.

const { getSupabaseAdmin } = require('./_lib/supabaseAdmin');
const { generatePurchaseReport } = require('./_lib/purchase-engine');

module.exports = async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  const admin = getSupabaseAdmin();

  // Every paid buying submission that is not moving, in one query.
  //
  // This used to name two shapes: (failed, not yet in recovery) and (paid,
  // already in recovery). A row that was paid and NOT in recovery matched
  // neither, and nothing else in the system looks at buying — it is excluded
  // from api/generate-paid-navigator.js on the grounds that it "has its own
  // job", and this is that job.
  //
  // Two real customers had been sitting in that gap since 2026-08-30. Both
  // had a Stripe session, status 'paid', auto_recovery_attempted false,
  // generation_attempts 0 and no error: they paid, the browser-triggered
  // generation never ran or never finished, and there was no second shape for
  // them to fall into. Eleven days, no report, no refund, no alert.
  //
  // Found by asking where an outage row goes next when the failure path was
  // changed to park one at 'paid' — the same gap, approached from the other
  // side.
  //
  // The grace period is why widening this is safe. Generation sets 'processing'
  // as its first act, so a row still reading 'paid' minutes later is one nobody
  // is generating. Without the wait, this sweep could start a second generation
  // alongside a customer's own browser and bill the same report twice.
  const GRACE_MINUTES = 5;
  const cutoff = new Date(Date.now() - GRACE_MINUTES * 60 * 1000).toISOString();

  const { data: eligible, error: fetchError } = await admin
    .from('navigator_submissions')
    .select('id, status, auto_recovery_attempted')
    .eq('product', 'buying')
    .lt('updated_at', cutoff)
    .or('and(status.eq.failed,auto_recovery_attempted.eq.false),status.eq.paid');

  if (fetchError) {
    res.status(500).json({ ok: false, error: fetchError.message });
    return;
  }

  const results = [];
  for (const row of eligible || []) {
    if (row.status === 'failed') {
      // First time this submission is being auto-recovered: mark it BEFORE
      // attempting (not after), so if this very function gets killed
      // mid-attempt, a future sweep won't give it a second free reset — one
      // automatic extra attempt budget, no matter what.
      await admin
        .from('navigator_submissions')
        .update({ auto_recovery_attempted: true, status: 'paid', generation_attempts: 0, error: null, updated_at: new Date().toISOString() })
        .eq('id', row.id);
    }
    try {
      const report = await generatePurchaseReport(row.id);
      results.push({ id: row.id, outcome: report ? 'recovered' : 'retrying' });
    } catch (err) {
      results.push({ id: row.id, outcome: 'failed-again', error: String((err && err.message) || err).slice(0, 300) });
    }
  }

  res.status(200).json({ ok: true, processed: results.length, results });
};
