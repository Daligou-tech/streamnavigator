'use strict';

// The half of Landlord Navigator the report cannot do on its own.
//
// The audit of 2026-09-10 graded this product 0 of 5 on "confirm result" and
// found its headline — "never miss a rental compliance deadline again" — resting
// on nothing at all: no cron touched landlord, nothing stored a baseline, and
// no submission was ever looked at twice. The deterministic engine fixed what
// the report SAYS. This fixes when it says it.
//
// A compliance obligation is dated by nature. A registration renews on a day. A
// notice window opens a fixed distance before a lease ends. A report read in
// September and filed away is worth very little in December, which is exactly
// when the landlord needed it — so the report names the date, and this comes
// back and says it out loud while there is still time to act.
//
// Two kinds of reminder, both computed from dates the landlord typed in
// themselves, never from anything we inferred:
//
//   registration — the renewal date they gave, 45 days out
//   lease        — the lease end date they gave, 75 days out, which is inside
//                  the range where a non-renewal decision has to be made rather
//                  than deferred (the report explains why it will not print an
//                  exact notice period, and neither does this)
//
// Claim-before-send, like api/rental-reminders.js: the unique constraint on
// rental_reminders(entitlement_id, unit_id, lease_end) is what makes a daily
// sweep safe. `unit_id` carries "<property key>:<kind>", so one property can
// hold one registration reminder and one lease reminder without either
// blocking the other, and neither can repeat.
//
// Reuses rental_entitlements and rental_reminders rather than adding two
// near-identical tables. The names are rental's by history; the columns are
// generic, and a schema migration to rename them would be churn for no
// customer-visible gain.
//
// Protected by CRON_SECRET like every other scheduled function here.

const { getSupabaseAdmin } = require('./_lib/supabaseAdmin');
const { ENTITLED_PRODUCTS } = require('./_lib/rental-entitlement');

// How far ahead each kind fires. Both are inside the window where the landlord
// can still do something, and far enough out that doing it is not a scramble.
const LEAD_DAYS = {
  registration: { at: 45, floor: 0 },
  lease: { at: 75, floor: 0 },
};

// A daily sweep that mails a whole portfolio at once would be a worse product
// than one that mails the thing due next. Bounded per run for the same reason
// the report sweep is: a wall clock, and a mail provider with its own limits.
const MAX_PER_SWEEP = 40;
const SITE = 'https://streamnavigator.ai';

