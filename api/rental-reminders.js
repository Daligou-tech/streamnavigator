// The one email that earns the year.
//
// The audit finds that Unit 1 rents $312.50 a month below the median of the
// identical units in the same building, and says the lease runs to 11/30/2026.
// That finding is worth $3,750 a year and it is worth nothing at all if the
// landlord reads it in September and remembers it in December. The renewal is
// the moment the largest finding in the report can actually be acted on, and
// nothing in the product used to know the date had arrived.
//
// So this is not "come back and buy something". It is: your own audit found
// this, the date you can act on it is six weeks out, and the audit you already
// paid for covers the re-run. Sent once per unit per lease end — the unique
// constraint on rental_reminders is what makes a daily sweep safe.
//
// Every address is checked against public.suppression_list first. This is a
// mail we send rather than one the customer asked for, and the fact that they
// bought something is not consent to be reminded about it forever. It carries
// the same unsubscribe link as everything else that goes out from here.

const { getSupabaseAdmin } = require('./_lib/supabaseAdmin');

// Six weeks out. Far enough that a notice period and a market check still fit
// before the renewal has to be sent, close enough that it is the next thing on
// the landlord's desk rather than a note for later.
const LEAD_DAYS_MAX = 45;
const LEAD_DAYS_MIN = 21;
const MAX_PER_SWEEP = 25;

function parseLeaseEnd(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
  return null;
}

function daysUntil(date) {
  return Math.round((date.getTime() - Date.now()) / 86400000);
}

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return '$' + Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: Math.abs(n) % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

// The finding this unit's renewal is actually about, if the audit found one.
// Without it the email is a calendar alert; with it, it is the reason they
// bought the report.
function rentFindingForUnit(report, unitId) {
  const sections = Array.isArray(report && report.sections) ? report.sections : [];
  const needle = new RegExp(`unit\\s+${String(unitId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  for (const section of sections) {
    for (const item of (Array.isArray(section.items) ? section.items : [])) {
      if (typeof item === 'string' && needle.test(item) && /below|median|comparable/i.test(item)) {
        return item;
      }
    }
  }
  return null;
}

function buildEmail({ unitId, leaseEnd, days, address, finding, runsLeft, expiresAt, unsubscribeUrl }) {
  const where = address ? ` at ${address}` : '';
  const lines = [
    `Unit ${unitId}${where} has a lease ending ${leaseEnd} — about ${days} days from now.`,
    '',
  ];

  if (finding) {
    lines.push('Your audit flagged this unit specifically:');
    lines.push('');
    lines.push(finding.length > 600 ? `${finding.slice(0, 600)}…` : finding);
    lines.push('');
    lines.push('A renewal is the point that finding can be acted on. After it, it waits another year.');
  } else {
    lines.push('A renewal is the one point in the year when the rent on a unit can be revisited.');
  }

  lines.push('');
  lines.push('Before you send anything, check your state and city notice period — they vary, and this');
  lines.push('is not legal advice.');
  lines.push('');

  if (runsLeft > 0) {
    lines.push(`Your audit covers ${runsLeft} more ${runsLeft === 1 ? 'report' : 'reports'} on this property until `
      + `${new Date(expiresAt).toISOString().slice(0, 10)}, at no further charge. If your numbers have moved since `
      + 'you last sent them, open your report and upload the new statement — the next audit will also compare the '
      + 'two periods and show you which costs rose.');
  } else {
    lines.push('You have used all the audits included with this property.');
  }

  lines.push('');
  lines.push('— StreamNavigator');
  lines.push('');
  lines.push(`Not useful? Unsubscribe: ${unsubscribeUrl}`);

  return {
    subject: `Unit ${unitId}'s lease ends ${leaseEnd}`,
    text: lines.join('\n'),
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

    // Suppression is checked per address, immediately before the send, not once
    // at the top of a batch. Somebody who opts out today must not receive
    // tomorrow's sweep.
    const { data: suppressed } = await admin
      .from('suppression_list')
      .select('email')
      .eq('email', String(entitlement.email).toLowerCase())
      .maybeSingle();
    if (suppressed) { skipped.push({ id: entitlement.id, reason: 'suppressed' }); continue; }

    const { data: submission } = await admin
      .from('navigator_submissions')
      .select('id, form_data')
      .eq('id', entitlement.source_submission_id)
      .maybeSingle();

    const extraction = submission && (submission.form_data || {}).rental_extraction;
    const units = extraction && Array.isArray(extraction.units) ? extraction.units : [];
    if (!units.length) { skipped.push({ id: entitlement.id, reason: 'no_units' }); continue; }

    const { data: report } = await admin
      .from('navigator_reports')
      .select('report_json')
      .eq('submission_id', entitlement.source_submission_id)
      .maybeSingle();

    for (const unit of units) {
      if (sent.length >= MAX_PER_SWEEP) break;
      const leaseEnd = parseLeaseEnd(unit.lease_end);
      if (!leaseEnd) continue;
      const days = daysUntil(leaseEnd);
      if (days > LEAD_DAYS_MAX || days < LEAD_DAYS_MIN) continue;

      const leaseEndDate = leaseEnd.toISOString().slice(0, 10);

      // Claim the send BEFORE mailing. If the insert loses to a concurrent
      // sweep, or this one already went, the unique constraint says so and
      // nothing is sent twice. A crash after this point costs one reminder;
      // sending first and recording after would cost a daily repeat.
      const { error: claimError } = await admin
        .from('rental_reminders')
        .insert({
          entitlement_id: entitlement.id,
          unit_id: String(unit.unit_id || 'unit'),
          lease_end: leaseEndDate,
        });
      if (claimError) continue;   // 23505: already reminded

      const runsLeft = Math.max(0, entitlement.runs_allowed - entitlement.runs_used);
      const { subject, text } = buildEmail({
        unitId: unit.unit_id || 'your unit',
        leaseEnd: unit.lease_end,
        days,
        address: entitlement.property_address,
        finding: report ? rentFindingForUnit(report.report_json, unit.unit_id) : null,
        runsLeft,
        expiresAt: entitlement.expires_at,
        unsubscribeUrl: 'https://streamnavigator.ai/unsubscribe',
      });

      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: RESEND_FROM_EMAIL, to: entitlement.email, subject, text }),
        });
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          console.error('[rental-reminders] Resend rejected:', body.slice(0, 200));
          skipped.push({ id: entitlement.id, unit: unit.unit_id, reason: 'send_failed' });
          continue;
        }
        sent.push({ id: entitlement.id, unit: unit.unit_id, leaseEnd: leaseEndDate });
      } catch (err) {
        console.error('[rental-reminders] send failed:', err.message);
        skipped.push({ id: entitlement.id, unit: unit.unit_id, reason: 'send_error' });
      }
    }
  }

  res.status(200).json({ ok: true, considered: (entitlements || []).length, sent, skipped });
};

module.exports._internal = { parseLeaseEnd, daysUntil, rentFindingForUnit, buildEmail, LEAD_DAYS_MIN, LEAD_DAYS_MAX };
