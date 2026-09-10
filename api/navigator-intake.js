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
const { isTestEmail } = require('./_lib/test-submissions');
const { checkBuyingSufficiency } = require('../navigator-buying-rules');
const { checkEntitlement, consumeEntitlement } = require('./_lib/rental-entitlement');

// Two upload routes reach this handler, and both are supported on purpose.
//
//   body.uploadedPaths — the current route. The browser already PUT each file
//     straight to Supabase Storage using a signed URL from
//     /api/navigator-upload-url, and sends only the resulting staging paths.
//     Nothing large passes through this function, so the Vercel body limit
//     does not apply and files may be up to 25MB each.
//
//   body.files — the legacy base64 route, kept because a browser holding a
//     cached navigator-shared.js will keep using it. Those requests are still
//     bounded by Vercel's 4.5MB body cap (~3.17MB of real bytes after base64
//     inflation), enforced below.
//
// Limits live in api/_lib/upload-limits.js rather than being restated here;
// three separate copies of these constants is what let the product pages
// advertise 24MB against a real ceiling of 3.17MB for months.
const {
  MAX_TOTAL_BYTES,
  MAX_FILE_BYTES,
  MAX_DIRECT_FILE_BYTES,
  MAX_DIRECT_TOTAL_BYTES,
  MAX_FILES,
  isStagingPath,
  allowedExtFor,
  extensionOf,
  asMB,
} = require('./_lib/upload-limits');

const MAX_TOTAL_MB = asMB(MAX_TOTAL_BYTES);

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
  const uploadedPaths = Array.isArray(body.uploadedPaths)
    ? body.uploadedPaths.filter((p) => typeof p === 'string').slice(0, MAX_FILES)
    : [];

  // Only paths this server issued may be claimed. Without this check a caller
  // could name any key in the bucket — including another customer's completed
  // submission — and have it copied onto their own row.
  if (uploadedPaths.some((p) => !isStagingPath(p))) {
    res.status(400).json({ ok: false, error: 'One of those uploads could not be verified. Please re-attach your files.' });
    return;
  }

  const attachmentCount = files.length + uploadedPaths.length;

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
    if (!description && attachmentCount === 0) {
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
    // The signed-URL route has always checked the extension; this one never
    // did, so anything at all could be base64'd through here and stored. It
    // then reached an engine that maps an unknown extension to image/jpeg and
    // fails on it — after payment. Same allowlist as the other route, and it
    // is per-product now, because Rental reads a CSV and nothing else does.
    if (!allowedExtFor(product).includes(extensionOf(f.name))) {
      res.status(400).json({
        ok: false,
        error: `We can't read ${f.name}. Send a PDF or a photo of the document`
          + `${allowedExtFor(product).includes('csv') ? ', or a CSV export of your spreadsheet' : ''}.`,
      });
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

  // A returning rental customer inside their year does not go to Stripe. They
  // present the id and token of the report they already bought; if that carries
  // a live entitlement with a run left, this submission is created already paid
  // at zero, and the browser skips the payment link entirely.
  //
  // price_cents 0 is also what stops the year extending itself: grantEntitlement
  // declines to hand a new twelve months to a submission that cost nothing.
  let spentEntitlement = null;
  if (product === 'rental' && body.entitlement && body.entitlement.id && body.entitlement.token) {
    const status = await checkEntitlement(admin, String(body.entitlement.id), String(body.entitlement.token));
    if (status.active) spentEntitlement = status;
  }

  const { data: submission, error: insertError } = await admin
    .from('navigator_submissions')
    // is_test is an analytics marker only — see api/_lib/test-submissions.js.
    // This one insert covers the ten Navigator products that share the intake.
    .insert({
      product,
      email: email || null,
      is_test: isTestEmail(email),
      form_data: formData,
      ...(spentEntitlement ? { status: 'paid', price_cents: 0 } : {}),
    })
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

  // Claim files the browser already uploaded directly to Storage. Sizes are
  // re-read from the bucket rather than trusted from the request: the size
  // checked when the signed URL was issued was whatever the client claimed,
  // and the object is the only authority on what was actually written.
  let directBytes = 0;
  for (const stagedPath of uploadedPaths) {
    const lastSlash = stagedPath.lastIndexOf('/');
    const folder = stagedPath.slice(0, lastSlash);
    const objectName = stagedPath.slice(lastSlash + 1);

    const { data: matches } = await admin.storage
      .from('navigator-uploads')
      .list(folder, { limit: 100, search: objectName });

    const entry = Array.isArray(matches) ? matches.find((m) => m.name === objectName) : null;
    if (!entry) continue; // never uploaded, already claimed, or already swept

    const size = Number(entry.metadata && entry.metadata.size) || 0;
    if (size > MAX_DIRECT_FILE_BYTES) continue;
    if (directBytes + size > MAX_DIRECT_TOTAL_BYTES) break;
    directBytes += size;

    // The staging name is "<uuid>__<already sanitized original name>"; keep
    // the readable half so citations in the report name the document rather
    // than a UUID.
    const originalName = objectName.split('__').slice(1).join('__') || objectName;
    const destination = `${product}/${submission.id}/${Date.now()}-${originalName}`;

    const { error: moveError } = await admin.storage
      .from('navigator-uploads')
      .move(stagedPath, destination);

    if (!moveError) filePaths.push(destination);
  }

  if (filePaths.length) {
    await admin
      .from('navigator_submissions')
      .update({ file_paths: filePaths, updated_at: new Date().toISOString() })
      .eq('id', submission.id);
  }

  // Spent only now, once the submission exists and its files are attached, so a
  // run is never burned on an intake that failed halfway. consumeEntitlement is
  // conditional on the count it read, so two tabs racing the last audit cannot
  // both take it — and the loser is put back on the ordinary paid path rather
  // than being handed a free report the entitlement no longer covers.
  let covered = false;
  if (spentEntitlement) {
    covered = await consumeEntitlement(admin, spentEntitlement.entitlementId);
    if (!covered) {
      await admin
        .from('navigator_submissions')
        .update({ status: 'pending_payment', price_cents: null, updated_at: new Date().toISOString() })
        .eq('id', submission.id);
    }
  }

  res.status(200).json({
    ok: true,
    id: submission.id,
    token: submission.access_token,
    // The browser reads this to decide between the Stripe link and the status
    // page. Absent or false means pay.
    covered,
    ...(covered ? { runsLeft: Math.max(0, spentEntitlement.runsLeft - 1), expiresAt: spentEntitlement.expiresAt } : {}),
  });
};
