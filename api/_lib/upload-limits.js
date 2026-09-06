// Upload limits and staging-path rules, in one place.
//
// There are two upload routes into this codebase and they have very different
// ceilings, which is the whole reason this file exists.
//
// LEGACY (base64 through the intake request): the browser reads each file,
// base64-encodes it, and POSTs it inside the JSON body of
// /api/navigator-intake. Vercel caps a function request body at 4.5MB and
// rejects anything larger at the edge with a raw 413, before the handler runs
// — so no friendly error is possible. base64 inflates by 4/3, leaving ~3.17MB
// of real file bytes for the whole submission. That is the ceiling every
// product page advertised wrongly for months, and it is far too small for the
// document that matters most to HOA Navigator: a reserve study routinely runs
// 5-20MB on its own.
//
// DIRECT (signed upload straight to Supabase Storage): the browser asks
// /api/navigator-upload-url for a signed URL, PUTs the file to Supabase
// directly, and sends only the resulting path to intake. The Vercel body limit
// stops applying because the file never passes through a Vercel function, so
// the ceiling becomes a product decision rather than a platform accident.
//
// The legacy route is kept because a browser holding a cached copy of
// navigator-shared.js will keep using it, and those submissions must not
// break. New uploads go the direct route.

'use strict';

// --- Legacy base64 route ---------------------------------------------------
// Keep in step with the identical constants in navigator-shared.js and
// api/closing-scorecard.js.
const VERCEL_BODY_LIMIT_BYTES = 4.5 * 1024 * 1024;
const BASE64_INFLATION = 4 / 3;
const JSON_ENVELOPE_MARGIN = 0.94; // filenames, mime types, JSON punctuation
const MAX_TOTAL_BYTES = Math.floor((VERCEL_BODY_LIMIT_BYTES / BASE64_INFLATION) * JSON_ENVELOPE_MARGIN); // ~3.17MB
const MAX_FILE_BYTES = MAX_TOTAL_BYTES;

// --- Direct signed-upload route --------------------------------------------
// 50MB is Supabase's own standard-upload ceiling and matches the bucket's
// file_size_limit, so a client ignoring this number still cannot write a
// larger object. Raised from 25MB after a real full HOA package was refused:
// scanned reserve studies are image-heavy and routinely clear 25MB on their
// own.
const MAX_DIRECT_FILE_BYTES = 50 * 1024 * 1024;
// A full HOA package is a reserve study, a budget, financials, minutes and an
// insurance summary — several of them scans. 150MB holds that comfortably
// without inviting someone to use the bucket as free storage.
const MAX_DIRECT_TOTAL_BYTES = 150 * 1024 * 1024;

const MAX_FILES = 12;

// Files land here first, under a hash of the uploader's IP, and are moved to
// <product>/<submission id>/ once a submission actually claims them. Anything
// left behind was never attached to a submission and is deleted by
// api/cleanup-staging-uploads.js.
const STAGING_PREFIX = 'staging';
const STAGING_TTL_HOURS = 24;

// A cap on how many files one IP can leave sitting in staging. Attached files
// leave staging, so this counts only unclaimed uploads — a real customer never
// approaches it, and a script filling the bucket hits it quickly.
const MAX_STAGED_PER_IP = 60;

const ALLOWED_UPLOAD_MIME = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
];

const ALLOWED_UPLOAD_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];

const asMB = (bytes) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

// Storage keys are user-influenced, so everything that reaches a path is
// reduced to a conservative character set. Keeping the last 120 characters
// rather than the first preserves the extension while bounding length.
function safeFileName(name) {
  const cleaned = String(name || 'document')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(-120);
  return cleaned.replace(/^[._-]+/, '') || 'document';
}

function extensionOf(name) {
  const parts = String(name || '').toLowerCase().split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

// Only paths this server issued may be claimed by a submission. Anything else
// — a traversal attempt, a path pointing at another customer's completed
// submission — is rejected before it is read or moved.
const STAGING_PATH_RE = new RegExp(
  `^${STAGING_PREFIX}/[0-9a-f]{32}/[0-9a-f-]{36}__[A-Za-z0-9._-]{1,120}$`,
);

function isStagingPath(path) {
  return typeof path === 'string' && STAGING_PATH_RE.test(path) && !path.includes('..');
}

module.exports = {
  VERCEL_BODY_LIMIT_BYTES,
  MAX_TOTAL_BYTES,
  MAX_FILE_BYTES,
  MAX_DIRECT_FILE_BYTES,
  MAX_DIRECT_TOTAL_BYTES,
  MAX_FILES,
  STAGING_PREFIX,
  STAGING_TTL_HOURS,
  MAX_STAGED_PER_IP,
  ALLOWED_UPLOAD_MIME,
  ALLOWED_UPLOAD_EXT,
  STAGING_PATH_RE,
  isStagingPath,
  safeFileName,
  extensionOf,
  asMB,
};
