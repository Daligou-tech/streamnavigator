// Reopening a free scorecard the customer already ran.
//
// The scorecard lived in one browser tab and nowhere else. Close it, or open
// the link on a phone to show a spouse, and it was gone — "This scorecard is no
// longer open. Upload your Closing Disclosure again and it comes straight
// back." The reasoning was sound and stated plainly: no copy kept at a
// guessable address, because it is built from somebody's closing figures.
//
// But the scorecard is the entire top of the funnel, and the gap between seeing
// findings and deciding to pay is exactly where a person closes a tab to think.
// Asking them to re-upload the largest document they will sign this decade, at
// that moment, is the most expensive friction in the product.
//
// What makes this safe is that nothing new is stored. The submission row has
// carried the extraction, the answers and the scorecard since the free run;
// what was missing was a way back to it. The address is not guessable because
// it needs the row's access token, the same token the paid report already uses
// — a submission id alone gets nothing.
//
// The scorecard is REBUILT from the stored extraction rather than served from
// the stored copy. Two reasons: a customer returning after an engine change
// sees what the engine says now rather than a stale snapshot, and the stored
// copy stops being a second source of truth for figures the audit can derive.
// The stored copy is the fallback for a row whose extraction never completed.

'use strict';

const { getSupabaseAdmin } = require('./_lib/supabaseAdmin');
const { runDocumentAudit } = require('./_lib/closing-service');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (err) { body = {}; }
  }
  body = body || {};

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const token = typeof body.token === 'string' ? body.token.trim() : '';

  if (!id || !token) {
    res.status(400).json({ ok: false, error: 'That link is incomplete.' });
    return;
  }

  const admin = getSupabaseAdmin();
  const { data: submission, error } = await admin
    .from('navigator_submissions')
    .select('id, access_token, product, status, form_data')
    .eq('id', id)
    .single();

  // One message for every failure mode, deliberately. Distinguishing "no such
  // submission" from "wrong token" tells someone probing ids which half they
  // got right.
  if (error || !submission
      || submission.access_token !== token
      || submission.product !== 'closing') {
    res.status(404).json({ ok: false, error: 'That link is no longer valid. Run the free check again — it is still free.' });
    return;
  }

  const formData = submission.form_data || {};
  let scorecard = formData.scorecard || null;
  let coverageByGroup = null;

  if (formData.extraction) {
    try {
      const audited = runDocumentAudit({
        extraction: formData.extraction,
        answers: formData.answers || {},
        loanEstimates: formData.loan_estimates || null,
        contractTerms: formData.contract_terms || null,
      });
      scorecard = {
        // The scorecard endpoint computes fields the audit does not produce —
        // tier, tolerance flags, mismatch detail. Keep them under the rebuild.
        ...(formData.scorecard || {}),
        ...audited.scorecard,
      };
      coverageByGroup = audited.coverage_by_group;
    } catch (err) {
      // A failed rebuild falls back to the stored copy rather than costing the
      // customer the scorecard they came back for.
      console.error('[closing-scorecard-resume] audit re-run failed:', err.message);
    }
  }

  if (!scorecard) {
    res.status(404).json({ ok: false, error: 'That check did not finish. Run it again — it is still free.' });
    return;
  }

  res.status(200).json({
    ok: true,
    id: submission.id,
    token: submission.access_token,
    scorecard,
    coverage_by_group: coverageByGroup,
    answers: formData.answers || {},
    // A submission that has already been paid for should not be sold again.
    already_paid: submission.status !== 'pending_payment' && submission.status !== 'scorecard',
  });
};
