// Refunds customers whose paid report could not be produced.
//
// A report that fails after exhausting every attempt leaves a customer who
// paid and received nothing. Before this, the only trace was a status of
// 'failed' and an error string in the database, so the refund depended on
// somebody noticing an alert email and remembering to act on it. That is not
// a system; it is a good intention.
//
// api/_lib/hoa-engine.js now sets refund_state='due' at the same moment it
// gives up, and this endpoint turns that into money actually returned. The
// status page tells the customer their refund has been queued, so this is
// what makes that sentence true rather than a promise.
//
// FOUR conditions must all hold before a single cent moves. Any one of them
// missing and the row is skipped:
//
//   1. refund_state = 'due'          — the engine marked it, nothing else does
//   2. status = 'failed'             — it really did give up
//   3. a checkout session exists     — there was a payment to return
//   4. no report row exists          — nothing was ever delivered for it
//
// The fourth is the one that matters most: it means a submission that
// eventually succeeded can never be refunded by a stale flag, whatever went
// wrong earlier. It looks in every table a report can land in, not just
// navigator_reports: Contractor Navigator writes to contractor_reports, and a
// guard that cannot see a delivered report is not a guard.
//
// There is a SECOND queue here, and it is the opposite case. A contractor
// submission whose documents were too thin to run most of the checks is
// refunded WITH its report — see COVERAGE_FLOOR in api/_lib/contractor-engine.js.
// That row is 'complete' and does have a report, so it fails conditions 2 and 4
// by design and is read separately below. The customer keeps what we found and
// does not pay for it, and nobody has to ask.
//
// Protected by CRON_SECRET like the other scheduled endpoints. Runs every ten
// minutes, so a refund lands well inside the window where a customer is still
// wondering what happened.

'use strict';

const Stripe = require('stripe');
const { getSupabaseAdmin } = require('./_lib/supabaseAdmin');

// A refund is real money leaving the account, so the batch is deliberately
// small: a bug that somehow got past the four guards above refunds a handful
// of rows per run and shows up in the response, rather than draining the
// account in one pass.
const MAX_PER_RUN = 5;

// Every table a finished report can live in. navigator_reports holds eleven
// products; Contractor Navigator has always had its own.
const REPORT_TABLES = ['navigator_reports', 'contractor_reports'];

async function reportExists(admin, submissionId) {
  for (const table of REPORT_TABLES) {
    const { count, error } = await admin
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('submission_id', submissionId);
    // A query that errored is not evidence of absence. Treating it as "no
    // report" would refund a delivered report, so it counts as present and the
    // row waits for the next run.
    if (error) return true;
    if (count && count > 0) return true;
  }
  return false;
}

// The thin-result state, kept in step with api/_lib/contractor-engine.js.
const REFUND_STATE_THIN = 'due_thin_result';

module.exports = async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) {
    res.status(500).json({ ok: false, error: 'Missing STRIPE_SECRET_KEY' });
    return;
  }

  const admin = getSupabaseAdmin();
  const stripe = new Stripe(STRIPE_SECRET_KEY);

  const failedAndUndelivered = await admin
    .from('navigator_submissions')
    .select('id, product, status, email, price_cents, stripe_checkout_session_id')
    .eq('refund_state', 'due')
    .eq('status', 'failed')
    .not('stripe_checkout_session_id', 'is', null)
    .order('updated_at', { ascending: true })
    .limit(MAX_PER_RUN);

  // Delivered, and refunded anyway. The report exists and the customer keeps
  // it; what they do not keep is the charge, because the audit could not run
  // enough of itself on the documents they had.
  const thinButDelivered = await admin
    .from('navigator_submissions')
    .select('id, product, status, refund_state, email, price_cents, stripe_checkout_session_id')
    .eq('refund_state', REFUND_STATE_THIN)
    .eq('status', 'complete')
    .not('stripe_checkout_session_id', 'is', null)
    .order('updated_at', { ascending: true })
    .limit(MAX_PER_RUN);

  const queryError = failedAndUndelivered.error || thinButDelivered.error;
  if (queryError) {
    res.status(500).json({ ok: false, error: String(queryError.message).slice(0, 300) });
    return;
  }

  const due = (failedAndUndelivered.data || []).concat(thinButDelivered.data || []).slice(0, MAX_PER_RUN);

  const results = [];

  for (const row of due || []) {
    const thin = row.refund_state === REFUND_STATE_THIN || row.status === 'complete';
    try {
      // Guard 4. A report that exists means the customer got what they paid
      // for, whatever a leftover flag says.
      const delivered = !thin && await reportExists(admin, row.id);

      if (delivered) {
        await admin
          .from('navigator_submissions')
          .update({ refund_state: null, updated_at: new Date().toISOString() })
          .eq('id', row.id);
        results.push({ id: row.id, action: 'cleared', reason: 'a report exists for this submission' });
        continue;
      }

      const session = await stripe.checkout.sessions.retrieve(row.stripe_checkout_session_id);
      const paymentIntent = session && session.payment_intent;
      if (!paymentIntent) {
        await admin
          .from('navigator_submissions')
          .update({ refund_state: 'failed', updated_at: new Date().toISOString() })
          .eq('id', row.id);
        results.push({ id: row.id, action: 'needs_human', reason: 'no payment intent on that checkout session' });
        continue;
      }

      // Stripe treats a repeated refund of the same payment intent as an
      // error rather than a no-op, so an already-refunded payment is recorded
      // as refunded instead of retried forever.
      const refund = await stripe.refunds.create({
        payment_intent: typeof paymentIntent === 'string' ? paymentIntent : paymentIntent.id,
        reason: 'requested_by_customer',
        metadata: {
          submission_id: row.id,
          product: row.product,
          cause: thin ? 'too_few_checks_could_run_on_the_documents' : 'report_could_not_be_produced',
        },
      });

      await admin
        .from('navigator_submissions')
        .update({ refund_state: 'refunded', updated_at: new Date().toISOString() })
        .eq('id', row.id);

      results.push({
        id: row.id,
        action: thin ? 'refunded_thin_result' : 'refunded',
        amount_cents: refund.amount,
        refund_id: refund.id,
      });
    } catch (err) {
      const message = String((err && err.message) || err).slice(0, 300);
      const alreadyRefunded = /already been refunded|has already been refunded/i.test(message);

      await admin
        .from('navigator_submissions')
        .update({
          refund_state: alreadyRefunded ? 'refunded' : 'failed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);

      results.push({ id: row.id, action: alreadyRefunded ? 'already_refunded' : 'error', error: message });
    }
  }

  res.status(200).json({ ok: true, considered: (due || []).length, results });
};
