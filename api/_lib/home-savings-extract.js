// Household bill extraction for Home Savings Navigator.
//
// Split of responsibility, and the reason this file exists:
//   * The model TRANSCRIBES. It reads the statement and reports the lines that
//     are printed on it — label, amount, page — with a confidence score per
//     reading. It does not classify anything and it does not judge anything.
//   * This file CLASSIFIES, deterministically. Whether a line called
//     "Xfinity xFi Complete" is rented equipment, a pass-through tax, or the
//     base service is decided by the pattern table below, not by the model.
//   * navigator-home-savings-engine.js DECIDES. Every finding, figure and
//     refusal comes from its seven checks.
//   * The model then WRITES UP the decisions (see navigator-engine.js).
//
// Keeping transcription and classification apart is the whole point, and it is
// the part that was missing. A model asked to do both will quietly decide that
// "Broadcast TV Fee" is an add-on the customer could drop — it is not, it is
// mandatory — and a customer will spend twenty minutes on the phone being told
// no. The same model asked only "what does this line say, and what is the
// number beside it" is doing OCR with a schema, which is what it is good at.
//
// This is the same split closing-extract.js and rental-extract.js already run.
// See docs/HOME-SAVINGS-AUDIT.md.

'use strict';

const EXTRACT_MODEL = 'claude-sonnet-5';

// Same threshold and the same helper shape as closing-extract.js. Below this a
// reading is discarded rather than used: a wrong amount costs the customer a
// phone call they lose, a discarded one costs them a question they can answer.
const CONF_THRESHOLD = 0.85;
const confident = (o) => o && typeof o.confidence === 'number' && o.confidence >= CONF_THRESHOLD;
const val = (o) => (confident(o) ? o.value : null);

/* ---------------------------------------------------------- the schema

   Every object carrying a confidence score REQUIRES it — see
   tests/extraction-schema.test.js, which exists because an optional
   confidence field is a silent off switch: the model omits it, a perfectly
   good reading is discarded, and the check never runs.
   ---------------------------------------------------------------------- */

const CONFIDENCE_DESC =
  'Your confidence that you read this correctly, 0 to 1. Below 0.85 the value is discarded '
  + 'rather than used. Score honestly — a low score costs the customer a question, a wrong '
  + 'value costs them a phone call they will lose. If the text is faint, cropped, ambiguous, '
  + 'or you are inferring it rather than reading it, score it below 0.85.';

const amountField = (desc) => ({
  type: 'object',
  description: desc,
  properties: {
    value: { type: 'number', description: 'The dollar amount as printed, no currency symbol. Negative for a credit or discount.' },
    confidence: { type: 'number', description: CONFIDENCE_DESC },
  },
  required: ['value', 'confidence'],
});

const dateField = (desc) => ({
  type: 'object',
  description: desc,
  properties: {
    value: { type: 'string', description: 'ISO date, YYYY-MM-DD, exactly as printed. Do not infer a date that is not on the document.' },
    confidence: { type: 'number', description: CONFIDENCE_DESC },
  },
  required: ['value', 'confidence'],
});

