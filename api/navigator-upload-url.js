// Issues a short-lived signed URL so the browser can upload a document
// straight to Supabase Storage, instead of base64-ing it through
// /api/navigator-intake.
//
// Why this exists: files sent through intake ride inside a JSON request body,
// and Vercel rejects any function request over 4.5MB at the edge. After base64
// inflation that left ~3.17MB for an entire submission. HOA Navigator's most
// valuable document is the reserve study, which routinely runs 5-20MB, so the
// single document the analysis most needs could not physically be uploaded.
// The engine was reading whatever fraction of an HOA package happened to fit.
//
// The file never touches a Vercel function on this route, so the body limit
// stops applying and the ceiling becomes a product decision (25MB per file,
// 50MB per submission — see api/_lib/upload-limits.js).
//
// This endpoint is unauthenticated, because uploading happens before payment
// and before any account exists. Four things keep that from being an open
// write handle on the bucket:
//
//   1. The path is chosen here, never by the caller. Callers cannot name a
//      destination, so they cannot overwrite an existing submission's files.
//   2. Files land in staging/<ip hash>/, are moved out only when a submission
//      claims them, and anything still there after a day is deleted by
//      api/cleanup-staging-uploads.js.
//   3. One IP may leave only MAX_STAGED_PER_IP unclaimed files in staging.
//      Attached files leave staging, so a real customer never approaches it.
//   4. The bucket carries its own file_size_limit, so a client ignoring the
//      size we validate here still cannot write a larger object.

'use strict';

const crypto = require('crypto');
const { getSupabaseAdmin, ALLOWED_PRODUCTS } = require('./_lib/supabaseAdmin');
const { hashIp, clientIp } = require('./_lib/rate-limit');
const {
  MAX_DIRECT_FILE_BYTES,
  STAGING_PREFIX,
  MAX_STAGED_PER_IP,
  ALLOWED_UPLOAD_MIME,
  ALLOWED_UPLOAD_EXT,
  safeFileName,
  extensionOf,
  asMB,
} = require('./_lib/upload-limits');

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

  const product = String(body.product || '');
  if (!ALLOWED_PRODUCTS.includes(product)) {
    res.status(400).json({ ok: false, error: 'Unknown product' });
    return;
  }

  const rawName = String(body.filename || '');
  const ext = extensionOf(rawName);
  const contentType = String(body.contentType || '').toLowerCase();

  // Extension and MIME are checked independently, and an empty contentType is
  // allowed through the second check: browsers report the type inconsistently
  // for scanner PDFs, so trusting MIME alone would refuse real documents. The
  // extension check is the one that always applies.
  //
  // Both lists dropped HEIC and HEIF. This endpoint used to accept them, and
  // said so in the message below, while nothing downstream could read one —
  // the engines hand image/heic to an API that takes jpeg, png, gif and webp.
  // On the direct-upload products the file was therefore accepted, stored, and
  // failed during analysis, which for HOA is after the customer has paid.
  if (!ALLOWED_UPLOAD_EXT.includes(ext)) {
    res.status(400).json({ ok: false, error: 'That file type is not supported. Send a PDF, JPG, PNG or WEBP. '
        + 'iPhone photos save as HEIC, which we cannot read — open the photo, tap '
        + 'Share, then Copy Photo and paste it into an email to yourself to get a JPEG, '
        + 'or send the original PDF of the document, which works best.' });
    return;
  }
  if (contentType && !ALLOWED_UPLOAD_MIME.includes(contentType)) {
    res.status(400).json({ ok: false, error: 'That file type is not supported. Send a PDF, JPG, PNG or WEBP. '
        + 'iPhone photos save as HEIC, which we cannot read — open the photo, tap '
        + 'Share, then Copy Photo and paste it into an email to yourself to get a JPEG, '
        + 'or send the original PDF of the document, which works best.' });
    return;
  }

  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) {
    res.status(400).json({ ok: false, error: 'Could not read that file’s size.' });
    return;
  }
  if (size > MAX_DIRECT_FILE_BYTES) {
    res.status(400).json({
      ok: false,
      error: `${rawName} is ${asMB(size)}MB — the limit is ${asMB(MAX_DIRECT_FILE_BYTES)}MB per file.`,
    });
    return;
  }

  const admin = getSupabaseAdmin();
  const ipHash = hashIp(clientIp(req));

  // Counts only files still sitting unclaimed in this IP's staging folder.
  // A list failure is treated as "allow": storage being briefly unavailable
  // should not stop a paying customer uploading, and the bucket size limit
  // plus the daily cleanup still bound the damage.
  const { data: staged } = await admin.storage
    .from('navigator-uploads')
    .list(`${STAGING_PREFIX}/${ipHash}`, { limit: MAX_STAGED_PER_IP + 1 });

  if (Array.isArray(staged) && staged.length > MAX_STAGED_PER_IP) {
    res.status(429).json({ ok: false, error: 'Too many uploads from this connection right now. Please try again later.' });
    return;
  }

  const path = `${STAGING_PREFIX}/${ipHash}/${crypto.randomUUID()}__${safeFileName(rawName)}`;

  const { data, error } = await admin.storage
    .from('navigator-uploads')
    .createSignedUploadUrl(path);

  if (error || !data || !data.signedUrl) {
    res.status(500).json({ ok: false, error: 'Could not start that upload. Please try again.' });
    return;
  }

  // `token` is returned for clients using the Supabase JS SDK's
  // uploadToSignedUrl(); the pages here just PUT to signedUrl directly.
  res.status(200).json({ ok: true, path, signedUrl: data.signedUrl, token: data.token });
};
