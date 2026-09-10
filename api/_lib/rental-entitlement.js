'use strict';

// One payment buys a year of audits on one property.
//
// The rental page sold exactly that for months — "$149/year", "one price covers
// ongoing checks across your properties for a year", "a full year of
// monitoring" — against a Stripe link that charges once, a schema with no
// entitlement column, and a cron table with no rental job. The claim came off
// the page on 2026-09-09 because nothing behind it existed. This is the thing
// that has to exist before it goes back on.
//
// What it grants, precisely, because the page will say precisely this:
//
//   * Twelve months from the day the first report is delivered.
//   * Up to four audits of the same property in that window, the first
//     included. Four rather than unlimited because every audit is two model
//     calls, and a bound that can be stated on the page is worth more than an
//     "unlimited" that would quietly need rationing later.
//   * Spent by presenting the id and token of the original report, which is the
//     capability the customer's browser already holds. Not by email address:
//     an entitlement claimable by anyone who guesses a customer's email is not
//     an entitlement, it is a coupon.
//
// A re-audit funded this way never grants another entitlement. It is recorded
// with price_cents = 0, and grantEntitlement declines those, so the year cannot
// extend itself.

const ENTITLEMENT_MONTHS = 12;
const RUNS_ALLOWED = 4;

function addMonths(date, months) {
  const d = new Date(date.getTime());
  const targetMonth = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(targetMonth);
  // Clamp rather than roll over: a year from 31 January is 31 January, and
  // where the target month is short it is the last day of it, never 3 March.
  const lastDayOfTarget = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfTarget));
  return d;
}

// Called once, after a rental report is delivered. Idempotent: the unique
// constraint on source_submission_id means a retried generation cannot hand a
// customer a second year.
async function grantEntitlement(admin, submission, extraction) {
  if (!submission || submission.product !== 'rental' || !submission.email) return null;

  // A re-audit spent from an existing entitlement must not create a new one.
  if (submission.price_cents === 0) return null;

  const now = new Date();
  const row = {
    source_submission_id: submission.id,
    email: submission.email,
    property_address: ((extraction || {}).property || {}).address || null,
    expires_at: addMonths(now, ENTITLEMENT_MONTHS).toISOString(),
    runs_allowed: RUNS_ALLOWED,
    // The delivered report is the first of the four.
    runs_used: 1,
    is_test: !!submission.is_test,
  };

  const { data, error } = await admin
    .from('rental_entitlements')
    .upsert(row, { onConflict: 'source_submission_id', ignoreDuplicates: true })
    .select('id, expires_at, runs_allowed, runs_used')
    .maybeSingle();

  if (error) {
    // A missing entitlement costs the customer a re-run they can ask for by
    // email. A thrown error here would cost them the report they just paid for.
    console.error('[rental] could not grant entitlement:', error.message);
    return null;
  }
  return data || null;
}

// What the browser asks before offering a free re-audit. Answers only for a
// caller holding the original submission's token.
async function checkEntitlement(admin, id, token) {
  if (!id || !token) return { active: false, reason: 'missing_credentials' };

  const { data: submission, error } = await admin
    .from('navigator_submissions')
    .select('id, product, access_token, email')
    .eq('id', id)
    .maybeSingle();

  if (error || !submission) return { active: false, reason: 'not_found' };
  if (submission.product !== 'rental') return { active: false, reason: 'not_rental' };
  if (submission.access_token !== token) return { active: false, reason: 'bad_token' };

  const { data: entitlement } = await admin
    .from('rental_entitlements')
    .select('id, expires_at, runs_allowed, runs_used, property_address')
    .eq('source_submission_id', submission.id)
    .maybeSingle();

  if (!entitlement) return { active: false, reason: 'none' };

  const expiresAt = new Date(entitlement.expires_at);
  const runsLeft = Math.max(0, entitlement.runs_allowed - entitlement.runs_used);

  if (expiresAt.getTime() < Date.now()) {
    return { active: false, reason: 'expired', expiresAt: entitlement.expires_at, runsLeft };
  }
  if (runsLeft <= 0) {
    return { active: false, reason: 'spent', expiresAt: entitlement.expires_at, runsLeft: 0 };
  }

  return {
    active: true,
    entitlementId: entitlement.id,
    expiresAt: entitlement.expires_at,
    runsLeft,
    propertyAddress: entitlement.property_address || null,
  };
}

// Spends one run. Conditional on runs_used still being what we read, so two
// submissions racing the last run cannot both win it.
async function consumeEntitlement(admin, entitlementId) {
  const { data: current } = await admin
    .from('rental_entitlements')
    .select('id, runs_allowed, runs_used, expires_at')
    .eq('id', entitlementId)
    .maybeSingle();

  if (!current) return false;
  if (new Date(current.expires_at).getTime() < Date.now()) return false;
  if (current.runs_used >= current.runs_allowed) return false;

  const { data: updated } = await admin
    .from('rental_entitlements')
    .update({ runs_used: current.runs_used + 1 })
    .eq('id', entitlementId)
    .eq('runs_used', current.runs_used)
    .select('id')
    .maybeSingle();

  return !!updated;
}

module.exports = {
  grantEntitlement,
  checkEntitlement,
  consumeEntitlement,
  ENTITLEMENT_MONTHS,
  RUNS_ALLOWED,
  _internal: { addMonths },
};
