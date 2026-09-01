// Customer-supplied corrections for values we could not read.
//
// The audit used to tell customers "upload a clearer copy, or type the value in
// manually" — with nowhere to type it and nothing that would recompute if they
// had. This closes that loop.
//
// The design constraint that shapes everything here: a typed number is NOT a
// verified reading. We cannot see the customer's document. So values arrive
// tagged value_source: 'customer', that tag travels into every finding built on
// them, and a "confirmed mathematical error" resting on a typed figure is
// downgraded to something the customer must check before acting on. Getting this
// wrong would mean a mistyped digit becoming a confident accusation the customer
// emails to their lender with our name on it.
//
// Only fields the audit itself flagged as unreadable can be set. Anything else
// is rejected, so this cannot be used to rewrite figures we read correctly.

const { getSupabaseAdmin } = require('./_lib/supabaseAdmin');
const {
  listUnreadableFields,
  mergeCustomerValues,
  runClosingAudit,
  buildScorecard,
} = require('./_lib/closing-extract');

const MAX_VALUES = 40;

// A regeneration costs one model call — pennies against a $59 sale — so this cap
// exists only to stop a loop, not to ration a legitimate correction.
const MAX_REGENERATIONS = 3;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const id = typeof body.id === 'string' ? body.id : '';
  const token = typeof body.token === 'string' ? body.token : '';
  if (!id || !token) {
    res.status(400).json({ ok: false, error: 'Missing submission reference.' });
    return;
  }

  const values = body.values && typeof body.values === 'object' ? body.values : null;
  if (!values || !Object.keys(values).length) {
    res.status(400).json({ ok: false, error: 'No values were provided.' });
    return;
  }
  if (Object.keys(values).length > MAX_VALUES) {
    res.status(400).json({ ok: false, error: 'Too many values in one request.' });
    return;
  }

  const admin = getSupabaseAdmin();

  const { data: submission, error: fetchError } = await admin
    .from('navigator_submissions')
    .select('id, access_token, product, form_data, status')
    .eq('id', id)
    .single();

  if (fetchError || !submission || submission.access_token !== token || submission.product !== 'closing') {
    res.status(404).json({ ok: false, error: 'Submission not found.' });
    return;
  }

  const formData = submission.form_data || {};
  const extraction = formData.extraction;
  if (!extraction) {
    res.status(400).json({ ok: false, error: 'This submission has no analysis to update yet.' });
    return;
  }

  // Merge against the ORIGINAL extraction, not the previously corrected one, so
  // a customer can revise an earlier entry rather than being locked into it.
  const baseExtraction = formData.original_extraction || extraction;
  const previous = formData.customer_values || {};
  const combined = { ...previous, ...values };

  const { extraction: merged, applied, rejected } = mergeCustomerValues(baseExtraction, combined);

  if (!applied.length) {
    res.status(400).json({
      ok: false,
      error: 'None of those values could be applied. Only figures we flagged as unreadable can be entered.',
      rejected,
    });
    return;
  }

  const { findings, skipped } = runClosingAudit(merged, { answers: formData.answers || {} });
  const scorecard = buildScorecard(merged, findings, skipped);

  // If the report has already been generated and paid for, the customer is
  // holding an audit with known holes. New figures have to produce a new report
  // or the correction is cosmetic. Resetting status to 'paid' is enough:
  // get-navigator-submission regenerates any paid submission on its next poll,
  // so this reuses the existing pipeline rather than duplicating it.
  const regenCount = Number(formData.regeneration_count || 0);
  const alreadyReported = submission.status === 'complete' || submission.status === 'failed';
  const willRegenerate = alreadyReported && regenCount < MAX_REGENERATIONS;

  const update = {
    form_data: {
      ...formData,
      // Keep the untouched reading so corrections stay reversible and auditable.
      original_extraction: baseExtraction,
      extraction: merged,
      customer_values: combined,
      scorecard,
      regeneration_count: willRegenerate ? regenCount + 1 : regenCount,
    },
    updated_at: new Date().toISOString(),
  };
  if (willRegenerate) {
    update.status = 'paid';
    update.error = null;
  }

  const { error: updateError } = await admin
    .from('navigator_submissions')
    .update(update)
    .eq('id', id);

  if (updateError) {
    res.status(500).json({ ok: false, error: 'Could not save those values. Please try again.' });
    return;
  }

  res.status(200).json({
    ok: true,
    scorecard,
    applied: applied.length,
    rejected,
    regenerating: willRegenerate,
    regenerations_left: willRegenerate ? MAX_REGENERATIONS - (regenCount + 1) : null,
    regeneration_blocked: alreadyReported && !willRegenerate,
    // What is still missing, so the UI can show a shrinking list rather than
    // making the customer guess whether their entry did anything.
    remaining: listUnreadableFields(merged),
  });
};
