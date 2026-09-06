// Deletes files that were uploaded but never attached to a submission.
//
// /api/navigator-upload-url hands out signed URLs so the browser can PUT a
// document straight into staging/<ip hash>/. api/navigator-intake.js then
// moves whatever a submission actually claims into <product>/<submission id>/.
// Anything left in staging is an upload that went nowhere: the customer closed
// the tab, changed their mind, or never got as far as pressing the button.
//
// Without this the bucket only ever grows, and the abandoned files are
// customers' financial documents — the least appropriate thing to keep
// indefinitely for no reason. A day is long enough that no live upload is at
// risk and short enough that nothing lingers.
//
// Protected by CRON_SECRET exactly as api/refresh-shows.js and
// api/retry-failed-buying.js are, so it cannot be triggered from the browser.

'use strict';

const { getSupabaseAdmin } = require('./_lib/supabaseAdmin');
const { STAGING_PREFIX, STAGING_TTL_HOURS } = require('./_lib/upload-limits');

const BUCKET = 'navigator-uploads';
const PAGE = 1000;

module.exports = async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  const admin = getSupabaseAdmin();
  const cutoff = Date.now() - STAGING_TTL_HOURS * 60 * 60 * 1000;

  let deleted = 0;
  let scanned = 0;
  const problems = [];

  try {
    // Top level of staging/ is one folder per IP hash. Supabase reports a
    // folder as an entry with a null id, so real files sitting directly under
    // staging/ (there should be none) are skipped rather than mistaken for
    // folders.
    const { data: folders, error: listError } = await admin.storage
      .from(BUCKET)
      .list(STAGING_PREFIX, { limit: PAGE });

    if (listError) throw listError;

    for (const folder of folders || []) {
      if (folder.id !== null && folder.id !== undefined) continue;

      const prefix = `${STAGING_PREFIX}/${folder.name}`;
      const { data: objects, error: objError } = await admin.storage
        .from(BUCKET)
        .list(prefix, { limit: PAGE });

      if (objError) { problems.push(`${prefix}: ${objError.message}`); continue; }

      scanned += (objects || []).length;

      const stale = (objects || [])
        .filter((o) => {
          const ts = Date.parse(o.created_at || o.updated_at || '');
          return Number.isFinite(ts) && ts < cutoff;
        })
        .map((o) => `${prefix}/${o.name}`);

      if (!stale.length) continue;

      const { error: removeError } = await admin.storage.from(BUCKET).remove(stale);
      if (removeError) problems.push(`${prefix}: ${removeError.message}`);
      else deleted += stale.length;
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err).slice(0, 300), deleted, scanned });
    return;
  }

  res.status(200).json({ ok: true, scanned, deleted, ttlHours: STAGING_TTL_HOURS, problems });
};
