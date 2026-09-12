/* =============================================================================
   Shared front-end helpers for all 10 StreamNavigator "Navigator" product
   pages (contractor.html, property-tax.html, home-savings.html, rental.html,
   subscriptions.html, government-money.html, home-maintenance.html,
   landlord.html, insurance.html, buying.html) plus navigator-status.html
   and contractor-report.html.

   Talks to three API functions:
     POST /api/navigator-intake             -> { id, token }
     POST /api/get-navigator-submission      -> { status, product, report? }
   and sends the customer on to a Stripe Payment Link for payment — see the
   PAYMENT PORTAL SETUP comment inside each product page's <head> for how to
   connect those.
   ========================================================================= */

// ---------- Toast + FAQ accordion ----------
document.addEventListener('DOMContentLoaded', () => {

  document.querySelectorAll('.faq-item').forEach((item) => {
    const btn = item.querySelector('.faq-q');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const wasOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item.open').forEach((i) => i.classList.remove('open'));
      if (!wasOpen) item.classList.add('open');
    });
  });

  document.querySelectorAll('[data-stripe-link]').forEach((link) => {
    link.addEventListener('click', (e) => {
      if (link.getAttribute('href').includes('REPLACE_WITH_')) {
        e.preventDefault();
        showToast('Payment portal not connected yet — add your Stripe Payment Link to enable checkout.');
      }
    });
  });
});

function showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  document.getElementById('toast-text').textContent = msg;
  toast.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
}

// ---------- File helpers ----------
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const MAX_FILES = 12;

// Uploads are base64-encoded into a JSON body and POSTed to a Vercel function.
// Vercel caps a function request body at 4.5MB and returns a raw 413
// (FUNCTION_PAYLOAD_TOO_LARGE) above it — before the handler runs, so no
// friendly error is possible at that point. base64 inflates bytes by 4/3, so
// the real ceiling on raw file bytes is ~3.2MB, not the 6MB/9MB previously
// advertised. Anything above that failed with a generic "something went wrong"
// and could never succeed on retry. Keep these in step with the identical
// constants in api/closing-scorecard.js and api/navigator-intake.js.
const VERCEL_BODY_LIMIT_BYTES = 4.5 * 1024 * 1024;
const BASE64_INFLATION = 4 / 3;
const JSON_ENVELOPE_MARGIN = 0.94; // filenames, mime types, JSON punctuation
const MAX_TOTAL_BYTES = Math.floor(
  (VERCEL_BODY_LIMIT_BYTES / BASE64_INFLATION) * JSON_ENVELOPE_MARGIN
); // ~3.17MB
const MAX_FILE_BYTES = MAX_TOTAL_BYTES; // one document may use the whole budget
const asMB = (b) => Math.round((b / (1024 * 1024)) * 10) / 10;

// The limits above apply only to pages that still post base64 through a Vercel
// function — today that is closing.html, which uploads to
// /api/closing-scorecard. Every page that submits through
// submitNavigatorIntake now PUTs files straight to Supabase Storage with a
// signed URL, so the request-body cap does not apply and these much larger
// ceilings do. Keep in step with api/_lib/upload-limits.js.
//
// This is what makes HOA Navigator work as sold: a reserve study runs 5-20MB
// and could not previously be uploaded at all.
const DIRECT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DIRECT_MAX_TOTAL_BYTES = 150 * 1024 * 1024;

// closing.html now takes the direct route as well, but it does not get the
// ceiling above: its documents are all read in one model call, so its limit
// comes from that call's request-size cap rather than from Supabase. Keep in
// step with api/_lib/upload-limits.js, which carries the arithmetic.
const CLOSING_MAX_FILE_BYTES = 20 * 1024 * 1024;
const CLOSING_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