const EXTRACT_TOOL = {
  name: 'record_household_bills',
  description: 'Record what is printed on each uploaded bill. Transcribe only — do not classify, '
    + 'judge, or decide whether anything is worth cancelling.',
  input_schema: {
    type: 'object',
    properties: {
      bills: {
        type: 'array',
        description: 'One entry per distinct bill or statement in the upload. If several pages '
          + 'belong to one statement, they are one bill.',
        items: {
          type: 'object',
          properties: {
            provider: {
              type: 'string',
              description: 'The company name as printed on the statement, e.g. "Xfinity", '
                + '"Verizon", "State Farm". Not a guess — if no name is legible, use "".',
            },
            service_hint: {
              type: 'string',
              description: 'What the statement calls the service, as printed — e.g. "Internet", '
                + '"Wireless", "Auto Policy", "Electric Service". Empty string if unclear. This '
                + 'is a transcription, not a classification.',
            },
            statement_date: dateField('The statement or bill date as printed.'),
            total_due: amountField('The total amount due on this statement.'),
            prior_period_amount: amountField(
              'The previous or prior-period amount, IF the statement prints one (many bills show '
              + '"Previous balance", "Last month" or a 12-month history graph). Omit entirely if '
              + 'the statement does not show it — never infer or calculate it.'
            ),
            promo_end_date: dateField(
              'The date a promotional or introductory rate ends, IF printed (often "Your '
              + 'promotional rate ends on ...", "Price good through ...", or a footnote). Omit '
              + 'entirely if no such date appears.'
            ),
            standard_rate_after_promo: amountField(
              'The monthly amount the bill says it will become when the promotion ends, IF '
              + 'printed. Omit entirely if not stated.'
            ),
            instalment_payments_made: {
              type: 'object',
              description: 'IF the bill prints device instalment progress such as "Payment 24 of '
                + '24" or "18 of 24 payments". Omit entirely if not shown.',
              properties: {
                made: { type: 'number', description: 'Payments made so far, as printed.' },
                total: { type: 'number', description: 'Total payments in the agreement, as printed.' },
                confidence: { type: 'number', description: CONFIDENCE_DESC },
              },
              required: ['made', 'total', 'confidence'],
            },
            line_items: {
              type: 'array',
              description: 'Every charge, fee, credit and discount line printed on the statement, '
                + 'in the order they appear. Transcribe the label exactly as printed — do not '
                + 'tidy it, expand an abbreviation, or group lines together. Include taxes, '
                + 'surcharges and credits: deciding what they are is not your job.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'The line label exactly as printed.' },
                  amount: { type: 'number', description: 'The amount beside it. Negative for a credit or discount.' },
                  monthly: {
                    type: 'boolean',
                    description: 'True if this line is a recurring monthly charge, false if it is '
                      + 'a one-off (an activation fee, a late fee, a prorated adjustment). If the '
                      + 'statement does not make it clear, use true — a recurring charge wrongly '
                      + 'marked one-off disappears from the audit entirely.',
                  },
                  confidence: { type: 'number', description: CONFIDENCE_DESC },
                },
                required: ['label', 'amount', 'monthly', 'confidence'],
              },
            },
          },
          required: ['provider', 'service_hint', 'line_items'],
        },
      },
    },
    required: ['bills'],
  },
};

const EXTRACT_SYSTEM = `You are transcribing household bills so that a separate deterministic engine can audit them.

Your only job is to report what is printed. You are doing careful OCR with a schema.

- Transcribe every line item exactly as labelled. Do not tidy, expand, translate or group.
- Include taxes, surcharges, regulatory fees and credits. Deciding what those are is not your job and you must not filter them out.
- Never classify. Do not decide that something is an add-on, an equipment rental, or a fee the customer could avoid. A downstream pattern table does that, and it is auditable in a way you are not.
- Never judge. Do not comment on whether anything looks expensive, unnecessary or worth cancelling.
- Never infer a value that is not printed. If the statement does not show a prior-period amount, omit that field — do not compute one from a balance. If no promotional end date appears, omit it.
- Score confidence honestly and per reading. A cropped, faint or ambiguous figure belongs below 0.85, where it is discarded rather than used.
- If the upload contains several statements, return several bills. If several pages are one statement, return one bill.`;

/* -------------------------------------------------- deterministic classifier

   The part that used to be the model's judgement and is now a table.

   Order matters and the exclusions come first. "Equipment Return Credit"
   contains "equipment"; "Broadcast TV Fee" looks like an add-on and is
   mandatory; "Regional Sports Fee" is not a sports package. Each of those
   would have been a finding that sends a customer to argue for something they
   cannot have.
   ---------------------------------------------------------------------- */

const Category = {
  EQUIPMENT: 'equipment',
  INSTALMENT: 'instalment',
  ADDON: 'addon_candidate',
  AUTOPAY_DISCOUNT: 'autopay_discount',
  PROMO_DISCOUNT: 'promo_discount',
  TAX_OR_FEE: 'tax_or_fee',
  CREDIT: 'credit',
  BASE_SERVICE: 'base_service',
  UNKNOWN: 'unknown',
};