function parseDate(value) {
  if (!value) return null;
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

function daysUntil(date) {
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  return Math.round((date.getTime() - today.getTime()) / 86400000);
}

function propertyKey(property, index) {
  const name = String(property.label || property.line1 || '').trim();
  const where = [property.city, property.state].filter(Boolean).join(' ');
  return (name || where || `property-${index + 1}`).toLowerCase().slice(0, 60);
}

function propertyName(property, index) {
  return String(property.label || property.line1 || '').trim()
    || [property.city, property.state].filter(Boolean).join(', ')
    || `Property ${index + 1}`;
}

// What is due, for one property, today. Returns at most one entry per kind, and
// nothing at all for a property whose dates the landlord left blank — this
// product does not guess a renewal date and must not remind against one.
function dueFor(property, index) {
  const due = [];
  const name = propertyName(property, index);
  const key = propertyKey(property, index);

  const renewal = parseDate(property.registration_expires);
  if (renewal) {
    const days = daysUntil(renewal);
    if (days <= LEAD_DAYS.registration.at && days >= LEAD_DAYS.registration.floor) {
      due.push({ kind: 'registration', key: `${key}:registration`, name, days, on: renewal });
    }
  }

  const lease = parseDate(property.lease_ends);
  if (lease) {
    const days = daysUntil(lease);
    if (days <= LEAD_DAYS.lease.at && days >= LEAD_DAYS.lease.floor) {
      due.push({ kind: 'lease', key: `${key}:lease`, name, days, on: lease });
    }
  }
  return due;
}

// The mail. Deliberately short and specific: one property, one date, one thing
// to do, and the link back to the report the rest of it is in.
//
// It never states a notice period or a fee, for the same reason the engine
// never does — those change, we do not hold them, and a wrong one in a reminder
// is worse than no reminder. What it does carry is the arithmetic on the
// customer's own date, which is the part they cannot get wrong.
function buildEmail({ item, link, runsLeft }) {
  const on = item.on.toISOString().slice(0, 10);
  const when = item.days === 0 ? 'today'
    : item.days === 1 ? 'tomorrow'
      : `in ${item.days} days`;

  if (item.kind === 'registration') {
    return {
      subject: `${item.name}: rental registration renews ${when}`,
      text: [
        `Your rental registration for ${item.name} expires on ${on} — ${when}.`,
        '',
        'Where renewal requires an inspection to be booked first, this is about as '
          + 'late as it can be started comfortably. Two things worth confirming with '
          + 'the office named in your report: whether an inspection has to be completed '
          + 'before the current registration lapses, and what a late renewal costs.',
        '',
        `Your compliance report, with the office to contact: ${link}`,
        '',
        runsLeft > 0
          ? `You have ${runsLeft} re-run${runsLeft === 1 ? '' : 's'} left on this year's report — `
            + 'worth using once the renewal is done, so the next reminder counts from the new date.'
          : '',
        '',
        'To stop these, reply with STOP and we will not email you again.',
      ].filter((line) => line !== null).join('\n'),
    };
  }

  return {
    subject: `${item.name}: the lease ends ${when} — the decision is due now`,
    text: [
      `The lease you gave for ${item.name} ends on ${on} — ${when}.`,
      '',
      'This is the point where renewing or not renewing stops being a decision you '
        + 'can defer. Required notice for non-renewal is set by state and sometimes '
        + 'city law and commonly runs from thirty to ninety days; we do not print your '
        + 'exact period, because a wrong one here would cost you the whole notice. '
        + 'What the arithmetic does say is that the window is open or about to be.',
      '',
      'If you are renewing, that is also the moment to redo any disclosure your report '
        + 'flagged — for most of these purposes a renewal is a new lease.',
      '',
      `Your compliance report, with what applies to this property: ${link}`,
      '',
      'To stop these, reply with STOP and we will not email you again.',
    ].join('\n'),
  };
}

module.exports = async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL;
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    res.status(500).json({ ok: false, error: 'Missing Resend configuration' });
    return;
  }
  if (!ENTITLED_PRODUCTS.includes('landlord')) {
    // The page may only sell a year for a product on that list, and this job
    // may only mail one. Keeping the two in step here means removing landlord
    // from the list turns the reminder off rather than leaving it sending
    // against something the page no longer promises.
    res.status(200).json({ ok: true, skipped: 'landlord is not an entitled product' });
    return;
  }

  const admin = getSupabaseAdmin();
  const nowIso = new Date().toISOString();

  const { data: entitlements, error } = await admin
    .from('rental_entitlements')
    .select('id, source_submission_id, email, property_address, expires_at, runs_allowed, runs_used, is_test')
    .gt('expires_at', nowIso)
    .order('granted_at', { ascending: true })
    .limit(200);

  if (error) {
    res.status(500).json({ ok: false, error: error.message });
    return;
  }

  const sent = [];
  const skipped = [];

  for (const entitlement of entitlements || []) {
    if (sent.length >= MAX_PER_SWEEP) break;

    const { data: submission } = await admin
      .from('navigator_submissions')
      .select('id, product, access_token, form_data')
      .eq('id', entitlement.source_submission_id)
      .maybeSingle();

    // rental_entitlements holds both products. A rental entitlement has no
    // properties array and is somebody else's job.
    if (!submission || submission.product !== 'landlord') continue;

    const properties = Array.isArray((submission.form_data || {}).properties)
      ? submission.form_data.properties : [];
    if (!properties.length) { skipped.push({ id: entitlement.id, reason: 'no_properties' }); continue; }

    // Checked per address immediately before the send rather than once at the
    // top, so somebody who opts out today does not receive tomorrow's sweep.
    const { data: suppressed } = await admin
      .from('suppression_list')
      .select('email')
      .eq('email', String(entitlement.email).toLowerCase())
      .maybeSingle();
    if (suppressed) { skipped.push({ id: entitlement.id, reason: 'suppressed' }); continue; }

    const link = `${SITE}/navigator-status?id=${encodeURIComponent(submission.id)}`
      + `&t=${encodeURIComponent(submission.access_token)}&p=landlord`;
    const runsLeft = Math.max(0, entitlement.runs_allowed - entitlement.runs_used);

    for (let i = 0; i < properties.length; i++) {
      if (sent.length >= MAX_PER_SWEEP) break;

      for (const item of dueFor(properties[i] || {}, i)) {
        if (sent.length >= MAX_PER_SWEEP) break;

        const onDate = item.on.toISOString().slice(0, 10);

        // Claim before mailing. If this loses to a concurrent sweep, or the
        // reminder already went, the unique constraint says so and nothing is
        // sent twice. A crash after this costs one reminder; sending first and
        // recording after would cost a daily repeat for weeks.
        const { error: claimError } = await admin
          .from('rental_reminders')
          .insert({ entitlement_id: entitlement.id, unit_id: item.key, lease_end: onDate });
        if (claimError) continue;   // 23505: already reminded

        const { subject, text } = buildEmail({ item, link, runsLeft });

        try {
          const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: RESEND_FROM_EMAIL, to: entitlement.email, subject, text }),
          });
          if (!response.ok) {
            // Give the claim back. A rejection is proof nothing was sent, and
            // without this the row stays claimed forever — one bad afternoon at
            // the mail provider would silently cost a customer the reminder
            // they paid for. The ambiguous case below keeps its claim.
            await admin
              .from('rental_reminders')
              .delete()
              .eq('entitlement_id', entitlement.id)
              .eq('unit_id', item.key)
              .eq('lease_end', onDate);
            skipped.push({ id: entitlement.id, unit: item.key, reason: 'send_rejected_claim_released' });
            continue;
          }
          sent.push({ id: entitlement.id, unit: item.key, kind: item.kind, days: item.days });
        } catch (err) {
          console.error('[landlord-reminders] send failed after the claim:', err.message);
          skipped.push({ id: entitlement.id, unit: item.key, reason: 'send_error_claim_kept' });
        }
      }
    }
  }

  res.status(200).json({ ok: true, sent: sent.length, skipped: skipped.length, details: { sent, skipped } });
};

module.exports.__internal = { dueFor, buildEmail, propertyKey, propertyName, daysUntil, LEAD_DAYS };
