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

const MAX_FILES = 4;
const MAX_FILE_MB = 6;

function wireUploadZone(zoneEl, inputEl, listEl) {
  const selected = [];
  function render() {
    listEl.innerHTML = '';
    selected.forEach((f, idx) => {
      const row = document.createElement('div');
      row.className = 'upload-file-row';
      row.innerHTML = `<span class="upload-file-name">📄 ${f.name}</span>`;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'upload-file-remove';
      rm.textContent = '✕';
      rm.addEventListener('click', () => { selected.splice(idx, 1); render(); });
      row.appendChild(rm);
      listEl.appendChild(row);
    });
    zoneEl.classList.toggle('has-files', selected.length > 0);
  }
  function addFiles(fileList) {
    for (const f of fileList) {
      if (selected.length >= MAX_FILES) { showToast(`You can attach up to ${MAX_FILES} files.`); break; }
      if (f.size > MAX_FILE_MB * 1024 * 1024) { showToast(`${f.name} is over ${MAX_FILE_MB}MB — try a smaller scan or photo.`); continue; }
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
async function submitNavigatorIntake({ product, email, formData, files }) {
  const encoded = [];
  for (const f of (files || [])) {
    encoded.push({ name: f.name, type: f.type, dataBase64: await fileToBase64(f) });
  }
  const resp = await fetch('/api/navigator-intake', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ product, email, formData, files: encoded }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.ok) throw new Error(data.error || 'Something went wrong saving your submission.');
  return data; // { id, token }
}

function goToStripe(paymentLinkUrl, submission, email) {
  localStorage.setItem('sn_last_submission', JSON.stringify({ ...submission, product: submission.product, ts: Date.now() }));
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
