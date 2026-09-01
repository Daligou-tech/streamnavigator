// Tests for the scorecard rate limit. The policy decision is a pure function,
// so it is tested directly rather than through the database.

const test = require('node:test');
const assert = require('node:assert/strict');
const { LIMITS, decide, hashIp, clientIp, checkScorecardRateLimit } = require('../api/_lib/rate-limit');

test('a normal customer is never blocked', () => {
  // Two closings audited, one re-upload each because the first scan was poor.
  const r = decide({ emailHour: 2, emailDay: 4, ipHour: 2, ipDay: 4, globalDay: 30 });
  assert.equal(r.allowed, true);
  assert.equal(r.message, null);
});

test('failed attempts must not lock a customer out of retrying', () => {
  // The regression that caught the first real tester: three uploads rejected as
  // the wrong document type, then a fourth with the correct file. Being refused
  // here is the worst possible moment — the customer has just worked out what
  // was wrong and is fixing it.
  const afterThreeFailures = decide({ emailHour: 3, emailDay: 3, ipHour: 3, ipDay: 3, globalDay: 3 });
  assert.equal(afterThreeFailures.allowed, true);

  // And still fine after a couple more rounds of bad scans.
  assert.equal(decide({ emailHour: 6, emailDay: 6, ipHour: 6, ipDay: 6, globalDay: 10 }).allowed, true);
});

test('the block message explains that failed attempts count', () => {
  // Otherwise "you have used 8 scorecards" is baffling to someone who believes
  // they never got one.
  const r = decide({ emailHour: LIMITS.EMAIL_PER_HOUR });
  assert.match(r.message, /could not be read count too/);
});

test('looping the same email is blocked at the hourly limit', () => {
  const r = decide({ emailHour: LIMITS.EMAIL_PER_HOUR, ipHour: 3, globalDay: 10 });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'email_hourly');
  assert.equal(r.retryAfterMinutes, 60);
});

test('the daily email limit catches someone spread across hours', () => {
  const r = decide({ emailHour: 1, emailDay: LIMITS.EMAIL_PER_DAY, globalDay: 10 });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'email_daily');
});

test('cycling throwaway emails is caught by the IP limit', () => {
  // fresh email every time, so the email counters stay at zero
  const r = decide({ emailHour: 0, emailDay: 0, ipHour: LIMITS.IP_PER_HOUR, globalDay: 20 });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'ip_hourly');
});

test('the global cap fires first and outranks everything', () => {
  const r = decide({ emailHour: 0, emailDay: 0, ipHour: 0, ipDay: 0, globalDay: LIMITS.GLOBAL_PER_DAY });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'global_daily_cap');
});

test('the global cap message does not tell an abuser they broke the service', () => {
  const r = decide({ globalDay: LIMITS.GLOBAL_PER_DAY });
  assert.equal(/global|cap|limit reached|everyone/i.test(r.message), false);
  assert.match(r.message, /temporarily unavailable/i);
});

test('a distributed attack is bounded only by the global cap', () => {
  // every request a different email AND a different IP — the per-caller limits
  // are useless here, which is exactly why the third layer exists
  const perCaller = decide({ emailHour: 0, ipHour: 0, globalDay: 100 });
  assert.equal(perCaller.allowed, true);
  const atCap = decide({ emailHour: 0, ipHour: 0, globalDay: LIMITS.GLOBAL_PER_DAY });
  assert.equal(atCap.allowed, false);
});

test('limits are boundaries, not off-by-one', () => {
  assert.equal(decide({ emailHour: LIMITS.EMAIL_PER_HOUR - 1 }).allowed, true);
  assert.equal(decide({ emailHour: LIMITS.EMAIL_PER_HOUR }).allowed, false);
});

test('an empty counts object is allowed', () => {
  assert.equal(decide({}).allowed, true);
  assert.equal(decide().allowed, true);
});

// --- IP handling ------------------------------------------------------------

test('the client IP is the first entry in x-forwarded-for, not the proxy chain', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.9, 70.41.3.18, 150.172.238.178' } };
  assert.equal(clientIp(req), '203.0.113.9');
});

test('x-real-ip is the fallback, then the socket', () => {
  assert.equal(clientIp({ headers: { 'x-real-ip': '198.51.100.4' } }), '198.51.100.4');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '192.0.2.7' } }), '192.0.2.7');
  assert.equal(clientIp({ headers: {} }), 'unknown');
});

test('the raw IP is never stored — only a stable hash', () => {
  const ip = '203.0.113.9';
  const h = hashIp(ip);
  assert.equal(h, hashIp(ip));              // stable, so counting works
  assert.notEqual(h, hashIp('203.0.113.10')); // distinct per address
  assert.equal(h.includes(ip), false);        // not recoverable from the hash
  assert.equal(h.length, 32);
});

// --- failure behaviour ------------------------------------------------------

test('a database failure allows the request rather than blocking a paying customer', async () => {
  const brokenAdmin = { from() { throw new Error('supabase is down'); } };
  const r = await checkScorecardRateLimit(brokenAdmin, { email: 'a@b.com', ipHash: 'x' });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'check_failed');
});