// Pass-through and mandatory charges. Nothing here is droppable by asking, so
// nothing here may become an add-on candidate. Broadcast TV and Regional
// Sports are the two that catch people out: they are unavoidable on a TV
// package and they are labelled exactly like something optional.
const TAX_OR_FEE_RE = new RegExp([
  /\btax(es)?\b/, /\bsurcharge/, /\bregulatory\b/, /\b9-?1-?1\b/, /\buniversal service\b/,
  /\bfranchise fee\b/, /\bfcc\b/, /\bgross receipts\b/, /\bcost recovery\b/,
  /\bbroadcast tv\b/, /\bregional sports\b/, /\bright[- ]of[- ]way\b/, /\bstate\b.*\bfee\b/,
  /\bcity\b.*\bfee\b/, /\bcounty\b.*\bfee\b/, /\bdeposit\b/, /\blate fee\b/,
  /\bpublic (purpose|goods)\b/, /\bdelivery (charge|service)\b/, /\bdistribution charge\b/,
  /\bsupply charge\b/, /\bmeter charge\b/, /\bbasic service charge\b/,
].map((r) => r.source).join('|'), 'i');

// A negative line. Credits and discounts are already in the customer's favour,
// and recommending the removal of one would be the worst finding this product
// could produce.
const CREDIT_RE = /\b(credit|discount|adjustment|refund|rebate|savings|promo(tion(al)?)? ?(credit|discount)?)\b/i;

const AUTOPAY_RE = /\b(auto ?pay|autopay|auto-?payment|paperless|e-?bill|ecobill|paper ?free)\b/i;

const PROMO_RE = /\b(promo(tion(al)?)?|introductory|intro (rate|offer|price)|new customer|welcome|loyalty|bundle) ?(discount|credit|offer|rate)?\b/i;

const EQUIPMENT_RE = new RegExp([
  /\bequipment\b/, /\bgateway\b/, /\bmodem\b/, /\brouter\b/, /\bset-?top\b/, /\bcable box\b/,
  /\breceiver\b/, /\bdvr\b/, /\bwi-?fi (rental|equipment|gateway)\b/, /\bxfi complete\b/,
  /\bhome ?base\b/, /\bwireless gateway\b/, /\btv box\b/, /\bhd (box|receiver)\b/,
  /\brental (fee|charge)\b/, /\bmonitoring (equipment|panel)\b/,
].map((r) => r.source).join('|'), 'i');

const INSTALMENT_RE = new RegExp([
  /\bdevice (payment|instal?lment|charge|agreement)\b/, /\binstal?lment (plan|agreement|payment)\b/,
  /\bphone payment\b/, /\bequipment instal?lment\b/, /\bpayment \d+ of \d+\b/,
  /\bdevice payment plan\b/, /\bannual upgrade\b/,
].map((r) => r.source).join('|'), 'i');

const ADDON_RE = new RegExp([
  /\bwire maintenance\b/, /\binside wire\b/, /\bwiring (plan|protection)\b/,
  /\bprotection plan\b/, /\bdevice protection\b/, /\bhandset protection\b/,
  /\bpremium tech\b/, /\btech support\b/, /\bidentity (theft|protection)\b/,
  /\bvoicemail to text\b/, /\binternational (calling|plan|pack)\b/,
  /\bhbo\b/, /\bshowtime\b/, /\bstarz\b/, /\bcinemax\b/, /\bepix\b/, /\bmax\b/,
  /\bsports (package|pack|plus)\b/, /\bpremium channel\b/, /\bmovie (pack|package)\b/,
  /\bentertainment (pack|package)\b/, /\bcloud dvr\b/, /\bextra (data|line|storage)\b/,
  /\broadside (assistance|cover(age)?)\b/, /\brental (car|reimbursement)\b/,
  /\btowing\b/, /\bglass cover(age)?\b/, /\bpet cover(age)?\b/, /\baccident forgiveness\b/,
  /\bhome ?tech\b/, /\bappliance (plan|cover(age)?)\b/, /\bservice (plan|contract)\b/,
  /\bequipment protection\b/,
].map((r) => r.source).join('|'), 'i');

