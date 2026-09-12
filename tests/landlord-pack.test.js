// The document the landlord leaves with.
//
// The audit graded this product 0 of 5 on enabling action: no form, no link, no
// authority contact, nothing drafted, while Rental Navigator hands its customer
// letters to sign. A checklist that ends at "contact your housing office" is a
// research agenda wearing a report's clothes.
//
// The pack is assembled from the findings deterministically and never passes
// through the model, for the reason closing-emails.js and rental-emails.js do
// not: a writer that reworded it could turn a requirement into a suggestion.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildLandlordPack } = require('../api/_lib/landlord-pack');
const { runLandlordAudit } = require('../api/_lib/landlord-audit');

const AS_OF = '2026-09-12';

function packFor(properties) {
  const audited = runLandlordAudit({ properties, asOf: AS_OF });
  return { audited, pack: buildLandlordPack(audited.findings, { coverage: audited.coverage }) };
}

const MESSY = [
  { label: 'Ashwood duplex', city: 'Cambridge', state: 'MA', year_built: 1908,
    child_under_six: 'yes', lead_disclosure_on_file: 'no', registered: 'no',
    deposit_held: 'commingled', lease_ends: '2026-11-20' },
  { label: 'Cedar St', city: 'Boise', state: 'ID', year_built: 1994, registered: 'yes' },
];

test('every property the landlord entered gets its own section', () => {
  const { pack } = packFor(MESSY);
  assert.match(pack, /ASHWOOD DUPLEX/);
  assert.match(pack, /CEDAR ST/);
});

test('the soonest date leads, ahead of a standing obligation', () => {
  // Not severity order. Only one of the two gets worse while you decide.
  const { pack } = packFor(MESSY);
  const section = pack.slice(pack.indexOf('ASHWOOD DUPLEX'), pack.indexOf('CEDAR ST'));
  assert.match(section.split('\n').find((l) => /^  1\./.test(l)) || '', /Lease ends in \d+ days/,
    'the dated item has to come first — it is the only one with a clock on it');
});

test('every action names the office to ask, and long names still wrap', () => {
  const { pack } = packFor(MESSY);
  assert.match(pack, /Who to ask:/);
  const tooWide = pack.split('\n').filter((l) => l.length > 82);
  assert.deepEqual(tooWide, [],
    `a pack is printed and read on a phone — these lines run off the page:\n  ${tooWide.join('\n  ')}`);
});

test('a confirm-first item says so, right where the landlord would act on it', () => {
  const { pack } = packFor(MESSY);
  assert.match(pack, /Confirm this one applies to you before acting on it\./);
});

test('the lead packet appears when a pre-1978 disclosure is open, and not otherwise', () => {
  const { pack } = packFor(MESSY);
  assert.match(pack, /THE LEAD-PAINT PACKET/);
  assert.match(pack, /three parts/, 'naming the three parts is the whole value of the section');
  assert.match(pack, /three years/, 'the retention rule is the part everyone misses');

  const modern = packFor([{ label: 'New build', city: 'Denver', state: 'CO', year_built: 2015, registered: 'yes' }]);
  assert.equal(/THE LEAD-PAINT PACKET/.test(modern.pack || ''), false,
    'a post-1978 portfolio must not be handed a lead packet it has no use for');
});

test('the child-under-six case escalates the lead packet rather than repeating it', () => {
  const { pack } = packFor(MESSY);
  const lead = pack.slice(pack.indexOf('THE LEAD-PAINT PACKET'));
  const flat = lead.replace(/\s+/g, ' ');
  assert.match(flat, /child under six/i);
  assert.match(flat, /this week/, 'it is the one item worth acting on before the next lease');
});

test('the pack reproduces no legal form text, no fee and no citation', () => {
  // Handing someone a slightly-wrong copy of a form they will put in front of a
  // tenant is the one way this product could do real damage. Naming the
  // document and its source is the help; inventing its wording is not.
  const { pack } = packFor(MESSY);
  assert.equal(/\$\s?\d/.test(pack), false, 'a dollar figure leaked into the pack');
  assert.equal(/§|\b(?:ordinance|statute|code section)\s+[\d.-]+/i.test(pack), false, 'a citation leaked in');
  assert.equal(/LEAD WARNING STATEMENT[\s\S]{0,40}(?:Housing built before|is hereby)/i.test(pack), false,
    'the pack is reproducing prescribed form language instead of pointing at the official copy');
  assert.match(pack, /official/i, 'it has to tell them to use the official version');
});

test('an uncovered jurisdiction is named, with the one question that closes it', () => {
  const { pack } = packFor(MESSY);
  const flat = pack.replace(/\s+/g, ' ');
  assert.match(flat, /WHAT WE COULD NOT LOOK UP/);
  assert.match(flat, /Boise, ID/);
  assert.match(flat, /register or licence a residential rental here/);
});

test('a clean property is told so rather than left out', () => {
  const { pack } = packFor([
    { label: 'Clean House', city: 'Austin', state: 'TX', year_built: 2005, registered: 'no', deposit_held: 'separate' },
  ]);
  assert.match(pack, /CLEAN HOUSE/);
  // Whitespace-tolerant: the pack hard-wraps at 76 columns, so any phrase in it
  // can be split across a line break.
  assert.match(pack.replace(/\s+/g, ' '), /That is a result, not an absence of one/);
});

test('the pack carries its own scope disclaimer', () => {
  const { pack } = packFor(MESSY);
  assert.match(pack, /not legal advice/i);
  assert.match(pack, /no fee, no legal deadline and no ordinance/i,
    'the pack should say what it deliberately leaves out, so a gap reads as a choice');
});

test('no findings produces no document at all', () => {
  assert.equal(buildLandlordPack([], {}), null,
    'an empty pack attached to a report is worse than no pack');
  assert.equal(buildLandlordPack(null, {}), null);
});

// --- wiring ------------------------------------------------------------------

test('the engine attaches the pack itself, without the model touching it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', '_lib', 'navigator-engine.js'), 'utf8');
  const attachAt = src.indexOf('report.closing_body = landlordPack');
  const generateAt = src.indexOf('https://api.anthropic.com/v1/messages');
  assert.ok(attachAt !== -1, 'the pack is built and never attached');
  assert.ok(attachAt > generateAt,
    'attaching before generation would put the pack through the writer, which is exactly '
    + 'what the letters in closing-emails.js and rental-emails.js avoid');
  assert.ok(/report\.closing_title = 'Your action pack/.test(src),
    'the closing block needs a title or the renderer shows an untitled slab of text');
});
