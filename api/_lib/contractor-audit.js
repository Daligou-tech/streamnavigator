'use strict';

// The deterministic half of Contractor Navigator.
//
// No model runs in this file. Every check reads numbers that
// api/_lib/contractor-extract.js copied off the homeowner's documents, compares
// them against the document's own other numbers or against a figure written
// down and sourced in api/_lib/contractor-reference.js, and produces an exact
// result or nothing at all. Nothing here estimates. If a check cannot be
// computed from what was uploaded it is skipped by name, and the name goes in
// the report, because a check the customer never hears about reads as a pass.
//
// Why this file exists.
//
// Contractor Navigator shipped for months as one Sonnet call: here are the
// documents, tell the homeowner whether the price is fair and what to
// negotiate. It was the last product still built that way, and it was the one
// selling the most consequential advice — a homeowner repeats this report to a
// contractor's face, and then signs or does not sign a five-figure contract.
//
// Three things were wrong with it, and they are the three this file fixes.
//
// The page promised "AI researches the context: typical price ranges and
// what's normal for this category are factored in." Nothing researched
// anything. The range behind every price verdict was model recall, unnamed and
// different run to run.
//
// Nothing added anything up. An estimate whose line items total $9,340 against
// a printed contract price of $9,840 went out as a clean report, because
// arithmetic is not what catches a reader's eye.
//
// And the things that are genuinely checkable — a deposit over a statutory cap,
// a split system below the federal efficiency minimum for that state, a price
// justified by a tax credit that ended on 31 December 2025 — depend on facts
// that are not in the document at all, so a model reading only the document
// could not have found them however carefully it looked.
//
// That is the arrangement api/_lib/closing-audit.js proved and
// api/_lib/rental-audit.js followed. This file follows it deliberately rather
// than inventing a third idiom.

const ref = require('./contractor-reference');

// --- vocabulary -------------------------------------------------------------

// Ordered strongest first, and the ordering is the argument. "The line items
// do not add up to the total on your own estimate" and "this is above a
// published national range" are different claims with different standing, and
// a report that interleaves them is telling a homeowner that a cost-guide
// average and a proven subtraction are worth the same on the phone.
const Severity = {
  CONFIRMED_ERROR: 'confirmed_arithmetic_error',
  EXCEEDS_LEGAL_LIMIT: 'exceeds_legal_limit',
  MISSING_PROTECTION: 'missing_contract_protection',
  OUTSIDE_PUBLISHED_RANGE: 'outside_published_range',
  QUOTE_SPREAD: 'difference_between_your_quotes',
  CHANGE_ORDER_RISK: 'change_order_risk',
  SALES_PRESSURE: 'sales_pressure_or_stale_claim',
  VERIFY_YOURSELF: 'verify_yourself',
  WITHIN_NORMS: 'within_norms',
};

const SEVERITY_ORDER = {
  [Severity.CONFIRMED_ERROR]: 0,
  [Severity.EXCEEDS_LEGAL_LIMIT]: 1,
  [Severity.MISSING_PROTECTION]: 2,
  [Severity.OUTSIDE_PUBLISHED_RANGE]: 3,
  [Severity.QUOTE_SPREAD]: 4,
  [Severity.CHANGE_ORDER_RISK]: 5,
  [Severity.SALES_PRESSURE]: 6,
  [Severity.VERIFY_YOURSELF]: 7,
  [Severity.WITHIN_NORMS]: 8,
};

// What the finding rests on. The distinction that matters to a homeowner is
// between something proved on their own paperwork or in a statute, and
// something compared against what is usual. The first survives an argument
// with a salesperson and the second does not, so they are never blurred.
const EvidenceKind = {
  DOCUMENT_ARITHMETIC: 'hard_rule:the_estimate_own_figures',
  STATUTE: 'hard_rule:statute',
  FEDERAL_STANDARD: 'hard_rule:federal_standard',
  DOCUMENT_TERMS: 'hard_rule:what_the_document_does_or_does_not_say',
  CROSS_QUOTE: 'hard_rule:your_own_competing_quotes',
  PUBLISHED_RANGE: 'reference:published_national_cost_range',
  NONE: 'no_evidence_available',
};

const Actionability = {
  BEFORE_SIGNING: 'fix_before_you_sign',
  BEFORE_WORK_STARTS: 'fix_before_work_starts',
  VERIFY: 'verify_this_yourself',
  ALREADY_SIGNED: 'remedy_if_you_have_already_signed',
  NONE: 'no_action_needed',
};

// What kind of number dollarImpact is. The write-up is not allowed to call a
// band overage "money you are owed", and this field is how it knows.
const ImpactKind = {
  ERROR: 'arithmetic_discrepancy',
  OVER_LEGAL_CAP: 'amount_above_a_statutory_cap',
  ABOVE_PUBLISHED_RANGE: 'amount_above_a_published_national_range',
  SPREAD: 'difference_between_quotes',
  AT_RISK: 'amount_exposed_to_a_later_change_order',
};