// ---------- Referral attribution -------------------------------------------
//
// An affiliate sends traffic with ?ref=THEIRCODE. The code is captured on
// whatever page it lands on, kept for 90 days, and attached to whichever
// submission the visitor eventually makes -- the page someone lands on and the
// page they buy from are rarely the same, and almost never the same visit.
//
// This is the BACKSTOP, not the primary record. The primary record is the
// Stripe promotion code the affiliate's audience types at checkout: Stripe
// counts those itself, they survive a cleared browser and a different device,
// and they cannot drift out of step with what was actually charged. This
// catches the people who followed the link and never typed the code.
const REFERRAL_KEY = 'sn_referral';
const REFERRAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;
// Deliberately narrow. This value is written onto a submission row and read
// back out into a payout report, so anything that is not a plain code is not a
// code -- there is no reason for a referral tag to contain punctuation.
const REFERRAL_CODE_RE = /^[A-Za-z0-9_-]{2,32}$/;

function captureReferralCode() {
  try {
    const param = new URLSearchParams(window.location.search).get('ref');
    if (!param || !REFERRAL_CODE_RE.test(param)) return;
    // Last touch wins. If someone arrives through a second affiliate weeks
    // later, that is the one whose recommendation actually produced the sale.
    localStorage.setItem(REFERRAL_KEY, JSON.stringify({ code: param, ts: Date.now() }));
  } catch (err) {
    // Private browsing, or storage disabled. Attribution is lost; the sale is
    // not, and nothing about the purchase depends on this succeeding.
  }
}

function getReferralCode() {
  try {
    const raw = JSON.parse(localStorage.getItem(REFERRAL_KEY) || 'null');
    if (!raw || !raw.code || !REFERRAL_CODE_RE.test(raw.code)) return null;
    // Re-checked on read as well as on write. A code stored by an older
    // version of this file has not been through the pattern above.
    if (!raw.ts || Date.now() - raw.ts > REFERRAL_TTL_MS) return null;
    return raw.code;
  } catch (err) {
    return null;
  }
}

// Guarded: this file is read as text by the test suite, and window does not
// exist there.
if (typeof window !== 'undefined') captureReferralCode();

// opts.maxFileBytes / opts.maxTotalBytes let a page that still uses the legacy
// base64 route keep the smaller ceiling. Defaults are the direct-upload
// limits, because that is now the common case.
// Extensions the analysis engines can actually read. Derived from the input's
// own `accept` attribute where there is one, so a page that changes what it
// accepts does not have to remember to change this too.
//
// The `accept` attribute alone is not enough. It filters the operating
// system's file picker and NOTHING else: it does not apply to drag-and-drop,
// and every upload zone on the site says "or drag files here". A dragged .docx
// was accepted into the list, uploaded, and failed minutes later with an error
// about our document reader being unavailable.
const DEFAULT_ACCEPTED_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'webp'];

function acceptedExtensionsFor(inputEl) {
  const attr = (inputEl && inputEl.getAttribute('accept')) || '';
  const fromAttr = attr
    .split(',')
    .map((s) => s.trim().replace(/^\./, '').toLowerCase())
    .filter((s) => s && s.indexOf('/') === -1);
  return fromAttr.length ? fromAttr : DEFAULT_ACCEPTED_EXTENSIONS.slice();
}

function extensionOf(name) {
  const parts = String(name || '').toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() : '';
}

// HEIC gets its own sentence. It is what an iPhone camera produces by default,
// this page invites photographing a document, and "unsupported file type" tells
// someone nothing about a format they never chose.
function unsupportedReason(ext, accepted) {
  // Deliberately says nothing about WHO to ask for the original. This file is
  // shared by twelve products: "ask your lender" is right on the closing
  // audit and wrong on the HOA one, where the document comes from the
  // management company and the buyer has no lender in the conversation.
  if (ext === 'heic' || ext === 'heif') {
    return 'iPhone photos are saved as HEIC, which we cannot read. Open the photo, tap Share, '
      + 'then Copy Photo and paste it into an email to yourself to get a JPEG — or send the '
      + 'original PDF of the document, which works best.';
  }
  const label = accepted.map((e) => e.toUpperCase()).join(', ');
  return (ext ? 'a .' + ext + ' file' : 'that file type') + ' is not something we can read. '
    + 'Please upload ' + label + '.';
}

