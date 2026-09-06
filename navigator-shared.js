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

// ---------- Reveal-on-scroll + toast + FAQ accordion (same as index.html) ----------
document.addEventListener('DOMContentLoaded', () => {
  const revealEls = document.querySelectorAll('.reveal');
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.12 });
  revealEls.forEach((el) => io.observe(el));

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
  if (ext === 'heic' || ext === 'heif') {
    return 'iPhone photos are saved as HEIC, which we cannot read. Open the photo, tap Share, '
      + 'then Copy Photo and paste it into an email to yourself to get a JPEG — or ask your '
      + 'lender for the original PDF, which works best.';
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
async function submitNavigatorIntake({ product, email, formData, files, onProgress }) {
  const list = Array.from(files || []);
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
    body: JSON.stringify({ product, email, formData, files: encoded, uploadedPaths }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.ok) throw new Error(data.error || 'Something went wrong saving your submission.');
  return data; // { id, token }
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

function getStoredSubmission() {
  try {
    const raw = localStorage.getItem('sn_last_submission');
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