// --- small helpers ----------------------------------------------------------

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function money(v) {
  const n = num(v);
  if (n === null) return 'n/a';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function money0(v) {
  const n = num(v);
  if (n === null) return 'n/a';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// The lines that make up the contract price: priced, not optional, and not the
// kind of line a document prints as a subtotal.
function pricedItems(quote) {
  return arr(quote.line_items).filter((i) => !i.is_optional && num(i.amount) !== null);
}

function itemisedTotal(quote) {
  return round2(pricedItems(quote).reduce((sum, i) => sum + num(i.amount), 0));
}

// The number the homeowner would be signing for.
function contractPrice(quote) {
  return num(quote.total_price);
}

function label(quote) {
  const name = (quote.contractor_name || '').trim();
  const base = quote.label || 'this quote';
  return name ? `${base} (${name})` : base;
}

// --- the catalog ------------------------------------------------------------
//
// Each entry declares the trade it applies to. A roof check on an HVAC estimate
// is not a check we failed to run, it is a check that does not exist for that
// job, so it is excluded from the denominator rather than reported as skipped.
// Getting that wrong makes every report look half-finished.

const CATALOG = [];

// silentSkip marks a check that is the complement of another one: it runs only
// when its sibling cannot, so listing it as skipped the rest of the time would
// tell the homeowner we missed something when in fact the stronger check ran.
// A silent skip comes out of the denominator too, so "29 of 32" stays a true
// count of the work that was available on their documents.
function check(id, checkLabel, opts) {
  CATALOG.push({
    id,
    label: checkLabel,
    appliesTo: opts.appliesTo || 'all',   // 'all' or a category name
    needs: opts.needs,
    run: opts.run,
    silentSkip: !!opts.silentSkip,
    // Complement checks that answer the same question by different means share
    // a pair id, so the page can advertise the pair once rather than twice or
    // neither. Exactly one of a pair runs on any given estimate.
    pair: opts.pair || null,
    // Why this check would not have run, in the homeowner's terms. "Checks we
    // could not run: the payment schedule adds up to the contract price" tells
    // them nothing. Naming the missing thing tells them whether sending one
    // more page would have changed the answer, which is the only useful thing
    // to do about a thin report.
    unmet: opts.unmet || null,
  });
}

// Runs a per-quote function over every quote that satisfies `can`, returning
// one finding per quote. Most checks are shaped this way: the homeowner has one
// to three estimates and each is examined on its own terms.
function perQuote(x, can, fn) {
  const out = [];
  for (const quote of arr(x.quotes)) {
    let ok = false;
    try { ok = !!can(quote, x); } catch (err) { ok = false; }
    if (!ok) continue;
    const result = fn(quote, x);
    if (Array.isArray(result)) out.push(...result.filter(Boolean));
    else if (result) out.push(result);
  }
  return out;
}

function anyQuote(x, can) {
  return arr(x.quotes).some((q) => {
    try { return !!can(q, x); } catch (err) { return false; }
  });
}

// ===========================================================================
// 1. The estimate's own arithmetic
// ===========================================================================

check('LINE_ITEMS_FOOT', 'The priced line items add up to the contract price', {
  unmet: 'no estimate gave a complete list of priced line items to add up',
  needs: (x) => anyQuote(x, (q) => q.line_items_are_priced && q.line_items_complete
    && pricedItems(q).length >= 2 && (num(q.subtotal) !== null || contractPrice(q) !== null)),
  run: (x) => perQuote(x,
    (q) => q.line_items_are_priced && q.line_items_complete && pricedItems(q).length >= 2
      && (num(q.subtotal) !== null || contractPrice(q) !== null),
    (q) => {
      const items = pricedItems(q);
      const itemised = itemisedTotal(q);
      // Compare against the subtotal where one is printed, because tax and
      // discounts sit between the subtotal and the total and are checked
      // separately. Comparing line items against a tax-inclusive total would
      // manufacture a discrepancy the size of the sales tax.
      const against = num(q.subtotal) !== null ? num(q.subtotal) : contractPrice(q);
      const againstName = num(q.subtotal) !== null ? 'subtotal' : 'contract price';
      const hasTaxBetween = num(q.subtotal) === null && num(q.tax_amount) !== null;
      if (hasTaxBetween) return null;

      const gap = round2(against - itemised);
      if (Math.abs(gap) < 1) {
        return {
          checkId: 'LINE_ITEMS_FOOT',
          quote: q.label,
          title: `The line items on ${label(q)} add up to its own ${againstName}`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.DOCUMENT_ARITHMETIC,
          actionability: Actionability.NONE,
          basis: `${items.length} priced lines totalling ${money(itemised)} against a stated ${againstName} of ${money(against)}.`,
          dollarImpact: null,
        };
      }
      return {
        checkId: 'LINE_ITEMS_FOOT',
        quote: q.label,
        title: gap > 0
          ? `${label(q)} charges more than the work it itemises`
          : `The itemised work on ${label(q)} costs more than the price it quotes`,
        severity: Severity.CONFIRMED_ERROR,
        evidence: EvidenceKind.DOCUMENT_ARITHMETIC,
        actionability: Actionability.BEFORE_SIGNING,
        basis: `The ${items.length} priced lines total ${money(itemised)}. The document's own ${againstName} is `
          + `${money(against)}. The difference is ${money(Math.abs(gap))}, and nothing on the document explains it.`,
        recommendedAction: gap > 0
          ? 'Ask what the difference covers, and ask for it as a line item before you sign.'
          : 'Ask for a corrected estimate. A price below the itemised work is usually a typing error, and the '
            + 'correction is more likely to arrive as a change order after you have signed than as a discount.',
        dollarImpact: Math.abs(gap),
        impactKind: ImpactKind.ERROR,
        detail: { itemCount: items.length, itemised, stated: against },
      };
    }),
});

check('LINE_EXTENSIONS_CORRECT', 'Quantity times unit price equals the amount on each line', {
  unmet: 'no line carried a quantity, a unit price and an amount together',
  needs: (x) => anyQuote(x, (q) => arr(q.line_items).some(
    (i) => num(i.quantity) !== null && num(i.unit_price) !== null && num(i.amount) !== null)),
  run: (x) => perQuote(x,
    (q) => arr(q.line_items).some((i) => num(i.quantity) !== null && num(i.unit_price) !== null && num(i.amount) !== null),
    (q) => {
      const checkable = arr(q.line_items).filter(
        (i) => num(i.quantity) !== null && num(i.unit_price) !== null && num(i.amount) !== null);
      const wrong = checkable
        .map((i) => ({
          description: i.description,
          expected: round2(num(i.quantity) * num(i.unit_price)),
          printed: num(i.amount),
          quantity: num(i.quantity),
          unitPrice: num(i.unit_price),
        }))
        // A dollar of rounding on a unit price is not a finding. Anything past
        // that is either a typo or a markup nobody wrote down.
        .filter((i) => Math.abs(i.expected - i.printed) >= 1);

      if (!wrong.length) {
        return {
          checkId: 'LINE_EXTENSIONS_CORRECT',
          quote: q.label,
          title: `Every priced line on ${label(q)} multiplies out correctly`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.DOCUMENT_ARITHMETIC,
          actionability: Actionability.NONE,
          basis: `${checkable.length} lines carry a quantity, a unit price and an amount. All ${checkable.length} agree.`,
          dollarImpact: null,
        };
      }
      const overcharge = round2(wrong.reduce((s, i) => s + (i.printed - i.expected), 0));
      return {
        checkId: 'LINE_EXTENSIONS_CORRECT',
        quote: q.label,
        title: `${wrong.length === 1 ? 'A line' : `${wrong.length} lines`} on ${label(q)} ${wrong.length === 1 ? 'does' : 'do'} not multiply out`,
        severity: Severity.CONFIRMED_ERROR,
        evidence: EvidenceKind.DOCUMENT_ARITHMETIC,
        actionability: Actionability.BEFORE_SIGNING,
        basis: wrong.slice(0, 4).map((i) => `"${i.description}": ${i.quantity} at ${money(i.unitPrice)} is `
          + `${money(i.expected)}, but the line reads ${money(i.printed)}.`).join(' '),
        recommendedAction: 'Point at the line and ask which of the two numbers is right. This is the easiest '
          + 'correction to get, because it is arithmetic on their own paper.',
        dollarImpact: Math.abs(overcharge) >= 1 ? Math.abs(overcharge) : null,
        impactKind: ImpactKind.ERROR,
        detail: { wrong: wrong.slice(0, 8) },
      };
    }),
});

check('TOTAL_RECONCILES', 'Subtotal plus tax, less any discount, equals the contract price', {
  unmet: 'no estimate printed both a subtotal and a contract price',
  needs: (x) => anyQuote(x, (q) => num(q.subtotal) !== null && contractPrice(q) !== null),
  run: (x) => perQuote(x,
    (q) => num(q.subtotal) !== null && contractPrice(q) !== null,
    (q) => {
      const subtotal = num(q.subtotal);
      const tax = num(q.tax_amount) || 0;
      const discount = num(q.discount_amount) || 0;
      const expected = round2(subtotal + tax - discount);
      const printed = contractPrice(q);
      const gap = round2(printed - expected);

      if (Math.abs(gap) < 1) {
        return {
          checkId: 'TOTAL_RECONCILES',
          quote: q.label,
          title: `The bottom line on ${label(q)} reconciles`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.DOCUMENT_ARITHMETIC,
          actionability: Actionability.NONE,
          basis: `${money(subtotal)} subtotal${tax ? ` plus ${money(tax)} tax` : ''}`
            + `${discount ? ` less ${money(discount)} discount` : ''} equals the quoted ${money(printed)}.`,
          dollarImpact: null,
        };
      }
      return {
        checkId: 'TOTAL_RECONCILES',
        quote: q.label,
        title: `The bottom line on ${label(q)} does not reconcile with its own subtotal`,
        severity: Severity.CONFIRMED_ERROR,
        evidence: EvidenceKind.DOCUMENT_ARITHMETIC,
        actionability: Actionability.BEFORE_SIGNING,
        basis: `${money(subtotal)} subtotal${tax ? ` plus ${money(tax)} tax` : ''}`
          + `${discount ? ` less ${money(discount)} discount` : ''} comes to ${money(expected)}. `
          + `The document quotes ${money(printed)} — ${money(Math.abs(gap))} ${gap > 0 ? 'more' : 'less'}.`,
        recommendedAction: 'Ask for a corrected estimate before signing. Whichever figure is wrong, the contract '
          + 'price is the one you are agreeing to.',
        dollarImpact: Math.abs(gap),
        impactKind: ImpactKind.ERROR,
      };
    }),
});

check('TAX_MATCHES_RATE', 'The tax charged matches the tax rate the estimate prints', {
  unmet: 'no estimate printed a tax rate to check the tax against',
  needs: (x) => anyQuote(x, (q) => num(q.tax_rate_stated) !== null && num(q.tax_amount) !== null
    && num(q.subtotal) !== null),
  run: (x) => perQuote(x,
    (q) => num(q.tax_rate_stated) !== null && num(q.tax_amount) !== null && num(q.subtotal) !== null,
    (q) => {
      const rate = num(q.tax_rate_stated);
      const subtotal = num(q.subtotal);
      const charged = num(q.tax_amount);
      const expected = round2(subtotal * (rate / 100));
      const gap = round2(charged - expected);
      // Labour is exempt from sales tax in many states while materials are not,
      // so tax on less than the full subtotal is ordinary and correct. Only an
      // OVERcharge is a finding here; undercharging against the printed rate is
      // the normal shape of a partly exempt job.
      if (gap < 1) {
        return {
          checkId: 'TAX_MATCHES_RATE',
          quote: q.label,
          title: `The tax on ${label(q)} is not more than its printed rate produces`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.DOCUMENT_ARITHMETIC,
          actionability: Actionability.NONE,
          basis: `${rate}% of the ${money(subtotal)} subtotal is ${money(expected)}; the estimate charges `
            + `${money(charged)}. Tax on less than the full subtotal is normal where labour is exempt.`,
          dollarImpact: null,
        };
      }
      return {
        checkId: 'TAX_MATCHES_RATE',
        quote: q.label,
        title: `${label(q)} charges more tax than its own rate produces`,
        severity: Severity.CONFIRMED_ERROR,
        evidence: EvidenceKind.DOCUMENT_ARITHMETIC,
        actionability: Actionability.BEFORE_SIGNING,
        basis: `The estimate prints a ${rate}% rate. ${rate}% of the ${money(subtotal)} subtotal is ${money(expected)}. `
          + `It charges ${money(charged)}, which is ${money(gap)} more.`,
        recommendedAction: 'Ask which figure is right. If labour is taxable in your state the subtotal may be taxed '
          + 'differently than you expect, but the rate on the page has to produce the number on the page.',
        dollarImpact: gap,
        impactKind: ImpactKind.ERROR,
      };
    }),
});

check('DEPOSIT_PERCENT_MATCHES', 'The deposit matches the percentage the estimate claims it is', {
  unmet: 'no estimate described its deposit as a percentage, so there is nothing to check it against',
  needs: (x) => anyQuote(x, (q) => num(q.deposit_amount) !== null && num(q.deposit_percent_stated) !== null
    && contractPrice(q) !== null),
  run: (x) => perQuote(x,
    (q) => num(q.deposit_amount) !== null && num(q.deposit_percent_stated) !== null && contractPrice(q) !== null,
    (q) => {
      const pct = num(q.deposit_percent_stated);
      const price = contractPrice(q);
      const expected = round2(price * (pct / 100));
      const charged = num(q.deposit_amount);
      const gap = round2(charged - expected);
      if (Math.abs(gap) < 1) {
        return {
          checkId: 'DEPOSIT_PERCENT_MATCHES',
          quote: q.label,
          title: `The deposit on ${label(q)} is the percentage it says it is`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.DOCUMENT_ARITHMETIC,
          actionability: Actionability.NONE,
          basis: `${pct}% of ${money(price)} is ${money(expected)}, which is what is asked for.`,
          dollarImpact: null,
        };
      }
      return {
        checkId: 'DEPOSIT_PERCENT_MATCHES',
        quote: q.label,
        title: `The deposit on ${label(q)} is not the percentage it claims`,
        severity: Severity.CONFIRMED_ERROR,
        evidence: EvidenceKind.DOCUMENT_ARITHMETIC,
        actionability: Actionability.BEFORE_SIGNING,
        basis: `The estimate describes the deposit as ${pct}%. ${pct}% of the ${money(price)} contract price is `
          + `${money(expected)}. The amount asked for is ${money(charged)} — ${money(Math.abs(gap))} `
          + `${gap > 0 ? 'more' : 'less'}.`,
        recommendedAction: gap > 0
          ? 'Pay the percentage that is written, not the figure in the box, and get the corrected number in writing.'
          : 'Worth confirming, so the shortfall is not treated as an arrears later.',
        dollarImpact: Math.abs(gap),
        impactKind: ImpactKind.ERROR,
      };
    }),
});

check('PAYMENT_SCHEDULE_SUMS', 'The payment schedule adds up to the contract price', {
  unmet: 'no estimate set out a payment schedule with amounts',
  needs: (x) => anyQuote(x, (q) => arr(q.payment_schedule).filter((p) => num(p.amount) !== null).length >= 2
    && contractPrice(q) !== null),
  run: (x) => perQuote(x,
    (q) => arr(q.payment_schedule).filter((p) => num(p.amount) !== null).length >= 2 && contractPrice(q) !== null,
    (q) => {
      const payments = arr(q.payment_schedule).filter((p) => num(p.amount) !== null);
      const scheduled = round2(payments.reduce((s, p) => s + num(p.amount), 0));
      const price = contractPrice(q);
      const gap = round2(scheduled - price);
      if (Math.abs(gap) < 1) {
        return {
          checkId: 'PAYMENT_SCHEDULE_SUMS',
          quote: q.label,
          title: `The payment schedule on ${label(q)} adds up to the contract price`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.DOCUMENT_ARITHMETIC,
          actionability: Actionability.NONE,
          basis: `${payments.length} scheduled payments totalling ${money(scheduled)} against a contract price of ${money(price)}.`,
          dollarImpact: null,
        };
      }
      return {
        checkId: 'PAYMENT_SCHEDULE_SUMS',
        quote: q.label,
        title: `The payment schedule on ${label(q)} does not add up to the contract price`,
        severity: Severity.CONFIRMED_ERROR,
        evidence: EvidenceKind.DOCUMENT_ARITHMETIC,
        actionability: Actionability.BEFORE_SIGNING,
        basis: `The ${payments.length} scheduled payments total ${money(scheduled)}. The contract price is `
          + `${money(price)} — a difference of ${money(Math.abs(gap))}.`,
        recommendedAction: gap > 0
          ? 'You would be paying more than the contract price across the schedule. Get it corrected before signing.'
          : 'The schedule leaves part of the price unallocated. Ask when the remainder is due and get it written in.',
        dollarImpact: Math.abs(gap),
        impactKind: ImpactKind.ERROR,
      };
    }),
});

// ===========================================================================
// 2. Deposits and payment structure — where the statutes are
// ===========================================================================

check('DEPOSIT_WITHIN_STATE_CAP', 'The deposit is within your state\'s statutory limit', {
  // The complement of DEPOSIT_AGAINST_NORM: whichever of the two applies to
  // this state is the one that runs, so neither is ever a skipped check.
  silentSkip: true,
  pair: 'deposit_limit',
  needs: (x) => !!ref.DEPOSIT_CAPS[x.state] && anyQuote(x, (q) => num(q.deposit_amount) !== null && contractPrice(q) !== null),
  run: (x) => {
    const cap = ref.DEPOSIT_CAPS[x.state];
    return perQuote(x,
      (q) => num(q.deposit_amount) !== null && contractPrice(q) !== null,
      (q) => {
        const price = contractPrice(q);
        const applied = cap.rule(price);
        if (!applied) return null;
        const deposit = num(q.deposit_amount);
        const over = round2(deposit - applied.cap);

        if (over <= 1) {
          return {
            checkId: 'DEPOSIT_WITHIN_STATE_CAP',
            quote: q.label,
            title: `The deposit on ${label(q)} is within ${ref.stateName(x.state)}'s statutory limit`,
            severity: Severity.WITHIN_NORMS,
            evidence: EvidenceKind.STATUTE,
            actionability: Actionability.NONE,
            basis: `${applied.basis} The deposit asked for is ${money(deposit)}.`,
            citation: cap.citation,
            source: cap.source,
            dollarImpact: null,
          };
        }
        return {
          checkId: 'DEPOSIT_WITHIN_STATE_CAP',
          quote: q.label,
          title: `The deposit on ${label(q)} exceeds ${ref.stateName(x.state)}'s statutory limit by ${money0(over)}`,
          severity: Severity.EXCEEDS_LEGAL_LIMIT,
          evidence: EvidenceKind.STATUTE,
          actionability: Actionability.BEFORE_SIGNING,
          basis: `${applied.basis} This estimate asks for ${money(deposit)} — ${money(over)} over the cap.`
            + (cap.exception ? ` ${cap.exception}` : ''),
          recommendedAction: `Pay no more than ${money(applied.cap)} up front and cite ${cap.citation}. `
            + 'A contractor who resists a limit set by their own licensing statute is telling you something '
            + 'useful about the rest of the job.',
          citation: cap.citation,
          source: cap.source,
          dollarImpact: over,
          impactKind: ImpactKind.OVER_LEGAL_CAP,
          detail: { cap: applied.cap, deposit, contractLanguage: cap.contractLanguage || null },
        };
      });
  },
});

check('DEPOSIT_AGAINST_NORM', 'The deposit is within customary practice, where no statute sets a limit', {
  // Only where there is no statutory cap. Where there IS one, the check above
  // is the better answer and this would tell the customer the same thing twice
  // on weaker evidence — so it leaves quietly rather than as a skipped check.
  silentSkip: true,
  pair: 'deposit_limit',
  needs: (x) => !ref.DEPOSIT_CAPS[x.state]
    && anyQuote(x, (q) => num(q.deposit_amount) !== null && contractPrice(q) !== null),
  run: (x) => {
    const escrow = ref.DEPOSIT_ESCROW_RULES[x.state];
    return perQuote(x,
      (q) => num(q.deposit_amount) !== null && contractPrice(q) !== null,
      (q) => {
        const price = contractPrice(q);
        const deposit = num(q.deposit_amount);
        const pct = round2((deposit / price) * 100);
        const stateLabel = ref.stateName(x.state) || 'your state';
        const escrowNote = escrow ? ` ${escrow.note}` : '';

        if (pct <= ref.DEPOSIT_NORM.typicalMaxPercent) {
          return {
            checkId: 'DEPOSIT_AGAINST_NORM',
            quote: q.label,
            title: `The deposit on ${label(q)} is within customary practice`,
            severity: escrow ? Severity.VERIFY_YOURSELF : Severity.WITHIN_NORMS,
            evidence: escrow ? EvidenceKind.STATUTE : EvidenceKind.PUBLISHED_RANGE,
            actionability: escrow ? Actionability.BEFORE_SIGNING : Actionability.NONE,
            basis: `${money(deposit)} on a ${money(price)} contract is ${pct}%. ${stateLabel} sets no statutory `
              + `maximum, and published guidance clusters at 10%-33% for residential work.${escrowNote}`,
            citation: escrow ? escrow.citation : null,
            source: escrow ? escrow.source : null,
            dollarImpact: null,
          };
        }
        return {
          checkId: 'DEPOSIT_AGAINST_NORM',
          quote: q.label,
          title: `The deposit on ${label(q)} is ${pct}% of the job, above customary practice`,
          severity: Severity.SALES_PRESSURE,
          evidence: EvidenceKind.PUBLISHED_RANGE,
          actionability: Actionability.BEFORE_SIGNING,
          basis: `${money(deposit)} on a ${money(price)} contract is ${pct}%. ${stateLabel} sets no statutory maximum, `
            + `so this is not unlawful — but published guidance puts residential deposits at 10%-33%, and money paid `
            + `before work starts is the money you cannot get back if the job stalls.${escrowNote}`,
          recommendedAction: `Ask for ${ref.DEPOSIT_NORM.typicalMaxPercent}% or less at signing, with the rest tied `
            + 'to work actually completed. If the deposit is high because of special-order materials, ask for those '
            + 'to be itemised and for the receipt.',
          citation: escrow ? escrow.citation : null,
          source: escrow ? escrow.source : null,
          dollarImpact: round2(deposit - price * (ref.DEPOSIT_NORM.typicalMaxPercent / 100)),
          impactKind: ImpactKind.AT_RISK,
        };
      });
  },
});

check('PAYMENT_NOT_FRONT_LOADED', 'More than half the price is held until work is done', {
  unmet: 'no estimate set out a payment schedule',
  needs: (x) => anyQuote(x, (q) => arr(q.payment_schedule).length >= 2 && contractPrice(q) !== null),
  run: (x) => perQuote(x,
    (q) => arr(q.payment_schedule).length >= 2 && contractPrice(q) !== null,
    (q) => {
      const price = contractPrice(q);
      const upFront = arr(q.payment_schedule)
        .filter((p) => p.is_before_work_starts && num(p.amount) !== null)
        .reduce((s, p) => s + num(p.amount), 0);
      if (upFront <= 0) return null;
      const pct = round2((upFront / price) * 100);

      if (pct < 50) {
        return {
          checkId: 'PAYMENT_NOT_FRONT_LOADED',
          quote: q.label,
          title: `${label(q)} holds more than half the price until the work is done`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.DOCUMENT_TERMS,
          actionability: Actionability.NONE,
          basis: `${money(upFront)} of the ${money(price)} price — ${pct}% — falls due before work starts, which is `
            + 'within the half-of-the-job line this check draws. Whether that particular amount is lawful is a '
            + 'separate question, answered by the deposit check.',
          dollarImpact: null,
        };
      }
      return {
        checkId: 'PAYMENT_NOT_FRONT_LOADED',
        quote: q.label,
        title: `${label(q)} asks for ${pct}% of the job before any work is done`,
        severity: Severity.MISSING_PROTECTION,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.BEFORE_SIGNING,
        basis: `${money(upFront)} of the ${money(price)} contract price falls due before work starts. Every dollar `
          + 'paid ahead of work is a dollar you are relying on goodwill to recover.',
        recommendedAction: 'Restructure the schedule so payments follow completed milestones you can see — materials '
          + 'delivered, tear-off done, equipment set, final inspection passed. Hold back a final payment until the '
          + 'permit is signed off.',
        dollarImpact: round2(upFront - price * 0.5),
        impactKind: ImpactKind.AT_RISK,
      };
    }),
});

// ===========================================================================
// 3. The contract terms a homeowner only misses once
// ===========================================================================

check('LICENCE_NUMBER_PRESENT', 'The estimate carries a contractor licence number you can look up', {
  needs: (x) => arr(x.quotes).length > 0,
  run: (x) => {
    const board = ref.licenseBoard(x.state);
    return perQuote(x, () => true, (q) => {
      const number = (q.license_number || '').trim();
      const where = board
        ? (board.url ? `${board.name}: ${board.url}` : board.name)
        : 'your state or county licensing board';
      if (number) {
        return {
          checkId: 'LICENCE_NUMBER_PRESENT',
          quote: q.label,
          title: `${label(q)} prints a licence number — look it up before you sign`,
          severity: Severity.VERIFY_YOURSELF,
          evidence: EvidenceKind.DOCUMENT_TERMS,
          actionability: Actionability.VERIFY,
          basis: `Licence number as printed: ${number}. We do not look this up for you, because a licence status is `
            + 'only worth anything read today — check it yourself and you also see the bond, the insurance and any '
            + 'complaint history.',
          recommendedAction: `Search ${number} at ${where}. Confirm the name on the licence matches the name on the `
            + 'estimate, that it is active, and that the classification covers this trade.',
          source: board && board.url ? board.url : null,
          dollarImpact: null,
          detail: { licenseNumber: number, board: board ? board.name : null, boardUrl: board ? board.url : null },
        };
      }
      return {
        checkId: 'LICENCE_NUMBER_PRESENT',
        quote: q.label,
        title: `${label(q)} does not print a contractor licence number`,
        severity: Severity.MISSING_PROTECTION,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.BEFORE_SIGNING,
        basis: 'No licence number appears anywhere on this estimate. In most states the number is required on the '
          + 'contract itself, and its absence is the cheapest warning sign there is.',
        recommendedAction: `Ask for the number in writing and check it at ${where} before you pay anything. `
          + 'An unlicensed contractor can also leave you without recourse to your state recovery fund and without '
          + 'cover if a worker is injured on your property.',
        source: board && board.url ? board.url : null,
        dollarImpact: null,
      };
    });
  },
});

check('COMPLETION_DATE_STATED', 'The estimate says when the work will be finished', {
  needs: (x) => arr(x.quotes).length > 0,
  run: (x) => perQuote(x, () => true, (q) => {
    if (q.completion_date_stated) {
      return {
        checkId: 'COMPLETION_DATE_STATED',
        quote: q.label,
        title: `${label(q)} commits to a completion date`,
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.NONE,
        basis: 'A completion date appears on the document.',
        dollarImpact: null,
      };
    }
    return {
      checkId: 'COMPLETION_DATE_STATED',
      quote: q.label,
      title: `${label(q)} does not say when the work will be finished`,
      severity: Severity.MISSING_PROTECTION,
      evidence: EvidenceKind.DOCUMENT_TERMS,
      actionability: Actionability.BEFORE_SIGNING,
      basis: `No completion date appears on this estimate${q.start_date_stated ? ', though a start date does' : ''}. `
        + 'Several states require approximate start and completion dates in a home improvement contract, and without '
        + 'one there is no such thing as late.',
      recommendedAction: 'Ask for approximate start and completion dates written into the contract before you sign. '
        + 'It costs the contractor nothing if they intend to show up.',
      dollarImpact: null,
    };
  }),
});

check('PERMIT_RESPONSIBILITY_NAMED', 'The estimate says who pulls the permit', {
  needs: (x) => arr(x.quotes).length > 0,
  run: (x) => perQuote(x, () => true, (q) => {
    const permit = q.permit || 'not_mentioned';
    if (permit === 'included') {
      return {
        checkId: 'PERMIT_RESPONSIBILITY_NAMED',
        quote: q.label,
        title: `${label(q)} includes the permit`,
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.NONE,
        basis: 'The document states the permit is included in the price.',
        dollarImpact: null,
      };
    }
    const excluded = permit === 'excluded' || permit === 'owner_responsibility';
    return {
      checkId: 'PERMIT_RESPONSIBILITY_NAMED',
      quote: q.label,
      title: excluded
        ? `${label(q)} leaves the permit to you`
        : `${label(q)} does not say who pulls the permit`,
      severity: excluded ? Severity.CHANGE_ORDER_RISK : Severity.MISSING_PROTECTION,
      evidence: EvidenceKind.DOCUMENT_TERMS,
      actionability: Actionability.BEFORE_SIGNING,
      basis: excluded
        ? 'The document puts the permit on the homeowner. That matters beyond the fee: a permit pulled in your name '
          + 'makes you the responsible party for code compliance, and it is the contractor whose work is being '
          + 'inspected.'
        : 'The document is silent on permits. Most HVAC changeouts, roof replacements, panel upgrades and repipes '
          + 'require one, and an unpermitted alteration is a problem that surfaces years later when you sell.',
      recommendedAction: 'Get it in writing that the contractor pulls the permit in their own name and that the '
        + 'price includes the fee and the inspection. Hold a final payment until the inspection passes.',
      dollarImpact: null,
    };
  }),
});

check('CHANGE_ORDERS_REQUIRE_WRITING', 'Extra work needs your written approval before it is charged', {
  needs: (x) => arr(x.quotes).length > 0,
  run: (x) => perQuote(x, () => true, (q) => {
    const clause = q.change_order_clause || 'absent';
    if (clause === 'written_approval_required') {
      return {
        checkId: 'CHANGE_ORDERS_REQUIRE_WRITING',
        quote: q.label,
        title: `${label(q)} requires written approval before extra work is charged`,
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.NONE,
        basis: 'The document contains a change order clause requiring your written authorisation.',
        dollarImpact: null,
      };
    }
    return {
      checkId: 'CHANGE_ORDERS_REQUIRE_WRITING',
      quote: q.label,
      title: clause === 'mentioned_without_terms'
        ? `${label(q)} mentions change orders but does not require your written approval`
        : `${label(q)} has no change order clause`,
      severity: Severity.MISSING_PROTECTION,
      evidence: EvidenceKind.DOCUMENT_TERMS,
      actionability: Actionability.BEFORE_SIGNING,
      basis: 'Nothing on this estimate commits the contractor to getting your signature on extra work before doing '
        + 'it and billing for it. This is the single clause that decides whether a surprise is a conversation or an '
        + 'invoice.',
      recommendedAction: 'Add one sentence: no additional work is performed and no additional charge is owed unless '
        + 'you have signed a written change order stating the scope and the price in advance.',
      dollarImpact: null,
    };
  }),
});

check('WARRANTY_SPLIT_STATED', 'Labour and materials warranties are stated separately', {
  needs: (x) => arr(x.quotes).length > 0,
  run: (x) => perQuote(x, () => true, (q) => {
    const labour = num(q.warranty_labor_years);
    const materials = num(q.warranty_materials_years);
    if (labour !== null && materials !== null) {
      return {
        checkId: 'WARRANTY_SPLIT_STATED',
        quote: q.label,
        title: `${label(q)} states both a labour and a materials warranty`,
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.NONE,
        basis: `${labour} year${labour === 1 ? '' : 's'} on labour, ${materials} year${materials === 1 ? '' : 's'} on materials.`,
        dollarImpact: null,
      };
    }
    if (labour === null && materials === null) {
      return {
        checkId: 'WARRANTY_SPLIT_STATED',
        quote: q.label,
        title: `${label(q)} does not state a warranty`,
        severity: Severity.MISSING_PROTECTION,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.BEFORE_SIGNING,
        basis: 'No warranty term appears on this estimate in years.',
        recommendedAction: 'Ask for both terms in writing and in years: how long the contractor warrants their own '
          + 'workmanship, and what the manufacturer warrants on the parts. They are different promises from '
          + 'different companies and only one of them survives the contractor going out of business.',
        dollarImpact: null,
      };
    }
    const missing = labour === null ? 'labour' : 'materials';
    const present = labour === null
      ? `${materials} year${materials === 1 ? '' : 's'} on materials`
      : `${labour} year${labour === 1 ? '' : 's'} on labour`;
    return {
      checkId: 'WARRANTY_SPLIT_STATED',
      quote: q.label,
      title: `${label(q)} states a warranty but not the ${missing} half`,
      severity: Severity.MISSING_PROTECTION,
      evidence: EvidenceKind.DOCUMENT_TERMS,
      actionability: Actionability.BEFORE_SIGNING,
      basis: `The document gives ${present} and says nothing about ${missing}.`,
      recommendedAction: `Ask for the ${missing} term in years, in writing. A manufacturer warranty on parts is `
        + 'worth much less than it sounds if nobody is warranting the labour to fit them.',
      dollarImpact: null,
    };
  }),
});

check('LIEN_WAIVER_ADDRESSED', 'The contract addresses mechanics liens', {
  needs: (x) => arr(x.quotes).length > 0,
  run: (x) => perQuote(x, () => true, (q) => {
    if (q.lien_waiver_mentioned) {
      return {
        checkId: 'LIEN_WAIVER_ADDRESSED',
        quote: q.label,
        title: `${label(q)} addresses lien waivers`,
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.NONE,
        basis: 'The document refers to lien waivers or lien releases.',
        dollarImpact: null,
      };
    }
    return {
      checkId: 'LIEN_WAIVER_ADDRESSED',
      quote: q.label,
      title: `${label(q)} says nothing about lien waivers`,
      severity: Severity.MISSING_PROTECTION,
      evidence: EvidenceKind.DOCUMENT_TERMS,
      actionability: Actionability.BEFORE_WORK_STARTS,
      basis: 'If your contractor does not pay their supplier or their subcontractor, that supplier can place a '
        + 'mechanics lien on your home even though you paid the contractor in full. A lien waiver at each payment is '
        + 'what stops you paying twice.',
      recommendedAction: 'Write in that each payment is made against a signed lien waiver from the contractor, and '
        + 'that final payment is made against final unconditional waivers from every supplier and subcontractor on '
        + 'the job.',
      dollarImpact: null,
    };
  }),
});

check('INSURANCE_EVIDENCE', 'The contractor states liability and workers compensation cover', {
  needs: (x) => arr(x.quotes).length > 0,
  run: (x) => perQuote(x, () => true, (q) => {
    if (q.insurance_evidence_mentioned) {
      return {
        checkId: 'INSURANCE_EVIDENCE',
        quote: q.label,
        title: `${label(q)} states insurance cover — ask for the certificate anyway`,
        severity: Severity.VERIFY_YOURSELF,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.VERIFY,
        basis: 'The document claims coverage. A claim on an estimate is not a policy.',
        recommendedAction: 'Ask the insurer — not the contractor — to send you the certificate of insurance direct, '
          + 'with your name as certificate holder. It takes one email and it is the only version that cannot be '
          + 'edited in a word processor.',
        dollarImpact: null,
      };
    }
    return {
      checkId: 'INSURANCE_EVIDENCE',
      quote: q.label,
      title: `${label(q)} says nothing about insurance`,
      severity: Severity.MISSING_PROTECTION,
      evidence: EvidenceKind.DOCUMENT_TERMS,
      actionability: Actionability.BEFORE_WORK_STARTS,
      basis: 'Nothing on this estimate states general liability or workers compensation cover. If an uninsured '
        + "worker is hurt on your roof, your homeowner's policy is the one that gets the claim.",
      recommendedAction: 'Ask for a certificate of insurance sent to you directly by the insurance agency, naming '
        + 'you as certificate holder, before anyone starts work.',
      dollarImpact: null,
    };
  }),
});

check('SCOPE_IS_PRICED', 'The estimate itemises what you are paying for', {
  needs: (x) => arr(x.quotes).length > 0,
  run: (x) => perQuote(x, () => true, (q) => {
    const priced = pricedItems(q).length;
    if (q.line_items_are_priced && priced >= 2) {
      return {
        checkId: 'SCOPE_IS_PRICED',
        quote: q.label,
        title: `${label(q)} breaks the price into line items`,
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.NONE,
        basis: `${priced} priced lines, which is what makes the rest of this audit possible on this quote.`,
        dollarImpact: null,
      };
    }
    return {
      checkId: 'SCOPE_IS_PRICED',
      quote: q.label,
      title: `${label(q)} is a single lump sum with no priced breakdown`,
      severity: Severity.CHANGE_ORDER_RISK,
      evidence: EvidenceKind.DOCUMENT_TERMS,
      actionability: Actionability.BEFORE_SIGNING,
      basis: 'The price arrives as one number. Nothing can be compared, negotiated or disputed line by line, and if '
        + 'part of the scope is dropped later there is no figure attached to it to argue about.',
      recommendedAction: 'Ask for the same quote itemised — equipment, labour, materials, permit, disposal. A '
        + 'contractor who will not break it down is usually protecting a markup, and the breakdown is also what you '
        + 'need to compare them against anyone else.',
      dollarImpact: null,
    };
  }),
});

check('ALLOWANCES_IDENTIFIED', 'Allowance lines are flagged as the change orders they usually become', {
  // Runs on any itemised estimate. "No allowances" is a real, good answer, and
  // a homeowner comparing two quotes needs to know which one carries them.
  unmet: 'no estimate had priced line items to look through for allowances',
  needs: (x) => anyQuote(x, (q) => arr(q.line_items).length > 0),
  run: (x) => perQuote(x,
    (q) => arr(q.line_items).length > 0,
    (q) => {
      const allowances = arr(q.line_items).filter((i) => i.is_allowance);
      if (!allowances.length) {
        return {
          checkId: 'ALLOWANCES_IDENTIFIED',
          quote: q.label,
          title: `${label(q)} carries no allowance lines`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.DOCUMENT_TERMS,
          actionability: Actionability.NONE,
          basis: 'No line on this estimate is a placeholder budget figure. Every priced line is a price.',
          dollarImpact: null,
        };
      }
      const total = round2(allowances.reduce((s, i) => s + (num(i.amount) || 0), 0));
      return {
        checkId: 'ALLOWANCES_IDENTIFIED',
        quote: q.label,
        title: `${label(q)} carries ${allowances.length} allowance line${allowances.length === 1 ? '' : 's'}`
          + `${total ? ` worth ${money0(total)}` : ''}`,
        severity: Severity.CHANGE_ORDER_RISK,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.BEFORE_SIGNING,
        basis: `An allowance is a placeholder, not a price: ${allowances.map((i) => `"${i.description}"`).join(', ')}. `
          + 'It is the number that changes once the work starts, and it changes upward.',
        recommendedAction: 'For each allowance, ask what it actually buys — the specific product, the specific '
          + 'quantity — and ask for a firm price instead. Where it has to stay an allowance, agree in writing how any '
          + 'overage is priced.',
        dollarImpact: total || null,
        impactKind: ImpactKind.AT_RISK,
      };
    }),
});

check('EXCLUSIONS_LISTED', 'The estimate says what it does not cover', {
  needs: (x) => arr(x.quotes).length > 0,
  run: (x) => perQuote(x, () => true, (q) => {
    const exclusions = arr(q.exclusions).filter(Boolean);
    if (exclusions.length) {
      return {
        checkId: 'EXCLUSIONS_LISTED',
        quote: q.label,
        title: `${label(q)} lists what it excludes — read these before the price`,
        // Not a fault. A contractor who writes down the boundary of the job has
        // done the right thing, and asking them for the exclusions they already
        // gave you is how a homeowner spends credibility for nothing. It is
        // something for the homeowner to read, so it is theirs to act on.
        severity: Severity.VERIFY_YOURSELF,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.VERIFY,
        basis: `Excluded: ${exclusions.slice(0, 8).join('; ')}.`,
        recommendedAction: 'An exclusion list is a good sign — it means the contractor has thought about the job. '
          + 'Price each exclusion now rather than discovering it mid-job, and ask which of them they actually expect '
          + 'to hit on a house like yours.',
        dollarImpact: null,
      };
    }
    return {
      checkId: 'EXCLUSIONS_LISTED',
      quote: q.label,
      title: `${label(q)} lists no exclusions`,
      severity: Severity.CHANGE_ORDER_RISK,
      evidence: EvidenceKind.DOCUMENT_TERMS,
      actionability: Actionability.BEFORE_SIGNING,
      basis: 'No exclusions section appears. That is not the same as everything being included — it usually means '
        + 'the boundary of the job has not been written down anywhere.',
      recommendedAction: 'Ask directly: what is NOT in this price? Get the answer in writing and attach it to the '
        + 'contract.',
      dollarImpact: null,
    };
  }),
});

check('RIGHT_TO_CANCEL_NOTICE', 'A contract signed at your home carries the three-day cancellation notice', {
  // The federal rule does not reach a quote the homeowner went out and
  // requested from the contractor's own premises, and claiming otherwise would
  // send them into an argument they lose. So the intake asks, and a "no" is
  // answered rather than skipped — most people believe they have three days on
  // any contract, and finding that out after signing is expensive.
  unmet: 'the intake form did not record whether this was quoted during a visit to your home',
  needs: (x) => x.signedAtHome === true || x.signedAtHome === false,
  run: (x) => perQuote(x, () => true, (q) => {
    if (x.signedAtHome === false) {
      return {
        checkId: 'RIGHT_TO_CANCEL_NOTICE',
        quote: q.label,
        title: 'The federal three-day cancellation right does not attach to this quote',
        severity: Severity.VERIFY_YOURSELF,
        evidence: EvidenceKind.FEDERAL_STANDARD,
        actionability: Actionability.BEFORE_SIGNING,
        basis: 'You told us this was not quoted during a visit to your home. The FTC Cooling-Off Rule covers sales '
          + "made at your home or away from the seller's usual place of business — not a quote you went and asked "
          + 'for. Worth knowing, because almost everyone assumes three days is automatic on any contract. It is not.',
        recommendedAction: 'Your state may give you more than the federal rule does, and some contracts write in '
          + 'their own cancellation window. Read that clause before you sign rather than after.',
        citation: ref.COOLING_OFF.citation,
        source: ref.COOLING_OFF.source,
        dollarImpact: null,
      };
    }
    if (q.right_to_cancel_notice) {
      return {
        checkId: 'RIGHT_TO_CANCEL_NOTICE',
        quote: q.label,
        title: `${label(q)} carries the three-day right-to-cancel notice`,
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.FEDERAL_STANDARD,
        actionability: Actionability.NONE,
        basis: `The notice appears on the document. ${ref.COOLING_OFF.note}`,
        citation: ref.COOLING_OFF.citation,
        source: ref.COOLING_OFF.source,
        dollarImpact: null,
      };
    }
    return {
      checkId: 'RIGHT_TO_CANCEL_NOTICE',
      quote: q.label,
      title: `${label(q)} was quoted at your home and carries no right-to-cancel notice`,
      severity: Severity.EXCEEDS_LEGAL_LIMIT,
      evidence: EvidenceKind.FEDERAL_STANDARD,
      actionability: Actionability.ALREADY_SIGNED,
      basis: `You told us this was quoted during a visit to your home. ${ref.COOLING_OFF.note} No such notice appears `
        + 'on this document.',
      recommendedAction: 'If you have already signed, the three days generally do not start running until you are '
        + 'given the notice — so your right to cancel may still be open. Put a cancellation in writing, keep proof '
        + 'of when you sent it, and say it is under the FTC Cooling-Off Rule.',
      citation: ref.COOLING_OFF.citation,
      source: ref.COOLING_OFF.source,
      dollarImpact: null,
    };
  }),
});

// ===========================================================================
// 4. Price, against the only two things that can honestly be compared
// ===========================================================================

// Which band applies, and what the quote works out to per unit. Returns null
// where the estimate does not carry the quantity the band is per, which is
// most of the reason this check is skipped.
function unitRate(quote, category) {
  const price = contractPrice(quote);
  if (price === null || price <= 0) return null;

  if (category === 'HVAC') {
    const tons = num((quote.hvac || {}).tons);
    if (!tons || tons <= 0) return null;
    const ductwork = (quote.hvac || {}).ductwork;
    return {
      band: ref.PRICE_BANDS.hvac_ac_per_ton,
      rate: round2(price / tons),
      quantity: tons,
      quantityLabel: `${tons} ton${tons === 1 ? '' : 's'}`,
      // The band is for a changeout on existing ductwork. A quote that
      // includes new ducts is a different job and must not be judged against it.
      disqualified: ductwork === 'included' ? 'this quote includes ductwork, which the band does not cover' : null,
    };
  }
  if (category === 'Roofing') {
    const r = quote.roofing || {};
    let squares = num(r.squares);
    if (!squares && num(r.roof_area_sqft)) squares = round2(num(r.roof_area_sqft) / 100);
    if (!squares || squares <= 0) return null;
    return {
      band: ref.PRICE_BANDS.roofing_per_square,
      rate: round2(price / squares),
      quantity: squares,
      quantityLabel: `${squares} square${squares === 1 ? '' : 's'}`,
      disqualified: null,
    };
  }
  if (category === 'Windows') {
    const count = num((quote.windows || {}).window_count);
    if (!count || count <= 0) return null;
    return {
      band: ref.PRICE_BANDS.windows_per_window,
      rate: round2(price / count),
      quantity: count,
      quantityLabel: `${count} window${count === 1 ? '' : 's'}`,
      disqualified: null,
    };
  }
  if (category === 'Plumbing') {
    const p = quote.plumbing || {};
    if (p.water_heater_type === 'tank') {
      return { band: ref.PRICE_BANDS.water_heater_tank, rate: price, quantity: 1, quantityLabel: 'one unit', disqualified: null };
    }
    if (p.water_heater_type === 'tankless') {
      return { band: ref.PRICE_BANDS.water_heater_tankless, rate: price, quantity: 1, quantityLabel: 'one unit', disqualified: null };
    }
    return null;
  }
  if (category === 'Electrical') {
    const amps = num((quote.electrical || {}).panel_amps);
    if (amps === 200) {
      return { band: ref.PRICE_BANDS.electrical_panel_200a, rate: price, quantity: 1, quantityLabel: 'one panel', disqualified: null };
    }
    return null;
  }
  return null;
}

check('PRICE_AGAINST_PUBLISHED_RANGE', 'The unit price sits inside published national cost ranges', {
  unmet: 'no estimate stated the quantity a published range is priced per — tons of cooling, roofing squares, '
    + 'a window count, a panel size — so there was nothing to divide the price by',
  needs: (x) => anyQuote(x, (q) => {
    const u = unitRate(q, x.category);
    return !!u && !u.disqualified;
  }),
  run: (x) => perQuote(x,
    (q) => {
      const u = unitRate(q, x.category);
      return !!u && !u.disqualified;
    },
    (q) => {
      const u = unitRate(q, x.category);
      const { band } = u;
      const inside = u.rate >= band.low && u.rate <= band.high;
      const perUnit = `${money0(u.rate)} per ${band.unit}`;
      const range = `${money0(band.low)}-${money0(band.high)}`;

      if (inside) {
        return {
          checkId: 'PRICE_AGAINST_PUBLISHED_RANGE',
          quote: q.label,
          title: `${label(q)} works out to ${perUnit}, inside the published national range`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.PUBLISHED_RANGE,
          actionability: Actionability.NONE,
          basis: `${money(contractPrice(q))} across ${u.quantityLabel} is ${perUnit}. Published national guides put `
            + `${band.label} at ${range} per ${band.unit}. Being inside a national range is not proof of a good `
            + 'price — it only means the number is not an outlier. The only real comparison is a second bid on the '
            + 'same scope.',
          citation: band.source,
          dollarImpact: null,
          detail: { rate: u.rate, low: band.low, high: band.high, unit: band.unit },
        };
      }
      const above = u.rate > band.high;
      const distance = above
        ? round2((u.rate - band.high) * u.quantity)
        : round2((band.low - u.rate) * u.quantity);
      return {
        checkId: 'PRICE_AGAINST_PUBLISHED_RANGE',
        quote: q.label,
        title: above
          ? `${label(q)} works out to ${perUnit}, above every published national range`
          : `${label(q)} works out to ${perUnit}, below every published national range`,
        severity: Severity.OUTSIDE_PUBLISHED_RANGE,
        evidence: EvidenceKind.PUBLISHED_RANGE,
        actionability: Actionability.BEFORE_SIGNING,
        basis: `${money(contractPrice(q))} across ${u.quantityLabel} is ${perUnit}. Published national guides put `
          + `${band.label} at ${range} per ${band.unit} — so this sits ${above ? 'above' : 'below'} the top`
          + `${above ? '' : ' of the bottom'} of that range by roughly ${money0(distance)} across the job. `
          + `A national range is not a local quote: ${band.caveat}`,
        recommendedAction: above
          ? 'Do not lead with the range — lead with a question. Ask what about this job puts it above what these '
            + 'guides report, and get a second bid on identical scope. If the answer is real (difficult access, '
            + 'structural work, premium equipment) it will be easy to give and the second bid will show it too.'
          : 'A price below every published range is worth as much scrutiny as one above it. Ask what is not in it: '
            + 'permit, disposal, warranty, the indoor half of the system, tear-off. A number this low is usually a '
            + 'scope difference rather than a bargain.',
        citation: band.source,
        dollarImpact: above ? distance : null,
        impactKind: above ? ImpactKind.ABOVE_PUBLISHED_RANGE : null,
        detail: { rate: u.rate, low: band.low, high: band.high, unit: band.unit },
      };
    }),
});

check('QUOTES_COMPARED', 'Your competing quotes are compared against each other', {
  unmet: 'only one priced quote was uploaded — a second one unlocks this, and it is the strongest price evidence '
    + 'in the whole report because it is your own market rather than a national average',
  needs: (x) => arr(x.quotes).filter((q) => contractPrice(q) !== null).length >= 2,
  run: (x) => {
    const priced = arr(x.quotes).filter((q) => contractPrice(q) !== null)
      .sort((a, b) => contractPrice(a) - contractPrice(b));
    const low = priced[0];
    const high = priced[priced.length - 1];
    const spread = round2(contractPrice(high) - contractPrice(low));
    const pct = round2((spread / contractPrice(low)) * 100);

    const rows = priced.map((q) => `${label(q)}: ${money(contractPrice(q))}`).join(' · ');

    return {
      checkId: 'QUOTES_COMPARED',
      title: `Your ${priced.length} quotes range ${money0(contractPrice(low))} to ${money0(contractPrice(high))}`,
      severity: spread >= 1 ? Severity.QUOTE_SPREAD : Severity.WITHIN_NORMS,
      evidence: EvidenceKind.CROSS_QUOTE,
      actionability: spread >= 1 ? Actionability.BEFORE_SIGNING : Actionability.NONE,
      basis: `${rows}. The spread is ${money(spread)}, or ${pct}% of the lowest. This is the only price comparison in `
        + 'your report drawn from your own market rather than from a published average — two contractors bidding the '
        + 'same house in the same month.',
      recommendedAction: spread >= 1
        ? 'A spread this size is almost always a scope difference before it is a pricing difference. Work through '
          + 'the apples-to-apples finding below before you conclude anyone is expensive.'
        : undefined,
      dollarImpact: spread >= 1 ? spread : null,
      impactKind: spread >= 1 ? ImpactKind.SPREAD : null,
      detail: { quotes: priced.map((q) => ({ label: q.label, price: contractPrice(q) })) },
    };
  },
});

// The differences that explain a spread. Deterministic: each dimension is a
// field the extractor either found or did not, compared across quotes.
function comparableDimensions(x) {
  const dims = [];
  const q = arr(x.quotes);

  const add = (name, getter, describe) => {
    const values = q.map((quote) => ({ label: quote.label, value: getter(quote) }));
    const known = values.filter((v) => v.value !== null && v.value !== undefined && v.value !== '' && v.value !== 'not_mentioned');
    if (known.length < 2) return;
    const distinct = new Set(known.map((v) => String(v.value)));
    if (distinct.size < 2) return;
    dims.push({ name, values: known, describe: describe(known) });
  };

  add('warranty on labour', (quote) => num(quote.warranty_labor_years),
    (known) => known.map((v) => `${v.label}: ${v.value} year${v.value === 1 ? '' : 's'}`).join(', '));
  add('warranty on materials', (quote) => num(quote.warranty_materials_years),
    (known) => known.map((v) => `${v.label}: ${v.value} year${v.value === 1 ? '' : 's'}`).join(', '));
  add('permit', (quote) => quote.permit,
    (known) => known.map((v) => `${v.label}: ${String(v.value).replace(/_/g, ' ')}`).join(', '));
  add('disposal and haul-away', (quote) => quote.haul_away_disposal,
    (known) => known.map((v) => `${v.label}: ${String(v.value).replace(/_/g, ' ')}`).join(', '));

  if (x.category === 'HVAC') {
    add('system size', (quote) => num((quote.hvac || {}).tons),
      (known) => known.map((v) => `${v.label}: ${v.value} tons`).join(', '));
    add('efficiency (SEER2)', (quote) => num((quote.hvac || {}).seer2),
      (known) => known.map((v) => `${v.label}: ${v.value} SEER2`).join(', '));
    add('refrigerant', (quote) => (quote.hvac || {}).refrigerant,
      (known) => known.map((v) => `${v.label}: ${v.value}`).join(', '));
    add('indoor unit replaced', (quote) => {
      const v = (quote.hvac || {}).indoor_unit_included;
      return v === undefined ? null : (v ? 'yes' : 'no');
    }, (known) => known.map((v) => `${v.label}: ${v.value}`).join(', '));
    add('ductwork', (quote) => (quote.hvac || {}).ductwork,
      (known) => known.map((v) => `${v.label}: ${String(v.value).replace(/_/g, ' ')}`).join(', '));
  }
  if (x.category === 'Roofing') {
    add('tear-off or overlay', (quote) => (quote.roofing || {}).tear_off,
      (known) => known.map((v) => `${v.label}: ${String(v.value).replace(/_/g, ' ')}`).join(', '));
    add('shingle', (quote) => (quote.roofing || {}).shingle_type,
      (known) => known.map((v) => `${v.label}: ${v.value}`).join(', '));
    add('ice and water shield', (quote) => (quote.roofing || {}).ice_water_shield,
      (known) => known.map((v) => `${v.label}: ${String(v.value).replace(/_/g, ' ')}`).join(', '));
    add('flashing', (quote) => (quote.roofing || {}).flashing,
      (known) => known.map((v) => `${v.label}: ${v.value}`).join(', '));
    add('roof area quoted', (quote) => num((quote.roofing || {}).squares),
      (known) => known.map((v) => `${v.label}: ${v.value} squares`).join(', '));
  }
  if (x.category === 'Windows') {
    add('number of windows', (quote) => num((quote.windows || {}).window_count),
      (known) => known.map((v) => `${v.label}: ${v.value}`).join(', '));
    add('installation method', (quote) => (quote.windows || {}).install_type,
      (known) => known.map((v) => `${v.label}: ${String(v.value).replace(/_/g, ' ')}`).join(', '));
    add('frame material', (quote) => (quote.windows || {}).frame_material,
      (known) => known.map((v) => `${v.label}: ${v.value}`).join(', '));
  }
  return dims;
}

check('QUOTES_ARE_APPLES_TO_APPLES', 'Your quotes are compared on scope, equipment and warranty, not just price', {
  unmet: 'only one quote was uploaded, so there is nothing to compare it with',
  needs: (x) => arr(x.quotes).length >= 2,
  run: (x) => {
    const dims = comparableDimensions(x);
    if (!dims.length) {
      return {
        checkId: 'QUOTES_ARE_APPLES_TO_APPLES',
        title: 'Your quotes describe the same job in the same terms, as far as they state it',
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.CROSS_QUOTE,
        actionability: Actionability.NONE,
        basis: 'On every dimension both estimates actually state — scope, equipment, warranty, permit, disposal — '
          + 'they agree. Note what that does and does not mean: where both are silent, there is nothing to compare, '
          + 'and silence on both sides is not agreement.',
        dollarImpact: null,
      };
    }
    return {
      checkId: 'QUOTES_ARE_APPLES_TO_APPLES',
      title: `Your quotes differ on ${dims.length} thing${dims.length === 1 ? '' : 's'} that change what the price buys`,
      severity: Severity.QUOTE_SPREAD,
      evidence: EvidenceKind.CROSS_QUOTE,
      actionability: Actionability.BEFORE_SIGNING,
      basis: dims.map((d) => `${d.name} — ${d.describe}`).join('. ') + '.',
      recommendedAction: 'Take the differences to the cheaper contractor first, not the dearer one. Ask them to '
        + 'requote matching the higher specification. Either the price gap closes, which tells you the gap was scope, '
        + 'or it does not, which tells you the gap was margin. Both answers are worth having before you choose.',
      dollarImpact: null,
      detail: { dimensions: dims.map((d) => ({ name: d.name, values: d.values })) },
    };
  },
});

// ===========================================================================
// 5. Sales practice and stale claims
// ===========================================================================

// Runs on every estimate, including the ones that promise nothing. The absence
// of a tax credit claim is the answer to this check, not a reason to skip it —
// and telling a homeowner that their quote does NOT rest on a credit that
// expired is worth saying, because the neighbour's quote might.
check('TAX_CREDIT_CLAIMS_STILL_VALID', 'Any tax credit the estimate promises still exists', {
  needs: (x) => arr(x.quotes).length > 0,
  run: (x) => perQuote(x, () => true,
    (q) => {
      const claims = arr(q.tax_credit_claims).filter(Boolean);
      if (!claims.length) {
        return {
          checkId: 'TAX_CREDIT_CLAIMS_STILL_VALID',
          quote: q.label,
          title: `${label(q)} does not justify its price with a federal tax credit`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.FEDERAL_STANDARD,
          actionability: Actionability.NONE,
          basis: 'Nothing on this estimate promises a federal tax credit. That matters in 2026: the Energy '
            + `Efficient Home Improvement Credit ended for property placed in service after `
            + `${ref.TAX_CREDIT_25C.expiredAfter}, and quotes still being written around it are quoting money that `
            + 'is not coming. This one is not.',
          citation: ref.TAX_CREDIT_25C.citation,
          source: ref.TAX_CREDIT_25C.source,
          dollarImpact: null,
        };
      }
      return {
        checkId: 'TAX_CREDIT_CLAIMS_STILL_VALID',
        quote: q.label,
        title: `${label(q)} sells a federal tax credit that no longer exists`,
        severity: Severity.SALES_PRESSURE,
        evidence: EvidenceKind.FEDERAL_STANDARD,
        actionability: Actionability.BEFORE_SIGNING,
        basis: `The estimate says: ${claims.map((c) => `"${c}"`).join(' ')} The Energy Efficient Home Improvement `
          + `Credit was terminated for property placed in service after ${ref.TAX_CREDIT_25C.expiredAfter}. `
          + `${ref.TAX_CREDIT_25C.note} If this work is installed in 2026 there is no federal credit behind it.`,
        recommendedAction: 'Ask them to put the credit claim in writing with the code section. Then ask for the '
          + 'price without it. A quote justified by money that is not coming should not survive the correction '
          + 'unchanged — and check any state or utility rebate separately, because those are real and are not '
          + 'affected by this.',
        citation: ref.TAX_CREDIT_25C.citation,
        source: ref.TAX_CREDIT_25C.source,
        dollarImpact: null,
      };
    }),
});

check('NO_DEADLINE_PRESSURE', 'The price is not conditioned on signing immediately', {
  needs: (x) => arr(x.quotes).length > 0,
  run: (x) => perQuote(x, () => true, (q) => {
    const pressure = arr(q.pressure_language).filter(Boolean);
    const expires = q.quote_expires;
    let shortWindow = null;
    if (expires && q.quote_date) {
      const days = Math.round((Date.parse(expires) - Date.parse(q.quote_date)) / 86400000);
      if (Number.isFinite(days) && days >= 0 && days <= 7) shortWindow = days;
    }

    if (!pressure.length && shortWindow === null) {
      return {
        checkId: 'NO_DEADLINE_PRESSURE',
        quote: q.label,
        title: `${label(q)} does not condition its price on signing immediately`,
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.NONE,
        basis: 'No same-day or expiring-price language appears on the document.',
        dollarImpact: null,
      };
    }
    return {
      checkId: 'NO_DEADLINE_PRESSURE',
      quote: q.label,
      title: `${label(q)} puts a deadline on its own price`,
      severity: Severity.SALES_PRESSURE,
      evidence: EvidenceKind.DOCUMENT_TERMS,
      actionability: Actionability.BEFORE_SIGNING,
      basis: [
        pressure.length ? `The document says: ${pressure.map((p) => `"${p}"`).join(' ')}` : null,
        shortWindow !== null ? `The quote is dated ${q.quote_date} and expires ${q.quote_expires} — a ${shortWindow}-day window.` : null,
        'Material and equipment prices do not move in a day. A price that expires tonight is a sales technique, and '
          + 'its purpose is to stop you getting the second quote that would tell you whether this one is any good.',
      ].filter(Boolean).join(' '),
      recommendedAction: 'Say you are getting one more bid and ask whether the price holds. It almost always does. '
        + 'If it genuinely does not, that is a reason to walk rather than a reason to hurry.',
      dollarImpact: null,
    };
  }),
});

check('FINANCING_COST_DISCLOSED', 'Any financing offered states its rate', {
  needs: (x) => arr(x.quotes).length > 0,
  run: (x) => perQuote(x, () => true,
    (q) => {
      if (q.financing_offered !== true) {
        return {
          checkId: 'FINANCING_COST_DISCLOSED',
          quote: q.label,
          title: `${label(q)} does not bundle financing into the sale`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.DOCUMENT_TERMS,
          actionability: Actionability.NONE,
          basis: 'No contractor-arranged financing appears on this estimate, so the price is the price.',
          dollarImpact: null,
        };
      }
      const apr = num(q.financing_apr_stated);
      const promo = q.financing_promo_text;
      if (apr !== null) {
        return {
          checkId: 'FINANCING_COST_DISCLOSED',
          quote: q.label,
          title: `${label(q)} offers financing and states the rate`,
          severity: Severity.VERIFY_YOURSELF,
          evidence: EvidenceKind.DOCUMENT_TERMS,
          actionability: Actionability.VERIFY,
          basis: `Financing is offered at ${apr}% APR${promo ? ` (${promo})` : ''}.`,
          recommendedAction: 'Ask one question: what is the cash price if I do not finance? Dealer-arranged finance '
            + 'is often paid for by a fee the lender charges the contractor and the contractor builds into the '
            + 'quote, so the cash price can be lower even when the rate looks good.',
          dollarImpact: null,
        };
      }
      return {
        checkId: 'FINANCING_COST_DISCLOSED',
        quote: q.label,
        title: `${label(q)} offers financing without stating a rate`,
        severity: Severity.SALES_PRESSURE,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.BEFORE_SIGNING,
        basis: `Financing is offered${promo ? ` — "${promo}"` : ''} with no APR on the document.`,
        recommendedAction: 'Ask for the APR, the term, what happens at the end of any promotional period, and the '
          + 'cash price without financing. A deferred-interest promotion that ends can back-charge every month of '
          + 'interest at once, and the cash price is the number that tells you what the finance is really costing.',
        dollarImpact: null,
      };
    }),
});

// ===========================================================================
// 6. HVAC
// ===========================================================================

check('HVAC_SYSTEM_IS_MATCHED', 'Both halves of the system are being replaced together', {
  appliesTo: 'HVAC',
  unmet: 'no estimate said whether the indoor coil or air handler is part of the job',
  needs: (x) => anyQuote(x, (q) => (q.hvac || {}).indoor_unit_included !== undefined),
  run: (x) => perQuote(x,
    (q) => (q.hvac || {}).indoor_unit_included !== undefined,
    (q) => {
      if (q.hvac.indoor_unit_included) {
        return {
          checkId: 'HVAC_SYSTEM_IS_MATCHED',
          quote: q.label,
          title: `${label(q)} replaces both halves of the system`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.DOCUMENT_TERMS,
          actionability: Actionability.NONE,
          basis: 'The indoor coil or air handler is in the scope alongside the outdoor unit, which is what a rated '
            + 'efficiency figure actually refers to.',
          dollarImpact: null,
        };
      }
      return {
        checkId: 'HVAC_SYSTEM_IS_MATCHED',
        quote: q.label,
        title: `${label(q)} replaces the outdoor unit and leaves the indoor coil in place`,
        severity: Severity.CHANGE_ORDER_RISK,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.BEFORE_SIGNING,
        basis: 'A SEER2 rating belongs to a matched pair, not to a condenser. Fitted to an older coil, the system '
          + 'does not deliver the rated efficiency, and most manufacturers will not honour the compressor warranty '
          + 'on an unmatched installation.',
        recommendedAction: 'Ask two things in writing: will the manufacturer warranty the compressor on this exact '
          + 'pairing, and what efficiency does the pair actually achieve. Then price the matched system so you are '
          + 'comparing the real options rather than a headline number.',
        dollarImpact: null,
        impactKind: ImpactKind.AT_RISK,
      };
    }),
});

check('HVAC_MEETS_FEDERAL_EFFICIENCY', 'The equipment meets the federal minimum efficiency for your region', {
  appliesTo: 'HVAC',
  unmet: 'no estimate printed a SEER2 rating to compare against the federal minimum',
  needs: (x) => !!ref.efficiencyRegion(x.state)
    && anyQuote(x, (q) => num((q.hvac || {}).seer2) !== null),
  run: (x) => {
    const region = ref.efficiencyRegion(x.state);
    return perQuote(x,
      (q) => num((q.hvac || {}).seer2) !== null,
      (q) => {
        const seer2 = num(q.hvac.seer2);
        const isHeatPump = /heat pump/i.test(String(q.hvac.system_type || ''));
        const minimum = isHeatPump ? region.minHeatPumpSeer2 : region.minSplitAcSeer2;
        const kind = isHeatPump ? 'heat pump' : 'split-system air conditioner';

        if (seer2 >= minimum) {
          return {
            checkId: 'HVAC_MEETS_FEDERAL_EFFICIENCY',
            quote: q.label,
            title: `The equipment on ${label(q)} meets the federal minimum for the ${region.region} region`,
            severity: Severity.WITHIN_NORMS,
            evidence: EvidenceKind.FEDERAL_STANDARD,
            actionability: Actionability.NONE,
            basis: `${seer2} SEER2 against a ${minimum} SEER2 minimum for a ${kind} in ${ref.stateName(x.state)} `
              + `(${region.region} region).`,
            citation: region.citation,
            source: region.source,
            dollarImpact: null,
          };
        }
        return {
          checkId: 'HVAC_MEETS_FEDERAL_EFFICIENCY',
          quote: q.label,
          title: `The equipment on ${label(q)} is below the federal minimum efficiency for ${ref.stateName(x.state)}`,
          severity: Severity.EXCEEDS_LEGAL_LIMIT,
          evidence: EvidenceKind.FEDERAL_STANDARD,
          actionability: Actionability.BEFORE_SIGNING,
          basis: `The quote specifies ${seer2} SEER2. The federal minimum for a ${kind} installed in `
            + `${ref.stateName(x.state)} — ${region.region} region — is ${minimum} SEER2, in force since 1 January 2023.`,
          recommendedAction: 'Ask them to confirm the model number and its SEER2 rating in writing. Either the '
            + 'rating on the quote is a typo, or it is equipment that cannot lawfully be installed in your state, '
            + 'and both are worth knowing before the crew arrives.',
          citation: region.citation,
          source: region.source,
          dollarImpact: null,
        };
      });
  },
});

check('HVAC_REFRIGERANT_GENERATION', 'You know which refrigerant generation you are buying', {
  appliesTo: 'HVAC',
  unmet: 'no estimate named the refrigerant — worth asking, because it decides what a recharge costs for the '
    + 'life of the system',
  needs: (x) => anyQuote(x, (q) => !!(q.hvac || {}).refrigerant),
  run: (x) => perQuote(x,
    (q) => !!(q.hvac || {}).refrigerant,
    (q) => {
      const r = String(q.hvac.refrigerant).toUpperCase().replace(/\s/g, '');
      const legacy = r.includes('410');
      if (!legacy) {
        return {
          checkId: 'HVAC_REFRIGERANT_GENERATION',
          quote: q.label,
          title: `${label(q)} specifies current-generation refrigerant (${q.hvac.refrigerant})`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.FEDERAL_STANDARD,
          actionability: Actionability.NONE,
          basis: `${q.hvac.refrigerant} is one of the low-GWP refrigerants that replaced R-410A in new residential `
            + 'equipment from 1 January 2025.',
          citation: ref.REFRIGERANT_TRANSITION.citation,
          source: ref.REFRIGERANT_TRANSITION.source,
          dollarImpact: null,
        };
      }
      return {
        checkId: 'HVAC_REFRIGERANT_GENERATION',
        quote: q.label,
        title: `${label(q)} specifies R-410A — the previous refrigerant generation`,
        severity: Severity.CHANGE_ORDER_RISK,
        evidence: EvidenceKind.FEDERAL_STANDARD,
        actionability: Actionability.BEFORE_SIGNING,
        basis: 'This is not a violation and it is worth being clear about that: manufacture of new residential '
          + 'R-410A systems ended on 1 January 2025 under the EPA AIM Act phasedown, but installing remaining stock '
          + 'was never prohibited. What it means is that you are buying an outgoing platform, and that R-410A gets '
          + 'scarcer and dearer across the life of the system every time it needs a recharge.',
        recommendedAction: 'Two questions. What does the same job cost with an R-454B or R-32 system? And, since '
          + 'this is stock the distributor wants to clear, what is the discount for taking it? One of those two '
          + 'answers is worth money to you.',
        citation: ref.REFRIGERANT_TRANSITION.citation,
        source: ref.REFRIGERANT_TRANSITION.source,
        dollarImpact: null,
      };
    }),
});

check('HVAC_SIZED_TO_THE_HOUSE', 'The system size is plausible for the house', {
  appliesTo: 'HVAC',
  unmet: 'this needs both the system size in tons from the estimate and your home size from the intake form',
  needs: (x) => num(x.homeSqft) !== null && anyQuote(x, (q) => num((q.hvac || {}).tons) !== null),
  run: (x) => perQuote(x,
    (q) => num((q.hvac || {}).tons) !== null,
    (q) => {
      const tons = num(q.hvac.tons);
      const sqft = num(x.homeSqft);
      const perTon = Math.round(sqft / tons);
      const rule = ref.SIZING_RULE;
      const inRange = perTon >= rule.sqftPerTonLow && perTon <= rule.sqftPerTonHigh;

      if (inRange) {
        return {
          checkId: 'HVAC_SIZED_TO_THE_HOUSE',
          quote: q.label,
          title: `${tons} tons is a plausible size for ${sqft.toLocaleString('en-US')} sq ft`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.PUBLISHED_RANGE,
          actionability: Actionability.NONE,
          basis: `${sqft.toLocaleString('en-US')} sq ft across ${tons} tons is ${perTon} sq ft per ton, inside the `
            + `conventional ${rule.sqftPerTonLow}-${rule.sqftPerTonHigh} rule of thumb. A rule of thumb is not a load `
            + 'calculation; it only tells you the size is not obviously wrong.',
          citation: rule.citation,
          dollarImpact: null,
        };
      }
      const oversized = perTon < rule.sqftPerTonLow;
      return {
        checkId: 'HVAC_SIZED_TO_THE_HOUSE',
        quote: q.label,
        title: oversized
          ? `${tons} tons may be oversized for ${sqft.toLocaleString('en-US')} sq ft`
          : `${tons} tons may be undersized for ${sqft.toLocaleString('en-US')} sq ft`,
        severity: Severity.CHANGE_ORDER_RISK,
        evidence: EvidenceKind.PUBLISHED_RANGE,
        actionability: Actionability.BEFORE_SIGNING,
        basis: `${sqft.toLocaleString('en-US')} sq ft across ${tons} tons is ${perTon} sq ft per ton, outside the `
          + `conventional ${rule.sqftPerTonLow}-${rule.sqftPerTonHigh} range. ${oversized ? rule.note : ''} `
          + 'Climate, insulation, windows and ceiling height all move the real answer, which is why the real answer '
          + 'is a load calculation rather than a rule of thumb.',
        recommendedAction: 'Ask for the Manual J load calculation this size came from. If there is not one, that is '
          + 'the finding: the size was picked off the old unit or off square footage, and replacing like-for-like '
          + 'repeats whatever mistake was made last time. A contractor who runs one is worth paying more.',
        citation: rule.citation,
        source: rule.source,
        dollarImpact: null,
      };
    }),
});

check('HVAC_LOAD_CALCULATION', 'A load calculation is behind the equipment size', {
  appliesTo: 'HVAC',
  unmet: 'the estimates carried no HVAC equipment detail at all',
  needs: (x) => anyQuote(x, (q) => !!q.hvac),
  run: (x) => perQuote(x,
    (q) => !!q.hvac,
    (q) => {
      if (q.hvac.load_calculation_mentioned) {
        return {
          checkId: 'HVAC_LOAD_CALCULATION',
          quote: q.label,
          title: `${label(q)} mentions a load calculation`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.DOCUMENT_TERMS,
          actionability: Actionability.NONE,
          basis: 'The document refers to a load calculation or Manual J. Ask for the printout anyway — it is a '
            + 'document, and a contractor who has run one will have it.',
          dollarImpact: null,
        };
      }
      return {
        checkId: 'HVAC_LOAD_CALCULATION',
        quote: q.label,
        title: `${label(q)} does not mention a load calculation`,
        severity: Severity.CHANGE_ORDER_RISK,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.BEFORE_SIGNING,
        basis: 'Nothing on the estimate says the size came from a Manual J load calculation. The common alternative '
          + 'is matching whatever is there now, which carries forward the previous installer\'s guess and any '
          + 'insulation or window work done since.',
        recommendedAction: 'Ask whether a Manual J was run and ask for the printout. This is the question that most '
          + 'reliably separates contractors, and it costs you nothing to ask all of them.',
        citation: ref.SIZING_RULE.citation,
        dollarImpact: null,
      };
    }),
});

check('HVAC_LINE_SET_ADDRESSED', 'The estimate says what happens to the refrigerant line set', {
  appliesTo: 'HVAC',
  unmet: 'the estimates carried no refrigerant or line set detail',
  needs: (x) => anyQuote(x, (q) => !!q.hvac && !!(q.hvac.refrigerant || q.hvac.line_set)),
  run: (x) => perQuote(x,
    (q) => !!q.hvac && !!(q.hvac.refrigerant || q.hvac.line_set),
    (q) => {
      const state = q.hvac.line_set || 'not_mentioned';
      if (state === 'replaced' || state === 'flushed') {
        return {
          checkId: 'HVAC_LINE_SET_ADDRESSED',
          quote: q.label,
          title: `${label(q)} says what happens to the line set (${state})`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.DOCUMENT_TERMS,
          actionability: Actionability.NONE,
          basis: 'The refrigerant lines are addressed in the scope rather than assumed.',
          dollarImpact: null,
        };
      }
      return {
        checkId: 'HVAC_LINE_SET_ADDRESSED',
        quote: q.label,
        title: `${label(q)} does not say what happens to the refrigerant line set`,
        severity: Severity.CHANGE_ORDER_RISK,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.BEFORE_SIGNING,
        basis: 'Reusing existing lines without flushing carries the old oil into the new compressor, and the '
          + 'refrigerant change makes the oils incompatible. It is a classic "we found a problem" line item on the '
          + 'day of installation, priced with the crew already in your driveway.',
        recommendedAction: 'Ask now whether the line set is being replaced, flushed, or reused as is — and get the '
          + 'price for the answer written into the estimate rather than discovered on the day.',
        dollarImpact: null,
        impactKind: ImpactKind.AT_RISK,
      };
    }),
});

// ===========================================================================
// 7. Roofing
// ===========================================================================

check('ROOF_TEAR_OFF_OR_OVERLAY', 'The estimate says whether the old roof comes off', {
  appliesTo: 'Roofing',
  unmet: 'the estimates carried no roofing detail we could read',
  needs: (x) => anyQuote(x, (q) => !!q.roofing),
  run: (x) => perQuote(x,
    (q) => !!q.roofing,
    (q) => {
      const t = q.roofing.tear_off || 'not_mentioned';
      if (t === 'full_tear_off') {
        return {
          checkId: 'ROOF_TEAR_OFF_OR_OVERLAY',
          quote: q.label,
          title: `${label(q)} tears the old roof off`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.DOCUMENT_TERMS,
          actionability: Actionability.NONE,
          basis: 'A full tear-off is in the scope, which is what lets the decking be inspected before the new roof '
            + 'goes over it.',
          dollarImpact: null,
        };
      }
      if (t === 'overlay') {
        return {
          checkId: 'ROOF_TEAR_OFF_OR_OVERLAY',
          quote: q.label,
          title: `${label(q)} lays the new roof over the old one`,
          severity: Severity.CHANGE_ORDER_RISK,
          evidence: EvidenceKind.DOCUMENT_TERMS,
          actionability: Actionability.BEFORE_SIGNING,
          basis: 'An overlay is cheaper now and costs more later: nobody sees the decking, the roof runs hotter, the '
            + 'shingle warranty is often reduced or void, and the next replacement has two layers to remove. Most '
            + 'codes also cap a roof at two layers total.',
          recommendedAction: 'Ask for the tear-off price alongside this one, ask how many layers are up there now, '
            + 'and ask what the shingle manufacturer warrants on an overlay. Then decide with all three numbers.',
          dollarImpact: null,
          impactKind: ImpactKind.AT_RISK,
        };
      }
      return {
        checkId: 'ROOF_TEAR_OFF_OR_OVERLAY',
        quote: q.label,
        title: `${label(q)} does not say whether the old roof comes off`,
        severity: Severity.CHANGE_ORDER_RISK,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.BEFORE_SIGNING,
        basis: 'Tear-off versus overlay is the largest single variable in a roofing price and this estimate does not '
          + 'state which one it is. Two quotes cannot be compared until both answer it.',
        recommendedAction: 'Get it in writing, along with the number of existing layers being removed.',
        dollarImpact: null,
      };
    }),
});

check('ROOF_DETAILS_SPECIFIED', 'The estimate specifies the parts of a roof that leak', {
  appliesTo: 'Roofing',
  unmet: 'the estimates carried no roofing detail we could read',
  needs: (x) => anyQuote(x, (q) => !!q.roofing),
  run: (x) => perQuote(x,
    (q) => !!q.roofing,
    (q) => {
      const r = q.roofing;
      const missing = [];
      if (!r.underlayment || r.underlayment === 'not_mentioned') missing.push('underlayment');
      if (!r.drip_edge || r.drip_edge === 'not_mentioned') missing.push('drip edge');
      if (!r.ventilation || r.ventilation === 'not_mentioned') missing.push('ventilation');
      if (!r.flashing || r.flashing === 'not_mentioned') missing.push('flashing');
      if (!r.ice_water_shield || r.ice_water_shield === 'not_mentioned') missing.push('ice and water shield at the eaves');

      if (!missing.length) {
        return {
          checkId: 'ROOF_DETAILS_SPECIFIED',
          quote: q.label,
          title: `${label(q)} specifies underlayment, drip edge, flashing, ventilation and ice barrier`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.DOCUMENT_TERMS,
          actionability: Actionability.NONE,
          basis: 'Every detail that decides whether a roof leaks is named in the scope rather than assumed.',
          dollarImpact: null,
        };
      }
      const reused = r.flashing === 'reused';
      return {
        checkId: 'ROOF_DETAILS_SPECIFIED',
        quote: q.label,
        title: `${label(q)} does not specify ${missing.length === 1 ? missing[0] : `${missing.length} details that decide whether a roof leaks`}`,
        severity: Severity.CHANGE_ORDER_RISK,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.BEFORE_SIGNING,
        basis: `Not stated: ${missing.join(', ')}. Shingles are rarely what fails — roofs leak at the edges, the `
          + 'valleys and the penetrations, and every item on that list is one of those.'
          + (reused ? ' This estimate also reuses existing flashing, which is the most common source of a leak on a new roof.' : ''),
        recommendedAction: 'Ask for each of these written into the scope by name and material. Whether an ice barrier '
          + 'is required at your eaves depends on local ice-damming history under the building code, so ask that one '
          + 'as a question rather than a demand — but ask it.',
        dollarImpact: null,
      };
    }),
});

check('ROOF_DECKING_TERMS', 'The price for replacing rotten decking is agreed in advance', {
  appliesTo: 'Roofing',
  unmet: 'the estimates carried no roofing detail we could read',
  needs: (x) => anyQuote(x, (q) => !!q.roofing),
  run: (x) => perQuote(x,
    (q) => !!q.roofing,
    (q) => {
      if (q.roofing.decking_terms) {
        return {
          checkId: 'ROOF_DECKING_TERMS',
          quote: q.label,
          title: `${label(q)} prices decking replacement in advance`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.DOCUMENT_TERMS,
          actionability: Actionability.NONE,
          basis: `The document states the terms: "${q.roofing.decking_terms}"`,
          dollarImpact: null,
        };
      }
      return {
        checkId: 'ROOF_DECKING_TERMS',
        quote: q.label,
        title: `${label(q)} does not price decking replacement`,
        severity: Severity.CHANGE_ORDER_RISK,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.BEFORE_SIGNING,
        basis: 'Rotten decking is found after the old roof is off, which is the moment your leverage is lowest: the '
          + 'roof is open, the crew is on it, and the price for each sheet has not been agreed. This is the most '
          + 'common change order in roofing.',
        recommendedAction: 'Agree a per-sheet price in writing now, and ask to be shown and photographed any sheet '
          + 'they intend to charge for. Some contractors include a few sheets in the base price — ask how many.',
        dollarImpact: null,
        impactKind: ImpactKind.AT_RISK,
      };
    }),
});

// ===========================================================================
// 8. Windows
// ===========================================================================

check('WINDOW_INSTALL_METHOD', 'The estimate says which kind of window installation you are buying', {
  appliesTo: 'Windows',
  unmet: 'the estimates carried no window detail we could read',
  needs: (x) => anyQuote(x, (q) => !!q.windows),
  run: (x) => perQuote(x,
    (q) => !!q.windows,
    (q) => {
      const t = (q.windows || {}).install_type || 'not_stated';
      if (t !== 'not_stated') {
        return {
          checkId: 'WINDOW_INSTALL_METHOD',
          quote: q.label,
          title: `${label(q)} states the installation method (${t.replace(/_/g, ' ')})`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.DOCUMENT_TERMS,
          actionability: Actionability.NONE,
          basis: t === 'insert'
            ? 'An insert fits inside the existing frame: cheaper and faster, but it keeps the old frame and loses a '
              + 'little glass area.'
            : 'A full-frame replacement takes the old frame out, which is what lets rot and flashing behind it be '
              + 'seen and fixed.',
          dollarImpact: null,
        };
      }
      return {
        checkId: 'WINDOW_INSTALL_METHOD',
        quote: q.label,
        title: `${label(q)} does not say whether these are inserts or full-frame replacements`,
        severity: Severity.CHANGE_ORDER_RISK,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.BEFORE_SIGNING,
        basis: 'These are different jobs at different prices and two quotes cannot be compared until both say which '
          + 'one they are. A full-frame job also finds and fixes rot an insert simply covers over.',
        recommendedAction: 'Ask which method is quoted, and ask what happens to interior trim and exterior capping — '
          + 'a window price that excludes finishing the opening is not a finished window.',
        dollarImpact: null,
      };
    }),
});

check('WINDOW_FINISHING_INCLUDED', 'Trim and exterior capping are in the price', {
  appliesTo: 'Windows',
  unmet: 'the estimates carried no window detail we could read',
  needs: (x) => anyQuote(x, (q) => !!q.windows),
  run: (x) => perQuote(x,
    (q) => !!q.windows,
    (q) => {
      const w = q.windows;
      const missing = [];
      if (!w.interior_trim || w.interior_trim === 'not_mentioned') missing.push('interior trim');
      else if (w.interior_trim === 'excluded') missing.push('interior trim (explicitly excluded)');
      if (!w.exterior_capping || w.exterior_capping === 'not_mentioned') missing.push('exterior capping');
      else if (w.exterior_capping === 'excluded') missing.push('exterior capping (explicitly excluded)');

      if (!missing.length) {
        return {
          checkId: 'WINDOW_FINISHING_INCLUDED',
          quote: q.label,
          title: `${label(q)} includes finishing the openings`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.DOCUMENT_TERMS,
          actionability: Actionability.NONE,
          basis: 'Interior trim and exterior capping are both addressed in the scope.',
          dollarImpact: null,
        };
      }
      return {
        checkId: 'WINDOW_FINISHING_INCLUDED',
        quote: q.label,
        title: `${label(q)} does not include ${missing.join(' or ')}`,
        severity: Severity.CHANGE_ORDER_RISK,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.BEFORE_SIGNING,
        basis: `Not covered: ${missing.join(', ')}. A window that is in but not finished leaves you hiring a `
          + 'carpenter and a painter to complete a job you thought you had bought.',
        recommendedAction: 'Ask for finishing to be priced into the quote, inside and out, and confirm who paints.',
        dollarImpact: null,
        impactKind: ImpactKind.AT_RISK,
      };
    }),
});

// ===========================================================================
// 9. Disposal — applies everywhere and is forgotten everywhere
// ===========================================================================

check('DISPOSAL_INCLUDED', 'Removing and disposing of the old equipment is in the price', {
  needs: (x) => arr(x.quotes).length > 0,
  run: (x) => perQuote(x, () => true, (q) => {
    const d = q.haul_away_disposal || 'not_mentioned';
    if (d === 'included') {
      return {
        checkId: 'DISPOSAL_INCLUDED',
        quote: q.label,
        title: `${label(q)} includes removing the old material`,
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.DOCUMENT_TERMS,
        actionability: Actionability.NONE,
        basis: 'Haul-away and disposal are stated as included.',
        dollarImpact: null,
      };
    }
    return {
      checkId: 'DISPOSAL_INCLUDED',
      quote: q.label,
      title: d === 'not_mentioned'
        ? `${label(q)} does not say who removes the old material`
        : `${label(q)} leaves removing the old material to you`,
      severity: Severity.CHANGE_ORDER_RISK,
      evidence: EvidenceKind.DOCUMENT_TERMS,
      actionability: Actionability.BEFORE_SIGNING,
      basis: 'Tear-off debris, an old furnace, a tank water heater or twenty window sashes all have to go somewhere, '
        + 'and disposal fees are a normal separate charge. It is only a problem when it appears after the price is '
        + 'agreed.',
      recommendedAction: 'Confirm in writing that removal, disposal and the dumpster are included, or get the figure '
        + 'if they are not — and compare it against the other quotes, which may be quietly including it.',
      dollarImpact: null,
    };
  }),
});

// --- running the catalog ----------------------------------------------------

function rankFindings(findings) {
  return findings.slice().sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    return (b.dollarImpact || 0) - (a.dollarImpact || 0);
  });
}

