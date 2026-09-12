'use strict';

// The document the landlord leaves with.
//
// The audit graded this product 0 of 5 on "enable action": nothing was made
// easy, there was no form, no link, no authority contact and no drafted
// anything, while Rental Navigator hands its customer letters to sign and send.
// A checklist that ends at "contact your housing office" is a research agenda
// wearing a report's clothes.
//
// So the findings are assembled into a printable action pack, per property, in
// the order the work should be done. Built here, deterministically, from the
// audit's own findings — it never passes through the model, for the same reason
// closing-emails.js and rental-emails.js do not: this is a document the
// customer acts on, and a writer that reworded it could soften a requirement
// into a suggestion.
//
// What it deliberately does NOT contain: any fee, any statutory deadline, any
// ordinance number, and no reproduction of a prescribed legal form. The lead
// section tells the landlord exactly which three things the federal disclosure
// requires and where to get the official versions, because handing someone a
// slightly-wrong copy of a form they will put in front of a tenant is the one
// way this product could do real damage. Naming the document and its source is
// the help; inventing its text is not.

const { Severity } = require('./landlord-audit');

const ACTIONABLE = [
  Severity.REQUIREMENT_UNMET,
  Severity.DEADLINE_NEAR,
  Severity.REQUIREMENT_LIKELY,
  Severity.VERIFY_LOCALLY,
  Severity.COVERAGE_GAP,
];

// Ordered by what a landlord should actually do first, which is not the same as
// severity: a date that is already running beats a standing obligation, because
// only one of the two gets worse while you decide.
const ORDER = {
  [Severity.DEADLINE_NEAR]: 0,
  [Severity.REQUIREMENT_UNMET]: 1,
  [Severity.REQUIREMENT_LIKELY]: 2,
  [Severity.COVERAGE_GAP]: 3,
  [Severity.VERIFY_LOCALLY]: 4,
};

function wrap(text, width = 76) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && (line + ' ' + word).length > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

function block(lines) {
  return lines.filter((l) => l !== null && l !== undefined).join('\n');
}

// The one place a lead-paint pack is warranted: a pre-1978 unit where the
// federal disclosure is unmet or unconfirmed. Driven off the finding rather
// than off the property, so it appears exactly when the audit flagged it.
function leadSection(findings) {
  const relevant = findings.filter((f) =>
    f.checkId === 'LEAD_DISCLOSURE_MISSING'
    || f.checkId === 'LEAD_CHILD_STATE_REGIME'
    || f.checkId === 'LEAD_CHILD_GENERAL');
  if (!relevant.length) return null;

  const withChild = relevant.some((f) => f.checkId !== 'LEAD_DISCLOSURE_MISSING');

  return block([
    'THE LEAD-PAINT PACKET',
    '',
    ...wrap('This is the highest-stakes item on your report and the cheapest to '
      + 'close. For any pre-1978 unit the federal disclosure has three parts, and '
      + 'all three have to happen before a lease is signed — including a renewal, '
      + 'which counts as a new lease for this purpose.'),
    '',
    '  1. Give the tenant the EPA-approved lead hazard information pamphlet.',
    '     Get the current official version from the EPA or HUD — do not retype it',
    '     or use a copy of unknown age.',
    '',
    '  2. Disclose, in writing, any known lead-based paint or hazards in the unit,',
    '     and hand over any records or reports you hold. "None known" is a valid',
    '     answer and still has to be written down.',
    '',
    '  3. Include the signed lead warning statement in the lease itself, signed by',
    '     the tenant. Use the official form language rather than your own wording.',
    '',
    ...wrap('Keep the signed disclosure for three years. It is the only thing that '
      + 'proves any of this happened, and it is the document that is missing in '
      + 'almost every case where a landlord has a problem here.'),
    '',
    withChild
      ? block([
        ...wrap('A child under six lives in one of these units, which is the situation '
          + 'several states write additional duties around — inspection, certification, '
          + 'or removal of hazards, over and above disclosure. Those duties commonly '
          + 'sit with the owner whether or not the owner knew about the paint, so this '
          + 'is the one item on your report worth taking to your state health '
          + 'department this week rather than at the next lease.'),
        '',
      ])
      : null,
    'Where to get the official documents: the EPA and HUD publish the pamphlet and',
    'the disclosure form free. Your state or city housing authority can tell you',
    'whether your state adds anything on top.',
  ]);
}

function propertySection(name, findings) {
  const actionable = findings
    .filter((f) => ACTIONABLE.includes(f.severity))
    .sort((a, b) => (ORDER[a.severity] ?? 9) - (ORDER[b.severity] ?? 9));

  if (!actionable.length) {
    return block([
      name.toUpperCase(),
      '-'.repeat(Math.min(name.length, 76)),
      ...wrap('Nothing outstanding on the checks that could run for this property. '
        + 'That is a result, not an absence of one.'),
    ]);
  }

  // The title wraps like everything else. A finding title is a full sentence
  // and several run past eighty characters, which on a phone or a printed page
  // is a line that simply disappears off the edge.
  const items = actionable.map((f, i) => block([
    ...wrap(`${i + 1}. ${f.title}`, 72).map((l, n) => (n === 0 ? `  ${l}` : `     ${l}`)),
    ...wrap(f.recommendedAction, 72).map((l) => `     ${l}`),
    ...(f.verifyWith ? wrap(`Who to ask: ${f.verifyWith}`, 72).map((l) => `     ${l}`) : []),
    f.confidence === 'check'
      ? '     Confirm this one applies to you before acting on it.'
      : null,
    '',
  ]));

  return block([
    name.toUpperCase(),
    '-'.repeat(Math.min(Math.max(name.length, 8), 76)),
    '',
    ...items,
  ]);
}

// Returns null when there is nothing worth printing, so the caller can leave
// the closing block off entirely rather than attach an empty document.
function buildLandlordPack(findings, { coverage } = {}) {
  const list = Array.isArray(findings) ? findings : [];
  if (!list.length) return null;

  const byProperty = new Map();
  const portfolio = [];
  for (const f of list) {
    if (!f.property) { portfolio.push(f); continue; }
    if (!byProperty.has(f.property)) byProperty.set(f.property, []);
    byProperty.get(f.property).push(f);
  }

  const sections = [];
  for (const [name, group] of byProperty) sections.push(propertySection(name, group));

  const lead = leadSection(list);
  if (lead) sections.push(lead);

  if (portfolio.length) {
    sections.push(block([
      'ACROSS YOUR PORTFOLIO',
      '-'.repeat(21),
      '',
      ...portfolio.flatMap((f) => [...wrap(f.recommendedAction, 76), '']),
    ]));
  }

  const uncovered = (coverage && coverage.uncovered) || [];
  if (uncovered.length) {
    sections.push(block([
      'WHAT WE COULD NOT LOOK UP',
      '-'.repeat(25),
      '',
      ...wrap(`We hold no registration reference for ${uncovered.join('; ')}. Everything `
        + 'else on this report still ran for those properties. One phone call to each '
        + 'local housing or code enforcement office closes the gap: "do I need to '
        + 'register or licence a residential rental here?"'),
    ]));
  }

  return block([
    ...sections.join('\n\n').split('\n'),
    '',
    '-'.repeat(76),
    ...wrap('This pack lists which requirements apply to the properties you entered '
      + 'and which office administers each one. It is information, not legal advice, '
      + 'and it deliberately contains no fee, no legal deadline and no ordinance '
      + 'number — confirm each item with the office named beside it before acting.'),
  ]);
}

module.exports = { buildLandlordPack, __internal: { leadSection, propertySection, wrap } };