function wireUploadZone(zoneEl, inputEl, listEl, opts) {
  opts = opts || {};
  const maxFileBytes = opts.maxFileBytes || DIRECT_MAX_FILE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes || DIRECT_MAX_TOTAL_BYTES;
  const accepted = opts.acceptedExtensions || acceptedExtensionsFor(inputEl);
  const selected = [];
  // Files the browser refused, kept on screen with the reason.
  //
  // These used to be reported only by a toast that disappears after 3.6
  // seconds. A customer picking a package that is over the limit saw a
  // message they may not have caught, an upload box that looked empty, and —
  // on pressing the button — "please attach at least one file", which
  // describes the symptom and not the cause. That is a real thing that
  // happened, twice, to someone who knew what the limits were.
  const rejected = [];

  function fileRow(text, className, onRemove) {
    const row = document.createElement('div');
    row.className = 'upload-file-row';
    const name = document.createElement('span');
    name.className = 'upload-file-name';
    // textContent, not innerHTML: the filename is attacker-controlled and was
    // previously interpolated into markup.
    name.textContent = text;
    if (className === 'rejected') {
      row.style.borderColor = '#b4442b';
      name.style.color = '#b4442b';
      name.style.whiteSpace = 'normal';
    }
    row.appendChild(name);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'upload-file-remove';
    rm.textContent = '✕';
    rm.addEventListener('click', onRemove);
    row.appendChild(rm);
    return row;
  }

  function render() {
    listEl.innerHTML = '';

    selected.forEach((f, idx) => {
      listEl.appendChild(fileRow(`📄 ${f.name}`, 'ok', () => {
        selected.splice(idx, 1);
        render();
      }));
    });

    rejected.forEach((r, idx) => {
      listEl.appendChild(fileRow(`⚠ ${r.name} — ${r.reason}`, 'rejected', () => {
        rejected.splice(idx, 1);
        render();
      }));
    });

    // A running total, so someone assembling a large package can see where
    // they stand before the last file is the one that gets refused.
    if (selected.length) {
      const used = selected.reduce((n, x) => n + x.size, 0);
      const note = document.createElement('div');
      note.className = 'upload-file-total';
      note.style.fontSize = '12px';
      note.style.opacity = '.7';
      note.style.marginTop = '6px';
      note.textContent = `${selected.length} file${selected.length === 1 ? '' : 's'} · ${asMB(used)}MB of ${asMB(maxTotalBytes)}MB`;
      listEl.appendChild(note);
    }

    zoneEl.classList.toggle('has-files', selected.length > 0);
  }

  function reject(name, reason) {
    rejected.push({ name, reason });
    showToast(`${name} — ${reason}`);
  }

  function addFiles(fileList) {
    for (const f of fileList) {
      if (selected.length >= MAX_FILES) {
        reject(f.name, `you can attach up to ${MAX_FILES} files`);
        continue;
      }
      // Type before size: a HEIC photo is usually also small, and being told
      // "the limit is 3.2MB" about a 900KB file would be nonsense.
      const ext = extensionOf(f.name);
      if (accepted.indexOf(ext) === -1) {
        reject(f.name, unsupportedReason(ext, accepted));
        continue;
      }
      if (f.size > maxFileBytes) {
        reject(f.name, `${asMB(f.size)}MB — the limit is ${asMB(maxFileBytes)}MB per file. Try the original PDF rather than a photo of it, or scan in black and white.`);
        continue;
      }
      // Checked against the running total, not just per file. Without this the
      // browser accepts the files, spends time uploading them, and the
      // submission dies with an error the customer cannot act on.
      const used = selected.reduce((n, x) => n + x.size, 0);
      if (used + f.size > maxTotalBytes) {
        reject(f.name, `this would take you past the ${asMB(maxTotalBytes)}MB total (you are at ${asMB(used)}MB). Remove a file, or send the most important documents now and add the rest afterwards.`);
        continue;
      }
      selected.push(f);
    }
    render();
  }
  zoneEl.addEventListener('click', () => inputEl.click());
  zoneEl.addEventListener('dragover', (e) => { e.preventDefault(); zoneEl.classList.add('drag'); });
  zoneEl.addEventListener('dragleave', () => zoneEl.classList.remove('drag'));
  zoneEl.addEventListener('drop', (e) => {
    e.preventDefault();
    zoneEl.classList.remove('drag');
    addFiles(e.dataTransfer.files);
  });
  inputEl.addEventListener('change', () => addFiles(inputEl.files));
  return { getFiles: () => selected };
}