// The plan itself. Never a finding — cancelling the service is not what this
// product is for.
const BASE_SERVICE_RE = new RegExp([
  /\b(internet|broadband|fiber|fibre)\b(?!.*\b(equipment|rental)\b)/,
  /\bunlimited (plan|data|talk)\b/, /\bvoice (line|service)\b/,
  /\b(bodily injury|property damage|comprehensive|collision|liability|uninsured|medical payments)\b/,
  /\bmembership (fee|dues)\b/, /\bmonthly (plan|service|membership)\b/,
  /\bbase (rate|charge|plan)\b/, /\benergy charge\b/, /\bgeneration charge\b/,
].map((r) => r.source).join('|'), 'i');

/**
 * Classify one transcribed line. Pure, total, and the single place the product
 * decides what a bill line IS.
 */
function classifyLine(label, amount) {
  const l = String(label || '').trim();
  if (!l) return Category.UNKNOWN;

  // 1. Anything in the customer's favour. Checked first and unconditionally:
  //    a negative amount is a credit whatever it is called.
  if (typeof amount === 'number' && amount < 0) {
    if (AUTOPAY_RE.test(l)) return Category.AUTOPAY_DISCOUNT;
    if (PROMO_RE.test(l)) return Category.PROMO_DISCOUNT;
    return Category.CREDIT;
  }
  if (CREDIT_RE.test(l) && !/\bcredit (check|report|score)\b/i.test(l)) {
    if (AUTOPAY_RE.test(l)) return Category.AUTOPAY_DISCOUNT;
    if (PROMO_RE.test(l)) return Category.PROMO_DISCOUNT;
    return Category.CREDIT;
  }

  // 2. Mandatory and pass-through. Before every positive pattern, because
  //    "Broadcast TV Fee" and "Regional Sports Fee" read as optional extras
  //    and are not.
  if (TAX_OR_FEE_RE.test(l)) return Category.TAX_OR_FEE;

  // 3. The positives, most specific first.
  if (INSTALMENT_RE.test(l)) return Category.INSTALMENT;
  if (EQUIPMENT_RE.test(l)) return Category.EQUIPMENT;
  if (ADDON_RE.test(l)) return Category.ADDON;

  // 4. The service itself.
  if (BASE_SERVICE_RE.test(l)) return Category.BASE_SERVICE;

  return Category.UNKNOWN;
}

/* ------------------------------------------------------------- normalizing */

function normalizeExtraction(raw) {
  const x = raw && typeof raw === 'object' ? raw : {};
  const bills = Array.isArray(x.bills) ? x.bills : [];
  return {
    bills: bills.map((b) => ({
      provider: String((b && b.provider) || '').trim(),
      serviceHint: String((b && b.service_hint) || '').trim(),
      statementDate: b && b.statement_date ? b.statement_date : null,
      totalDue: b && b.total_due ? b.total_due : null,
      priorPeriodAmount: b && b.prior_period_amount ? b.prior_period_amount : null,
      promoEndDate: b && b.promo_end_date ? b.promo_end_date : null,
      standardRateAfterPromo: b && b.standard_rate_after_promo ? b.standard_rate_after_promo : null,
      instalmentPayments: b && b.instalment_payments_made ? b.instalment_payments_made : null,
      lineItems: (Array.isArray(b && b.line_items) ? b.line_items : [])
        .filter((li) => li && typeof li.label === 'string')
        .map((li) => ({
          label: li.label.trim(),
          amount: typeof li.amount === 'number' ? li.amount : null,
          monthly: li.monthly !== false,
          confidence: typeof li.confidence === 'number' ? li.confidence : null,
          category: classifyLine(li.label, li.amount),
        })),
    })),
  };
}

/* ---------------------------------------------------------------- matching

   Which extracted bill is which typed bill. Provider name, normalized. An
   extracted bill that matches nothing the customer typed is a bill they
   forgot, which is worth having.
   ---------------------------------------------------------------------- */

