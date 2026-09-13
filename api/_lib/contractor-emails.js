'use strict';

// Drafts the email the homeowner sends to each contractor.
//
// No model touches these words, for the same reason no model touches the
// letters in api/_lib/rental-emails.js: the customer signs their own name to
// this and sends it to someone who is about to be standing on their roof. A
// sentence that overstates a finding is not a copy problem, it is the customer
// losing an argument they were winning.
//
// Three rules, none of them stylistic.
//
// 1. Ask, do not allege. Every finding here is a discrepancy between a document
//    and either its own arithmetic or a written rule. It is not a determination
//    that anyone did anything dishonest, and the overwhelmingly likely
//    explanation for most of them is a template nobody has revised since 2019.
//    "Could you confirm" survives being wrong. "You overcharged me" does not.
//
// 2. Say what each point rests on. A figure proved on the contractor's own
//    paperwork is stated flatly, with the numbers, because it is not arguable.
//    A comparison against a published national range is asked as a question,
//    because a national range is not a quote for this house and the contractor
//    may well have a good answer.
//
// 3. One email per quote, and only where that quote has something to ask. A
//    homeowner with two bids does not want one letter addressed to nobody, and
//    sending a list of concerns to the contractor who wrote a clean estimate
//    spends credibility for nothing.

const { Severity, Actionability, EvidenceKind } = require('./contractor-audit');

// How each finding opens, in the homeowner's voice. Keyed by check, because the
// right opening for "your line items do not add up" is not the right opening
// for "your price expires tonight". A check with no entry here falls back to a
// neutral lead-in rather than being dropped — a missing phrase must never cost
// the customer a point they should have raised.
const LEAD_IN = {
  LINE_ITEMS_FOOT: 'The line items and the total do not match. Could you tell me which is right?',
  LINE_EXTENSIONS_CORRECT: 'One of the lines does not multiply out. Could you check it?',
  TOTAL_RECONCILES: 'The subtotal and the bottom line do not reconcile. Could you check it?',
  TAX_MATCHES_RATE: 'The tax charged is more than the rate on the estimate produces. Could you check it?',
  DEPOSIT_PERCENT_MATCHES: 'The deposit is described as a percentage that does not match the amount asked for.',
  PAYMENT_SCHEDULE_SUMS: 'The payments in the schedule do not add up to the contract price.',
  DEPOSIT_WITHIN_STATE_CAP: 'I think the deposit is above the limit my state sets for this kind of contract. '
    + 'Could we bring it to the cap?',
  DEPOSIT_AGAINST_NORM: 'The deposit is a large share of the job up front. Could we tie more of it to work completed?',
  PAYMENT_NOT_FRONT_LOADED: 'Could we restructure the payments so they follow milestones I can see?',
  LICENCE_NUMBER_PRESENT: 'Could you send me your licence number so I can look it up?',
  COMPLETION_DATE_STATED: 'Could we add approximate start and completion dates to the contract?',
  PERMIT_RESPONSIBILITY_NAMED: 'Could you confirm in writing that you pull the permit and that the price includes '
    + 'the fee and the inspection?',
  CHANGE_ORDERS_REQUIRE_WRITING: 'Could we add a line saying no extra work is charged without my written approval '
    + 'in advance?',
  WARRANTY_SPLIT_STATED: 'Could you put the warranty in writing, in years, for labour and for materials separately?',
  LIEN_WAIVER_ADDRESSED: 'Could we say in the contract that each payment is made against a signed lien waiver?',
  INSURANCE_EVIDENCE: 'Could you have your insurer send me a certificate of insurance directly, with me as '
    + 'certificate holder?',
  SCOPE_IS_PRICED: 'Could you send the same quote broken into line items — equipment, labour, materials, permit, '
    + 'disposal?',
  ALLOWANCES_IDENTIFIED: 'Could we replace the allowance lines with firm prices, or agree now how any overage '
    + 'is priced?',
  EXCLUSIONS_LISTED: 'Could you tell me what is NOT in this price, in writing?',
  RIGHT_TO_CANCEL_NOTICE: 'I understood this was quoted at my home, and I do not see the three-day cancellation '
    + 'notice on the paperwork. Could you send it?',
  PRICE_AGAINST_PUBLISHED_RANGE: 'This works out above the published national ranges I can find. What is it about '
    + 'this job that puts it there?',
  QUOTES_ARE_APPLES_TO_APPLES: 'I have another bid on this work and the two differ on a few things. Could you '
    + 'requote matching the specification below, so I am comparing like with like?',
  TAX_CREDIT_CLAIMS_STILL_VALID: 'The estimate mentions a federal tax credit. My understanding is that the Energy '
    + 'Efficient Home Improvement Credit ended for work placed in service after 31 December 2025. Could you confirm, '
    + 'and let me know the price without it?',
  NO_DEADLINE_PRESSURE: 'I am getting one more quote before I decide. Does this price hold?',
  FINANCING_COST_DISCLOSED: 'Could you tell me the APR and term on the financing, and what the cash price is '
    + 'without it?',
  HVAC_SYSTEM_IS_MATCHED: 'The quote replaces the outdoor unit but leaves the indoor coil. Will the manufacturer '
    + 'warranty the compressor on that pairing, and what efficiency does the pair actually reach?',
  HVAC_MEETS_FEDERAL_EFFICIENCY: 'Could you confirm the model number and its SEER2 rating? The figure on the quote '
    + 'looks below the federal minimum for my region.',
  HVAC_REFRIGERANT_GENERATION: 'The quote specifies R-410A. What does the same job cost with an R-454B or R-32 '
    + 'system, and is there a discount for taking the outgoing stock?',
  HVAC_SIZED_TO_THE_HOUSE: 'Could you send me the load calculation the system size came from?',
  HVAC_LOAD_CALCULATION: 'Was a Manual J load calculation run for this? Could you send me the printout?',
  HVAC_LINE_SET_ADDRESSED: 'Is the refrigerant line set being replaced, flushed, or reused as is — and what does '
    + 'that cost? I would rather have it in the estimate than find out on the day.',
  ROOF_TEAR_OFF_OR_OVERLAY: 'Could you confirm whether this is a full tear-off or an overlay, and how many layers '
    + 'are coming off?',
  ROOF_DETAILS_SPECIFIED: 'Could you write the underlayment, drip edge, flashing, ventilation and ice barrier into '
    + 'the scope by name and material?',
  ROOF_DECKING_TERMS: 'Could we agree a per-sheet price for decking replacement now, with photographs of anything '
    + 'you replace?',
  WINDOW_INSTALL_METHOD: 'Could you confirm whether these are inserts or full-frame replacements?',
  WINDOW_FINISHING_INCLUDED: 'Could you confirm that interior trim and exterior capping are in the price, and who '
    + 'paints?',
  DISPOSAL_INCLUDED: 'Could you confirm that removal, disposal and any dumpster are included in the price?',
};