// ---------- Intake + payment handoff ----------

// Asks the server for a signed URL and PUTs the file straight to Supabase
// Storage. The file never passes through a Vercel function, which is what
// lifts the old ~3.17MB ceiling on an entire submission.
async function uploadFileDirect(product, file) {
  const resp = await fetch('/api/navigator-upload-url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      product,
      filename: file.name,
      contentType: file.type || '',
      size: file.size,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok || !data.signedUrl) {
    throw new Error(data.error || `Could not start the upload for ${file.name}.`);
  }

  const put = await fetch(data.signedUrl, {
    method: 'PUT',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!put.ok) throw new Error(`Upload of ${file.name} did not complete. Please try again.`);

  return data.path;
}

// onProgress({ done, total, name }) is optional — pass it to show which file
// is uploading, which matters now that a submission can legitimately be tens
// of megabytes rather than three.
async function submitNavigatorIntake({ product, email, formData, files, onProgress, entitlement }) {
  const list = Array.from(files || []);

  // Attached here rather than on each of the eleven pages that call this, so a
  // new product page cannot ship without attribution and quietly cost an
  // affiliate their share.
  const intakeFormData = Object.assign({}, formData || {});
  const referralCode = getReferralCode();
  if (referralCode) intakeFormData.referral_code = referralCode;
  let uploadedPaths = [];
  let encoded = [];

  try {
    for (let i = 0; i < list.length; i++) {
      if (onProgress) onProgress({ done: i, total: list.length, name: list[i].name });
      uploadedPaths.push(await uploadFileDirect(product, list[i]));
    }
    if (onProgress && list.length) onProgress({ done: list.length, total: list.length, name: '' });
  } catch (directErr) {
    // Fall back to the legacy base64 route so a customer is not blocked by a
    // problem with the signed-URL endpoint — but only when everything would
    // actually fit through it. Above that the legacy route dies at Vercel's
    // edge with a 413 no error message can explain, so the honest outcome is
    // the upload error itself.
    const totalBytes = list.reduce((n, f) => n + f.size, 0);
    if (totalBytes > MAX_TOTAL_BYTES) throw directErr;

    uploadedPaths = [];
    encoded = [];
    for (const f of list) {
      encoded.push({ name: f.name, type: f.type, dataBase64: await fileToBase64(f) });
    }
  }

  const resp = await fetch('/api/navigator-intake', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ product, email, formData: intakeFormData, files: encoded, uploadedPaths, entitlement }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.ok) throw new Error(data.error || 'Something went wrong saving your submission.');
  return data; // { id, token, covered?, runsLeft?, expiresAt? }
}

// A rental customer inside their year does not go to Stripe. The intake told us
// so — it created the submission already paid at zero and answered `covered` —
// and sending them to a payment link anyway would charge a second time for
// something they were promised was included.
//
// The previous submission is kept under its own key rather than being
// overwritten by this one: it holds the token that proves the entitlement, and
// losing it would strand the rest of the year in a browser that had forgotten
// how to claim it.
function rememberRentalEntitlementSource(submission, email) {
  try {
    localStorage.setItem('sn_rental_entitlement', JSON.stringify({
      id: submission.id, token: submission.token, email: email || null, ts: Date.now(),
    }));
  } catch (e) { /* private mode */ }
}

