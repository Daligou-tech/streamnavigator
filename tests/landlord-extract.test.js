// Reading a registration certificate the landlord uploaded.
//
// One date on that document drives two things: the renewal check and the
// reminder that fires 45 days before it. A landlord who leaves the field blank
// loses both, and the date is usually printed on the licence already sitting in
// their upload.
//
// The rule the whole module is built on: an invented or misapplied expiry is
// worse than none, because it drives a reminder the landlord will act on. So it
// only ever fills a blank, never overrides a typed answer, and refuses any date
// it cannot sanity-check.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyLicences, __internal: I } = require('../api/_lib/landlord-extract');

const iso = (years) => new Date(Date.now() + years * 365.25 * 86400000).toISOString().slice(0, 10);

// --- which dates are allowed through ----------------------------------------

test('a plausible printed date is accepted', () => {
  assert.equal(I.usableDate(iso(1)), iso(1));
});

test('a malformed or partial date is refused outright', () => {
  for (const bad of ['next March', '2027', '03/2027', '', null, undefined, '2027-13-45']) {
    assert.equal(I.usableDate(bad), null, `should refuse: ${JSON.stringify(bad)}`);
  }
});

test('a date far outside a plausible term is treated as a misread', () => {
  assert.equal(I.usableDate(iso(30)), null, 'a thirty-year registration is an OCR error, not a term');
  assert.equal(I.usableDate(iso(-8)), null, 'an eight-year-lapsed licence drives no useful reminder');
  assert.ok(I.usableDate(iso(-1)), 'recently lapsed is still a real, useful fact');
});

// --- what it is allowed to change -------------------------------------------

test('a date the landlord typed is never overwritten', () => {
  const before = [{ label: 'Cedar St', city: 'Kansas City', state: 'MO', registration_expires: '2027-01-01' }];
  const { properties, filled } = applyLicences(before, [
    { property_hint: 'Cedar St', city: 'Kansas City', state: 'MO', expires_on: iso(2) },
  ]);
  assert.equal(properties[0].registration_expires, '2027-01-01',
    'the date they typed is the one they will recognise in a reminder, and the document may be an old copy');
  assert.deepEqual(filled, []);
});

test('a blank date is filled, and recorded as having come from a document', () => {
  const { properties, filled } = applyLicences(
    [{ label: 'Cedar St', city: 'Kansas City', state: 'MO' }],
    [{ property_hint: '1412 Cedar Street', city: 'Kansas City', state: 'MO', expires_on: iso(1), licence_number: 'KC-88213' }]
  );
  assert.equal(properties[0].registration_expires, iso(1));
  assert.equal(properties[0].registration_expires_source, 'document',
    'the report has to be able to say the customer did not give us this date');
  assert.equal(properties[0].licence_number, 'KC-88213');
  assert.equal(filled.length, 1);
});

test('holding a licence implies registered, but only where that was left blank too', () => {
  // A realistic label. matchProperty deliberately ignores candidates shorter
  // than three characters — a one-letter name matches half the documents in a
  // portfolio, and a wrong match here fills one property's date from another
  // property's licence.
  const filledIn = applyLicences([{ label: 'Pearl St', city: 'Denver', state: 'CO' }],
    [{ property_hint: 'Pearl St', state: 'CO', expires_on: iso(1) }]).properties[0];
  assert.equal(filledIn.registered, 'yes');

  const said = applyLicences([{ label: 'Pearl St', city: 'Denver', state: 'CO', registered: 'no' }],
    [{ property_hint: 'Pearl St', state: 'CO', expires_on: iso(1) }]).properties[0];
  assert.equal(said.registered, 'no', 'their own answer stands even against a document');
});

test('the input is never mutated', () => {
  const before = [{ label: 'Cedar St', city: 'Kansas City', state: 'MO' }];
  applyLicences(before, [{ property_hint: 'Cedar St', state: 'MO', expires_on: iso(1) }]);
  assert.equal(before[0].registration_expires, undefined);
});

// --- matching the document to the right property ----------------------------

test('a certificate matches the property it names, in either direction', () => {
  const props = [{ label: 'Cedar St', city: 'Kansas City', state: 'MO' }, { label: 'Ashwood', city: 'Cambridge', state: 'MA' }];
  assert.equal(I.matchProperty({ property_hint: '1412 Cedar Street, Kansas City', state: 'MO' }, props), 0);
  assert.equal(I.matchProperty({ property_hint: 'Ashwood', state: 'MA' }, props), 1);
});

test('a certificate from the wrong state matches nothing', () => {
  const props = [{ label: 'Cedar St', city: 'Kansas City', state: 'MO' }];
  assert.equal(I.matchProperty({ property_hint: 'Cedar St', state: 'WA' }, props), -1,
    'filling one property\'s date from another property\'s licence is the worst thing this could do');
});

test('an unmatched certificate changes nothing rather than guessing', () => {
  const { properties, filled } = applyLicences(
    [{ label: 'Cedar St', city: 'Kansas City', state: 'MO' }],
    [{ property_hint: 'Some Other Building', state: 'MO', expires_on: iso(1) }]
  );
  assert.equal(properties[0].registration_expires, undefined);
  assert.deepEqual(filled, []);
});

test('an empty or nonsense extraction is a no-op', () => {
  const before = [{ label: 'A', city: 'Denver', state: 'CO' }];
  for (const licences of [[], null, undefined, [{}], [{ property_hint: 'A' }]]) {
    const { properties, filled } = applyLicences(before, licences);
    assert.equal(properties[0].registration_expires, undefined);
    assert.deepEqual(filled, []);
  }
});

// --- the schema tells the model the one thing that matters ------------------

test('the extraction schema forbids inferring a date', () => {
  const expires = I.EXTRACT_TOOL.input_schema.properties.licences.items.properties.expires_on;
  assert.match(expires.description, /never infer/i,
    'an expiry guessed from an issue date drives a reminder on a date that does not exist');
  assert.match(expires.description, /YYYY-MM-DD/);
});

// --- the engine uses it safely ----------------------------------------------

test('extraction failure costs the date, never the report', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', '_lib', 'navigator-engine.js'), 'utf8');
  const branch = src.slice(src.indexOf('extractLandlordLicences('), src.indexOf('const audited = runLandlordAudit'));
  assert.ok(/catch \(err\)/.test(branch), 'an unreadable licence would take down a paid report');
  assert.equal(/throw/.test(branch), false, 'nothing in this branch may rethrow');
});

test('a document-sourced date is disclosed to the writer as not the customer’s own', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', '_lib', 'navigator-engine.js'), 'utf8');
  assert.ok(/DATES READ OFF AN UPLOADED LICENCE/.test(src),
    'presenting a date we read off a document as the answer they gave us is exactly the kind of '
    + 'small dishonesty this whole audit was about');
});