function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Whether two normalized labels describe the same line. Containment either
// way, with a floor so that a two-character fragment cannot match everything.
function containsEither(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  return short.length >= 5 && long.indexOf(short) !== -1;
}

function sameAddOn(billLabel, typedLabel) {
  return containsEither(normName(billLabel), normName(typedLabel));
}

function matchBill(extracted, typedBills) {
  const e = normName(extracted.provider);
  if (!e) return -1;
  let best = -1;
  for (let i = 0; i < typedBills.length; i += 1) {
    const t = normName(typedBills[i] && typedBills[i].provider);
    if (!t) continue;
    if (t === e || t.indexOf(e) === 0 || e.indexOf(t) === 0) { best = i; break; }
  }
  return best;
}

/* ------------------------------------------------------------------ merging

   What the document says vs what the customer typed.

   PRECEDENCE, and the reasoning behind it:
   - A PRINTED FACT beats a typed one. The customer guessing $12 for a modem
     rental printed at $15 is the normal case, and the bill is right.
   - An INTENT answer can only come from the customer and is never overridden.
     Whether they use the wire maintenance plan, and whether they rely on the
     roadside cover, are not on any statement.
   - A disagreement between the two is RECORDED, not silently resolved. The
     customer who said they do not rent a modem, on a bill with an equipment
     line, has learned something worth knowing.
   ---------------------------------------------------------------------- */

