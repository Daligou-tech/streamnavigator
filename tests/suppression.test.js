// Run: node tests/suppression.test.js
//
// The opt-out path is the one piece of the outreach machinery that is legally
// load-bearing. Apollo cannot provide it — its unsubscribe link is a tracked
// link and link tracking is a paid feature, so on the free plan the setting
// will not save at all and `<%unsubscribe here%>` has nothing to expand into.
// unsubscribe.html + api/unsubscribe.js + scripts/check-suppression.js replace
// it, and this suite guards the three ways that replacement could quietly stop
// working:
//
//   1. the page stops being able to record an opt-out,
//   2. the endpoint starts accepting GET, so corporate link scanners
//      unsubscribe people who never clicked,
//   3. the pre-send filter stops matching an address it should have caught.
//
// (3) is the one that actually mails somebody who asked you to stop.

'use strict';

const fs = require('fs');
const path = require('path');
const { parseCsv, toCsvLine, partitionBySuppression } = require('../scripts/check-suppression');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}\n    ${err.message.split('\n')[0]}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const root = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'unsubscribe.html'), 'utf8');
const endpoint = fs.readFileSync(path.join(root, 'api', 'unsubscribe.js'), 'utf8');

// ---------------------------------------------------------------- the filter

test('a suppressed address is removed from a contact list', () => {
  const rows = parseCsv([
    'first_name,email,company',
    'Yanet,yanet@impactrealestatellc.com,Impact',
    'Linda,lindacwardle@gmail.com,Buck',
  ].join('\n'));
  const { hits, clean } = partitionBySuppression(rows, new Set(['lindacwardle@gmail.com']));
  assert(hits.length === 1, `expected 1 hit, got ${hits.length}`);
  assert(hits[0].email === 'lindacwardle@gmail.com', 'wrong address flagged');
  assert(clean.length === 1, `expected 1 remaining, got ${clean.length}`);
  assert(clean[0].email === 'yanet@impactrealestatellc.com', 'wrong address kept');
});

// The address in a CSV came from Apollo; the address on the suppression list
// was typed into a form by a person. Expecting those two to agree on case is
// how somebody who opted out gets mailed anyway.
test('matching ignores case and surrounding whitespace', () => {
  const rows = parseCsv([
    'first_name,email',
    'Genevieve,  Genevieve@KWDulles.com  ',
  ].join('\n'));
  const { hits } = partitionBySuppression(rows, new Set(['genevieve@kwdulles.com']));
  assert(hits.length === 1, 'a differently-cased address was not matched');
});

// This is the bug the hand-rolled parser exists to prevent: "Impact Real
// Estate, LLC" contains a comma, and a split(',') shifts every column after it
// by one, so the email column stops holding email addresses and NOBODY matches
// the suppression list. The filter would report all-clear on a file it never
// actually read.
test('a quoted comma inside a company name does not shift the email column', () => {
  const rows = parseCsv([
    'first_name,company,email',
    'Yanet,"Impact Real Estate, LLC",yanet@impactrealestatellc.com',
  ].join('\n'));
  assert(rows[1].length === 3, `row split into ${rows[1].length} fields, expected 3`);
  assert(rows[1][1] === 'Impact Real Estate, LLC', 'quoted comma was not preserved');
  const { hits } = partitionBySuppression(rows, new Set(['yanet@impactrealestatellc.com']));
  assert(hits.length === 1, 'address behind a quoted comma was not matched');
});

test('CRLF line endings parse the same as LF', () => {
  const rows = parseCsv('first_name,email\r\nYanet,yanet@impactrealestatellc.com\r\n');
  assert(rows.length === 2, `expected 2 rows, got ${rows.length}`);
  assert(rows[1][1] === 'yanet@impactrealestatellc.com', 'a stray \\r survived into the address');
});

test('a row with no email address is kept, not dropped', () => {
  const rows = parseCsv([
    'first_name,email',
    'Yanet,yanet@impactrealestatellc.com',
    'Nobody,',
  ].join('\n'));
  const { hits, clean, noEmail } = partitionBySuppression(rows, new Set());
  assert(hits.length === 0, 'a blank cell was treated as an opt-out');
  assert(clean.length === 2, `expected both rows kept, got ${clean.length}`);
  assert(noEmail.length === 1, 'the blank row was not reported');
});

