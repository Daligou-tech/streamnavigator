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
} = require('./_lib/closing-extract');
const { checkScorecardRateLimit, hashIp, clientIp } = require('./_lib/rate-limit');

const MAX_FILE_BYTES = 6 * 1024 * 1024;
const MAX_TOTAL_BYTES = 9 * 1024 * 1024;
const MAX_FILES = 12;

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
      res.status(400).json({ ok: false, error: `${f.name} is larger than the 6MB limit.` });
      return;
    }
    totalBytes += approxBytes;
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    res.status(400).json({ ok: false, error: 'Those files together are too large — please upload 9MB or less total.' });
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
        description: typeof body.description === 'string' ? body.description.trim() : '',
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
        `That looks like a ${DOCUMENT_LABELS[extraction.document_type] || 'document'}, which we cannot ` +
        'audit on its own. We need either your Closing Disclosure — the five-page form headed ' +
        '"Closing Disclosure" that your lender sends at least three business days before closing — or ' +
        'your settlement agent\'s ALTA Settlement Statement. Upload either and we will take another look.',
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

  const { findings, skipped } = runClosingAudit(extraction, { loanEstimates });

  // Tolerance testing needs charges on BOTH sides. Reading the Loan Estimates is
  // only half of it — if the Closing Disclosure has no charge lines (a page-1
  // excerpt, a scan missing page 2), 22 Loan Estimate charges get compared to an
  // empty list and produce nothing. Reporting that as "no fee rose beyond what
  // the rules permit" is a silent pass on a test that never ran, which is worse
  // than reporting nothing at all.
  const cdChargeCount = (extraction.line_items || []).length;
  const toleranceTested = Boolean(loanEstimates) && cdChargeCount > 0;

  const scorecard = {
    ...buildScorecard(extraction, findings, skipped),
    tier,
    tolerance_tested: toleranceTested,
    tolerance_blocked_reason: (loanEstimates && !cdChargeCount)
      ? 'no_cd_charges'
      : (leIndexes.length && !loanEstimates ? 'le_unreadable' : null),
    loan_estimates_read: loanEstimates ? loanEstimates.length : 0,
    loan_estimates_uploaded: leIndexes.length,
    cd_charge_lines: cdChargeCount,
  };

  await admin
    .from('navigator_submissions')
    .update({
      form_data: {
        description: typeof body.description === 'string' ? body.description.trim() : '',
        stage: 'scorecard',
        ip_hash: ipHash,
        extraction,
        scorecard,
        documents: classified,
        tier,
        loan_estimates: loanEstimates,
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