const NEUTRAL_LEAD_IN = 'Could you help me with this one?';

function hasText(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// The first sentence of the basis, which is where the audit puts the figures.
// The email is an opening, not the report — the contractor gets the number and
// the question, and the homeowner keeps the rest in front of them.
function firstSentence(text) {
  if (!hasText(text)) return null;
  const s = text.trim().split(/(?<=\.)\s+/)[0];
  return s && s.length < 300 ? s : null;
}

// What belongs in an email at all.
//
// Findings that only the homeowner can act on — look your contractor's licence
// up, decide whether you want an overlay — are not asks, and a letter padded
// with them reads as a form letter and gets treated as one. What goes in is
// what the contractor can answer, change, or put in writing.
const SENDABLE_SEVERITIES = new Set([
  Severity.CONFIRMED_ERROR,
  Severity.EXCEEDS_LEGAL_LIMIT,
  Severity.MISSING_PROTECTION,
  Severity.OUTSIDE_PUBLISHED_RANGE,
  Severity.CHANGE_ORDER_RISK,
  Severity.SALES_PRESSURE,
]);

// Checks whose findings never belong in a letter, whatever their severity.
//
// QUOTES_COMPARED is the spread between the homeowner's own bids. It belongs to
// no single contractor, and forwarding a rival's number is the one move that
// reliably ends a negotiation badly — it invites a price match on an unequal
// scope instead of a requote on an equal one, which is what the apples-to-apples
// finding asks for and why that one IS sent.
//
// Exported because tests/contractor-emails.test.js asserts that every other
// check has a sentence written for it. A check that falls through to the
// generic lead-in still gets raised, which is the right failure — but it gets
// raised vaguely, and the gap should be caught here rather than in someone's
// inbox.
const NOT_SENT_BY_DESIGN = new Set(['QUOTES_COMPARED']);

function sendable(finding, quoteLabel) {
  if (!finding) return false;
  if (NOT_SENT_BY_DESIGN.has(finding.checkId)) return false;
  if (!SENDABLE_SEVERITIES.has(finding.severity)) return false;
  // The licence finding is an ask only when the number is missing. When it is
  // printed, the action is the homeowner's own lookup.
  if (finding.checkId === 'LICENCE_NUMBER_PRESENT' && finding.severity !== Severity.MISSING_PROTECTION) return false;
  if (quoteLabel && finding.quote && finding.quote !== quoteLabel) return false;
  return true;
}

// Which findings may quote their own evidence into the letter.
//
// An allowlist rather than a denylist, because the failure it prevents is a
// voice leak and a voice leak is silent. The audit's `basis` is written to the
// homeowner — "you told us this was quoted at your home", "if your contractor
// does not pay their supplier" — and pasted unedited into an email addressed to
// that contractor it reads as though somebody else wrote the letter. Which
// somebody else did, and the whole point is that it should not show.
//
// So only the findings whose basis is a statement about the document or its
// numbers are quoted. Everything else sends the question alone, which is all
// the contractor needs: they are holding the estimate.
const QUOTE_EVIDENCE = new Set([
  'LINE_ITEMS_FOOT', 'LINE_EXTENSIONS_CORRECT', 'TOTAL_RECONCILES', 'TAX_MATCHES_RATE',
  'DEPOSIT_PERCENT_MATCHES', 'PAYMENT_SCHEDULE_SUMS', 'DEPOSIT_WITHIN_STATE_CAP', 'DEPOSIT_AGAINST_NORM',
  'LICENCE_NUMBER_PRESENT', 'COMPLETION_DATE_STATED', 'PERMIT_RESPONSIBILITY_NAMED', 'WARRANTY_SPLIT_STATED',
  'INSURANCE_EVIDENCE', 'SCOPE_IS_PRICED', 'ALLOWANCES_IDENTIFIED', 'EXCLUSIONS_LISTED',
  'PRICE_AGAINST_PUBLISHED_RANGE', 'TAX_CREDIT_CLAIMS_STILL_VALID', 'NO_DEADLINE_PRESSURE',
  'FINANCING_COST_DISCLOSED', 'HVAC_MEETS_FEDERAL_EFFICIENCY', 'HVAC_SIZED_TO_THE_HOUSE',
  'HVAC_LOAD_CALCULATION', 'ROOF_TEAR_OFF_OR_OVERLAY', 'ROOF_DETAILS_SPECIFIED', 'WINDOW_INSTALL_METHOD',
  'WINDOW_FINISHING_INCLUDED',
]);

// How many points one email may carry.
//
// Twenty-one is not a negotiation, it is an indictment, and a contractor who
// opens it stops reading at four and answers none. The audit still found all
// twenty-one and the report still lists all twenty-one — what this cap decides
// is how many the homeowner leads with, and the ranking already put the
// arithmetic and the statutes at the top. The rest are one reply away.
const MAX_POINTS = 10;

// The letter orders its points differently from the report, on purpose.
//
// The report ranks by how firmly a finding is proved, which is the right order
// for someone deciding what to believe. A letter is read by someone deciding
// what to answer, and there the order is what costs them money: the arithmetic
// they will simply concede, then the statute, then the price, then the claims
// that were made to close the sale, then the scope gaps.
//
// Pressure tactics sit above change-order risk here and below it in the report,
// and both are right. A tax credit that ended in 2025 is weaker evidence than a
// missing line-set price and a far better question to ask first.
const EMAIL_ORDER = [
  Severity.CONFIRMED_ERROR,
  Severity.EXCEEDS_LEGAL_LIMIT,
  Severity.OUTSIDE_PUBLISHED_RANGE,
  Severity.SALES_PRESSURE,
  Severity.CHANGE_ORDER_RISK,
  Severity.QUOTE_SPREAD,
];

function emailRank(finding) {
  const i = EMAIL_ORDER.indexOf(finding.severity);
  return i === -1 ? EMAIL_ORDER.length : i;
}

// Ordered the way the homeowner should raise them: the things that are simply
// wrong on the page first, because those get conceded rather than argued, and
// the judgement calls last.
function renderItem(finding, index) {
  const lead = LEAD_IN[finding.checkId] || NEUTRAL_LEAD_IN;
  const lines = [`${index + 1}. ${lead}`];

  if (QUOTE_EVIDENCE.has(finding.checkId)) {
    const evidence = firstSentence(finding.basis);
    if (evidence) lines.push(`   ${evidence}`);
  }
  return lines.join('\n');
}

function buildSubject(findings) {
  const hasError = findings.some((f) => f.severity === Severity.CONFIRMED_ERROR);
  const hasLegal = findings.some((f) => f.severity === Severity.EXCEEDS_LEGAL_LIMIT);
  if (hasError) return 'A couple of questions on the estimate before I sign';
  if (hasLegal) return 'Question about the deposit and the paperwork';
  return 'A few things to confirm before I sign';
}

// Returns one email per quote with something to ask, plus null entries dropped.
// A quote with nothing to ask produces no email at all, and that is a result
// worth showing the customer rather than a gap to fill.
function buildContractorEmails(findings, context) {
  const ctx = context || {};
  const quotes = Array.isArray(ctx.quotes) ? ctx.quotes : [];
  const all = Array.isArray(findings) ? findings : [];
  const out = [];

  for (const quote of quotes) {
    const eligible = all.filter((f) => sendable(f, quote.label));
    if (!eligible.length) continue;

    // The paperwork asks go in together at the end, as one point with a list.
    //
    // Separated out because of what they are: "add a completion date", "add a
    // change order clause", "send a certificate of insurance" are seven
    // requests to amend a contract, and numbered one to seven they push the
    // questions that are actually about money off the bottom of the message.
    // As a single closing item they take one line of the contractor's
    // attention and lose nothing.
    const paperwork = eligible.filter((f) => f.severity === Severity.MISSING_PROTECTION);
    const substantive = eligible
      .filter((f) => f.severity !== Severity.MISSING_PROTECTION)
      .slice()
      .sort((a, b) => {
        const r = emailRank(a) - emailRank(b);
        if (r !== 0) return r;
        return (b.dollarImpact || 0) - (a.dollarImpact || 0);
      });

    const leading = substantive.slice(0, MAX_POINTS);
    const held = substantive.length - leading.length;

    const name = hasText(quote.contractor_name) ? quote.contractor_name : null;
    const body = [];
    body.push(name ? `Hello ${name},` : 'Hello,');
    body.push('');
    body.push('Thank you for the estimate. Before I sign I have been through it carefully and there are a few '
      + 'things I would like to sort out. Most of these are probably straightforward, and I would rather ask now '
      + 'than have them come up once work has started.');
    body.push('');
    leading.forEach((finding, i) => {
      body.push(renderItem(finding, i));
      body.push('');
    });
    if (paperwork.length) {
      body.push(`${leading.length + 1}. And a few things I would like written into the contract before I sign:`);
      paperwork.forEach((finding) => {
        body.push(`   - ${LEAD_IN[finding.checkId] || NEUTRAL_LEAD_IN}`);
      });
      body.push('');
    }
    const mine = leading.concat(paperwork);
    body.push('It is entirely possible I have misread something, and if there is a simple explanation I would '
      + 'rather hear it than keep guessing. Once these are settled I am ready to move ahead.');
    body.push('');
    body.push('Thanks,');
    body.push(hasText(ctx.homeownerName) ? ctx.homeownerName : '[your name]');

    out.push({
      quote: quote.label,
      to: name,
      subject: buildSubject(mine),
      body: body.join('\n').trim(),
      pointCount: mine.length,
      // Named so the page can say so. A customer who counts fourteen findings
      // and ten points in the email should be told the four were held back on
      // purpose, not left to wonder which ones the draft dropped.
      heldBack: held,
    });
  }

  return out;
}

// The plain text the PDF and the status page both render, so the page and the
// emailed copy carry the same words.
function renderContractorEmails(emails) {
  const blocks = [];
  for (const email of (emails || [])) {
    if (!email || !email.body) continue;
    const heading = `EMAIL TO ${email.to ? email.to.toUpperCase() : email.quote.toUpperCase()}`;
    blocks.push(`${heading}\n\nSubject: ${email.subject}\n\n${email.body}`.trim());
  }
  return blocks.join('\n\n---\n\n');
}

module.exports = {
  buildContractorEmails,
  renderContractorEmails,
  LEAD_IN,
  NOT_SENT_BY_DESIGN,
  _internal: { sendable, renderItem, buildSubject, firstSentence, SENDABLE_SEVERITIES },
};