function getRentalEntitlementSource() {
  try {
    const raw = localStorage.getItem('sn_rental_entitlement');
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function goToStatusPage(submission, email) {
  localStorage.setItem('sn_last_submission', JSON.stringify({
    ...submission, product: submission.product, email: email || null, ts: Date.now(),
  }));
  window.location.href = '/navigator-status';
}

function goToStripe(paymentLinkUrl, submission, email) {
  // Store the email too. The status page offers to send a PDF and used to show
  // an empty box, forcing the customer to retype an address they had already
  // given us two screens earlier.
  localStorage.setItem('sn_last_submission', JSON.stringify({
    ...submission, product: submission.product, email: email || null, ts: Date.now(),
  }));
  if (!paymentLinkUrl || paymentLinkUrl.includes('REPLACE_WITH_')) {
    showToast('Payment portal not connected yet — add your Stripe Payment Link to enable checkout.');
    return;
  }
  const url = new URL(paymentLinkUrl);
  url.searchParams.set('client_reference_id', submission.id);
  if (email) url.searchParams.set('prefilled_email', email);
  window.location.href = url.toString();
}

// ---------- Status polling (used by navigator-status.html and contractor-report.html) ----------
async function pollNavigatorSubmission(id, token, { onUpdate, intervalMs = 3000, maxTries = 60 } = {}) {
  for (let i = 0; i < maxTries; i++) {
    const resp = await fetch('/api/get-navigator-submission', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, token }),
    });
    const data = await resp.json();
    if (resp.ok && data.ok) {
      onUpdate(data);
      if (data.status === 'complete' || data.status === 'failed') return data;
    } else {
      onUpdate({ ok: false, error: data.error || 'Not found' });
      return null;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

// The reference to the customer's own submission: {id, token, product}.
//
// A URL beats localStorage when both exist, and that ordering is the whole
// point of the change made on 2026-09-10. Until then this read localStorage
// and nothing else, so a paid report was reachable from exactly one browser on
// exactly one device — the one the purchase was made from. Clear the site
// data, open the emailed receipt on a phone, or pay on a work laptop and look
// on a home one, and the status page said "we couldn't find that submission"
// about a report that existed and had been paid for.
//
// api/_lib/report-delivery.js now emails a link carrying ?id=&t=, and this is
// what makes that link work. The reference is written back to localStorage on
// arrival so a later visit to the bare URL still finds it.
function getStoredSubmission() {
  let stored = null;
  try {
    const raw = localStorage.getItem('sn_last_submission');
    stored = raw ? JSON.parse(raw) : null;
  } catch (e) { stored = null; }

  try {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    const token = params.get('t') || params.get('token');
    // Both halves or neither. An id on its own is not a credential, and
    // api/get-navigator-submission.js will refuse it — better to fall through
    // to whatever localStorage has than to replace a working reference with a
    // broken one.
    if (id && token) {
      const fromUrl = { id, token, product: params.get('p') || (stored && stored.product) || null };
      try { localStorage.setItem('sn_last_submission', JSON.stringify(fromUrl)); } catch (e) { /* private mode */ }

      // Take the token back out of the address bar now that it is stored.
      //
      // It arrives here from a link in the customer's own email, which is the
      // right way to reach a report from a second device. It should not then
      // sit in the URL bar through a screenshot, a shared link, or the browser
      // history of a shared laptop. localStorage already holds it, so the page
      // reloads fine without it.
      try {
        if (window.history && window.history.replaceState) {
          window.history.replaceState({}, '', window.location.pathname);
        }
      } catch (e) { /* older browser: the link still worked, which is the point */ }

      return fromUrl;
    }
  } catch (e) { /* no URL API, or no window */ }

  return stored;
}
