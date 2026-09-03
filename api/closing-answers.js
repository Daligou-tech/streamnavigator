// Step 2 — the two structured questions, stored against the submission before
// checkout.
//
// Both answers change the analysis, which is why they are asked rather than
// assumed:
//   * property type / occupancy drives HOA and condo questionnaire charges,
//     escrow requirements, and investment-property handling.
//   * whether the lender supplied a WRITTEN list of service providers decides
//     which TRID tolerance bucket the shoppable services fall into. Without the
//     list the creditor cannot rely on the shopping exception, and those charges
//     are tested at zero tolerance — where any increase is a potential cure.
//     "Don't know" is not treated as "yes"; see normalizeProviderListAnswer.
//
// The access token is required. Without it, knowing a submission id would let
// anyone alter someone else's answers.

const { getSupabaseAdmin } = require('./_lib/supabaseAdmin');
const { mergeFormData } = require('./_lib/submission-store');
const { runClosingAudit, buildScorecard } = require('./_lib/closing-extract');

const PROPERTY_TYPES = [
  'single_family', 'condo', 'other_attached', 'investment', 'other',
];
const PROVIDER_LIST_ANSWERS = ['yes', 'no', 'dont_know'];

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

  const propertyType = String(body.property_type || '');
  const providerList = String(body.provider_list || '');
  if (!PROPERTY_TYPES.includes(propertyType)) {
    res.status(400).json({ ok: false, error: 'Please choose a property type.' });
    return;
  }
  if (!PROVIDER_LIST_ANSWERS.includes(providerList)) {
    res.status(400).json({ ok: false, error: 'Please answer the service provider list question.' });
    return;
  }

  const admin = getSupabaseAdmin();

  const { data: submission, error: fetchError } = await admin
    .from('navigator_submissions')
    .select('id, access_token, form_data, product')
    .eq('id', id)
    .single();

  if (fetchError || !submission || submission.access_token !== token || submission.product !== 'closing') {
    res.status(404).json({ ok: false, error: 'Submission not found.' });
    return;
  }

  const formData = submission.form_data || {};
  const answers = { property_type: propertyType, provider_list: providerList };

  // Storing the answers was never the point. Until now they were written here
  // and read by nothing: the audit had already run at upload time, before the
  // questions were asked, so both answers changed the price of nothing.
  //
  // Re-running the audit is what makes them real. The provider-list answer
  // decides which tolerance bucket the shoppable charges fall into, and the
  // property-type answer decides whether an HOA or condo charge is expected or
  // unexplained. Everything the re-run needs was stored at the scorecard stage.
  let refreshed = null;
  if (formData.extraction) {
    try {
      const { findings, skipped } = runClosingAudit(formData.extraction, {
        answers,
        loanEstimates: formData.loan_estimates || null,
        contractTerms: formData.contract_terms || null,
      });
      refreshed = {
        // Preserve the fields the scorecard endpoint computed that the audit
        // does not produce (tier, tolerance flags, mismatch detail).
        ...(formData.scorecard || {}),
        ...buildScorecard(formData.extraction, findings, skipped),
      };
    } catch (err) {
      // A failed re-run must not cost the customer their scorecard or block
      // checkout. Keep the original and carry on.
      console.error('[closing-answers] audit re-run failed:', err.message);
    }
  }

  const { error: updateError } = await admin
    .from('navigator_submissions')
    .update({
      form_data: mergeFormData(formData, {
        stage: 'answered',
        answers,
        ...(refreshed ? { scorecard: refreshed } : {}),
      }),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (updateError) {
    res.status(500).json({ ok: false, error: 'Could not save your answers. Please try again.' });
    return;
  }

  res.status(200).json({ ok: true, scorecard: refreshed });
};
