// Rate limiting for the free, pre-payment scorecard.
//
// The problem this solves: /api/closing-scorecard is unauthenticated and every
// call runs a model request over a multi-page PDF. At roughly $0.05-$0.15 per
// call, an unattended script is a real bill.
//
// Deliberately built with NO new table. Counts come from navigator_submissions,
// which already records every scorecard attempt. Fewer moving parts, nothing to
// migrate, and the counter can never drift out of sync with reality because it
// IS reality.
//
// Three layers, because they fail differently:
//   * per email  — stops one person looping the same address
//   * per IP     — stops one person cycling throwaway addresses
//   * global/day — the circuit breaker. Neither of the above helps against a
//                  distributed script, and this is the only layer that puts a
//                  hard ceiling on a single day's spend.

'use strict';

const crypto = require('crypto');

// Tuned so a real customer never notices.
//
// The original numbers (3/hour per email) were too tight and locked out the
// first person who tested this: three attempts that all FAILED — wrong document
// type — consumed the whole hourly budget, so the retry with the right file was
// refused. That is backwards. Failures are exactly when someone retries, and a
// customer fighting a bad scan is the last person who should be blocked.
//
// Every attempt still counts, because every attempt costs a model call. The
// answer is headroom, not exemptions: enough that a frustrated customer working
// through three or four bad uploads never hits a wall, while the global cap
// keeps the day's worst case bounded.
const LIMITS = {
  EMAIL_PER_HOUR: 8,
  EMAIL_PER_DAY: 20,
  IP_PER_HOUR: 15,
  IP_PER_DAY: 40,
  GLOBAL_PER_DAY: 250, // ~$12-38/day worst case. Raise as real volume grows.
};

// Raw IPs are personal data and there is no reason to keep them. The hash is
// enough to count repeat callers and useless for identifying anyone. Set
// RATE_LIMIT_SALT in Vercel to make the hashes unguessable across deployments;
// without it the fallback still works, it is just guessable given an IP.
function hashIp(ip) {
  const salt = process.env.RATE_LIMIT_SALT || 'streamnavigator-closing-scorecard';
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 32);
}

// Vercel puts the real client IP first in x-forwarded-for. Everything after is
// proxy chain and is not trustworthy.
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

// Pure decision function — no I/O, so the policy is testable on its own.
// Returns { allowed, reason, message, retryAfterMinutes }.
function decide(counts, limits = LIMITS) {
  const {
    emailHour = 0, emailDay = 0, ipHour = 0, ipDay = 0, globalDay = 0,
  } = counts || {};

  if (globalDay >= limits.GLOBAL_PER_DAY) {
    return {
      allowed: false,
      reason: 'global_daily_cap',
      // Deliberately vague to the caller: telling an abuser they have tripped
      // the global cap tells them the service is now down for everyone.
      message: 'Free scorecards are temporarily unavailable. Please try again later.',
      retryAfterMinutes: 60,
    };
  }
  if (emailHour >= limits.EMAIL_PER_HOUR) {
    return {
      allowed: false,
      reason: 'email_hourly',
      message: `You have used ${emailHour} scorecard attempts in the past hour — attempts that could not be read count too, since each one still runs a full analysis. Please wait an hour, or email us and we will look at your document directly.`,
      retryAfterMinutes: 60,
    };
  }
  if (emailDay >= limits.EMAIL_PER_DAY) {
    return {
      allowed: false,
      reason: 'email_daily',
      message: 'You have reached the daily limit for free scorecards on this email address. Please try again tomorrow.',
      retryAfterMinutes: 60 * 12,
    };
  }
  if (ipHour >= limits.IP_PER_HOUR) {
    return {
      allowed: false,
      reason: 'ip_hourly',
      message: 'Too many free scorecards from this connection in the past hour. Please wait an hour and try again.',
      retryAfterMinutes: 60,
    };
  }
  if (ipDay >= limits.IP_PER_DAY) {
    return {
      allowed: false,
      reason: 'ip_daily',
      message: 'Too many free scorecards from this connection today. Please try again tomorrow.',
      retryAfterMinutes: 60 * 12,
    };
  }
  return { allowed: true, reason: null, message: null, retryAfterMinutes: 0 };
}

async function countSince(admin, sinceIso, extra) {
  let q = admin
    .from('navigator_submissions')
    .select('id', { count: 'exact', head: true })
    .eq('product', 'closing')
    .gte('created_at', sinceIso);
  if (extra) q = extra(q);
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
}

// Fails OPEN on a database error. A customer blocked by a transient Supabase
// blip is a worse outcome than a handful of extra model calls — and the global
// cap still applies on the next successful check.
async function checkScorecardRateLimit(admin, { email, ipHash }, limits = LIMITS) {
  const now = Date.now();
  const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  try {
    const [emailHour, emailDay, ipHour, ipDay, globalDay] = await Promise.all([
      email ? countSince(admin, hourAgo, (q) => q.eq('email', email)) : 0,
      email ? countSince(admin, dayAgo, (q) => q.eq('email', email)) : 0,
      ipHash ? countSince(admin, hourAgo, (q) => q.eq('form_data->>ip_hash', ipHash)) : 0,
      ipHash ? countSince(admin, dayAgo, (q) => q.eq('form_data->>ip_hash', ipHash)) : 0,
      countSince(admin, dayAgo, null),
    ]);
    return decide({ emailHour, emailDay, ipHour, ipDay, globalDay }, limits);
  } catch (err) {
    console.error('[rate-limit] check failed, allowing request:', err.message);
    return { allowed: true, reason: 'check_failed', message: null, retryAfterMinutes: 0 };
  }
}

module.exports = { LIMITS, decide, hashIp, clientIp, checkScorecardRateLimit };
