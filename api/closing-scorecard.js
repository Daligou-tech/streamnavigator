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

  let extraction;
  try {
    extraction = await extractClosingDisclosure(ANTHROPIC_API_KEY, contentBlocks);
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

  // The customer uploaded something that is not a Closing Disclosure. Say so
  // now, for free, rather than after taking their money.
  if (extraction.document_type !== 'closing_disclosure') {
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
        `That looks like a ${String(extraction.document_type).replace(/_/g, ' ')}, not a Closing ` +
        'Disclosure. The Closing Disclosure is the five-page form your lender sends at least three ' +
        'business days before closing, headed "Closing Disclosure". Upload that and we will take another look.',
    });
    return;
  }

  const { findings, skipped } = runClosingAudit(extraction);
  const scorecard = buildScorecard(extraction, findings, skipped);

  await admin
    .from('navigator_submissions')
    .update({
      form_data: {
        description: typeof body.description === 'string' ? body.description.trim() : '',
        stage: 'scorecard',
        ip_hash: ipHash,
        extraction,
        scorecard,
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