function applies(entry, category) {
  return entry.appliesTo === 'all' || entry.appliesTo === category;
}

// Returns every finding the documents support, plus the names of the checks
// that could not run. A homeowner is owed both: the second list is why their
// report is shorter than it might have been, and saying nothing implies a pass.
//
// `context` carries what the intake form asked and the documents cannot say:
// the state (which statute, which efficiency region, which licensing board),
// the home's size (whether the equipment size is plausible) and whether the
// quote was given during a visit to the home (whether the federal cancellation
// right attaches at all).
function runContractorAudit(extraction, context) {
  const ctx = context || {};
  const x = Object.assign({}, extraction || {}, {
    state: String(ctx.state || '').toUpperCase() || null,
    homeSqft: num(ctx.homeSqft),
    signedAtHome: ctx.signedAtHome === true ? true : (ctx.signedAtHome === false ? false : null),
    // The customer's answer wins.
    //
    // The extractor also classifies the trade, and letting it override would
    // repeat the defect this rebuild removed from the intake form: a roofer
    // whose quote was analysed as an HVAC job, silently, after paying. The
    // homeowner knows what they are having done. The model's classification is
    // used only to fill the gap they left — when they picked "Other", or when
    // the form predates this field.
    category: (ctx.category && ctx.category !== 'Other')
      ? ctx.category
      : ((extraction && extraction.category) || ctx.category || 'Other'),
  });
  x.quotes = arr(x.quotes);

  const applicable = CATALOG.filter((entry) => applies(entry, x.category));
  const findings = [];
  const skipped = [];
  let silentlySkipped = 0;

  for (const entry of applicable) {
    let ok = false;
    try { ok = !!entry.needs(x); } catch (err) { ok = false; }
    if (!ok) {
      if (entry.silentSkip) silentlySkipped += 1;
      else skipped.push(entry.unmet ? `${entry.label} — ${entry.unmet}` : entry.label);
      continue;
    }

    let result = null;
    try {
      result = entry.run(x);
    } catch (err) {
      // One check throwing on an odd document must not cost the customer the
      // other thirty.
      skipped.push(`${entry.label} (could not be computed)`);
      continue;
    }
    const produced = (Array.isArray(result) ? result : [result]).filter(Boolean);
    if (!produced.length) {
      if (entry.silentSkip) silentlySkipped += 1;
      else skipped.push(entry.unmet ? `${entry.label} — ${entry.unmet}` : entry.label);
      continue;
    }
    findings.push(...produced);
  }

  // Coverage, returned as a pair rather than left for the reader to count.
  //
  // "We found nothing wrong" is two completely different results and the report
  // has to say which one the customer got. An itemised estimate where
  // twenty-six checks ran and passed has been examined and is fine. A phone
  // photograph of a handwritten quote where six ran is a statement about the
  // document, not about the contractor — and a homeowner who reads the first
  // sentence and stops must not walk away believing the second was the first.
  //
  // It is also the number that decides the refund. See api/_lib/
  // contractor-engine.js: below the floor, the customer's money goes back
  // without them having to ask.
  return {
    findings: rankFindings(findings),
    skipped,
    checksRun: applicable.length - silentlySkipped - skipped.length,
    checksTotal: applicable.length - silentlySkipped,
    category: x.category,
  };
}

// How many checks a category can run at best. The page prints these, so they
// come from the catalog rather than from a number typed into HTML. Complement
// checks are excluded for the same reason they are excluded from coverage: only
// one of a pair can ever run, so counting both would advertise a check that
// does not exist.
function checkCountFor(category) {
  const mine = CATALOG.filter((entry) => applies(entry, category));
  const singles = mine.filter((entry) => !entry.pair).length;
  const pairs = new Set(mine.filter((entry) => entry.pair).map((entry) => entry.pair)).size;
  return singles + pairs;
}

module.exports = {
  runContractorAudit,
  rankFindings,
  checkCountFor,
  CATALOG,
  Severity,
  SEVERITY_ORDER,
  EvidenceKind,
  Actionability,
  ImpactKind,
  _internal: { num, money, money0, round2, unitRate, comparableDimensions, pricedItems, itemisedTotal },
};