test('a file with no email column is reported rather than passed as clean', () => {
  const rows = parseCsv('first_name,company\nYanet,Impact');
  const { emailCol } = partitionBySuppression(rows, new Set(['yanet@impactrealestatellc.com']));
  assert(emailCol === -1, 'a file with no email column looked usable');
});

test('a written row round-trips back through the parser unchanged', () => {
  const original = ['Yanet', 'Impact Real Estate, LLC', 'yanet@impactrealestatellc.com'];
  const rows = parseCsv('a,b,c\n' + toCsvLine(original));
  assert(JSON.stringify(rows[1]) === JSON.stringify(original),
    `round-trip changed the row: ${JSON.stringify(rows[1])}`);
});

// -------------------------------------------------------------- the endpoint

// Every one of these recipients is behind Microsoft 365 or Google Workspace,
// and both prefetch URLs in inbound mail to scan them. A GET that suppressed on
// sight would opt out the people whose mail was delivered, without them ever
// touching it.
test('the endpoint refuses anything but POST', () => {
  assert(/req\.method !== 'POST'/.test(endpoint), 'no POST-only guard in api/unsubscribe.js');
  assert(/405/.test(endpoint), 'the non-POST path does not return 405');
});

test('an already-suppressed address is not reported as a failure', () => {
  assert(/23505/.test(endpoint),
    'unique_violation is not special-cased — a second opt-out would return an error to someone who is already unsubscribed');
});

test('the endpoint writes to suppression_list', () => {
  assert(/from\('suppression_list'\)/.test(endpoint), 'the endpoint does not touch suppression_list');
  assert(/\.insert\(/.test(endpoint), 'the endpoint never inserts');
});

test('the address is lowercased before it is stored', () => {
  assert(/toLowerCase\(\)/.test(endpoint),
    'addresses are stored as typed, so a capitalised opt-out would not match the CSV');
});

// ------------------------------------------------------------------ the page

test('the page posts to the endpoint', () => {
  assert(/\/api\/unsubscribe/.test(page), 'the page does not call /api/unsubscribe');
  assert(/method:\s*'POST'/.test(page), 'the page does not POST');
});

// Loading the page must not suppress anything — see the GET reasoning above.
// The prefill is a convenience; the button press is the act.
test('loading the page does not submit anything by itself', () => {
  const auto = /addEventListener\(\s*['"]DOMContentLoaded['"][^)]*\)[\s\S]{0,200}?fetch\(/.test(page)
    || /\bform\.submit\(\)/.test(page);
  assert(!auto, 'the page appears to fire the opt-out on load rather than on click');
});

test('the page keeps working when the link carries no address', () => {
  assert(/params\.get\('e'\)/.test(page), 'the page never reads a prefill parameter');
  assert(/id="email"/.test(page), 'there is no field for someone to type their address into');
  assert(/required/.test(page), 'the address field is not marked required');
});

// CAN-SPAM needs the sender identified. A bare form on an unfamiliar domain
// also reads as a phishing page, which is its own reason people do not use it.
test('the page names the sender and a real postal address', () => {
  assert(/StreamNavigator LLC/.test(page), 'the page does not name the entity');
  assert(/478 Elden Street/.test(page), 'the page does not carry the postal address');
  assert(/partners@streamnavigator\.ai/.test(page), 'the page offers no human fallback address');
});

// An opt-out that fails silently is worse than no button: the person believes
// they are unsubscribed and the next email proves otherwise.
test('a failed opt-out tells the person how to reach a human', () => {
  const catchBlock = page.slice(page.indexOf('.catch('));
  assert(/partners@streamnavigator\.ai/.test(catchBlock),
    'the error path does not offer the fallback address');
});

test('the page is not indexable', () => {
  assert(/name="robots"[^>]*noindex/.test(page), 'the unsubscribe page is missing noindex');
});

// ------------------------------------------------------------------- results

if (failures.length) {
  console.log(`\n${passed}/${passed + failures.length} passed\n`);
  for (const f of failures) console.log('  x ' + f);
  console.log('');
  process.exit(1);
}
console.log(`${passed}/${passed} passed`);
