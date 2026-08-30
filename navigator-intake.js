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

const MAX_FILES = 4;
const MAX_FILE_BYTES = 6 * 1024 * 1024; // 6MB per file
const MAX_TOTAL_BYTES = 9 * 1024 * 1024; // keep the whole request under Vercel's body limit

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
