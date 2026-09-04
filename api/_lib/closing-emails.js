'use strict';

// Drafts the two emails a customer sends after reading their audit: one to the
// lender, one to the settlement agent.
//
// The routing already exists. Every finding produced by closing-audit.js carries
// askLender and askSettlement booleans, set by the check that produced it. This
// module does not decide who should hear about a finding — it only renders what
// the audit already decided.
//
// Three rules govern the wording, and they are not stylistic:
//
// 1. The customer sends these, not us. So they are written in the customer's
//    voice, and they ask rather than allege. "Could you confirm" survives being
//    wrong; "you overcharged me" does not.
// 2. Never assert wrongdoing. A finding is a discrepancy between the document
//    and a rule or its own arithmetic. It is not a determination that anyone
//    acted improperly, and the email must not read as one.
// 3. A finding built on something the customer typed is not independently
//    confirmed. closing-audit.js flags these with basedOnCustomerInput; the
//    email must say so rather than presenting them as read from the document.

const RECIPIENT = { LENDER: 'lender', SETTLEMENT: 'settlement' };

// Actionability values from closing-audit.js. A post-closing remedy needs a
// different ask from something still changeable, and needing another document
// is a request to the customer, not to the recipient — those are dropped.
const ACTIONABILITY = {
  CHANGEABLE: 'still_changeable_before_closing',
  LOCKED: 'likely_locked_informational',
  POST_CLOSING: 'potential_post_closing_remedy',
  NEEDS_DOCS: 'requires_additional_documentation',
};

function hasText(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function money(cents) {
  if (cents === null || cents === undefined) return null;
  const n = typeof cents === 'number' ? cents : Number(cents);
  if (!isFinite(n)) return null;
  return '$' + Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Findings that need another document from the customer are not a question for
// anyone else, so they never reach an email.
function isSendable(f) {
  return f && f.actionability !== ACTIONABILITY.NEEDS_DOCS;
}

function forRecipient(findings, who) {
  const flag = who === RECIPIENT.LENDER ? 'askLender' : 'askSettlement';
  return (findings || []).filter((f) => isSendable(f) && f[flag] === true);
}

// One numbered item per finding. Order is whatever the audit produced, which is
// severity order — the customer should lead with the strongest point.
function renderItem(f, index) {
  const lines = [];
  lines.push(String(index + 1) + '. ' + (f.title || 'Item to confirm'));

  const charged = money(f.charged);
  const expected = money(f.expected);
  const variance = money(f.variance != null ? f.variance : f.dollarImpact);

  if (charged && expected) {
    lines.push('   Charged ' + charged + '; the figure I get is ' + expected +
      (variance ? ' — a difference of ' + variance + '.' : '.'));
  } else if (variance) {
    lines.push('   This affects about ' + variance + '.');
  }

  if (hasText(f.basis)) lines.push('   ' + f.basis.trim());

  // whyItMatters explains the stake to the customer. It is useful context for
  // the recipient too, but only when it is not restating the basis.
  if (hasText(f.whyItMatters) && f.whyItMatters.trim() !== (f.basis || '').trim()) {
    lines.push('   ' + f.whyItMatters.trim());
  }

  if (hasText(f.recommendedAction)) lines.push('   ' + f.recommendedAction.trim());

  if (f.basedOnCustomerInput) {
    lines.push('   (I supplied one of the figures behind this myself, so please ' +
      'correct me if I have it wrong.)');
  }

  if (f.actionability === ACTIONABILITY.POST_CLOSING) {
    lines.push('   If this is right, I understand it may be something to settle ' +
      'after closing rather than before.');
  }

  return lines.join('\n');
}

function loanLine(ctx) {
  const bits = [];
  if (hasText(ctx.loanId)) bits.push('loan ' + ctx.loanId.trim());
  if (hasText(ctx.propertyAddress)) bits.push(ctx.propertyAddress.trim());
  if (hasText(ctx.closingDate)) bits.push('closing ' + ctx.closingDate.trim());
  return bits.length ? bits.join(', ') : null;
}

function greeting(name) {
  return hasText(name) ? 'Hello ' + name.trim() + ',' : 'Hello,';
}

function buildBody(who, items, ctx) {
  const ref = loanLine(ctx);
  const out = [];

  out.push(greeting(who === RECIPIENT.LENDER ? ctx.lenderContact : ctx.settlementContact));
  out.push('');

  const subjectOfReview = who === RECIPIENT.LENDER
    ? 'I have been going through my Closing Disclosure'
    : 'I have been going through the Closing Disclosure for my settlement';

  out.push(subjectOfReview + (ref ? ' (' + ref + ')' : '') +
    ' and there ' + (items.length === 1 ? 'is one item' : 'are ' + items.length + ' items') +
    ' I would like to understand before we go further. I may well be reading ' +
    'something wrong, so I would appreciate your help squaring ' +
    (items.length === 1 ? 'it' : 'these') + ' up.');
  out.push('');

  items.forEach((f, i) => {
    out.push(renderItem(f, i));
    out.push('');
  });

  const anyChangeable = items.some((f) => f.actionability === ACTIONABILITY.CHANGEABLE);
  out.push(anyChangeable
    ? (items.length === 1 ? 'If this needs correcting' : 'If any of these need correcting') +
      ', could you send a revised Closing Disclosure ' +
      'before we close? And if ' + (items.length === 1 ? 'it is' : 'they are all') +
      ' correct as issued, a short explanation is enough — I would just like to ' +
      'understand the figures before I sign.'
    : (items.length === 1 ? 'A short explanation is enough' : 'A short explanation of each is enough') +
      ' — I would just like to understand the figures before I sign.');
  out.push('');
  out.push('Thank you,');
  out.push(hasText(ctx.borrowerName) ? ctx.borrowerName.trim() : '');

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function buildSubject(who, items, ctx) {
  const ref = hasText(ctx.loanId) ? ' — loan ' + ctx.loanId.trim()
    : hasText(ctx.propertyAddress) ? ' — ' + ctx.propertyAddress.trim()
    : '';
  const noun = items.length === 1 ? 'a question' : items.length + ' questions';
  return (who === RECIPIENT.LENDER
    ? 'Closing Disclosure: ' + noun + ' before signing'
    : 'Settlement statement: ' + noun + ' before closing') + ref;
}

function draft(who, findings, ctx) {
  const items = forRecipient(findings, who);
  if (items.length === 0) return null;
  return {
    recipient: who,
    to: who === RECIPIENT.LENDER ? (ctx.lenderName || null) : (ctx.settlementName || null),
    subject: buildSubject(who, items, ctx),
    body: buildBody(who, items, ctx),
    findingCount: items.length,
    checkIds: items.map((f) => f.checkId).filter(Boolean),
  };
}

// Returns { lender, settlement }, either of which may be null when no finding
// was routed there. A null is not a failure — a clean document should produce
// no emails, and inventing one would waste the customer's credibility with a
// party they have to keep working with.
function buildEmails(findings, context) {
  const ctx = context || {};
  return {
    lender: draft(RECIPIENT.LENDER, findings, ctx),
    settlement: draft(RECIPIENT.SETTLEMENT, findings, ctx),
  };
}

module.exports = {
  buildEmails,
  RECIPIENT,
  ACTIONABILITY,
  // exported for tests
  _internal: { forRecipient, renderItem, buildSubject, money },
};