function merge(typedBills, extraction) {
  const typed = Array.isArray(typedBills) ? typedBills.map((b) => Object.assign({}, b)) : [];
  const out = typed.map((b) => Object.assign({}, b, { evidence: {} }));
  const disagreements = [];
  const newQuestions = [];
  const foundBills = [];

  for (const ex of (extraction && extraction.bills) || []) {
    const idx = matchBill(ex, typed);
    let bill;
    if (idx === -1) {
      // A bill in the upload the customer never named. Carried through with
      // no intent answers, so its checks that need one land in couldNotRun
      // and are asked rather than assumed.
      bill = {
        kind: kindFromHint(ex.serviceHint, ex.provider),
        provider: ex.provider,
        monthly: null,
        evidence: {},
        discoveredInUpload: true,
      };
      out.push(bill);
      foundBills.push({ provider: ex.provider, serviceHint: ex.serviceHint });
    } else {
      bill = out[idx];
    }

    const lines = ex.lineItems.filter((li) => confident(li) && li.monthly);

    // --- the total, if printed
    const total = val(ex.totalDue);
    if (total !== null && total > 0) {
      if (bill.monthly && Math.abs(Number(bill.monthly) - total) > 1) {
        disagreements.push({
          provider: ex.provider, field: 'monthly',
          youSaid: Number(bill.monthly), billSays: total,
          note: 'We used the amount printed on the statement.',
        });
      }
      bill.monthly = total;
      bill.evidence.monthly = { label: 'Total due', amount: total };
    }

    // --- H1 equipment: printed, so authoritative
    const equip = lines.filter((li) => li.category === Category.EQUIPMENT && li.amount > 0);
    if (equip.length) {
      const fee = equip.reduce((s, li) => s + li.amount, 0);
      if (bill.equipmentRental === false) {
        disagreements.push({
          provider: ex.provider, field: 'equipmentRental',
          youSaid: 'no rented equipment',
          billSays: `${equip.map((l) => l.label).join(', ')} — ${fee.toFixed(2)}/mo`,
          note: 'We used the statement. This is the commonest thing to be wrong about.',
        });
      }
      bill.equipmentRental = true;
      bill.equipmentFee = fee;
      bill.evidence.equipment = equip.map((l) => ({ label: l.label, amount: l.amount }));
    } else if (ex.lineItems.length && bill.equipmentRental !== true) {
      // We read the bill and there is no equipment line. That is an answer,
      // and it lets check H1 run and pass instead of sitting in couldNotRun.
      bill.equipmentRental = false;
      bill.evidence.equipment = [];
    }

    // --- H2 promo: the end date is the whole finding
    const promoEnd = val(ex.promoEndDate);
    if (promoEnd) {
      bill.promoRate = true;
      bill.promoEndsOn = promoEnd;
      bill.evidence.promoEndsOn = { label: 'Promotional rate ends', value: promoEnd };
    }
    const standard = val(ex.standardRateAfterPromo);
    if (standard !== null && standard > 0) {
      bill.standardRate = standard;
      bill.evidence.standardRate = { label: 'Rate after promotion', amount: standard };
    }

    // --- H3 instalment: "24 of 24" settles paid-off deterministically
    const inst = lines.filter((li) => li.category === Category.INSTALMENT && li.amount > 0);
    if (inst.length) {
      bill.deviceInstalment = true;
      bill.deviceFee = inst.reduce((s, li) => s + li.amount, 0);
      bill.evidence.instalment = inst.map((l) => ({ label: l.label, amount: l.amount }));
      const p = ex.instalmentPayments;
      if (confident(p) && typeof p.made === 'number' && typeof p.total === 'number'
          && p.total > 0 && p.made >= p.total) {
        // The bill says the agreement is complete and is still charging for
        // it. Nobody has to remember anything for this one.
        bill.devicePaidOff = true;
        bill.evidence.devicePaidOff = {
          label: `Payment ${p.made} of ${p.total}`, note: 'the agreement is complete',
        };
      }
    } else if (ex.lineItems.length && bill.deviceInstalment !== true) {
      bill.deviceInstalment = false;
    }

    // --- H4 add-ons: candidates only. Whether they are WANTED is the
    //     customer's answer and extraction must never supply it.
    const addons = lines.filter((li) => li.category === Category.ADDON && li.amount > 0);
    if (addons.length) {
      const named = new Set(
        (Array.isArray(bill.addOns) ? bill.addOns : [])
          .map((a) => normName(a && a.label))
          .filter(Boolean)
      );
      // Price the ones they already named, from the bill rather than memory.
      //
      // Containment in EITHER direction, not a prefix: a customer types "wire
      // maintenance" and the statement prints "Inside Wire Maintenance". A
      // prefix match misses that, silently leaves their guessed amount in the
      // report, and produces a figure that disagrees with the bill it claims
      // to have read.
      if (Array.isArray(bill.addOns)) {
        bill.addOns = bill.addOns.map((a) => {
          const hit = addons.filter((li) => sameAddOn(li.label, a.label))[0];
          return hit ? Object.assign({}, a, { monthly: hit.amount, label: hit.label }) : a;
        });
      }
      const unasked = addons.filter((li) => !named.has(normName(li.label))
        && ![...named].some((nm) => containsEither(normName(li.label), nm)));
      for (const li of unasked) {
        newQuestions.push({
          provider: ex.provider,
          checkId: 'H4',
          label: li.label,
          monthly: li.amount,
          question: `Your ${ex.provider || 'bill'} has a line called "${li.label}" at `
            + `$${li.amount.toFixed(2)} a month that you did not mention. Do you use it?`,
        });
      }
      bill.evidence.addOnCandidates = addons.map((l) => ({ label: l.label, amount: l.amount }));
    }

    // --- H6 autopay: a printed discount line settles it
    const autopay = lines.filter((li) => li.category === Category.AUTOPAY_DISCOUNT);
    if (autopay.length) {
      bill.autopayDiscount = true;
      bill.evidence.autopayDiscount = autopay.map((l) => ({ label: l.label, amount: l.amount }));
    } else if (ex.lineItems.length && bill.autopayDiscount !== true) {
      bill.autopayDiscount = false;
      bill.evidence.autopayDiscount = [];
    }

    // --- prior period: a QUESTION, never a finding.
    //
    // Deliberately not fed into check H7. What statements print is the
    // PREVIOUS MONTH, and H7 is year-on-year — conflating them would put a
    // seasonal heating bill's January-to-February jump into a report as though
    // it were a price rise. So a material month-on-month jump becomes a
    // question, on the kinds of bill where the amount is not driven by usage.
    // It adds no check and changes no total.
    const prior = val(ex.priorPeriodAmount);
    const FIXED_RATE = ['internet', 'tv', 'mobile', 'insurance', 'security', 'gym', 'warehouse'];
    if (prior !== null && prior > 0 && total !== null && total > prior
        && FIXED_RATE.indexOf(bill.kind) !== -1) {
      const jump = Math.round((total - prior) * 100) / 100;
      if (jump >= 5) {
        bill.evidence.priorPeriod = { label: 'Previous period', amount: prior };
        newQuestions.push({
          provider: ex.provider,
          checkId: 'H7',
          label: 'Month-on-month increase',
          monthly: jump,
          question: `Your ${ex.provider || 'bill'} went from $${prior.toFixed(2)} last period to `
            + `$${total.toFixed(2)} this one — $${jump.toFixed(2)} more. This is not a `
            + `year-on-year comparison and we have not counted it, but it is worth knowing `
            + `what changed. If you have last year's statement, send it and check H7 can run `
            + `properly.`,
        });
      }
    }
  }

  return { bills: out, disagreements, newQuestions, foundBills };
}

