// Shared intake endpoint for all 10 "Navigator" product pages
// (contractor.html, property-tax.html, home-savings.html, rental.html,
// subscriptions.html, government-money.html, home-maintenance.html,
// landlord.html, insurance.html, buying.html).
//
// Each page's upload/details form POSTs JSON here (files pre-read as
// base64 in the browser — no multipart parsing needed). This function:
//   1. creates a `navigator_submissions` row,
//   2. uploads any attached files to the private `navigator-uploads`
//      Storage bucket at contractor-uploads/<product>/<submission id>/...,
//   3. returns { id, token } — the browser stores these (localStorage) and
//      sends the customer to the product's Stripe Payment Link with
//      client_reference_id=<id> appended, then later uses {id, token} to
//      poll api/get-navigator-submission.js for status/report.
//
// Kept deliberately generic: it doesn't know anything about what a
// "report" is for any given product — that's each product's own concern
// (see api/_lib/contractor-engine.js for the one product wired up so far).

const { getSupabaseAdmin, ALLOWED_PRODUCTS } = require('./_lib/supabaseAdmin');
const { checkBuyingSufficiency } = require('../navigator-buying-rules');

// Raised from 4: a full closing file is the CD, the purchase contract, and the
// complete Loan Estimate sequence. NOTE: MAX_TOTAL_BYTES below still caps the
// whole request at 9MB, so this ceiling is not yet reachable in practice — see
// the direct-upload note in the handover.
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

  const email = typeof body.email === 'string' ? body.email.trim().slice(0, 320) : '';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ ok: false, error: 'That email address doesn’t look right.' });
    return;
  }

  const formData = (body.formData && typeof body.formData === 'object') ? body.formData : {};
  const files = Array.isArray(body.files) ? body.files.slice(0, MAX_FILES) : [];

  // Purchase Navigator gets a stricter, structured sufficiency gate instead
  // of the generic D-04 check below: a non-empty description was letting
  // customers pay $19 for something like "fridge purchase 33 inch" with no
  // price, financing, or usage info, and the AI could only honestly report
  // back that it didn't have enough to work with — a bait-and-switch, since
  // that was discoverable before payment and wasn't checked. This uses the
  // exact same rules buying.html uses to gate its own checkout button, so a
  // customer can never reach checkout with input this endpoint would then
  // reject — and calling this endpoint directly can't bypass the frontend
  // gate either.
  if (product === 'buying') {
    const sufficiency = checkBuyingSufficiency(formData.category, formData);
    if (!sufficiency.sufficient) {
      res.status(400).json({
        ok: false,
        error: 'A few more details are needed before this can be analyzed — see missing[].',
        missing: sufficiency.missing,
      });
      return;
    }
  } else {
    // D-04 fix: require at least one piece of substantive input — a
    // non-empty description/address, or an uploaded document — before
    // accepting a submission for payment. Enforced here (not just
    // client-side in each product page) so it can't be bypassed by calling
    // this endpoint directly.
    const description = typeof formData.description === 'string' ? formData.description.trim() : '';
    if (!description && files.length === 0) {
      res.status(400).json({ ok: false, error: 'Please provide a description (or address, situation, etc.) or upload at least one file so we have something to generate your report from.' });
      return;
    }
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

  const admin = getSupabaseAdmin();

  const { data: submission, error: insertError } = await admin
    .from('navigator_submissions')
    .insert({ product, email: email || null, form_data: formData })
    .select('id, access_token')
    .single();

  if (insertError || !submission) {
    res.status(500).json({ ok: false, error: 'Could not save your submission. Please try again.' });
    return;
  }

  const filePaths = [];
  for (const f of files) {
    const safeName = String(f.name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
    const path = `${product}/${submission.id}/${Date.now()}-${safeName}`;
    const buffer = Buffer.from(f.dataBase64, 'base64');
    const { error: uploadError } = await admin.storage
      .from('navigator-uploads')
      .upload(path, buffer, {
        contentType: f.type || 'application/octet-stream',
        upsert: false,
      });
    if (!uploadError) {
      filePaths.push(path);
    }
    // A single failed file upload shouldn't sink the whole submission —
    // the customer already has a confirmed record; a missing attachment
    // is something a human can follow up on if needed.
  }

  if (filePaths.length) {
    await admin
      .from('navigator_submissions')
      .update({ file_paths: filePaths, updated_at: new Date().toISOString() })
      .eq('id', submission.id);
  }

  res.status(200).json({ ok: true, id: submission.id, token: submission.access_token });
};
