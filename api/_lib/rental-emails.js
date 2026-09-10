'use strict';

// Drafts the letters a landlord sends after reading their audit: one to the
// loan servicer, one to the property manager, one to the insurance agent.
//
// The routing is already decided. Every finding produced by rental-audit.js
// carries askServicer, askManager or askInsurer, set by the check that found
// it. This module renders what the audit decided; it does not decide anything,
// and no model touches these words. A letter the customer signs their own name
// to and sends to a company they still have to work with is not a place for
// generated prose.
//
// Three rules, none of them stylistic:
//
// 1. The customer sends these. So they are in the customer's voice, and they
//    ask rather than allege. "Could you confirm" survives being wrong; "you
//    overcharged me" does not, and these are relationships the landlord has to
//    keep — a manager who collects their rent, a servicer who holds their loan.
// 2. Never assert wrongdoing. A finding is a discrepancy between a document and
//    a rule or its own arithmetic. It is not a determination that anyone acted
//    improperly.
// 3. Say what a figure rests on. A number proved from the customer's own
//    paperwork is stated plainly; a comparison against what is typical is
//    framed as a question, because it is one.

const RECIPIENT = { SERVICER: 'servicer', MANAGER: 'manager', INSURER: 'insurer' };

const ROUTE_FLAG = {
  [RECIPIENT.SERVICER]: 'askServicer',
  [RECIPIENT.MANAGER]: 'askManager',
  [RECIPIENT.INSURER]: 'askInsurer',
};

const HEADING = {
  [RECIPIENT.SERVICER]: 'LOAN SERVICER',
  [RECIPIENT.MANAGER]: 'PROPERTY MANAGER',
  [RECIPIENT.INSURER]: 'INSURANCE AGENT',
};

const OPENER = {
  [RECIPIENT.SERVICER]: 'I have been going through my loan statement and there '
    + 'are one or two things I would like to sort out.',
  [RECIPIENT.MANAGER]: 'I have been going through the statement for the period '
    + 'and there are a couple of things I could use your help squaring up.',
  [RECIPIENT.INSURER]: 'I am reviewing the policy ahead of renewal and there are '
    + 'a couple of things I would like to look at with you.',
};

const CLOSER = {
  [RECIPIENT.SERVICER]: 'Could you let me know what you need from me to move this along? '
    + 'Happy to put anything in writing in whatever form you need it.',
  [RECIPIENT.MANAGER]: 'It is entirely possible I am reading something wrong, so if there '
    + 'is a straightforward explanation I would rather hear it than keep guessing. Thanks for taking a look.',
  [RECIPIENT.INSURER]: 'No rush on this — I would just like to have the numbers in front '
    + 'of me before the renewal date. Thank you.',
};

function hasText(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function money(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return '$' + Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: Math.abs(n) % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

// A finding that needs another document from the customer is a task for the
// customer, not a question for anyone else.
function isSendable(finding) {
  return finding && finding.actionability !== 'requires_additional_documentation';
}

function forRecipient(findings, who) {
  const flag = ROUTE_FLAG[who];
  return (findings || []).filter((f) => isSendable(f) && f[flag] === true);
}

function renderItem(finding, index) {
  const lines = [`${index + 1}. ${finding.title || 'Item to confirm'}`];

  const charged = money(finding.charged);
  const expected = money(finding.expected);
  const impact = money(finding.dollarImpact);

  if (charged && expected && charged !== expected) {
    lines.push(`   The statement shows ${charged}; the figure I get is ${expected}`
      + (impact ? ` — a difference of ${impact}.` : '.'));
  } else if (impact) {
    lines.push(`   This comes to about ${impact} a year.`);
  }

  if (hasText(finding.basis)) {
    // The basis is written in the third person and addressed to nobody in
    // particular, which is what lets it be put in front of the recipient
    // unchanged. First sentence only — the letter is an opening, not the report.
    const firstSentence = finding.basis.trim().split(/(?<=\.)\s+/)[0];
    if (firstSentence && firstSentence.length < 260) lines.push(`   ${firstSentence}`);
  }

  return lines.join('\n');
}

function buildSubject(who, findings, ctx) {
  const address = hasText(ctx.propertyAddress) ? ` — ${ctx.propertyAddress}` : '';
  if (who === RECIPIENT.SERVICER) {
    const pmi = findings.find((f) => f.checkId === 'PMI_STILL_CHARGED');
    if (pmi) return `Request to cancel mortgage insurance${address}`;
    return `Question about my escrow account${address}`;
  }
  if (who === RECIPIENT.MANAGER) {
    return `Couple of questions on the statement${address}`;
  }
  return `Policy review before renewal${address}`;
}

function draft(who, findings, ctx) {
  const mine = forRecipient(findings, who);
  if (!mine.length) return null;

  const body = [];
  body.push('Hello,');
  body.push('');
  body.push(OPENER[who]);
  body.push('');
  mine.forEach((finding, i) => {
    body.push(renderItem(finding, i));
    body.push('');
  });
  body.push(CLOSER[who]);
  body.push('');
  body.push('Thanks,');
  body.push(hasText(ctx.ownerName) ? ctx.ownerName : '[your name]');
  if (hasText(ctx.propertyAddress)) body.push(ctx.propertyAddress);

  return {
    to: hasText(ctx[`${who}Name`]) ? ctx[`${who}Name`] : null,
    subject: buildSubject(who, mine, ctx),
    body: body.join('\n').trim(),
    findingCount: mine.length,
  };
}

// Returns { servicer, manager, insurer }, any of which may be null. A null is
// not a failure. A property with nothing to ask a servicer about should produce
// no servicer letter, and inventing one spends the landlord's credibility with
// a company they will be dealing with for the next twenty years.
function buildRentalEmails(findings, context) {
  const ctx = context || {};
  return {
    servicer: draft(RECIPIENT.SERVICER, findings, ctx),
    manager: draft(RECIPIENT.MANAGER, findings, ctx),
    insurer: draft(RECIPIENT.INSURER, findings, ctx),
  };
}

// The plain text navigator-status.html shows in its closing block, so the page
// and the emailed PDF carry the same words.
function renderRentalLetters(emails) {
  const blocks = [];
  for (const key of [RECIPIENT.SERVICER, RECIPIENT.MANAGER, RECIPIENT.INSURER]) {
    const email = emails && emails[key];
    if (!email || !email.body) continue;
    const heading = `EMAIL TO ${HEADING[key]}${email.to ? ` (${email.to})` : ''}`;
    blocks.push(`${heading}\n\nSubject: ${email.subject}\n\n${email.body}`.trim());
  }
  return blocks.join('\n\n---\n\n');
}

module.exports = {
  buildRentalEmails,
  renderRentalLetters,
  RECIPIENT,
  _internal: { forRecipient, renderItem, buildSubject, money },
};
