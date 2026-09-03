// Free, pre-payment Closing Disclosure scorecard.
//
// This is the top of the funnel: the customer uploads their CD, we extract it,
// run every deterministic check that needs no other document, and hand back
// headline figures and counts. No fee is named and no dollar impact is shown —
// that is what the $59 report is for.
//
// It runs BEFORE payment on purpose. The old flow took $59 and only then
// discovered whether the upload was legible, or even a Closing Disclosure. Now
// an unreadable or mislabelled document is caught while it is still free, and
// the customer is told what to do about it.
//
// The extraction is stored on the submission, so the paid report reuses it
// instead of paying to read the same PDF twice.

const { getSupabaseAdmin } = require('./_lib/supabaseAdmin');
const {
  extractClosingDisclosure,
  runClosingAudit,
  buildScorecard,
  ACCEPTED_DOCUMENT_TYPES,
  DOCUMENT_LABELS,
  classifyDocuments,
  determineTier,
  PRIMARY_TYPES,
  extractLoanEstimate,
  toLoanEstimateRecord,
  extractPurchaseContract,
  toContractTerms,
  checkTransactionMatch,
} = require('./_lib/closing-extract');
const { checkScorecardRateLimit, hashIp, clientIp } = require('./_lib/rate-limit');
const { runDocumentAudit } = require('./_lib/closing-service');

// Uploads arrive base64-encoded in a JSON body. Vercel caps a function request
// body at 4.5MB and returns 413 FUNCTION_PAYLOAD_TOO_LARGE above it — at the
// edge, before this handler runs, so the friendly errors below never fire for
// an oversized request. base64 inflates bytes by 4/3, so the real ceiling on
// raw file bytes is ~3.2MB. The previous 6MB/9MB values were unreachable: a
// single 5MB scan died with a generic client-side error and no retry could fix
// it. Keep in step with navigator-shared.js.
const VERCEL_BODY_LIMIT_BYTES = 4.5 * 1024 * 1024;
const BASE64_INFLATION = 4 / 3;
const JSON_ENVELOPE_MARGIN = 0.94;
const MAX_TOTAL_BYTES = Math.floor((VERCEL_BODY_LIMIT_BYTES / BASE64_INFLATION) * JSON_ENVELOPE_MARGIN);
const MAX_FILE_BYTES = MAX_TOTAL_BYTES;
const MAX_TOTAL_MB = Math.round((MAX_TOTAL_BYTES / (1024 * 1024)) * 10) / 10;
const MAX_FILES = 12;

// Mirrors TIERS.basic in _lib/closing-extract.js.
const TIERS_BASIC = { id: 'basic', price_cents: 2900, price_label: '$29' };

// Contract terms read below this confidence are discarded, not used.
const CONTRACT_CONF_THRESHOLD = 0.85;