// Map the statement's own words to one of the engine's bill kinds. A table,
// not a judgement — and `other` when nothing matches, which costs a couple of
// checks rather than running the wrong ones.
const KIND_HINTS = [
  [/\b(internet|broadband|fiber|fibre|xfinity|comcast|spectrum|cox|frontier)\b/i, 'internet'],
  [/\b(wireless|mobile|cellular|verizon|at&t|t-?mobile|phone)\b/i, 'mobile'],
  [/\b(tv|cable|television|directv|dish)\b/i, 'tv'],
  [/\b(policy|insurance|allstate|geico|progressive|state farm|nationwide)\b/i, 'insurance'],
  [/\b(electric|gas|energy|power|utility|pg&e|coned|con edison)\b/i, 'electric'],
  [/\bwater\b/i, 'water'],
  [/\b(security|alarm|monitoring|adt|simplisafe|vivint)\b/i, 'security'],
  [/\b(gym|fitness|planet fitness|equinox|ymca)\b/i, 'gym'],
  [/\b(costco|sam'?s club|bj'?s|warehouse|club)\b/i, 'warehouse'],
];

function kindFromHint(serviceHint, provider) {
  const s = `${serviceHint || ''} ${provider || ''}`;
  for (const [re, kind] of KIND_HINTS) {
    if (re.test(s)) return kind;
  }
  return 'other';
}

/* ------------------------------------------------------------- the API call

   Two attempts, for the same reason rental-extract.js takes two: a truncated
   or missing tool call is worth one retry before a paying customer's report
   falls back to the answers they typed.
   ---------------------------------------------------------------------- */

async function extractHouseholdBills(apiKey, contentBlocks, options) {
  const opts = options || {};
  const fetchImpl = opts.fetch || fetch;
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        max_tokens: 8000,
        system: EXTRACT_SYSTEM,
        tools: [EXTRACT_TOOL],
        tool_choice: { type: 'tool', name: 'record_household_bills' },
        messages: [{ role: 'user', content: contentBlocks }],
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Anthropic API error ${response.status}: ${text.slice(0, 500)}`);
    }

    const data = await response.json();
    // A truncated tool call still parses into a plausible-looking object with
    // its later line items missing. Using that would silently drop whichever
    // charges got cut off — and the ones at the end of a statement are exactly
    // the add-ons and equipment fees this product is looking for.
    if (data.stop_reason === 'max_tokens') {
      lastError = new Error('Bill extraction was truncated');
      continue;
    }
    const toolUse = (data.content || [])
      .find((b) => b.type === 'tool_use' && b.name === 'record_household_bills');
    if (!toolUse) {
      lastError = new Error('Extraction returned no structured result');
      continue;
    }
    return normalizeExtraction(toolUse.input);
  }

  throw lastError || new Error('Bill extraction failed');
}

module.exports = {
  extractHouseholdBills,
  normalizeExtraction,
  classifyLine,
  merge,
  matchBill,
  kindFromHint,
  Category,
  EXTRACT_TOOL,
  EXTRACT_SYSTEM,
  EXTRACT_MODEL,
  CONF_THRESHOLD,
  _internal: { confident, val, normName },
};
