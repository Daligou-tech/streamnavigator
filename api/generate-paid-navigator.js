// Scheduled sweep for submissions that were paid for and never generated.
//
// These reports are produced by api/get-navigator-submission.js, which runs
// when the customer's browser polls the status page. That is fine while the
// customer is watching. It is not fine when they are not: a landlord who pays,
// sees the Stripe receipt and closes the tab leaves a row sitting at 'paid'
// with nothing scheduled to look at it again. No report is generated, no PDF is
// emailed, and api/process-refunds.js never sees them either, because that only
// considers rows that reached 'failed'. Paid, silent, and invisible.
//
// The 2026-09-09 product audit found this on rental and it was fixed there
// alone, which was the wrong scope: the same browser-triggered generation runs
// nine products, and a customer of any of them who pays and closes the tab gets
// nothing and is not refunded either, because api/process-refunds.js only
// considers rows that reached "failed".
//
// buying, hoa and contractor are excluded because each already has a job of its
// own — retry-failed-buying, hoa-job, and the contractor engine's own path — and
// two sweeps racing the same row would pay for the same report twice.
//
// Two minutes of grace before this picks a row up, so the ordinary case (the
// customer IS on the page, and generation is already running inside their poll)
// is left alone rather than raced. generateNavigatorReport moves the row to
// 'processing' as its first act, and this only ever selects 'paid'.
//
// Authenticated via Vercel's auto-provisioned CRON_SECRET, like every other
// scheduled function here, so it cannot be triggered by a public request.

const { getSupabaseAdmin } = require('./_lib/supabaseAdmin');
const { generateNavigatorReport } = require('./_lib/navigator-engine');
const { deliverReportByEmail } = require('./_lib/report-delivery');

// Everything api/_lib/navigator-engine.js generates, minus the three products
// that already have a job of their own.
const SWEPT_PRODUCTS = [
  'property-tax', 'home-savings', 'rental', 'subscriptions', 'government-money',
  'home-maintenance', 'landlord', 'insurance', 'closing',
];

const GRACE_MINUTES = 2;
const MAX_PER_SWEEP = 3;

module.exports = async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  const admin = getSupabaseAdmin();
  const cutoff = new Date(Date.now() - GRACE_MINUTES * 60 * 1000).toISOString();

  const { data: waiting, error: fetchError } = await admin
    .from('navigator_submissions')
    .select('id, updated_at')
    .in('product', SWEPT_PRODUCTS)
    .eq('status', 'paid')
    .lt('updated_at', cutoff)
    .order('updated_at', { ascending: true })
    // Each report is two model calls and the function has a wall clock. Taking
    // a few per sweep and leaving the rest for the next one finishes a backlog
    // a minute later than one heroic pass would, and without timing out
    // half way through somebody's report.
    .limit(MAX_PER_SWEEP);

  if (fetchError) {
    res.status(500).json({ ok: false, error: fetchError.message });
    return;
  }

  const results = [];
  for (const row of waiting || []) {
    try {
      await generateNavigatorReport(row.id);

      // And then actually give it to them.
      //
      // This sweep exists precisely for the customer who is NOT on the status
      // page, so every report it produces is one nobody is watching arrive.
      // Until this line, that report was written to the database and left
      // there: the PDF email is sent by JavaScript on the status page, so a
      // customer who paid and closed the tab got a complete, correct,
      // undelivered report and no way to reach it — localStorage in the
      // purchasing browser was the only route back to it, and the Stripe
      // webhook sends nothing.
      //
      // Delivery failing must never turn a produced report into a failed one:
      // the report is stored, the row says 'complete', and process-refunds
      // must not see this as undelivered work. So it is reported, not thrown.
      let delivery = 'skipped';
      try {
        delivery = await deliverReportByEmail(admin, row.id);
      } catch (err) {
        delivery = `error: ${String(err.message || err).slice(0, 120)}`;
        console.error(`[generate-paid-navigator] delivery failed for ${row.id}:`, err.message);
      }
      results.push({ id: row.id, ok: true, delivery });
    } catch (err) {
      // generateNavigatorReport has already written the row: 'failed' with a
      // refund queued where the failure was ours, or back to 'paid' where the
      // model provider was simply unavailable and the next sweep should retry.
      // Swallowing here keeps one bad submission from stopping the sweep.
      results.push({ id: row.id, ok: false, error: String(err.message || err).slice(0, 200) });
    }
  }

  res.status(200).json({ ok: true, considered: (waiting || []).length, results });
};
