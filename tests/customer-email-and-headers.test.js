// Run: node tests/customer-email-and-headers.test.js
//
// Two things found by outside checks on 2026-09-27, not by any suite here:
//
//   1. Google Public DNS showed the Resend-verified domain is
//      send.streamnavigator.ai, and its only MX is Amazon SES's bounce-feedback
//      inbox. Every customer email said "Reply to this email" and none of them
//      set reply_to, so a customer's reply went nowhere.
//
//   2. Mozilla's HTTP Observatory graded the site C (50/100): no
//      X-Content-Type-Options, no X-Frame-Options, no Referrer-Policy, no CSP --
//      on pages where customers upload closing documents and insurance policies,
//      and where the report link carries its access token in the query string.
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; } catch (err) { failures.push(`${name}\n    ${err.message.split('\n')[0]}`); }
}
function assert(ok, msg) { if (!ok) throw new Error(msg); }

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// Everything that sends through Resend to a CUSTOMER. api/_lib/alerts.js is left
// out on purpose: it mails the operator, not a customer.
const CUSTOMER_SENDERS = [
  'api/_lib/report-delivery.js',
  'api/_lib/scorecard-link.js',
  'api/email-report-pdf.js',
  'api/landlord-reminders.js',
  'api/rental-reminders.js',
  'api/refresh-shows.js',
];

(async () => {
  await test('no file sends through Resend without being listed here', () => {
    const files = [];
    const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).forEach((e) => {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (rel.endsWith('.js') && read(rel).includes('api.resend.com/emails')) files.push(rel);
    });
    walk('api');
    const unlisted = files.filter((f) => !CUSTOMER_SENDERS.includes(f) && f !== 'api/_lib/alerts.js');
    assert(!unlisted.length, `new Resend sender(s) not covered by this test: ${unlisted.join(', ')}`);
  });

  for (const f of CUSTOMER_SENDERS) {
    await test(`${f}: every payload sets reply_to`, () => {
      const src = read(f);
      const froms = (src.match(/api\.resend\.com\/emails/g) || []).length;
      const replies = (src.match(/reply_to: REPLY_TO/g) || []).length;
      assert(froms > 0, 'found no Resend send to check -- has the send moved?');
      assert(replies >= froms, `${froms} Resend send(s), ${replies} with reply_to`);
      assert(/const REPLY_TO = '[^'@\s]+@streamnavigator\.ai'/.test(src), 'REPLY_TO is not a streamnavigator.ai mailbox');
    });
  }

  // The payload Resend actually receives, not the source text.
  await test('the scorecard-link email Resend receives has a reply_to on the real domain', async () => {
    process.env.RESEND_API_KEY = 'test';
    process.env.RESEND_FROM_EMAIL = 'StreamNavigator <hello@send.streamnavigator.ai>';
    let sent = null;
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => { sent = { url, body: JSON.parse(opts.body) }; return { ok: true, json: async () => ({}), text: async () => '' }; };
    try {
      const { emailScorecardLink } = require('../api/_lib/scorecard-link');
      // Any chain of .from().update().eq() resolves to an empty result.
      const chain = new Proxy(function () {}, { get: (t, k) => (k === 'then' ? (r) => r({ data: null, error: null }) : chain), apply: () => chain });
      await emailScorecardLink(chain, { id: 'x', email: 'c@example.com', access_token: 't' });
    } finally { global.fetch = realFetch; }
    assert(sent, 'nothing was sent');
    assert(sent.body.reply_to === 'hello@streamnavigator.ai', `reply_to was ${JSON.stringify(sent.body.reply_to)}`);
    assert(/Reply to this email/.test(sent.body.text), 'the body no longer invites a reply; revisit this test');
  });

  const headers = JSON.parse(read('vercel.json')).headers
    .filter((h) => h.source === '/(.*)')
    .flatMap((h) => h.headers);
  const get = (k) => (headers.find((h) => h.key.toLowerCase() === k.toLowerCase()) || {}).value;

  await test('every response carries the security headers', () => {
    assert(get('X-Content-Type-Options') === 'nosniff', 'X-Content-Type-Options missing');
    assert(get('X-Frame-Options') === 'DENY', 'X-Frame-Options missing');
    assert(/strict-origin|same-origin|no-referrer/.test(get('Referrer-Policy') || ''), 'Referrer-Policy missing or leaks the full URL');
    assert(/frame-ancestors 'none'/.test(get('Content-Security-Policy') || ''), "CSP missing frame-ancestors 'none'");
  });

  console.log(`${passed}/${passed + failures.length} passed`);
  if (failures.length) { failures.forEach((f) => console.log(`FAIL ${f}`)); process.exit(1); }
})();
