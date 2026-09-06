// Drives HOA report generation, one stage per invocation.
//
// Generation used to run inside the customer's polling request. On a single
// reserve study that took 654 seconds against Vercel's 800 second ceiling —
// and at the ceiling a report does not come out worse, it fails outright. A
// full package (reserve study, budget, financials, minutes) had no chance of
// finishing, which is the opposite of how the product should behave: the more
// documents a buyer provides, the better the analysis should get.
//
// So the work is now staged. Each document is read in its own invocation with
// its own full time budget, then a synthesis stage does the cross-document
// comparison with no documents attached. Adding documents costs more
// invocations rather than more seconds inside one. See the staged-generation
// section of api/_lib/hoa-engine.js.
//
// This endpoint claims one submission and advances it by exactly one stage.
// Run once a minute by the cron in vercel.json, so a four-document package
// completes across four ticks rather than one enormous request.
//
// Protected by CRON_SECRET exactly as api/refresh-shows.js,
// api/retry-failed-buying.js and api/cleanup-staging-uploads.js are.

'use strict';

const { getSupabaseAdmin } = require('./_lib/supabaseAdmin');
const { advanceHoaJob, STAGE_STALL_MS, MAX_JOB_ATTEMPTS } = require('./_lib/hoa-engine');

module.exports = async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  const admin = getSupabaseAdmin();
  const stallCutoff = new Date(Date.now() - STAGE_STALL_MS).toISOString();

  // Three kinds of work, in priority order:
  //
  //   1. paid           — nobody has started it yet.
  //   2. processing     — a stage was claimed but has not reported back
  //      (stale)          within STAGE_STALL_MS. The platform killed it
  //                       outside the engine's own try/catch, so the row was
  //                       never updated. Resumes from job_state, so the
  //                       documents already read are not re-read.
  //   3. failed         — a transient API error. job_state is deliberately
  //      (retryable)      kept on failure, so this resumes mid-package rather
  //                       than starting over. Bounded by MAX_JOB_ATTEMPTS so
  //                       a document the model genuinely cannot read does not
  //                       loop forever at Opus prices.
  //
  // One submission per tick. Two HOA analyses running at once is a cost
  // spike, and the queue is measured in minutes, not hours.
  async function claimable() {
    const paid = await admin
      .from('navigator_submissions')
      .select('id, status')
      .eq('product', 'hoa')
      .eq('status', 'paid')
      .order('updated_at', { ascending: true })
      .limit(1);
    if (paid.data && paid.data.length) return paid.data[0];

    const stalled = await admin
      .from('navigator_submissions')
      .select('id, status')
      .eq('product', 'hoa')
      .eq('status', 'processing')
      .not('job_state', 'is', null)
      .lt('updated_at', stallCutoff)
      .order('updated_at', { ascending: true })
      .limit(1);
    if (stalled.data && stalled.data.length) return stalled.data[0];

    const retryable = await admin
      .from('navigator_submissions')
      .select('id, status')
      .eq('product', 'hoa')
      .eq('status', 'failed')
      .not('job_state', 'is', null)
      .lt('generation_attempts', MAX_JOB_ATTEMPTS)
      .order('updated_at', { ascending: true })
      .limit(1);
    if (retryable.data && retryable.data.length) return retryable.data[0];

    return null;
  }

  let target;
  try {
    target = await claimable();
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err).slice(0, 300) });
    return;
  }

  if (!target) {
    res.status(200).json({ ok: true, worked: false, reason: 'nothing to do' });
    return;
  }

  try {
    const result = await advanceHoaJob(target.id);
    res.status(200).json({
      ok: true,
      worked: true,
      submission_id: target.id,
      picked_up_as: target.status,
      ...result,
      // The report itself is large and already stored; the cron log does not
      // need a copy of it.
      report: undefined,
    });
  } catch (err) {
    // advanceHoaJob has already recorded status:'failed' and the message on
    // the row. Reported as a 200 so a single bad submission does not make the
    // cron itself look broken — the next tick picks up whatever is next.
    res.status(200).json({
      ok: true,
      worked: true,
      submission_id: target.id,
      picked_up_as: target.status,
      failed: true,
      error: String(err.message || err).slice(0, 300),
    });
  }
};
