/* =========================================================================
   navigator-government-money-engine.js — the deterministic half of
   Government Money Finder.

   Before this file existed, /government-money was a 219-word prompt in
   PRODUCT_CONFIGS handed to the model with one free-text box of input. The
   page sold "AI searches current programs", "estimated dollar value of each
   program" and "deadlines or windows you shouldn't miss" while the prompt's
   own second paragraph read "You do not have live access to current program
   databases" and the shared honesty rules forbade, by name, stating the
   current dollar amount of a specific government program. Three of the six
   things the customer paid for were declined by the engine as policy, and the
   form never asked which state they lived in. See
   docs/GOVERNMENT-MONEY-AUDIT.md.

   So this is the house pattern applied to the last product without it:
   closing-audit.js, rental-audit.js, landlord-audit.js,
   navigator-subscription-engine.js and navigator-home-savings-engine.js
   decide, and the model writes up what they decided. Nothing here calls a
   model, nothing here reaches the network, and — the difference that matters
   on this product — nothing here states a dollar amount at all.

   THE FOUR RULES THAT MATTER MOST are not the ones that find money. They are
   the ones that refuse to:

     D1  A credit against tax you do not owe is worth nothing. A household
         that says it expects no federal income tax liability never sees a
         non-refundable credit presented as money.
     D3  Programs sharing an annual ceiling do not stack into several
         ceilings. Three pieces of work in one year is one cap.
     D4  A utility rebate usually reduces the cost a federal credit is
         computed on, so the two do not add. Where both touch one purchase,
         the line carries the order to work them out in.
     D5  Whoever sold the solar, the EV or the heat pump almost certainly
         mentioned the headline credit at the time. Those come back as
         "confirm you already claimed this", not as a discovery.

   In all four, the obvious read of the customer's answers points at the
   answer that leaves them worse off — told about money they will not get, or
   told to count the same money twice. So they are implemented as a pass that
   can only ever LOWER a verdict, never raise one, and
   tests/government-money-engine.test.js enumerates every combination of
   answers a customer can give and asserts that not one of them escapes.

   The catalogue is data/government-programs.json, which holds gates and
   authorities and deliberately holds no amounts. In Node it is required. In
   the browser the page fetches it and calls load() — and note that
   checkSufficiency() works WITHOUT it, so the checkout gate never depends on
   that fetch succeeding.
   ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GovernmentMoneyEngine = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------- the places */

  // Names and postal codes for the fifty states, DC and the five inhabited
  // territories. Territories are included because their residents are
  // eligible for federal programs and for their own local ones, and being
  // told "name your state" by a form that does not know Guam exists is its
  // own kind of insult.
  const PLACES = [
    ['Alabama', 'AL'], ['Alaska', 'AK'], ['Arizona', 'AZ'], ['Arkansas', 'AR'],
    ['California', 'CA'], ['Colorado', 'CO'], ['Connecticut', 'CT'], ['Delaware', 'DE'],
    ['Florida', 'FL'], ['Georgia', 'GA'], ['Hawaii', 'HI'], ['Idaho', 'ID'],
    ['Illinois', 'IL'], ['Indiana', 'IN'], ['Iowa', 'IA'], ['Kansas', 'KS'],
    ['Kentucky', 'KY'], ['Louisiana', 'LA'], ['Maine', 'ME'], ['Maryland', 'MD'],
    ['Massachusetts', 'MA'], ['Michigan', 'MI'], ['Minnesota', 'MN'], ['Mississippi', 'MS'],
    ['Missouri', 'MO'], ['Montana', 'MT'], ['Nebraska', 'NE'], ['Nevada', 'NV'],
    ['New Hampshire', 'NH'], ['New Jersey', 'NJ'], ['New Mexico', 'NM'], ['New York', 'NY'],
    ['North Carolina', 'NC'], ['North Dakota', 'ND'], ['Ohio', 'OH'], ['Oklahoma', 'OK'],
    ['Oregon', 'OR'], ['Pennsylvania', 'PA'], ['Rhode Island', 'RI'], ['South Carolina', 'SC'],
    ['South Dakota', 'SD'], ['Tennessee', 'TN'], ['Texas', 'TX'], ['Utah', 'UT'],
    ['Vermont', 'VT'], ['Virginia', 'VA'], ['Washington', 'WA'], ['West Virginia', 'WV'],
    ['Wisconsin', 'WI'], ['Wyoming', 'WY'],
    ['District of Columbia', 'DC'],
    ['Puerto Rico', 'PR'], ['Guam', 'GU'], ['American Samoa', 'AS'],
    ['U.S. Virgin Islands', 'VI'], ['Northern Mariana Islands', 'MP'],
  ];
  const CODES = new Set(PLACES.map((p) => p[1]));
  const NAME_TO_CODE = new Map(PLACES.map((p) => [p[0].toLowerCase(), p[1]]));

  // Full names match case-insensitively; postal codes match UPPERCASE ONLY,
  // and that asymmetry is the whole trick. Half the codes are ordinary
  // English words — IN, OR, ME, OK, HI, DE, MS, PA, AL, AR, CA — and a
  // case-insensitive match on those passes every sentence ever written, which
  // is a gate that is not a gate. Anyone writing "Ohio" is matched by name;
  // anyone writing "OH" meant the state.
  const NAME_RE = new RegExp(
    '\\b(' + PLACES.map((p) => p[0].replace(/\./g, '\\.')).join('|') + ')\\b', 'i',
  );
  const CODE_RE = new RegExp('\\b(' + PLACES.map((p) => p[1]).join('|') + ')\\b');
  const ZIP_RE = /\b\d{5}(?:-\d{4})?\b/;

  function namesAPlace(text) {
    const s = String(text || '');
    return NAME_RE.test(s) || CODE_RE.test(s) || ZIP_RE.test(s);
  }

  /* --------------------------------------------------------- the answer set */

  const TENURE = ['own', 'rent'];
  const LIABILITY = ['yes', 'no', 'unsure'];
  const CLAIMED = ['yes', 'no', 'unsure'];
  const INCOME_BANDS = ['under-50k', '50-75k', '75-100k', '100-150k', 'over-150k', 'prefer-not-say'];

  const INCOME_LABELS = {
    'under-50k': 'under $50,000',
    '50-75k': '$50,000–$75,000',
    '75-100k': '$75,000–$100,000',
    '100-150k': '$100,000–$150,000',
    'over-150k': 'over $150,000',
    'prefer-not-say': 'not given',
  };

  const ACTION_LABELS = {
    solar: 'solar panels', battery: 'battery storage', geothermal: 'a geothermal system',
    'heat-pump': 'a heat pump', 'heat-pump-water-heater': 'a heat-pump water heater',
    'water-heater': 'a water heater', 'furnace-ac': 'a furnace or air conditioner',
    insulation: 'insulation', 'air-sealing': 'air sealing', windows: 'windows', doors: 'exterior doors',
    'panel-upgrade': 'an electrical panel upgrade', 'induction-range': 'an induction range',
    'ev-new': 'a new electric vehicle', 'ev-used': 'a used electric vehicle',
    'ev-charger': 'a home EV charger', 'energy-audit': 'a home energy audit',
    'smart-thermostat': 'a smart thermostat',
  };

  const EVENT_LABELS = {
    'first-home': 'bought a first home', 'new-child': 'a new child in the household',
    'paid-childcare': 'paid for childcare', tuition: 'paid tuition',
    'turned-65': 'someone turned 65', veteran: 'a veteran in the household',
    disability: 'a disability in the household', 'low-income-year': 'an unusually low-income year',
    'bought-own-health-insurance': 'bought health insurance directly',
  };

  // The three actions whose headline credit is advertised at the point of
  // sale by somebody with a commission riding on it. The report frames these
  // as "confirm you already have this" rather than as a discovery, because
  // telling a customer what their installer told them is not worth paying for.
  const SALES_ADVERTISED = ['solar', 'ev-new', 'ev-used', 'heat-pump'];

  /* ------------------------------------------------------------- the verdicts */

  const Verdict = {
    CLAIM: 'claim',
    CHECK: 'check',
    NOT_NOW: 'not-now',
    RULED_OUT: 'ruled-out',
  };

  // Strength order. Stage 2 may move a line DOWN this ladder and never up —
  // the structural property that makes the safety pass trustworthy, and the
  // one tests/government-money-engine.test.js checks on every combination.
  const RANK = { claim: 3, check: 2, 'not-now': 1, 'ruled-out': 0 };

  const VERDICT_LABELS = {
    claim: 'On your shortlist',
    check: 'Worth checking',
    'not-now': 'Not this year',
    'ruled-out': 'Ruled out',
  };

  /* ------------------------------------------------------------ the catalogue */

  let CATALOGUE = null;

  function load(json) {
    if (!json || !Array.isArray(json.programs)) {
      throw new Error('government-programs catalogue is missing or malformed');
    }
    CATALOGUE = json;
    return CATALOGUE;
  }

  // Node loads it directly; the browser fetches it and calls load(). The
  // require is wrapped because this same file is served to the browser, where
  // `require` does not exist and a bare reference would throw on parse of the
  // surrounding scope in some bundlers.
  function catalogue() {
    if (CATALOGUE) return CATALOGUE;
    if (typeof module === 'object' && module.exports && typeof require === 'function') {
      // eslint-disable-next-line global-require
      CATALOGUE = require('./data/government-programs.json');
      return CATALOGUE;
    }
    return null;
  }

  function isLoaded() { return !!catalogue(); }

  /* --------------------------------------------------------------- the gate */

  // The pre-payment sufficiency check. Deliberately catalogue-free: it is the
  // thing standing between a customer and a charge, so it must not be able to
  // fail because a JSON fetch did.
  //
  // Five answers are required and two lists must be present-but-may-be-empty.
  // The distinction matters: an empty list we were given is the answer "none",
  // and an absent one is a question nobody asked. The report says different
  // things about each.
  const REQUIRED = [
    ['state', 'which state you live in'],
    ['tenure', 'whether you own or rent'],
    ['householdSize', 'how many people are in the household'],
    ['incomeBand', 'roughly what the household earns'],
    ['taxLiability', 'whether you expect to owe federal income tax'],
  ];

  function normalizeState(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    if (CODES.has(s.toUpperCase()) && s.length === 2) return s.toUpperCase();
    const byName = NAME_TO_CODE.get(s.toLowerCase());
    return byName || null;
  }

  function checkSufficiency(formData) {
    const f = formData || {};

    // A submission from the old free-text page, or from anything posting the
    // pre-2026-09-19 shape. Held to the one rule that page was gated on, so an
    // in-flight browser with a cached script cannot be broken by this change
    // and cannot bypass the place requirement either.
    //
    // "Legacy" means NOT ONE structured answer is present, not merely that the
    // state box is empty. The structured form always posts a description field
    // — it has an optional free-text box — so testing on state alone sent a
    // half-filled modern form down this path and told the customer to "tell us
    // about your situation" when what was actually missing was four tick-box
    // answers it could have named.
    const structured = TENURE.indexOf(f.tenure) !== -1
      || INCOME_BANDS.indexOf(f.incomeBand) !== -1
      || LIABILITY.indexOf(f.taxLiability) !== -1
      || Number(f.householdSize) >= 1
      || Array.isArray(f.actionsDone)
      || Array.isArray(f.events);

    if (!f.state && !structured && typeof f.description === 'string') {
      if (!f.description.trim()) {
        return {
          sufficient: false,
          missing: ['description'],
          message: 'Tell us about your situation — at minimum, which state you live in.',
        };
      }
      if (!namesAPlace(f.description)) {
        return {
          sufficient: false,
          missing: ['state'],
          message: 'Add your state (or ZIP code). Federal programs are the same everywhere, '
            + 'but state, county and utility programs are not — and those are most of them.',
        };
      }
      return { sufficient: true, missing: [], message: null, legacy: true };
    }

    const missing = [];
    const wanted = [];

    if (!normalizeState(f.state)) { missing.push('state'); wanted.push(REQUIRED[0][1]); }
    if (TENURE.indexOf(f.tenure) === -1) { missing.push('tenure'); wanted.push(REQUIRED[1][1]); }
    if (!(Number(f.householdSize) >= 1)) { missing.push('householdSize'); wanted.push(REQUIRED[2][1]); }
    if (INCOME_BANDS.indexOf(f.incomeBand) === -1) { missing.push('incomeBand'); wanted.push(REQUIRED[3][1]); }
    if (LIABILITY.indexOf(f.taxLiability) === -1) { missing.push('taxLiability'); wanted.push(REQUIRED[4][1]); }

    // Present-but-empty is a valid answer; absent is not.
    if (!Array.isArray(f.actionsDone)) { missing.push('actionsDone'); wanted.push('what you have bought or installed recently (tick "nothing" if none)'); }
    if (!Array.isArray(f.events)) { missing.push('events'); wanted.push('what has changed for the household (tick "nothing" if none)'); }

    if (missing.length) {
      return {
        sufficient: false,
        missing,
        message: `A few more answers are needed before this can be analysed: ${wanted.join('; ')}.`,
      };
    }
    return { sufficient: true, missing: [], message: null };
  }

  /* ---------------------------------------------------------- normalisation */

  function uniq(a) { return [...new Set(a)]; }
  function intersect(a, b) { return (a || []).filter((x) => (b || []).indexOf(x) !== -1); }

  function normalize(formData) {
    const f = formData || {};
    return {
      state: normalizeState(f.state),
      zip: String(f.zip || '').trim() || null,
      tenure: TENURE.indexOf(f.tenure) !== -1 ? f.tenure : null,
      householdSize: Number(f.householdSize) >= 1 ? Math.round(Number(f.householdSize)) : null,
      incomeBand: INCOME_BANDS.indexOf(f.incomeBand) !== -1 ? f.incomeBand : 'prefer-not-say',
      taxLiability: LIABILITY.indexOf(f.taxLiability) !== -1 ? f.taxLiability : 'unsure',
      alreadyClaimed: CLAIMED.indexOf(f.alreadyClaimed) !== -1 ? f.alreadyClaimed : 'unsure',
      done: uniq(Array.isArray(f.actionsDone) ? f.actionsDone : []),
      planned: uniq(Array.isArray(f.actionsPlanned) ? f.actionsPlanned : []),
      events: uniq(Array.isArray(f.events) ? f.events : []),
      utility: String(f.utility || '').trim() || null,
      notes: String(f.notes || f.description || '').trim() || null,
    };
  }

  /* ------------------------------------------------------- Stage 1 — the gate */

  function gate(p, a, cat) {
    const blockers = [];
    const reasons = [];
    const unknowns = [];
    let futureOnly = null;

    if (p.tenure && p.tenure.indexOf(a.tenure) === -1) {
      blockers.push({
        code: 'tenure',
        say: a.tenure === 'rent'
          ? 'You told us you rent, and this is for people who own and occupy the home.'
          : 'This one is for renters.',
      });
    }

    if (p.requiresStateIncomeTax) {
      const none = (cat.noIndividualIncomeTax || []).indexOf(a.state) !== -1;
      if (none) {
        blockers.push({
          code: 'no-state-income-tax',
          say: `${a.state} has no broad individual income tax, so there is no state return for a credit like this to sit on.`,
        });
      } else {
        reasons.push({ code: 'state-has-income-tax', say: `${a.state} levies an individual income tax, so a state-level credit is possible.` });
      }
    }

    if (Array.isArray(p.qualifyingActions) && p.qualifyingActions.length) {
      const done = intersect(p.qualifyingActions, a.done);
      const planned = intersect(p.qualifyingActions, a.planned);
      if (done.length) {
        reasons.push({
          code: 'qualifying-work-done',
          actions: done,
          say: `You told us you had ${done.map((x) => ACTION_LABELS[x] || x).join(' and ')} done.`,
        });
      } else if (planned.length) {
        futureOnly = planned;
      } else {
        blockers.push({ code: 'no-qualifying-purchase', say: 'Nothing you told us about falls into what this covers.' });
      }
    }

    if (Array.isArray(p.requiresEvents) && p.requiresEvents.length) {
      const hit = intersect(p.requiresEvents, a.events);
      if (hit.length) {
        reasons.push({
          code: 'life-event',
          events: hit,
          say: `You told us about ${hit.map((x) => EVENT_LABELS[x] || x).join(' and ')}.`,
        });
      } else {
        blockers.push({ code: 'no-matching-life-event', say: 'Nothing you told us about the household points at this one.' });
      }
    }

    let incomeScreen = false;
    if (Array.isArray(p.incomeBands) && p.incomeBands.length) {
      incomeScreen = true;
      if (a.incomeBand === 'prefer-not-say') {
        unknowns.push({ code: 'income-band', say: 'You did not give an income band, and this one is gated on income.' });
      } else if (p.incomeBands.indexOf(a.incomeBand) === -1) {
        blockers.push({
          code: 'income-band',
          say: `This is for households under an income ceiling, and you told us ${INCOME_LABELS[a.incomeBand]}.`,
        });
      } else {
        reasons.push({
          code: 'income-band',
          say: `Your band (${INCOME_LABELS[a.incomeBand]}) is inside the range this kind of program usually screens for — though the real ceiling moves with household size, so it is a screen and not a determination.`,
        });
      }
    }

    let verdict;
    let revisit = null;
    if (blockers.length) {
      verdict = Verdict.RULED_OUT;
    } else if (futureOnly) {
      verdict = Verdict.NOT_NOW;
      revisit = {
        when: `when the ${futureOnly.map((x) => ACTION_LABELS[x] || x).join(' and ')} work is finished and paid for`,
        on: null,
        why: 'These are claimed for the year the work is finished, not the year you decide to do it.',
      };
      reasons.push({
        code: 'planned-work',
        actions: futureOnly,
        say: `You told us you are planning ${futureOnly.map((x) => ACTION_LABELS[x] || x).join(' and ')}.`,
      });
    } else if (unknowns.length || incomeScreen || p.confidence === 'check') {
      verdict = Verdict.CHECK;
    } else {
      verdict = Verdict.CLAIM;
    }

    return {
      id: p.id,
      scope: p.scope,
      label: p.label,
      covers: p.covers || null,
      verdict,
      verdictLabel: VERDICT_LABELS[verdict],
      reasons,
      blockers,
      unknowns,
      revisit,
      cautions: [],
      sharesCapWith: [],
      stackingWith: [],
      amountGovernedBy: null,
      authority: (cat.authorities || {})[p.authority] || null,
      confidence: p.confidence || 'check',
      note: p.note || null,
      // Never set. Present so that the absence is explicit rather than
      // accidental, and so the test asserting it can point at a field.
      amount: null,
    };
  }

  /* -------------------------------------------- Stage 2 — the DON'T-COUNT pass */

  // The only mutator in this file that touches a verdict, and it can only
  // lower one. Every call goes through here so the invariant is in one place.
  function demote(line, to, caution) {
    if (RANK[to] < RANK[line.verdict]) {
      line.verdict = to;
      line.verdictLabel = VERDICT_LABELS[to];
    }
    if (caution) line.cautions.push(caution);
    return line;
  }

  function monthsBetween(isoA, isoB) {
    const a = new Date(isoA);
    const b = new Date(isoB);
    if (isNaN(a) || isNaN(b)) return 0;
    return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  }

  function dontCount(lines, a, cat, today) {
    const byId = new Map(cat.programs.map((p) => [p.id, p]));

    for (const line of lines) {
      const p = byId.get(line.id);
      if (!p) continue;
      if (line.verdict === Verdict.RULED_OUT) continue;

      /* D1 — a credit against tax you do not owe. The first rule, and the one
         that most often points the other way: a household that has just spent
         $9,000 on a heat pump is exactly the household most pleased to be told
         about a credit, and exactly the household for whom it is worth nothing
         if they owe nothing. */
      const nonRefundable = p.requiresTaxLiability && !p.refundable && !p.partiallyRefundable;
      if (nonRefundable && a.taxLiability === 'no') {
        if (p.carryforward) {
          demote(line, Verdict.CHECK, {
            code: 'D1-carryforward',
            say: 'This reduces federal tax owed and you told us you expect to owe none. Unused '
              + 'amounts on this particular credit have historically carried forward to a later '
              + 'year, so it is not necessarily lost — but it is not money this year. Confirm the '
              + 'carryforward rules before you count on it.',
          });
        } else {
          demote(line, Verdict.NOT_NOW, {
            code: 'D1',
            say: 'This reduces federal tax owed, and you told us you expect to owe none this year. '
              + 'That makes it worth nothing to you now, whatever figure you see quoted elsewhere.',
          });
          line.revisit = line.revisit || {
            when: 'a year in which you expect to owe federal income tax',
            on: null,
            why: 'A non-refundable credit needs a tax bill to reduce.',
          };
        }
      } else if (nonRefundable && a.taxLiability === 'unsure') {
        demote(line, Verdict.CHECK, {
          code: 'D1-unsure',
          say: 'This reduces federal tax owed, and you were not sure whether you will owe any. '
            + 'Settle that first — it decides whether this line is worth anything at all.',
        });
      }

      /* D2 — a cap is a ceiling, not a payment. We hold no amounts and never
         collect what the work cost, so no figure is ever stated. What the line
         carries instead is what GOVERNS the figure. */
      if (p.capKind) {
        line.amountGovernedBy = {
          'percentage-of-cost': 'a percentage of what you actually spent, with no annual ceiling',
          'percentage-of-cost-with-cap': 'a percentage of what you actually spent, up to an annual ceiling',
          'percentage-of-price-with-cap': 'a percentage of the purchase price, up to a ceiling',
          'fixed-with-eligibility-conditions': 'a fixed amount, but only if the item itself qualifies',
        }[p.capKind] || 'rules published by the authority named on this line';
        line.cautions.push({
          code: 'D2',
          say: `The amount is ${line.amountGovernedBy}. We do not hold current figures and will not `
            + 'estimate one — confirm it at the authority on this line.',
        });
      }

      /* D5 — a discovery the installer already made. Respect a customer who
         says they have not claimed, but say the words anyway on the four
         purchases somebody had a commission riding on. */
      const advertised = intersect(SALES_ADVERTISED, intersect(p.qualifyingActions || [], a.done));
      if (advertised.length) {
        if (a.alreadyClaimed === 'yes') {
          demote(line, Verdict.CHECK, {
            code: 'D5',
            say: 'You told us something has already been claimed for this work. Confirm exactly '
              + 'what, before claiming again — the same expense cannot be used twice.',
          });
        } else {
          line.cautions.push({
            code: 'D5-advertised',
            say: `Whoever sold you ${advertised.map((x) => ACTION_LABELS[x] || x).join(' and ')} `
              + 'very likely mentioned this credit at the time. Check your paperwork before '
              + 'treating it as something new.',
          });
        }
      } else if (a.alreadyClaimed === 'yes' && (p.qualifyingActions || []).length) {
        line.cautions.push({
          code: 'D5-unspecified',
          say: 'You told us something has already been claimed. Confirm what it covered before '
            + 'adding this one.',
        });
      }

      /* D6 — a stale catalogue entry says so rather than pretending. Will not
         fire today. It is here for the year nobody has opened this file. */
      const asOf = p.asOf || cat.asOf;
      if (asOf && today && monthsBetween(asOf, today) > 18) {
        demote(line, Verdict.CHECK, {
          code: 'D6',
          say: `What we hold about this kind of program was last reviewed on ${asOf}, which is `
            + 'long enough ago to treat every part of it as needing confirmation.',
        });
      }

      /* D7 — defensive. A tenure mismatch must never survive Stage 1, and if
         one ever does it is removed rather than shown. */
      if (p.tenure && p.tenure.indexOf(a.tenure) === -1) {
        demote(line, Verdict.RULED_OUT, { code: 'D7', say: 'Tenure does not match.' });
      }
    }

    /* D3 — a shared annual ceiling. Runs across lines rather than within one,
       so it comes after the per-line pass. */
    const live = lines.filter((l) => l.verdict !== Verdict.RULED_OUT);
    const groups = new Map();
    for (const line of live) {
      const p = byId.get(line.id);
      if (!p || !p.capGroup) continue;
      if (!groups.has(p.capGroup)) groups.set(p.capGroup, []);
      groups.get(p.capGroup).push(line);
    }
    const sharedCaps = [];
    for (const [group, members] of groups) {
      if (members.length < 2) continue;
      const ids = members.map((m) => m.id);
      sharedCaps.push({ group, ids, say: (cat.capGroups || {})[group] || null });
      for (const line of members) {
        line.sharesCapWith = ids.filter((id) => id !== line.id);
        line.cautions.push({
          code: 'D3',
          say: `This shares one annual ceiling with ${line.sharesCapWith.length} other line`
            + `${line.sharesCapWith.length === 1 ? '' : 's'} on your shortlist. Doing several `
            + 'pieces of work in one year does not give you several ceilings — and splitting '
            + 'them across 1 January can give you two.',
        });
      }
    }

    /* D4 — a utility rebate and a federal credit on the same purchase. The
       one that quietly costs people money, because both are real, both apply,
       and adding them is wrong. */
    const stacking = [];
    const federal = live.filter((l) => byId.get(l.id) && byId.get(l.id).basisReducedByRebate);
    const utility = live.filter((l) => byId.get(l.id) && byId.get(l.id).reducesFederalBasis);
    for (const fed of federal) {
      for (const util of utility) {
        const shared = intersect(
          intersect((byId.get(fed.id).qualifyingActions || []), (byId.get(util.id).qualifyingActions || [])),
          a.done.concat(a.planned),
        );
        if (!shared.length) continue;
        stacking.push({ federal: fed.id, utility: util.id, actions: shared });
        const say = `A rebate from your utility on ${shared.map((x) => ACTION_LABELS[x] || x).join(' and ')} `
          + 'usually reduces the cost the federal credit is worked out on, so these two do not add up. '
          + 'Apply for the utility rebate first, then work the federal credit out on what you were left '
          + 'paying — doing it the other way round means redoing the arithmetic, or claiming too much.';
        fed.stackingWith.push(util.id);
        util.stackingWith.push(fed.id);
        fed.cautions.push({ code: 'D4', say });
        util.cautions.push({ code: 'D4', say });
      }
    }

    return { lines, sharedCaps, stacking };
  }

  /* -------------------------------------------------- Stage 3 — the time pass */

  function nextJanuaryFirst(today) {
    const d = new Date(today);
    const year = isNaN(d) ? new Date().getFullYear() : d.getFullYear();
    return `${year + 1}-01-01`;
  }

  function timePass(state, a, cat, today) {
    const { lines, sharedCaps } = state;

    // Work already planned inside a group that is also being claimed this
    // year is the single most actionable dated thing this product can say.
    for (const cap of sharedCaps) {
      const members = lines.filter((l) => cap.ids.indexOf(l.id) !== -1);
      const claimingNow = members.filter((l) => l.verdict === Verdict.CLAIM || l.verdict === Verdict.CHECK);
      if (claimingNow.length < 2) continue;
      for (const line of claimingNow) {
        line.cautions.push({
          code: 'T1',
          say: `If any of this work is not finished yet, finishing it after ${nextJanuaryFirst(today)} `
            + 'puts it against next year\'s ceiling instead of this one. Where the cap binds, that is '
            + 'the difference between claiming once and claiming twice.',
          revisitOn: nextJanuaryFirst(today),
        });
      }
    }

    // Planned work that lands in a ceiling the customer is ALREADY using this
    // year. T1 above only fires when two lines in one group are both live, so
    // it misses the commonest case by far: one thing claimed this year, one
    // thing booked for the spring, same ceiling. That is the single most
    // valuable dated sentence this product can produce, and it was falling
    // through.
    if (a.planned.length) {
      const byId = new Map(cat.programs.map((p) => [p.id, p]));
      const plannedGroups = new Set();
      for (const p of cat.programs) {
        if (!p.capGroup) continue;
        if (intersect(p.qualifyingActions || [], a.planned).length) plannedGroups.add(p.capGroup);
      }
      for (const line of lines) {
        const p = byId.get(line.id);
        if (!p || !p.capGroup || !plannedGroups.has(p.capGroup)) continue;
        if (line.verdict !== Verdict.CLAIM && line.verdict !== Verdict.CHECK) continue;
        if (line.cautions.some((c) => c.code === 'T1' || c.code === 'T3')) continue;
        line.cautions.push({
          code: 'T3',
          say: 'You told us more work of this kind is planned, and it shares this line\'s annual '
            + `ceiling. Finishing that work on or after ${nextJanuaryFirst(today)} puts it against `
            + 'next year\'s ceiling instead of this one. Where the cap binds, scheduling is worth '
            + 'more than anything else on this report.',
          revisitOn: nextJanuaryFirst(today),
        });
      }
    }

    // A NOT_NOW without a date or a named event is not actionable, and the
    // date is the product. It cannot be constructed without one: anything that
    // arrives here lacking both becomes a CHECK instead of shipping a line the
    // customer can do nothing with.
    for (const line of lines) {
      if (line.verdict !== Verdict.NOT_NOW) continue;
      const r = line.revisit;
      if (!r || (!r.on && !r.when)) {
        demote(line, Verdict.CHECK, {
          code: 'T2',
          say: 'Not available to you on what you have told us, and we could not work out what would '
            + 'change that — worth asking the authority on this line directly.',
        });
        line.revisit = null;
      }
    }

    return state;
  }

  /* ------------------------------------------------------------- the analysis */

  function todayISO() { return new Date().toISOString().slice(0, 10); }

  /**
   * The whole decision. Returns null for a submission that does not carry the
   * structured answers — a legacy free-text one — so the caller can say so
   * rather than pretending to have run.
   */
  function analyze(formData, today) {
    const cat = catalogue();
    if (!cat) throw new Error('government-programs catalogue not loaded');
    const when = today || todayISO();

    const suff = checkSufficiency(formData);
    if (!suff.sufficient || suff.legacy) return null;

    const a = normalize(formData);
    const gated = cat.programs.map((p) => gate(p, a, cat));
    const safe = dontCount(gated, a, cat, when);
    const timed = timePass(safe, a, cat, when);
    const lines = timed.lines;

    const of = (v) => lines.filter((l) => l.verdict === v);
    const openQuestions = [];
    if (a.taxLiability === 'unsure') {
      openQuestions.push('Whether you will owe federal income tax this year. This is the single '
        + 'biggest unknown on your report — it decides whether several of these lines are worth '
        + 'anything at all.');
    }
    if (a.incomeBand === 'prefer-not-say') {
      openQuestions.push('Your household income band. Several programs screen on it, and without '
        + 'it those lines could only be listed as worth checking rather than ruled in or out.');
    }
    if (!a.zip) {
      openQuestions.push('Your ZIP code. It identifies which utility territory you are in, and a '
        + 'few federal conditions are tied to the address itself.');
    }
    if (!a.utility) {
      openQuestions.push('Which company sends your electricity and gas bills. Every utility line '
        + 'below has to be confirmed with them by name.');
    }
    if (a.alreadyClaimed === 'unsure') {
      openQuestions.push('What, if anything, has already been claimed for this work. The same '
        + 'expense cannot be used twice, and installers very often claim or advise on it at the '
        + 'point of sale.');
    }

    return {
      asOf: cat.asOf,
      today: when,
      answers: a,
      lines,
      sharedCaps: timed.sharedCaps,
      stacking: timed.stacking,
      openQuestions,
      totals: {
        shortlist: of(Verdict.CLAIM).length,
        toConfirm: of(Verdict.CHECK).length,
        notNow: of(Verdict.NOT_NOW).length,
        ruledOut: of(Verdict.RULED_OUT).length,
        considered: lines.length,
      },
    };
  }

  /**
   * The free scorecard. Counts and categories, never the program names — the
   * same trade /closing makes with its scorecard, and the reason this page can
   * show a visitor something specific to them before asking for money.
   */
  function buildSnapshot(formData, today) {
    if (!isLoaded()) return { ready: false, reason: 'catalogue-not-loaded' };
    const suff = checkSufficiency(formData);
    if (!suff.sufficient || suff.legacy) {
      return { ready: false, reason: 'insufficient', missing: suff.missing, message: suff.message };
    }
    const r = analyze(formData, today);
    const scopes = { federal: 0, state: 0, utility: 0 };
    for (const line of r.lines) {
      if (line.verdict === Verdict.RULED_OUT) continue;
      if (scopes[line.scope] !== undefined) scopes[line.scope] += 1;
    }
    return {
      ready: true,
      totals: r.totals,
      scopes,
      openQuestions: r.openQuestions.length,
      hasStacking: r.stacking.length > 0,
      hasSharedCap: r.sharedCaps.length > 0,
      notNowDated: r.lines.filter((l) => l.verdict === Verdict.NOT_NOW && l.revisit).length,
    };
  }

  /* ------------------------------------------------- what changed since last */

  /**
   * The re-check. Given this analysis and the line verdicts stored on the
   * customer's previous completed report, say what moved — which is the only
   * honest basis for telling somebody to look at something again.
   */
  function compareWithPrior(current, priorLines) {
    if (!current || !Array.isArray(priorLines) || !priorLines.length) return null;
    const before = new Map(priorLines.map((l) => [l.id, l.verdict]));
    const changes = [];
    for (const line of current.lines) {
      const was = before.get(line.id);
      if (!was || was === line.verdict) continue;
      changes.push({
        id: line.id,
        label: line.label,
        was,
        now: line.verdict,
        direction: RANK[line.verdict] > RANK[was] ? 'opened' : 'closed',
      });
    }
    const gone = priorLines
      .filter((l) => !current.lines.some((c) => c.id === l.id))
      .map((l) => ({ id: l.id, label: l.label, was: l.verdict, now: null, direction: 'dropped' }));
    return { changes: changes.concat(gone), priorCount: priorLines.length };
  }

  /** The shape stored on a completed report so a later one can compare. */
  function storableVerdicts(analysis) {
    if (!analysis) return [];
    return analysis.lines.map((l) => ({ id: l.id, label: l.label, verdict: l.verdict }));
  }

  return {
    PLACES, CODES, namesAPlace, normalizeState,
    TENURE, LIABILITY, CLAIMED, INCOME_BANDS, INCOME_LABELS,
    ACTION_LABELS, EVENT_LABELS, SALES_ADVERTISED,
    Verdict, VERDICT_LABELS, RANK,
    load, catalogue, isLoaded,
    checkSufficiency, normalize,
    analyze, buildSnapshot, compareWithPrior, storableVerdicts,
    _internal: { gate, dontCount, timePass, demote, nextJanuaryFirst, monthsBetween },
  };
}));
