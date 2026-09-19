/* =========================================================================
   navigator-home-savings-engine.js — the deterministic half of Home Savings.

   Before this file existed, /home-savings was a 201-word prompt in
   PRODUCT_CONFIGS handed to the model, told to judge whether each bill "looks
   priced above a typical market rate for that category, using your general
   knowledge of typical U.S. pricing patterns" — while the page's own footer
   said, correctly, that we hold no price database and do not look prices up.
   The product's headline claim was therefore a model's undated, un-regional
   recollection of what things cost, sold at $49 as a market comparison, with
   nothing able to catch it being wrong. See docs/HOME-SAVINGS-AUDIT.md.

   So this is the house pattern applied to the last product that did not have
   it: closing-audit.js, rental-audit.js, landlord-audit.js and
   navigator-subscription-engine.js decide, and the model writes up what they
   decided. Nothing here calls a model, nothing here reaches the network, and
   every figure it prints is arithmetic on a number that was either typed by
   the customer or read off their own statement.

   Where those numbers come from on the paid path is api/_lib/home-savings-
   extract.js, which runs the same split one level down: the model TRANSCRIBES
   the bill's lines, a pattern table CLASSIFIES them, and this file decides.
   The model never gets to call something an equipment rental. In the browser
   there is no extraction and the answers are the customer's own, which is why
   the free scorecard and the paid report can differ — the report reads the
   statement, and the scorecard says so.

   THE POINT OF THE REDESIGN is that none of these checks needs a price table.
   Each one is arithmetic on the customer's own bill:

     - a modem rental fee is a line on the bill; owning one ends it
     - a promotional rate has an end date printed on the bill
     - a device instalment stops when the device is paid off
     - an add-on the customer does not use is a line they can name
     - roadside cover bought twice is bought twice
     - an autopay discount is either applied or it is not
     - this year's bill against last year's is subtraction

   We never say "this is above market". We say "this line is on your bill, it
   is yours to stop, and here is what it is worth".

   THE THREE RULES THAT MATTER MOST are not the ones that find savings. They
   are the ones that refuse to:

     - never tell someone to drop insurance cover they say they rely on
     - never count a promotional rate as a saving — losing it is a cost
     - never put a figure on a line the customer did not price

   They are implemented in applySafety() as a pass that can only ever downgrade
   a finding, never raise one, so the invariant is testable directly rather
   than hoped for.

   Lives at the repository root, beside navigator-subscription-engine.js and
   for the same reason: it is required by the API *and* served to the browser.
   /home-savings runs this exact file to produce its free scorecard and to gate
   its own checkout button, so the check that decides whether a customer may
   pay and the check the server enforces cannot drift — they are one file.
   ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HomeSavingsEngine = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY = 24 * 60 * 60 * 1000;

  /* ---------------------------------------------------------- saving kinds

     Lifted from rental-audit.js and navigator-subscription-engine.js, which
     enforce the same discipline on products at $149 and $29: a total that
     mixes kinds is a number the customer cannot check, and once one line in it
     turns out to be wishful the whole figure is worthless.

       confirmed  the line is on the bill, the charge stops, nothing offsets
                  it beyond a one-off cost we name.            COUNTS.
       at_risk    a promotional rate, a discount the provider may not offer,
                  or a negotiating lever. Real, and not money yet, so it is
                  shown and never added.                       NEVER COUNTS.
       unpriced   the customer did not give us the amount.     NEVER COUNTS,
                                                               NEVER ESTIMATED.
     -------------------------------------------------------------------- */
  const SavingKind = {
    CONFIRMED: 'confirmed',
    AT_RISK: 'at_risk',
    UNPRICED: 'unpriced',
    NONE: 'none',
  };

  const Action = {
    STOP: 'stop',           // a line item you can end outright
    REPLACE: 'replace',     // stop renting, own the thing instead
    CALL: 'call',           // a renegotiation, with a script
    WATCH: 'watch',         // dated: act before this or the price rises
    REVIEW: 'review',       // not our decision, and we say why
  };

  const ACTION_LABELS = {
    stop: 'Stop', replace: 'Replace', call: 'Call', watch: 'Watch', review: 'Review',
  };

  // Bill kinds we hold behaviour for. This is NOT a price table — it is which
  // checks can apply to which kind of bill, and how a cancellation behaves.
  const BILL_KINDS = {
    internet: { label: 'internet', equipment: true, promo: true, addOns: true },
    tv: { label: 'TV or cable', equipment: true, promo: true, addOns: true },
    mobile: { label: 'mobile or phone', device: true, promo: true, addOns: true },
    insurance: { label: 'insurance', coverage: true, promo: true, addOns: true },
    electric: { label: 'electricity or gas', promo: true },
    water: { label: 'water', promo: false },
    gym: { label: 'gym membership', addOns: true },
    warehouse: { label: 'warehouse or club membership', addOns: true },
    security: { label: 'home security or monitoring', equipment: true, promo: true, addOns: true },
    other: { label: 'other recurring bill', promo: true, addOns: true },
  };

  function kindOf(bill) {
    const k = String((bill && bill.kind) || 'other').toLowerCase();
    return BILL_KINDS[k] ? k : 'other';
  }
  function kindMeta(bill) { return BILL_KINDS[kindOf(bill)]; }

  // Below this a recommendation is not worth the phone call. Deliberately on
  // the generous side: an engine graded on the size of its headline total will
  // always drift towards recommending six calls the customer resents making,
  // and this is the floor that stops it. Same role as TRIVIAL_MONTHLY in the
  // subscription engine, expressed annually because these bills are annual.
  const TRIVIAL_ANNUAL = 60.00;

  // What a modem or router costs to buy once, so a "stop renting it" finding
  // can be honest about the offset instead of printing the gross fee. A range,
  // because we are not pricing a specific model and will not pretend to.
  const OWN_EQUIPMENT_ONE_OFF = { low: 60, high: 160 };

  /* ------------------------------------------------------------ the checks

     Seven named checks. The page states this number and
     tests/home-savings-claims.test.js asserts the page's number equals
     CHECKS.length, so the count sold is the count that runs — the same
     contract /landlord is held to in tests/navigator-claims.test.js.
     -------------------------------------------------------------------- */
  const CHECKS = [
    {
      id: 'H1', slug: 'equipment-rental',
      label: 'Equipment you rent that you could own',
      applies: (b) => kindMeta(b).equipment === true,
    },
    {
      id: 'H2', slug: 'promo-expiring',
      label: 'A promotional rate with an end date',
      applies: (b) => kindMeta(b).promo === true,
    },
    {
      id: 'H3', slug: 'device-paid-off',
      label: 'A device instalment still billed after the device is paid off',
      applies: (b) => kindMeta(b).device === true,
    },
    {
      id: 'H4', slug: 'unused-addons',
      label: 'Add-ons on the bill you do not use',
      applies: (b) => kindMeta(b).addOns === true,
    },
    {
      id: 'H5', slug: 'duplicate-coverage',
      label: 'Cover you are paying for twice',
      applies: (b) => kindMeta(b).coverage === true,
    },
    {
      id: 'H6', slug: 'autopay-discount',
      label: 'An autopay or paperless discount not applied',
      applies: () => true,
    },
    {
      id: 'H7', slug: 'yoy-increase',
      label: 'What this bill was a year ago',
      applies: () => true,
    },
  ];

  const CHECK_COUNT = CHECKS.length;

  /* ----------------------------------------------------------- arithmetic */
  function round2(n) { return Math.round(Number(n) * 100) / 100; }
  function money(n) {
    const v = round2(n);
    return `$${v.toFixed(2).replace(/\.00$/, '')}`;
  }
  function num(v) {
    const n = Number(v);
    return isFinite(n) && n > 0 ? n : null;
  }
  function toDate(v) {
    if (!v) return null;
    const d = v instanceof Date ? new Date(v.getTime()) : new Date(String(v));
    if (isNaN(d.getTime())) return null;
    d.setHours(0, 0, 0, 0);
    return d;
  }
  function iso(d) { return d ? d.toISOString().slice(0, 10) : null; }
  function daysBetween(a, b) { return Math.round((toDate(b) - toDate(a)) / DAY); }
  function prettyDate(v) {
    const d = toDate(v);
    if (!d) return null;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  function annual(monthly) { return round2(Number(monthly) * 12); }

  /* ------------------------------------------------------------- findings

     Each check returns a finding or null. A finding never carries a figure the
     customer did not give us: where the amount is unknown the finding still
     appears, marked unpriced, and says what to look for on the bill. That is
     the rule the audit found broken everywhere else — an estimated figure in
     the same total as a real one.
     -------------------------------------------------------------------- */

  // What a finding rests on, named as precisely as we can name it.
  //
  // When the bill was read, this quotes the line and the amount printed on it.
  // When it was not, it says so rather than implying a document was consulted.
  // The difference matters: "your statement shows Equipment Rental — Gateway
  // at $15.00" is checkable by the customer in ten seconds, and "you told us
  // you rent it" is not.
  function basisFor(bill, key, fallback) {
    const ev = bill.evidence && bill.evidence[key];
    if (Array.isArray(ev) && ev.length) {
      return `Read from your statement: ${ev.map((e) => `"${e.label}" $${Number(e.amount).toFixed(2)}`).join(', ')}.`;
    }
    if (ev && ev.label && ev.amount != null) {
      return `Read from your statement: "${ev.label}" $${Number(ev.amount).toFixed(2)}.`;
    }
    if (ev && ev.label && ev.value != null) {
      return `Read from your statement: "${ev.label}" ${ev.value}.`;
    }
    return fallback;
  }

  function fH1(bill) {
    if (bill.equipmentRental !== true) return null;
    const fee = num(bill.equipmentFee);
    const base = {
      checkId: 'H1', slug: 'equipment-rental',
      title: `Stop renting the ${kindOf(bill) === 'security' ? 'equipment' : 'modem or router'} from ${bill.provider || 'your provider'}`,
      action: Action.REPLACE,
      basis: basisFor(bill, 'equipment', 'A rental line on your own bill, as you described it.'),
    };
    if (!fee) {
      return Object.assign(base, {
        kind: SavingKind.UNPRICED,
        amount: 0,
        why: ['You told us you rent it, but not what the line costs. It is usually shown as '
          + '"equipment", "gateway", "modem" or "router" on the bill.'],
        step: 'Find that line on your bill and tell us the monthly amount. We will not put a '
          + 'figure on it until you do.',
      });
    }
    const gross = annual(fee);
    return Object.assign(base, {
      kind: SavingKind.CONFIRMED,
      amount: gross,
      why: [
        `You pay ${money(fee)} a month to rent it — ${money(gross)} a year, every year, forever.`,
        `Buying your own is a one-off of roughly ${money(OWN_EQUIPMENT_ONE_OFF.low)}–`
        + `${money(OWN_EQUIPMENT_ONE_OFF.high)}, so it pays for itself in `
        + `${Math.max(1, Math.round(OWN_EQUIPMENT_ONE_OFF.low / fee))}–`
        + `${Math.max(1, Math.round(OWN_EQUIPMENT_ONE_OFF.high / fee))} months and saves the `
        + `full amount after that.`,
      ],
      offset: OWN_EQUIPMENT_ONE_OFF,
      step: `Check your provider's list of approved devices first, buy one, swap it, and return `
        + `the rented unit — keep the return receipt, because an unreturned-equipment charge is `
        + `the one way this goes wrong.`,
    });
  }

  function fH2(bill, today) {
    if (bill.promoRate !== true) return null;
    const ends = toDate(bill.promoEndsOn);
    const current = num(bill.monthly);
    const standard = num(bill.standardRate);
    const base = {
      checkId: 'H2', slug: 'promo-expiring',
      title: `${bill.provider || 'This bill'} is on a promotional rate`,
      action: Action.WATCH,
      basis: basisFor(bill, 'promoEndsOn', 'The end date printed on your own bill.'),
      // NEVER a saving. Losing a promotional rate is a cost, and an engine
      // that counted the gap as money found would be reporting a price rise
      // as a discovery. See the audit's Defect 2 on /subscriptions, which is
      // the same mistake in the other direction.
      kind: SavingKind.AT_RISK,
      amount: 0,
    };
    const why = [];
    let exposure = null;
    if (current && standard && standard > current) {
      exposure = annual(standard - current);
      why.push(`You pay ${money(current)} a month now. The standard rate is ${money(standard)}, `
        + `so when this ends your bill rises by ${money(annual(standard - current))} a year.`);
    } else {
      why.push('A promotional rate ends at a date the provider already knows and you usually '
        + 'do not notice until the bill arrives.');
    }
    if (ends) {
      const days = daysBetween(today, ends);
      if (days >= 0) {
        why.push(`It ends ${prettyDate(ends)} — ${days} days away.`);
      } else {
        why.push(`It ended ${prettyDate(ends)}. If your bill has already risen, this is the `
          + `call to make first.`);
      }
    }
    return Object.assign(base, {
      why,
      exposureAnnual: exposure,
      actOn: ends ? iso(new Date(ends.getTime() - 30 * DAY)) : null,
      step: ends
        ? `Call about a month before ${prettyDate(ends)} and ask what retention rate they can `
          + `put you on. Say you are comparing providers and you mean it — this is the one `
          + `conversation on your whole bill stack with the largest number attached to it.`
        : `Find the end date on your bill, then call about a month before it and ask what `
          + `retention rate they can offer.`,
    });
  }

  function fH3(bill) {
    if (bill.deviceInstalment !== true || bill.devicePaidOff !== true) return null;
    const fee = num(bill.deviceFee);
    const base = {
      checkId: 'H3', slug: 'device-paid-off',
      title: `A device instalment is still on the ${bill.provider || 'phone'} bill`,
      action: Action.STOP,
      basis: basisFor(bill, 'instalment',
        'An instalment line on your own bill, against your own answer that it is paid off.'),
    };
    if (!fee) {
      return Object.assign(base, {
        kind: SavingKind.UNPRICED,
        amount: 0,
        why: ['You told us the device is paid off and an instalment line is still showing, but '
          + 'not what it costs.'],
        step: 'Tell us the monthly amount on that line and we will price it.',
      });
    }
    return Object.assign(base, {
      kind: SavingKind.CONFIRMED,
      amount: annual(fee),
      why: [`${money(fee)} a month — ${money(annual(fee))} a year — for a device you have `
        + `already finished paying for.`],
      step: 'Call and ask for the instalment line to be removed and for the months billed after '
        + 'the final payment to be credited back. Have the payoff date ready.',
    });
  }

  function fH4(bill) {
    const addOns = Array.isArray(bill.addOns) ? bill.addOns.filter((a) => a && a.label) : [];
    if (!addOns.length) return null;
    const priced = addOns.filter((a) => num(a.monthly));
    const unpriced = addOns.filter((a) => !num(a.monthly));
    const total = priced.reduce((s, a) => s + Number(a.monthly), 0);
    const names = addOns.map((a) => String(a.label).trim()).join(', ');
    const base = {
      checkId: 'H4', slug: 'unused-addons',
      title: `Add-ons on the ${bill.provider || kindMeta(bill).label} bill you said you do not use`,
      action: Action.STOP,
      basis: basisFor(bill, 'addOnCandidates', 'Lines you identified on your own bill.'),
    };
    if (!priced.length) {
      return Object.assign(base, {
        kind: SavingKind.UNPRICED,
        amount: 0,
        why: [`You named ${names}, but not what they cost.`],
        step: 'Tell us what each one costs a month and we will price them.',
      });
    }
    const why = [`${names} — ${money(total)} a month, ${money(annual(total))} a year.`];
    if (unpriced.length) {
      why.push(`${unpriced.map((a) => a.label).join(', ')} ${unpriced.length === 1 ? 'is' : 'are'} `
        + `not priced, so ${unpriced.length === 1 ? 'it is' : 'they are'} not in that figure.`);
    }
    return Object.assign(base, {
      kind: SavingKind.CONFIRMED,
      amount: annual(total),
      why,
      step: 'These come off in the account settings or in one call. Ask for each by name and '
        + 'check the next bill — add-ons have a habit of coming back with a plan change.',
    });
  }

  function fH5(bill) {
    if (bill.duplicateCoverage !== true) return null;
    const fee = num(bill.duplicateFee);
    const base = {
      checkId: 'H5', slug: 'duplicate-coverage',
      title: `Cover on the ${bill.provider || 'insurance'} policy you already have elsewhere`,
      action: Action.STOP,
      basis: 'Two documents of your own covering the same thing.',
    };
    if (!fee) {
      return Object.assign(base, {
        kind: SavingKind.UNPRICED,
        amount: 0,
        why: ['You told us something on this policy duplicates cover you already have, but not '
          + 'what that part costs.'],
        step: 'Your declarations page itemises it. Tell us the amount and we will price it.',
      });
    }
    return Object.assign(base, {
      kind: SavingKind.CONFIRMED,
      amount: annual(fee),
      why: [`${money(fee)} a month — ${money(annual(fee))} a year — for cover you told us you `
        + `already hold somewhere else.`],
      step: 'Confirm the other cover is actually in force and read what it excludes before you '
        + 'remove anything. Then ask your insurer to drop that endorsement at the next renewal.',
    });
  }

  function fH6(bill) {
    if (bill.autopayDiscount !== false) return null;
    return {
      checkId: 'H6', slug: 'autopay-discount',
      title: `No autopay or paperless discount on the ${bill.provider || kindMeta(bill).label} bill`,
      action: Action.CALL,
      basis: bill.evidence && Array.isArray(bill.evidence.autopayDiscount)
        ? 'We read your statement line by line and there is no autopay or paperless discount on it.'
        : 'The absence of a discount line on your own bill.',
      // at_risk, not confirmed: whether this provider offers one, and what it
      // is worth, is exactly the kind of fact we do not hold and will not
      // invent. The check is that it is not currently applied.
      kind: SavingKind.AT_RISK,
      amount: 0,
      why: ['Nothing on this bill shows a discount for autopay or paperless billing. Many '
        + 'providers offer one and apply it only when asked.',
      'We do not know whether yours does, or what it is worth, so there is no figure here — '
        + 'only a question worth asking.'],
      step: 'Ask: "Is there an autopay or paperless discount on this account, and if not, can '
        + 'you apply one?" If they say no, that is a complete answer and it cost you a minute.',
    };
  }

  function fH7(bill) {
    const now = num(bill.monthly);
    const then = num(bill.lastYearMonthly);
    if (!now || !then) return null;
    const delta = round2(now - then);
    if (delta <= 0) {
      return {
        checkId: 'H7', slug: 'yoy-increase',
        title: `The ${bill.provider || kindMeta(bill).label} bill has not risen`,
        action: Action.REVIEW,
        basis: "Your own bill against your own bill a year ago.",
        kind: SavingKind.NONE,
        amount: 0,
        withinNorms: true,
        why: [`${money(then)} a year ago, ${money(now)} now. Nothing to do here, and it is worth `
          + `knowing which of your bills are behaving.`],
        step: 'Nothing. This one is fine.',
      };
    }
    const pct = Math.round((delta / then) * 100);
    return {
      checkId: 'H7', slug: 'yoy-increase',
      title: `The ${bill.provider || kindMeta(bill).label} bill is up ${pct}% on last year`,
      action: Action.CALL,
      basis: 'Your own bill against your own bill a year ago. Subtraction, not a market rate.',
      // A lever, not money. Nothing is saved until a call succeeds, and we
      // have no way to know whether it will.
      kind: SavingKind.AT_RISK,
      amount: 0,
      exposureAnnual: annual(delta),
      why: [`${money(then)} a month a year ago, ${money(now)} now — ${money(delta)} a month more, `
        + `${money(annual(delta))} a year.`,
      'That is the increase, not a saving. It becomes a saving only if a call works, and we '
        + 'cannot promise that it will.'],
      step: `Call and ask what changed. "My bill has gone from ${money(then)} to ${money(now)} `
        + `and I would like to know why, and what you can do about it" is the whole script. A `
        + `rise you can name is much harder to defend than one you cannot.`,
    };
  }

  const CHECK_FNS = { H1: fH1, H2: fH2, H3: fH3, H4: fH4, H5: fH5, H6: fH6, H7: fH7 };

  /* -------------------------------------------------------------- safety

     This pass can only ever downgrade a finding to something safer. It never
     turns a review into a stop, and it never raises an amount. That is what
     makes "we will not tell you to drop cover you rely on" an invariant a test
     can assert over arbitrary input rather than a branch somebody has to find.
     ---------------------------------------------------------------------- */
  function applySafety(finding, bill) {
    const cautions = [];
    let out = Object.assign({}, finding);

    function demote(action, ruleId, why) {
      out = Object.assign({}, out, {
        action,
        blockedRuleId: ruleId,
        provisionalAction: out.action,
        kind: SavingKind.UNPRICED === out.kind ? out.kind : SavingKind.AT_RISK,
        amount: 0,
        why: [why].concat(out.why || []),
      });
    }

    // S1 — cover the customer says they rely on. The obvious read of a
    // duplicate-cover answer points at the recommendation that can leave
    // somebody uninsured, and that is not a trade this product is allowed to
    // make on their behalf.
    if (out.slug === 'duplicate-coverage' && bill.reliesOnCoverage === true) {
      demote(Action.REVIEW, 'S1',
        'You told us you rely on this cover. We are not going to tell you to drop it on the '
        + 'strength of a form — duplicate cover is sometimes deliberate, and the exclusions in '
        + 'two policies are rarely identical.');
    }

    // S2 — anything that would give up a promotional rate. Cancelling or
    // downgrading a line on a promo bill can cost the rate itself, which is
    // invisible in the line-item arithmetic.
    if (bill.promoRate === true
        && (out.action === Action.STOP || out.action === Action.REPLACE)
        && out.slug !== 'promo-expiring') {
      cautions.push({
        kind: 'promo',
        text: 'This bill is on a promotional rate. Changing the plan can end the promotion '
          + 'early — ask whether this specific change affects your rate before you make it.',
      });
    }

    // S3 — the trivial floor. Small, and still a phone call.
    if (out.kind === SavingKind.CONFIRMED && out.amount > 0 && out.amount < TRIVIAL_ANNUAL
        && out.action === Action.CALL) {
      demote(Action.REVIEW, 'S3',
        `This is ${money(out.amount)} a year. It is real, and it is probably not worth the time `
        + `on hold — we would rather say so than pad the list.`);
    }

    return Object.assign({}, out, { cautions: (out.cautions || []).concat(cautions) });
  }

  /* -------------------------------------------------------------- analyze */

  const ACTION_RANK = { stop: 0, replace: 1, watch: 2, call: 3, review: 4 };

  function auditBill(bill, today) {
    const findings = [];
    const ran = [];
    const couldNotRun = [];

    for (const check of CHECKS) {
      if (!check.applies(bill)) continue;
      ran.push(check.id);
      const f = CHECK_FNS[check.id](bill, today);
      if (f) findings.push(applySafety(f, bill));
    }

    // A check that applies but had no answer is not a pass — it is a gap, and
    // the customer is the only person who can close it. Named rather than
    // silently dropped, the way rental-audit.js names an unreadable rent roll.
    for (const check of CHECKS) {
      if (!check.applies(bill)) continue;
      if (findings.some((f) => f.checkId === check.id)) continue;
      if (!answeredFor(check.id, bill)) {
        couldNotRun.push({ checkId: check.id, label: check.label, bill: billLabel(bill) });
      }
    }

    return { findings, ran, couldNotRun };
  }

  function answeredFor(checkId, bill) {
    switch (checkId) {
      case 'H1': return bill.equipmentRental === true || bill.equipmentRental === false;
      case 'H2': return bill.promoRate === true || bill.promoRate === false;
      case 'H3': return bill.deviceInstalment === true || bill.deviceInstalment === false;
      case 'H4': return Array.isArray(bill.addOns);
      case 'H5': return bill.duplicateCoverage === true || bill.duplicateCoverage === false;
      case 'H6': return bill.autopayDiscount === true || bill.autopayDiscount === false;
      case 'H7': return num(bill.lastYearMonthly) !== null;
      default: return false;
    }
  }

  function billLabel(bill) {
    const p = String((bill && bill.provider) || '').trim();
    return p || kindMeta(bill).label;
  }

  function analyze(input, options) {
    const opts = options || {};
    const today = toDate(opts.today) || (() => {
      const d = new Date(); d.setHours(0, 0, 0, 0); return d;
    })();

    const bills = (Array.isArray(input && input.bills) ? input.bills : [])
      .filter((b) => b && (String(b.provider || '').trim() || b.kind));

    const findings = [];
    const couldNotRun = [];
    let checkRuns = 0;
    let monthlySpend = 0;
    let pricedBills = 0;

    for (const bill of bills) {
      const r = auditBill(bill, today);
      const label = billLabel(bill);
      r.findings.forEach((f) => findings.push(Object.assign({}, f, {
        bill: label,
        billKind: kindOf(bill),
        actionLabel: ACTION_LABELS[f.action] || f.action,
      })));
      checkRuns += r.ran.length;
      r.couldNotRun.forEach((c) => couldNotRun.push(c));
      const m = num(bill.monthly);
      if (m) { monthlySpend += m; pricedBills += 1; }
    }

    findings.sort((a, b) => {
      const r = (ACTION_RANK[a.action] ?? 9) - (ACTION_RANK[b.action] ?? 9);
      if (r !== 0) return r;
      const av = a.amount || a.exposureAnnual || 0;
      const bv = b.amount || b.exposureAnnual || 0;
      return bv - av;
    });

    // Two exposure figures, never summed into one. A promotional rate ending
    // is a rise that has not happened yet; a year-on-year increase is one that
    // already has. Adding them would double-count a bill that has both — this
    // smoke case has exactly that, $74 -> $89 -> $104, and a single "$360 at
    // risk" would have been a number the customer could not reconstruct.
    const totals = {
      confirmedAnnual: 0,
      promoExposureAnnual: 0,
      increaseAnnual: 0,
      unpricedFindings: 0,
      reviewFindings: 0,
      withinNorms: 0,
    };
    for (const f of findings) {
      if (f.kind === SavingKind.CONFIRMED) totals.confirmedAnnual += f.amount || 0;
      else if (f.kind === SavingKind.UNPRICED) totals.unpricedFindings += 1;
      if (f.exposureAnnual && f.slug === 'promo-expiring') {
        totals.promoExposureAnnual += f.exposureAnnual;
      } else if (f.exposureAnnual && f.slug === 'yoy-increase') {
        totals.increaseAnnual += f.exposureAnnual;
      }
      if (f.action === Action.REVIEW && !f.withinNorms) totals.reviewFindings += 1;
      if (f.withinNorms) totals.withinNorms += 1;
    }
    totals.confirmedAnnual = round2(totals.confirmedAnnual);
    totals.promoExposureAnnual = round2(totals.promoExposureAnnual);
    totals.increaseAnnual = round2(totals.increaseAnnual);

    const counts = {};
    for (const f of findings) counts[f.action] = (counts[f.action] || 0) + 1;

    // Whether the statements were actually read. The scorecard says different
    // things either way, because "confirmed from the amounts you gave us" is
    // a lie once the figures came off the bill — and the difference is exactly
    // what the customer paid for.
    const documentsRead = findings.some((f) => /^Read from your statement/.test(f.basis || ''));

    // Questions the extraction raised that no check could answer — an add-on
    // on the statement the customer never mentioned, a month-on-month jump.
    // They ride alongside couldNotRun rather than becoming findings, because
    // every one of them turns on something only the customer knows.
    const openQuestions = Array.isArray(opts.openQuestions) ? opts.openQuestions : [];

    return {
      generatedAt: iso(today),
      checkCount: CHECK_COUNT,
      billCount: bills.length,
      documentsRead,
      openQuestions,
      disagreements: Array.isArray(opts.disagreements) ? opts.disagreements : [],
      pricedBills,
      monthlySpend: round2(monthlySpend),
      annualSpend: round2(monthlySpend * 12),
      checkRuns,
      totals,
      counts,
      couldNotRun,
      findings,
    };
  }

  /* ------------------------------------------------------------ scorecard

     What the customer sees for free, in their own browser, before deciding
     whether to pay. It reports counts and totals; the per-finding scripts and
     the document-grounded reading of the actual bills are the paid report.
     -------------------------------------------------------------------- */
  function buildScorecard(analysis) {
    const a = analysis;
    const actionable = (a.counts.stop || 0) + (a.counts.replace || 0);
    const levers = (a.counts.call || 0) + (a.counts.watch || 0);
    return {
      billCount: a.billCount,
      checkCount: a.checkCount,
      checkRuns: a.checkRuns,
      monthlySpend: a.monthlySpend,
      annualSpend: a.annualSpend,
      actionableFindings: actionable,
      leverFindings: levers,
      documentsRead: a.documentsRead === true,
      confirmedAnnual: a.totals.confirmedAnnual,
      promoExposureAnnual: a.totals.promoExposureAnnual,
      increaseAnnual: a.totals.increaseAnnual,
      unpricedFindings: a.totals.unpricedFindings,
      reviewFindings: a.totals.reviewFindings,
      openQuestions: a.couldNotRun.length + (a.openQuestions || []).length,
      headline: scorecardHeadline(a, actionable, levers),
      nothingFound: actionable === 0 && levers === 0 && a.totals.unpricedFindings === 0,
    };
  }

  function scorecardHeadline(a, actionable, levers) {
    if (a.totals.confirmedAnnual > 0) {
      return `${actionable} thing${actionable === 1 ? '' : 's'} on your bills `
        + `${actionable === 1 ? 'is' : 'are'} yours to stop. `
        + `${money(a.totals.confirmedAnnual)} a year, confirmed `
        + `${a.documentsRead ? 'from the lines printed on your statements' : 'from the amounts you gave us'}.`;
    }
    if (a.totals.unpricedFindings > 0) {
      return `We found ${a.totals.unpricedFindings} thing${a.totals.unpricedFindings === 1 ? '' : 's'} `
        + `worth stopping and you have not told us what `
        + `${a.totals.unpricedFindings === 1 ? 'it costs' : 'they cost'}. Add the amounts and `
        + `this turns into a figure — we will not estimate one.`;
    }
    if (levers > 0) {
      return `Nothing here is a straight overcharge, but ${levers} `
        + `${levers === 1 ? 'bill is' : 'bills are'} worth a phone call — `
        + `${a.totals.promoExposureAnnual > 0
          ? `${money(a.totals.promoExposureAnnual)} a year of promotional rate is about to end`
          : a.totals.increaseAnnual > 0
            ? `${money(a.totals.increaseAnnual)} a year of increase has already landed`
            : 'and we say exactly what to ask'}.`;
    }
    if (a.couldNotRun.length > 0) {
      return `Nothing found yet — but ${a.couldNotRun.length} of the ${a.checkCount} checks `
        + `could not run on what you have told us. The questions above are the whole gap.`;
    }
    return `We ran all ${a.checkCount} checks on ${a.billCount} `
      + `${a.billCount === 1 ? 'bill' : 'bills'} and found nothing you should stop paying for. `
      + `That is worth knowing, and you found it out for free.`;
  }

  /* ---------------------------------------------------------- sufficiency

     The same rules the page gates its own button on, so a customer can never
     reach checkout with input this would then reject — and calling the intake
     endpoint directly cannot bypass the page either.

     Before this existed, /home-savings fell through to the generic D-04 check
     in api/navigator-intake.js, which accepts a description OR a file. But
     PRODUCT_CONFIGS['home-savings'] sets requiresFiles: true, and that is
     enforced in api/_lib/navigator-engine.js AFTER payment — so a
     description-only submission bought a $49 report the engine then threw on.
     The money came back automatically, which is not the same as the purchase
     never having been allowed. See docs/HOME-SAVINGS-AUDIT.md, Critical 2.
     -------------------------------------------------------------------- */
  function checkSufficiency(formData, attachmentCount) {
    const missing = [];
    const bills = Array.isArray(formData && formData.bills) ? formData.bills : [];
    const usable = bills.filter((b) => b && String(b.provider || '').trim());
    const attached = Number(attachmentCount) || 0;

    // The one that was never checked. This product reads documents; without
    // one there is nothing to read.
    if (attached < 1) {
      missing.push({
        key: 'files',
        label: 'Attach at least one bill',
        why: 'This report is an audit of your actual bills, so it cannot start without one. '
          + 'A PDF or a clear photo of a statement both work.',
      });
    }

    if (!usable.length) {
      missing.push({
        key: 'bills',
        label: 'Name at least one bill',
        why: 'Tell us which bills you are sending and who they are from. The checks are '
          + 'per-provider, so an unnamed bill is one we cannot line the questions up against.',
      });
      return { sufficient: false, missing };
    }

    const noPrice = usable.filter((b) => !num(b.monthly));
    if (noPrice.length === usable.length) {
      missing.push({
        key: 'monthly',
        label: 'Add what at least one of these costs a month',
        why: 'Every figure in your report is arithmetic on the amounts you give us. Without one '
          + 'we can tell you what to look at, but not what it is worth — and that is not worth '
          + 'paying for.',
      });
    }

    // At least one bill has to have engaged with the checks that apply to it.
    // Not all of them — a customer who genuinely does not know whether they
    // rent their modem should still be able to buy the report, because the
    // uploaded bill answers it. But a form where nothing at all was answered
    // is a form that bought a report from a blank page.
    const engaged = usable.filter((b) => CHECKS.some((c) => c.applies(b) && answeredFor(c.id, b)));
    if (!engaged.length) {
      missing.push({
        key: 'answers',
        label: 'Answer the questions on at least one bill',
        why: 'The questions above are what turn a stack of PDFs into findings — whether you '
          + 'rent your equipment, whether you are on a promotional rate, what you no longer '
          + 'use. A bill can show us the amount; only you can tell us what you still want.',
      });
    }

    return { sufficient: missing.length === 0, missing };
  }

  /* ------------------------------------------------- the audit block

     What the writer is handed. Same shape as the rental and closing engines
     pass into api/_lib/navigator-engine.js: the model presents these findings
     and may not originate one, and every finding carries a checkId so the
     output ceiling can count the work in front of the writer directly.
     -------------------------------------------------------------------- */
  function toAuditBlock(analysis) {
    return {
      product: 'home-savings',
      generatedAt: analysis.generatedAt,
      checkCount: analysis.checkCount,
      checkRuns: analysis.checkRuns,
      billCount: analysis.billCount,
      monthlySpend: analysis.monthlySpend,
      annualSpend: analysis.annualSpend,
      totals: analysis.totals,
      findings: analysis.findings.map((f) => ({
        checkId: f.checkId,
        check: f.slug,
        bill: f.bill,
        title: f.title,
        action: f.action,
        actionLabel: f.actionLabel,
        savingKind: f.kind,
        annualAmount: f.amount || 0,
        exposureAnnual: f.exposureAnnual || null,
        basis: f.basis,
        why: f.why,
        step: f.step,
        cautions: f.cautions || [],
        actOn: f.actOn || null,
        blockedRuleId: f.blockedRuleId || null,
        withinNorms: f.withinNorms === true,
      })),
      couldNotRun: analysis.couldNotRun,
      openQuestions: analysis.openQuestions || [],
      disagreements: analysis.disagreements || [],
    };
  }

  return {
    CHECKS,
    CHECK_COUNT,
    BILL_KINDS,
    SavingKind,
    Action,
    ACTION_LABELS,
    TRIVIAL_ANNUAL,
    OWN_EQUIPMENT_ONE_OFF,
    analyze,
    buildScorecard,
    checkSufficiency,
    toAuditBlock,
    _internal: { money, annual, applySafety, answeredFor, billLabel, kindOf },
  };
}));