function guessMediaType(filename) {
  const ext = String(filename).toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'heic' || ext === 'heif') return 'image/heic';
  return 'image/jpeg';
}

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

  const email = typeof body.email === 'string' ? body.email.trim().slice(0, 320) : '';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ ok: false, error: 'That email address doesn’t look right.' });
    return;
  }

  const files = Array.isArray(body.files) ? body.files.slice(0, MAX_FILES) : [];
  if (!files.length) {
    res.status(400).json({ ok: false, error: 'Please attach your Closing Disclosure to continue.' });
    return;
  }

  let totalBytes = 0;
  for (const f of files) {
    if (!f || typeof f.dataBase64 !== 'string' || !f.name) {
      res.status(400).json({ ok: false, error: 'Malformed file upload.' });
      return;
    }
    const approxBytes = Math.ceil((f.dataBase64.length * 3) / 4);
    if (approxBytes > MAX_FILE_BYTES) {
      res.status(400).json({ ok: false, error: `${f.name} is larger than the ${MAX_TOTAL_MB}MB limit. Try the original PDF from your lender rather than a photo.` });
      return;
    }
    totalBytes += approxBytes;
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    res.status(400).json({ ok: false, error: `Those files together are too large — the limit is ${MAX_TOTAL_MB}MB total. Upload the Closing Disclosure now and add the rest afterwards.` });
    return;
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    res.status(500).json({ ok: false, error: 'Analysis is temporarily unavailable. Please try again shortly.' });
    return;
  }

  const admin = getSupabaseAdmin();

  // Checked BEFORE the row is inserted and before the model is called, so a
  // blocked request costs nothing and leaves no record to inflate the next count.
  const ipHash = hashIp(clientIp(req));
  const limit = await checkScorecardRateLimit(admin, { email: email || null, ipHash });
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterMinutes * 60));
    res.status(429).json({ ok: false, error: limit.message });
    return;
  }

  const { data: submission, error: insertError } = await admin
    .from('navigator_submissions')
    .insert({
      product: 'closing',
      email: email || null,
      form_data: {
        stage: 'scorecard',
        ip_hash: ipHash,
      },
    })
    .select('id, access_token')
    .single();

  if (insertError || !submission) {
    res.status(500).json({ ok: false, error: 'Could not save your submission. Please try again.' });
    return;
  }

  // Store the files first. If extraction fails afterwards, the customer's
  // upload is still on the record and the paid path can retry against it.
  const filePaths = [];
  const contentBlocks = [];
  for (const f of files) {
    const safeName = String(f.name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
    const path = `closing/${submission.id}/${Date.now()}-${safeName}`;
    const buffer = Buffer.from(f.dataBase64, 'base64');
    const { error: uploadError } = await admin.storage
      .from('navigator-uploads')
      .upload(path, buffer, { contentType: f.type || 'application/octet-stream', upsert: false });
    if (!uploadError) filePaths.push(path);

    const mediaType = guessMediaType(f.name);
    contentBlocks.push(
      mediaType === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: f.dataBase64 } }
        : { type: 'image', source: { type: 'base64', media_type: mediaType, data: f.dataBase64 } }
    );
  }

  await admin
    .from('navigator_submissions')
    .update({ file_paths: filePaths, updated_at: new Date().toISOString() })
    .eq('id', submission.id);

  // With several files we classify first — one small call — then fully extract
  // only the Closing Disclosure. Extracting every document at the free stage
  // would multiply the cost of an unauthenticated endpoint, and the Loan
  // Estimates and contract are not needed until the paid analysis runs.
  let documents = [{ index: 0, document_type: null }];
  let primaryIndex = 0;
  if (contentBlocks.length > 1) {
    try {
      documents = await classifyDocuments(ANTHROPIC_API_KEY, contentBlocks);
      const primary = documents.find((d) => PRIMARY_TYPES.includes(d.document_type));
      if (primary) primaryIndex = primary.index;
    } catch (err) {
      // Classification failing is not fatal — fall back to treating the first
      // file as the Closing Disclosure, which is what the single-file path does.
      documents = [{ index: 0, document_type: null }];
    }
  }

  let extraction;
  try {
    extraction = await extractClosingDisclosure(ANTHROPIC_API_KEY, [contentBlocks[primaryIndex]]);
  } catch (err) {
    res.status(200).json({
      ok: true,
      id: submission.id,
      token: submission.access_token,
      scorecard: null,
      error_message:
        'We could not read that document automatically. It may be a scan quality issue. ' +
        'Try uploading a clearer copy, or the original PDF from your lender rather than a photo.',
    });
    return;
  }

  // The customer uploaded something we cannot audit. Say so now, for free,
  // rather than after taking their money. An ALTA Settlement Statement IS
  // accepted — it is the title company's own form and is routinely mistaken for
  // the Closing Disclosure, so turning it away would lose customers who are
  // holding a perfectly usable document.
  if (!ACCEPTED_DOCUMENT_TYPES.includes(extraction.document_type)) {
    await admin
      .from('navigator_submissions')
      .update({
        form_data: { stage: 'scorecard', ip_hash: ipHash, extraction, wrong_document: true },
        updated_at: new Date().toISOString(),
      })
      .eq('id', submission.id);

    res.status(200).json({
      ok: true,
      id: submission.id,
      token: submission.access_token,
      scorecard: null,
      error_message:
        (DOCUMENT_LABELS[extraction.document_type]
          // Named type: tell them what we think it is.
          ? `That looks like a ${DOCUMENT_LABELS[extraction.document_type]}, which we cannot audit on its own. `
          // Unrecognised: say we could not identify it, rather than the previous
          // "That looks like a document, which we cannot audit" — which was both
          // broken English and unhelpful.
          : 'We could not identify that document. ') +
        'We need either your Closing Disclosure — the five-page form headed "Closing Disclosure" that ' +
        'your lender sends at least three business days before closing — or your settlement agent\'s ' +
        'ALTA Settlement Statement. Upload either and we will take another look.',
    });
    return;
  }

  // The classifier only saw the other files; make sure the primary reflects what
  // full extraction actually found, so the tier is based on real types.
  const classified = documents.map((d) =>
    d.index === primaryIndex ? { ...d, document_type: extraction.document_type } : d);
  const tier = determineTier(classified);

  // Tolerance testing runs HERE, in the free scorecard, when Loan Estimates were
  // uploaded — not only in the paid report.
  //
  // The flag count is the entire basis of the purchase decision. A count that
  // silently excludes the analysis the customer is paying extra for is not a
  // basis, it is a guess. Extracting the Loan Estimates costs a model call each,
  // which is why this is limited to people who actually uploaded them — a fair
  // proxy for intent — and the rate limiter still caps the exposure.
  //
  // The records are stored so the paid report reuses them instead of paying to
  // read the same PDFs twice.
  let loanEstimates = null;
  const leIndexes = classified
    .filter((d) => d.document_type === 'loan_estimate')
    .map((d) => d.index)
    .filter((i) => typeof i === 'number' && contentBlocks[i]);

  if (leIndexes.length) {
    const records = [];
    for (const i of leIndexes) {
      try {
        const raw = await extractLoanEstimate(ANTHROPIC_API_KEY, contentBlocks[i]);
        if (raw && raw.is_loan_estimate !== false && (raw.charges || []).length) {
          records.push(toLoanEstimateRecord(raw, `LE${records.length + 1}`));
        }
      } catch (err) {
        console.error('[closing-scorecard] loan estimate extraction failed:', err.message);
      }
    }
    // selectBaseline orders revisions by issue date. Without one we cannot
    // establish which Loan Estimate governs, and guessing a baseline is worse
    // than declining to test.
    const dated = records.filter((r) => r.dateIssued);
    if (dated.length) loanEstimates = dated;
  }

  // The purchase contract, extracted here for the same reason the Loan Estimates
  // are: the flag count must include the analysis the $59 tier is sold on.
  // Before this, contract_terms was read in three places and written in none.
  let contractTerms = null;
  let contractMismatch = null;
  let contractLowConfidence = 0;
  const contractIndexes = classified
    .filter((d) => d.document_type === 'purchase_contract')
    .map((d) => d.index)
    .filter((i) => typeof i === 'number' && contentBlocks[i]);

  for (const i of contractIndexes) {
    try {
      const raw = await extractPurchaseContract(ANTHROPIC_API_KEY, contentBlocks[i]);
      if (!raw || raw.is_purchase_contract === false) continue;

      // Same identity guard as the Loan Estimates. A contract for a different
      // property would report every negotiated credit as missing.
      const match = checkTransactionMatch(extraction, {
        propertyAddress: raw.property_address || null,
        lenderName: null,
        borrowerNames: raw.buyer_names || null,
      });
      if (!match.sameTransaction) {
        contractMismatch = match.mismatches.filter((m) => m.hard);
        continue;
      }

      // A barely legible scan still yields SOME terms, and a misread seller
      // credit becomes a confident "your credit is missing" finding — money
      // invented out of a bad photograph. That is the worst thing this product
      // can do, so terms read with low confidence are dropped and the customer
      // is told the contract could not be used rather than charged for it.
      const terms = toContractTerms(raw).filter((t) => {
        const c = typeof t.confidence === 'number' ? t.confidence : 1;
        if (c < CONTRACT_CONF_THRESHOLD) { contractLowConfidence += 1; return false; }
        return true;
      });
      if (terms.length) contractTerms = [...(contractTerms || []), ...terms];
    } catch (err) {
      console.error('[closing-scorecard] purchase contract extraction failed:', err.message);
    }
  }

  // The two questions are asked after this runs, so answers are empty here;
  // /api/closing-answers re-runs the audit once they arrive.
  const answers = (submission.form_data || {}).answers || {};
  // The document-only service. It runs the same engine with benchmarking
  // absent rather than merely disabled, adds the page 5 loan-math checks, and
  // returns a scorecard whose denominator is CHECKS rather than fees with rate
  // data. The tier it computes is ignored here: the block below already has
  // richer downgrade reasons because it can see which uploads were unusable.
  const audited = runDocumentAudit({
    extraction,
    answers,
    loanEstimates,
    contractTerms,
    unusableDocuments: [
      ...(leIndexes.length && !loanEstimates ? ['loan_estimate'] : []),
      ...(contractIndexes.length && !contractTerms ? ['purchase_contract'] : []),
    ],
  });
  const { findings, skipped } = audited;

  // Tolerance testing needs charges on BOTH sides. Reading the Loan Estimates is
  // only half of it — if the Closing Disclosure has no charge lines (a page-1
  // excerpt, a scan missing page 2), 22 Loan Estimate charges get compared to an
  // empty list and produce nothing. Reporting that as "no fee rose beyond what
  // the rules permit" is a silent pass on a test that never ran, which is worse
  // than reporting nothing at all.
  const cdChargeCount = (extraction.line_items || []).length;

  // The audit refuses to compare documents describing different loans. That
  // refusal was recorded in checks_skipped but never surfaced, so a customer who
  // uploaded the wrong Loan Estimate saw an ordinary scorecard and no reason to
  // fix it. The check worked; the telling did not.
  const transactionMismatch = skipped.some((x) => /different loan/.test(x));
  const toleranceTested = Boolean(loanEstimates) && cdChargeCount > 0 && !transactionMismatch;
  const contractReconciled = Boolean(contractTerms && contractTerms.length);

  // The tier was decided by which document TYPES were uploaded, before anyone
  // knew whether those documents could be used. A Loan Estimate for a different
  // loan, or a contract we could not read, still moved the price to $59 — and
  // the scorecard then listed the very check being charged for under "checks we
  // could not run". Charge for analysis that ran, not for a file that arrived.
  const usableUpgrades = (toleranceTested ? 1 : 0) + (contractReconciled ? 1 : 0);
  const effectiveTier = usableUpgrades
    ? { ...tier, upgrade_documents: usableUpgrades }
    : {
        ...TIERS_BASIC,
        has_loan_estimate: tier.has_loan_estimate,
        has_purchase_contract: tier.has_purchase_contract,
        upgrade_documents: 0,
        // The page needs to distinguish "you uploaded nothing extra" from
        // "you uploaded something extra and it did not work", because the
        // second case needs an explanation and a way to fix it.
        downgraded_from_full: tier.id === 'full',
      };

  const scorecard = {
    ...audited.scorecard,
    coverage_by_group: audited.coverage_by_group,
    tier: effectiveTier,
    tolerance_tested: toleranceTested,
    tolerance_blocked_reason: transactionMismatch
      ? 'different_loan'
      : (loanEstimates && !cdChargeCount)
        ? 'no_cd_charges'
        : (leIndexes.length && !loanEstimates ? 'le_unreadable' : null),
    // Surfaced so the page can tell the customer which checks did not run and
    // why, rather than leaving it to a silent count.
    checks_skipped_detail: skipped,
    contract_reconciled: contractReconciled,
    contract_terms_read: contractTerms ? contractTerms.length : 0,
    contract_uploaded: contractIndexes.length,
    contract_mismatch: contractMismatch,
    contract_low_confidence: contractLowConfidence,
    transaction_mismatch: transactionMismatch
      ? {
          fields: ((findings.find((f) => f.checkId === 'TRID_TRANSACTION_MISMATCH') || {}).detail || {}).mismatches || [],
          cd_lender: extraction.lender_name || null,
          le_lender: (loanEstimates && loanEstimates[0] && loanEstimates[0].lenderName) || null,
        }
      : null,
    loan_estimates_read: loanEstimates ? loanEstimates.length : 0,
    loan_estimates_uploaded: leIndexes.length,
    cd_charge_lines: cdChargeCount,
  };

  await admin
    .from('navigator_submissions')
    .update({
      form_data: {
        stage: 'scorecard',
        ip_hash: ipHash,
        extraction,
        scorecard,
        documents: classified,
        tier,
        loan_estimates: loanEstimates,
        contract_terms: contractTerms,
      },
      updated_at: new Date().toISOString(),
    })
    .eq('id', submission.id);

  res.status(200).json({
    ok: true,
    id: submission.id,
    token: submission.access_token,
    scorecard,
  });
};
