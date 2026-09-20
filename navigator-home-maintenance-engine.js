/* =========================================================================
   navigator-home-maintenance-engine.js — the deterministic half of Home
   Maintenance Navigator.

   Before this file existed, /home-maintenance was a single paragraph in
   PRODUCT_CONFIGS handed to the model with one free-text box of input, told
   to weigh repair against replacement "using general knowledge of typical
   lifespans and typical cost ranges" — the exact unverifiable claim this
   codebase's own audits had already found and banned on Home Savings and
   Government Money for the same reason: nobody here holds a price table,
   and a home system's repair/replacement cost depends on the specific unit,
   the contractor, and the region far too much for a general-knowledge guess
   to be worth $59. See docs/HOME-MAINTENANCE-AUDIT.md.

   So this is the house pattern applied to the second product that did not
   have it (Insurance Navigator was the first — api/_lib/insurance-audit.js).
   Nothing here calls a model, nothing here reaches the network, and every
   dollar figure it prints is arithmetic on a number the customer typed —
   their own repair quote against their own replacement quote, never a
   guess at what either "usually" costs.

   ONE THING HERE IS DELIBERATELY NOT ARITHMETIC ON THE CUSTOMER'S OWN
   NUMBERS: the typical-service-life ranges in LIFESPAN_RANGES below. That is
   a considered exception, not a lapse back into the pattern this file exists
   to close, and the difference is worth being explicit about. A "typical
   premium" or "typical cost" is a current market price — it moves with
   inflation, region, and the specific vendor, there is no stable source for
   it, and asserting one is exactly the failure mode Insurance's audit
   found. A system's typical SERVICE LIFE IN YEARS is a slow-moving
   engineering fact, published by manufacturers and standards bodies, that
   does not reprice itself every quarter — the same category of general,
   durable knowledge property-tax's own prompt already leans on for how
   appeals processes work. It is used here only for CONTEXT (where does this
   system's age sit relative to a normal range), is a small curated table
   rather than a live model guess, is never used to produce or imply a
   dollar figure, and every statement of it carries its own caveat. If that
   line ever gets blurred — a lifespan range doing the work of a cost
   estimate, or turning into a specific claim about THIS unit rather than a
   general range — this exception has been misused.

   THE ONE RULE THAT MATTERS MOST: a safety concern is never weighed against
   cost. See applySafetyOverride() — it can only ever short-circuit straight
   to "get a professional now," and nothing downstream of it may soften that
   into a repair-vs-replace comparison.

   Lives at the repository root, beside navigator-subscription-engine.js and
   navigator-government-money-engine.js and for the same reason: it is
   required by the API *and* served to the browser as a plain script, so the
   check that decides whether a customer may pay and the check the server
   enforces cannot drift — they are one file.
   ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HomeMaintenanceEngine = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CATEGORIES = ['Roof', 'HVAC', 'Water Heater', 'Windows', 'Generator', 'Other'];

  const SYMPTOMS = [
    'stopped_working', 'leaking_or_damage', 'declining_performance',
    'safety_concern', 'comparing_before_failure', 'other',
  ];

  const Verdict = {
    URGENT_SAFETY: 'urgent_safety',
    REPLACE: 'replace',
    REPAIR: 'repair',
    NEED_REPLACEMENT_QUOTE: 'need_replacement_quote',
    NEED_REPAIR_QUOTE: 'need_repair_quote',
    NEED_BOTH_QUOTES: 'need_both_quotes',
  };

  // The "50% rule" — a widely-used, disclosed personal-finance heuristic
  // (the same shape as "if repair costs more than half of replacement, replace
  // it," commonly given for appliances and vehicles), not a market claim.
  // Stated plainly to the customer every time it is used, exactly like the
  // materiality threshold insurance-audit.js discloses rather than hides.
  const REPLACE_RATIO_THRESHOLD = 0.5;

  // See the file header for why this table is here and what it is not. Every
  // entry names its own caveat because "roof" and "water heater" each cover a
  // range of materials with very different service lives, and the single
  // number this table gives is for the most common case only.
  const LIFESPAN_RANGES = {
    'Roof': {
      low: 20, high: 25,
      caveat: 'This range assumes asphalt shingle, the most common roofing material. Tile, metal and slate roofs commonly last significantly longer.',
    },
    'HVAC': {
      low: 15, high: 20,
      caveat: 'Furnaces, air conditioners and heat pumps with regular maintenance. Coastal climates and heavy usage commonly shorten this.',
    },
    'Water Heater': {
      low: 8, high: 12,
      caveat: 'This range assumes a standard storage-tank unit. Tankless water heaters commonly last 15-20 years.',
    },
    'Windows': {
      low: 20, high: 30,
      caveat: 'Vinyl and fiberglass frames. Wood-framed windows vary more widely depending on maintenance.',
    },
    'Generator': {
      low: 20, high: 25,
      caveat: 'Standby home generators, as commonly rated by manufacturers in years or running hours, whichever comes first.',
    },
    // 'Other' deliberately has no entry — there is no single system this
    // could describe, and a guessed range for an unnamed system is exactly
    // what this table exists to avoid producing.
  };

  const CHECKLISTS = {
    'Roof': [
      'Ask whether the quote is a tear-off of the old roof or an overlay on top of it.',
      'Ask about the warranty on materials and on labor separately — they are usually not the same length.',
      'Get at least one more quote before a full replacement.',
    ],
    'HVAC': [
      'Ask whether the quote is a like-for-like replacement or an upgrade in capacity or efficiency.',
      'Ask about the warranty on the compressor or heat exchanger separately from labor.',
      'Confirm whether the existing ductwork was inspected as part of the quote.',
    ],
    'Water Heater': [
      'Ask whether the quote includes any code-compliance work your area requires (an expansion tank, a drip pan, updated venting).',
      'Ask about the warranty length on the tank itself, separate from the installation.',
    ],
    'Windows': [
      'Ask whether the quote is full-frame replacement or an insert into the existing frame — the price and the result differ a great deal.',
      'Confirm the glass rating matches your climate before comparing quotes on price alone.',
    ],
    'Generator': [
      'Confirm installation, a transfer switch, and any required permit are included in the quote, not priced separately later.',
      'Ask what a maintenance contract covers and what it costs per year.',
    ],
    'Other': [
      'Get at least two independent quotes before committing.',
      'Ask exactly what is covered under warranty, for how long, and what voids it.',
    ],
  };

  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function pct(fraction) {
    return Math.round(fraction * 100) + '%';
  }

  function lifespanContext(category, ageYears) {
    const range = LIFESPAN_RANGES[category];
    if (!range) return null;
    if (ageYears === null) return { range, ageYears: null, pastTypicalRange: null, withinTypicalRange: null };
    return {
      range,
      ageYears,
      pastTypicalRange: ageYears > range.high,
      withinTypicalRange: ageYears >= range.low && ageYears <= range.high,
    };
  }

  // The one rule that can never be overridden by a cost comparison. Returns
  // a terminal result on its own, never merely a caution attached to one.
  function applySafetyOverride(category, symptoms, ageContext) {
    if (!symptoms.includes('safety_concern')) return null;
    return {
      category,
      verdict: Verdict.URGENT_SAFETY,
      reasons: ['This was flagged as a safety concern.'],
      ageContext,
      costComparison: null,
      cautions: [
        'This is not a repair-vs-replace decision until the hazard itself is addressed. Contact a '
          + 'licensed professional now. For a suspected gas leak, leave the property and call your gas '
          + 'utility or 911 from outside — do not operate switches, appliances, or attempt any repair '
          + 'yourself first.',
      ],
      checklist: [],
    };
  }

  // formData is what the page's structured fields (and the server-side
  // sufficiency gate below) both read and write, so the shape here is the
  // one contract between the client and the server.
  function analyze(formData) {
    const f = formData || {};
    const category = CATEGORIES.includes(f.category) ? f.category : 'Other';
    const ageYears = f.age_unknown ? null : num(f.system_age_years);
    const symptoms = Array.isArray(f.symptoms) ? f.symptoms.filter((s) => SYMPTOMS.includes(s)) : [];
    const repairQuote = num(f.repair_quote);
    const replacementQuote = num(f.replacement_quote);

    const ageContext = lifespanContext(category, ageYears);

    const safety = applySafetyOverride(category, symptoms, ageContext);
    if (safety) return safety;

    const reasons = [];
    const cautions = [];
    let verdict;
    let costComparison = null;

    if (repairQuote !== null && replacementQuote !== null && replacementQuote > 0) {
      const ratio = repairQuote / replacementQuote;
      costComparison = { repairQuote, replacementQuote, ratio, threshold: REPLACE_RATIO_THRESHOLD };
      if (ratio >= REPLACE_RATIO_THRESHOLD) {
        verdict = Verdict.REPLACE;
        reasons.push(`The repair quote ($${repairQuote.toLocaleString('en-US')}) is ${pct(ratio)} of the `
          + `replacement quote ($${replacementQuote.toLocaleString('en-US')}) — at or above the `
          + `${pct(REPLACE_RATIO_THRESHOLD)} threshold where replacing is usually the better value.`);
      } else {
        verdict = Verdict.REPAIR;
        reasons.push(`The repair quote ($${repairQuote.toLocaleString('en-US')}) is ${pct(ratio)} of the `
          + `replacement quote ($${replacementQuote.toLocaleString('en-US')}) — below the `
          + `${pct(REPLACE_RATIO_THRESHOLD)} threshold, so repairing is the cheaper path for now.`);
        if (ageContext && ageContext.pastTypicalRange) {
          cautions.push(`This system is already past the typical service-life range for ${category.toLowerCase()} `
            + `given below, so a repair now may only buy a limited amount of time before this decision comes up again.`);
        }
      }
    } else if (repairQuote !== null && replacementQuote === null) {
      verdict = Verdict.NEED_REPLACEMENT_QUOTE;
      reasons.push('A repair quote was given but no replacement quote — without both there is no comparison to make.');
    } else if (replacementQuote !== null && repairQuote === null) {
      verdict = Verdict.NEED_REPAIR_QUOTE;
      reasons.push('A replacement quote was given but no repair quote — without both there is no comparison to make.');
    } else {
      verdict = Verdict.NEED_BOTH_QUOTES;
      reasons.push('No repair or replacement quote was provided, so no financial recommendation can be made yet.');
    }

    return {
      category, verdict, reasons, ageContext, costComparison, cautions,
      checklist: CHECKLISTS[category] || CHECKLISTS.Other,
    };
  }

  function checkSufficiency(formData) {
    const missing = [];
    const f = formData || {};
    const category = CATEGORIES.includes(f.category) ? f.category : '';

    if (!category) {
      missing.push({
        key: 'category', label: 'Choose which system this decision is about',
        why: 'The typical-life comparison and the checklist both depend on knowing what kind of system this is.',
      });
    }

    if (num(f.system_age_years) === null && !f.age_unknown) {
      missing.push({
        key: 'system_age_years', label: 'Enter the system\'s age, or mark it unknown',
        why: 'Age is what places this system on or off a typical service-life range — without it, that context is skipped.',
      });
    }

    const symptoms = Array.isArray(f.symptoms) ? f.symptoms.filter((s) => SYMPTOMS.includes(s)) : [];
    if (!symptoms.length) {
      missing.push({
        key: 'symptoms', label: 'Select at least one reason this decision has come up',
        why: 'A safety concern is handled completely differently from general wear, and this is the only way we know which applies.',
      });
    }

    const hasQuote = num(f.repair_quote) !== null || num(f.replacement_quote) !== null;
    if (!hasQuote && !f.no_quotes_yet) {
      missing.push({
        key: 'quotes', label: 'Enter a repair or replacement cost, or confirm there isn\'t one yet',
        why: 'Every dollar figure in this report is arithmetic on a quote you give us — never a guess at what either '
          + 'one usually costs. Without at least one, the report can only give the age context and the checklist, and you should know that before paying.',
      });
    }

    return { sufficient: missing.length === 0, missing };
  }

  const api = {
    CATEGORIES, SYMPTOMS, Verdict, REPLACE_RATIO_THRESHOLD, LIFESPAN_RANGES, CHECKLISTS,
    analyze, checkSufficiency,
    _internal: { num, pct, lifespanContext },
  };

  return api;
}));
