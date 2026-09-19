/* =========================================================================
   navigator-subscription-engine.js — the deterministic half of Subscription Navigator.

   Before this file existed, /subscriptions was a five-sentence prompt in
   PRODUCT_CONFIGS handed to the model with one free-text box of input. The
   page sold a keep/cancel/rotate/downgrade call on every subscription and the
   form never asked the price, the billing period, when the service was last
   used, who else used it, or whether the customer would miss it — the five
   facts every one of those four recommendations turns on. See
   docs/SUBSCRIPTIONS-AUDIT.md.

   So this is the house pattern applied to the one product that did not have
   it: closing-audit.js, landlord-audit.js and rental-audit.js decide, and the
   model writes up what they decided. Nothing here calls a model, nothing here
   reaches the network, and every figure it prints is arithmetic on a number
   the customer typed.

   THE THREE RULES THAT MATTER MOST are not the ones that find savings. They
   are the ones that refuse to:

     - never cancel a prepaid annual plan mid-term
     - never cancel a plan somebody else in the house uses
     - never cancel something that is holding the customer's data, or that
       another service is bundled into

   In all three the obvious read of the usage signal ("used twice", "never
   opened it", "barely used") points at the recommendation that leaves the
   customer worse off. They are implemented in applySafety() as a pass that
   can only ever downgrade an action, never raise one, so the invariant is
   testable directly rather than hoped for.

   Lives at the repository root, beside navigator-streaming-engine.js and for
   the same reason: it is required by the API *and* served to the browser as a
   plain script. /subscriptions runs this exact file to produce its free
   scorecard and to gate its own checkout button, so the check that decides
   whether a customer may pay and the check the server enforces cannot drift —
   they are one file.
   ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SubscriptionEngine = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The streaming catalog is real, dated and verified by hand — 20 services
  // with published prices, per-service pause policies and account URLs that
  // somebody actually opened. Requiring it rather than copying it means this
  // engine cannot drift from the free product that shares its facts.
  //
  // In the browser it arrives as window.StreamingEngine (subscriptions.html
  // loads both scripts); under Node it is a require. Either way it is
  // optional: if it is missing the engine still runs, it just holds fewer
  // facts about fewer services, which is the correct failure mode.
  let STREAM = null;
  try {
    /* eslint-disable global-require */
    STREAM = (typeof require === 'function')
      ? require('./navigator-streaming-engine.js')
      : (typeof globalThis !== 'undefined' ? globalThis.StreamingEngine : null);
  } catch (err) {
    STREAM = (typeof globalThis !== 'undefined' && globalThis.StreamingEngine) || null;
  }

  const CATALOG_VERIFIED = '2026-09-19';

  const Action = {
    KEEP: 'keep',
    KEEP_UNTIL: 'keep_until',
    DOWNGRADE: 'downgrade',
    ROTATE: 'rotate',
    CANCEL_AND_RETURN: 'cancel_and_return',
    CANCEL: 'cancel',
    RESTART: 'restart',
    REVIEW: 'review',
  };

  const ACTION_LABELS = {
    keep: 'Keep',
    keep_until: 'Keep until',
    downgrade: 'Downgrade',
    rotate: 'Rotate',
    cancel_and_return: 'Cancel and return',
    cancel: 'Cancel',
    restart: 'Restart',
    review: 'Review',
  };

  // How a dollar figure is allowed to be counted. Lifted straight from
  // rental-audit.js, which enforces the same discipline on a $149 product: a
  // total that mixes kinds is a number the customer cannot check, and once one
  // line in it turns out to be wishful the whole figure is worthless.
  //
  //   confirmed   price known, the charge stops, nothing offsets it.  COUNTS.
  //   conditional a rotation. Counts the cycles actually skipped and
  //               nothing else — never the full year.                 COUNTS,
  //                                                                   SEPARATELY.
  //   at_risk     touches a promo rate or a bundle. The saving may not survive
  //               a round trip, so it is shown and never added.       NEVER COUNTS.
  //   unpriced    the customer did not give us the amount.            NEVER COUNTS,
  //                                                                   NEVER ESTIMATED.
  const SavingKind = {
    CONFIRMED: 'confirmed',
    CONDITIONAL: 'conditional',
    AT_RISK: 'at_risk',
    UNPRICED: 'unpriced',
    NONE: 'none',
  };

  const LAST_USED = ['this-week', 'this-month', '2-3-months', '6-plus-months', 'never', 'unknown'];
  const WOULD_MISS = ['not-at-all', 'a-bit', 'a-lot', 'unknown'];
  const USED_BY = ['just-me', 'someone-else-too', 'unknown'];

  // Months since last use, for the arithmetic. 'unknown' is deliberately not
  // in here: an unknown usage answer is a missing fact, not a value.
  const MONTHS_SINCE = {
    'this-week': 0, 'this-month': 0.5, '2-3-months': 2.5, '6-plus-months': 6, never: 99,
  };

  // Below this, a cancellation is not worth the phone call to a customer who
  // still likes the thing. The number is a judgement, and it is deliberately
  // on the generous side: an engine graded on the size of its headline total
  // will always drift towards recommending eight cancellations the customer
  // regrets, and this is the floor that stops it. See rule R10.
  const TRIVIAL_MONTHLY = 5.00;

  // Non-streaming behaviour. Facts about how a subscription BEHAVES when you
  // cancel it — not prices, and not URLs. Prices move and nobody publishes a
  // machine-readable table of them; these do not.
  //
  // holdsData      cancelling deletes or locks the customer's own content
  // bundleParent   cancelling takes something else down with it
  // contractRisk   a minimum term or a written-notice requirement is common
  // canPause       a genuine hold exists, as opposed to cancel-and-resubscribe
  // cheaperTierHint  described, never priced — see DOWNGRADE below
  const CATEGORIES = {
    'cloud-storage': {
      label: 'cloud storage',
      holdsData: true,
      canPause: false,
      dataWarning: 'Cancelling paid storage does not just stop a charge. Above the free '
        + 'tier the provider starts removing what does not fit, and on most accounts that '
        + 'is the photo library.',
      firstStep: 'Before anything else, look at what is actually in it. If it is photos you '
        + 'want, this is the price of keeping them and it may be a fair one. If it is an old '
        + 'backup, export it first, then cancel.',
      match: /icloud|google one|dropbox|onedrive|box\.com|backblaze|mega\b|pcloud|sync\.com/i,
    },
    'password-manager': {
      label: 'a password manager',
      holdsData: true,
      canPause: false,
      dataWarning: 'Cancelling a password manager usually drops you to a read-only or '
        + 'device-limited free tier rather than deleting anything — but losing access to '
        + 'your own logins is a bad surprise to have on a Tuesday.',
      firstStep: 'Export your vault before you change anything.',
      match: /1password|lastpass|dashlane|bitwarden|keeper/i,
    },
    'creative-software': {
      label: 'creative software',
      holdsData: true,
      canPause: false,
      contractRisk: true,
      dataWarning: 'Files stay yours, but cancelling usually means you can no longer open '
        + 'or edit them in that application, and cloud-synced assets stop syncing.',
      contractWarning: 'Annual plans in this category commonly carry an early-termination '
        + 'fee if you cancel part-way through.',
      cheaperTierHint: 'a single-app plan instead of the full suite',
      match: /adobe|creative cloud|photoshop|lightroom|illustrator|premiere|figma|sketch|affinity/i,
    },
    'office-software': {
      label: 'office software',
      holdsData: false,
      canPause: false,
      cheaperTierHint: 'the free web version, if you can live without the desktop apps and '
        + 'the storage that comes with the paid plan',
      match: /microsoft 365|office 365|google workspace|\bm365\b/i,
    },
    gym: {
      label: 'a gym or studio membership',
      canPause: true,
      contractRisk: true,
      contractWarning: 'Gym contracts commonly have a minimum term and require cancellation '
        + 'in writing. Some will freeze a membership for a monthly fee instead, which is '
        + 'worth asking about before you cancel outright.',
      firstStep: 'Read the membership agreement for the notice period before you do anything '
        + 'else — that is the number that decides what this actually saves you this year.',
      match: /gym|fitness|planet fit|equinox|crossfit|pilates|yoga|peloton|classpass|orangetheory/i,
    },
    news: {
      label: 'a news or magazine subscription',
      canPause: true,
      cheaperTierHint: 'a digital-only or weekend-only plan',
      match: /times\b|new yorker|economist|washington post|wsj|journal|atlantic|guardian|substack|medium/i,
    },
    music: {
      label: 'a music subscription',
      canPause: false,
      holdsData: true,
      dataWarning: 'Playlists and library usually survive a cancellation for a while, but '
        + 'downloads do not, and some services drop a shared plan\'s other members immediately.',
      cheaperTierHint: 'an individual plan instead of a family plan, or the ad-supported tier',
      match: /spotify|apple music|tidal|deezer|youtube music|pandora|qobuz/i,
    },
    'meal-kit': {
      label: 'a meal kit or delivery box',
      canPause: true,
      firstStep: 'Almost every box in this category has a skip-weeks or pause control that '
        + 'is easier than cancelling and keeps whatever introductory pricing you are on.',
      match: /hello ?fresh|blue apron|home ?chef|factor|gousto|marley spoon|green ?chef|\bbox\b/i,
    },
    'retail-membership': {
      label: 'a retail membership',
      canPause: false,
      bundleParent: 'delivery, and whatever else is attached to the same membership',
      bundleWarning: 'This membership carries more than the part you are thinking about. '
        + 'Cancelling it drops all of it, not just the piece you no longer use.',
      match: /amazon prime|walmart\+|costco|sam's club|instacart|doordash dash ?pass|uber one/i,
    },
    'ai-assistant': {
      label: 'an AI assistant',
      canPause: false,
      cheaperTierHint: 'the free tier, if your use is occasional',
      match: /chatgpt|claude|openai|anthropic|perplexity|copilot|midjourney|gemini advanced/i,
    },
    security: {
      label: 'security or antivirus software',
      canPause: false,
      contractRisk: true,
      contractWarning: 'These renew annually at a much higher rate than the first-year price, '
        + 'and auto-renewal is usually on by default.',
      match: /norton|mcafee|avast|malwarebytes|nordvpn|expressvpn|surfshark|\bvpn\b/i,
    },
    insurance: {
      label: 'an insurance or warranty plan',
      canPause: false,
      contractRisk: true,
      contractWarning: 'Cancelling cover is a different kind of decision from cancelling '
        + 'entertainment, and it is not one this report is qualified to make for you.',
      match: /insurance|warranty|applecare|protection plan|home shield/i,
    },
  };

  /* --------------------------------------------------------------------
     Service identification.

     Streaming first, because that catalog carries real prices, real tiers,
     real pause policies and real account URLs. Everything else falls back to
     a category, which carries behaviour but never a price.
     -------------------------------------------------------------------- */
  function categoryFor(name) {
    const n = String(name || '');
    for (const key of Object.keys(CATEGORIES)) {
      if (CATEGORIES[key].match.test(n)) return Object.assign({ id: key }, CATEGORIES[key]);
    }
    return null;
  }

  function streamingFor(name) {
    if (!STREAM || !STREAM.matchServiceId) return null;
    const id = STREAM.matchServiceId(String(name || ''));
    return id && STREAM.SERVICES[id] ? STREAM.SERVICES[id] : null;
  }

  // What we know about how this one behaves when cancelled. Every field is
  // allowed to be null; null means "we do not hold that fact", which the
  // write-up says plainly rather than filling in.
  function profileFor(name) {
    const svc = streamingFor(name);
    const cat = categoryFor(name);
    return {
      serviceId: svc ? svc.id : null,
      displayName: (svc && !cat) ? svc.name : String(name || '').trim(),
      category: cat ? cat.id : (svc ? 'streaming' : null),
      categoryLabel: cat ? cat.label : (svc ? 'a streaming service' : null),
      // canPause is the single most consequential fact in this file: it is what
      // separates ROTATE from CANCEL. Unknown is NOT treated as true.
      canPause: svc ? svc.canPause === true : (cat ? cat.canPause === true : null),
      tiers: svc && Array.isArray(svc.tiers) ? svc.tiers : null,
      holdsData: cat ? cat.holdsData === true : false,
      dataWarning: cat ? cat.dataWarning || null : null,
      bundleParent: cat ? cat.bundleParent || null : null,
      bundleWarning: cat ? cat.bundleWarning || null : null,
      contractRisk: cat ? cat.contractRisk === true : false,
      contractWarning: cat ? cat.contractWarning || null : null,
      cheaperTierHint: cat ? cat.cheaperTierHint || null : null,
      firstStep: cat ? cat.firstStep || null : null,
      manage: manageFor(svc, name),
    };
  }

  // A link, or nothing. Never a guess.
  //
  // This is the defect the audit found on the page: /subscriptions sold
  // "direct links to cancel or downgrade" twice in its body copy while the
  // prompt behind it told the model not to fabricate a URL, and the only real
  // URLs in the repository were in a file this product did not load. Twenty
  // services have one, hand-checked. For everything else the honest answer is
  // the shape of the path, not a URL nobody verified.
  function manageFor(svc, name) {
    if (svc && STREAM && STREAM.MANAGE_URLS && STREAM.MANAGE_URLS[svc.id]) {
      return {
        url: STREAM.MANAGE_URLS[svc.id],
        label: `Manage ${svc.name}`,
        checked: svc.checked || STREAM.CATALOG_VERIFIED || null,
      };
    }
    return {
      url: null,
      label: null,
      hint: `Sign in to ${String(name || 'the service').trim()} and look for Account, then `
        + 'Subscription, Plan or Membership. We do not hold a verified link for this one and '
        + 'we are not going to invent one.',
    };
  }

  /* ------------------------------------------------------------ small utils */
  const DAY = 86400000;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  function round2(n) { return Math.round(Number(n) * 100) / 100; }
  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return null;
    return '$' + Number(n).toFixed(2).replace(/\.00$/, '');
  }
  function toDate(v) {
    if (v instanceof Date) { const d = new Date(v); d.setHours(0, 0, 0, 0); return d; }
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return new Date(v.slice(0, 10) + 'T00:00:00');
    return null;
  }
  // Formatted from LOCAL components. toDate above already parses a date-only
  // string as local midnight, but toISOString() re-converts to UTC, which
  // moves the day back for anyone east of Greenwich — so a customer in Berlin
  // got a restart date one day early on every seasonal recommendation. Same
  // defect the home-savings engine had in the other direction; see its
  // toDate().
  function iso(d) {
    if (!d) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function daysBetween(a, b) { return Math.round((toDate(b) - toDate(a)) / DAY); }
  function prettyDate(v) {
    const d = toDate(v); if (!d) return null;
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }

  function normalizePeriod(p) { return p === 'annual' || p === 'yearly' || p === 'year' ? 'annual' : 'monthly'; }
  function annualCostOf(price, period) {
    if (!isFinite(price) || price <= 0) return null;
    return round2(normalizePeriod(period) === 'annual' ? price : price * 12);
  }
  function monthlyEquivalent(price, period) {
    if (!isFinite(price) || price <= 0) return null;
    return round2(normalizePeriod(period) === 'annual' ? price / 12 : price);
  }

  /* -------------------------------------------------------------- seasonal */
  // The number of billing cycles a rotation actually skips. This is the whole
  // arithmetic of a rotate recommendation, and getting it wrong in the
  // flattering direction — printing the full annual cost as the saving on a
  // two-month pause — is the single easiest way for this product to be caught
  // lying. Two cycles of $7.99 is $15.98, and if that is not worth two clicks
  // to the customer the report says so.
  function seasonOf(line) {
    const s = line.seasonal;
    if (!s) return null;
    // A named sport resolves against the calendar the streaming product
    // already maintains, rather than a second copy of the same months.
    if (s.sport && STREAM && STREAM.SPORT_SEASONS && STREAM.SPORT_SEASONS[s.sport]) {
      const k = STREAM.SPORT_SEASONS[s.sport];
      return {
        need: (STREAM.SPORT_LABELS && STREAM.SPORT_LABELS[s.sport]) || s.sport,
        fromMonth: k.startMonth, fromDay: k.startDay, toMonth: k.endMonth, approximate: true,
      };
    }
    const fromMonth = Number(s.fromMonth);
    const toMonth = Number(s.toMonth);
    if (!(fromMonth >= 1 && fromMonth <= 12 && toMonth >= 1 && toMonth <= 12)) return null;
    return {
      need: s.need || null,
      fromMonth, toMonth,
      fromDay: Number(s.fromDay) > 0 ? Number(s.fromDay) : 1,
      approximate: s.approximate !== false,
    };
  }

  function inSeasonMonthCount(season) {
    const { fromMonth, toMonth } = season;
    return fromMonth <= toMonth
      ? (toMonth - fromMonth + 1)
      : (12 - fromMonth + 1) + toMonth;
  }

  function isInSeason(season, today) {
    const m = today.getMonth() + 1;
    const { fromMonth, toMonth } = season;
    return fromMonth <= toMonth
      ? (m >= fromMonth && m <= toMonth)
      : (m >= fromMonth || m <= toMonth);
  }

  function nextSeasonStart(season, today) {
    const y = today.getFullYear();
    let d = new Date(y, season.fromMonth - 1, season.fromDay);
    d.setHours(0, 0, 0, 0);
    if (d < today) d = new Date(y + 1, season.fromMonth - 1, season.fromDay);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /* ------------------------------------------------------- the base decision

     Usage and value only. Safety and pricing are separate passes below, so
     that "never cancel a shared plan" is an invariant a test can assert on
     every possible input rather than a branch somebody has to find.
     ---------------------------------------------------------------------- */
  function baseDecision(line, profile, today) {
    const lastUsed = LAST_USED.includes(line.lastUsed) ? line.lastUsed : 'unknown';
    const wouldMiss = WOULD_MISS.includes(line.wouldMiss) ? line.wouldMiss : 'unknown';
    const months = MONTHS_SINCE[lastUsed];
    const season = seasonOf(line);
    const monthly = monthlyEquivalent(line.price, line.period);

    // R0 — not currently paying for it. The restart half of the product.
    //
    // The page sold "rotate (pause and resume)" and had no field for a
    // subscription you are not subscribed to, so the resume half had no input
    // path at all. This is that path.
    if (line.status === 'cancelled') {
      if (season) {
        if (isInSeason(season, today)) {
          return {
            action: Action.RESTART, ruleId: 'R0a', confidence: 'high',
            why: [`${season.need || 'What you need this for'} is on now. This is worth paying for again.`],
            actOn: iso(today),
          };
        }
        const start = nextSeasonStart(season, today);
        return {
          action: Action.KEEP, ruleId: 'R0b', confidence: season.approximate ? 'medium' : 'high',
          why: [`Leave it off. ${season.need || 'What you need this for'} starts `
            + `${season.approximate ? 'around ' : ''}${prettyDate(start)}, which is `
            + `${daysBetween(today, start)} days away.`],
          actOn: iso(addDays(start, -1)),
          restartOn: iso(addDays(start, -1)),
        };
      }
      if (wouldMiss === 'a-lot') {
        return {
          action: Action.RESTART, ruleId: 'R0c', confidence: 'medium',
          why: ['You told us you would miss this a lot and you are not currently paying for it.'],
          actOn: iso(today),
        };
      }
      return {
        action: Action.KEEP, ruleId: 'R0d', confidence: 'high',
        why: ['You are not paying for this and nothing you told us says you should start again. '
          + 'Leave it.'],
      };
    }

    // R6 — used, and wanted.
    if (months !== undefined && months <= 0.5 && wouldMiss === 'a-lot') {
      return {
        action: Action.KEEP, ruleId: 'R6', confidence: 'high',
        why: ['You used it this month and said you would miss it a lot. You are getting what '
          + 'you pay for.'],
      };
    }

    // R9 — seasonal. Before the generic cancel test, because a seasonal
    // subscription looks exactly like a dead one in June.
    if (season && wouldMiss !== 'not-at-all') {
      const offMonths = 12 - inSeasonMonthCount(season);
      const start = nextSeasonStart(season, today);
      const inSeason = isInSeason(season, today);
      if (inSeason) {
        return {
          action: Action.KEEP, ruleId: 'R9a', confidence: 'high',
          why: [`${season.need || 'What you use this for'} is in season now. The time to switch `
            + `it off is when the season ends, not today.`],
          restartOn: null,
          seasonOffMonths: offMonths,
        };
      }
      const canPause = profile.canPause === true;
      return {
        action: canPause ? Action.ROTATE : Action.CANCEL_AND_RETURN,
        ruleId: canPause ? 'R9b' : 'R9c',
        confidence: season.approximate ? 'medium' : 'high',
        why: [
          `You told us you use this for ${season.need || 'one thing'}, and it is out of season.`,
          canPause
            ? `${profile.displayName} offers a genuine hold, so the account stays as it is.`
            : `${profile.displayName} has no pause. This means cancelling and signing up again `
              + `later, at whatever the price is then — which is the part a "rotate" `
              + `recommendation would have hidden from you.`,
        ],
        actOn: iso(addDays(start, -1)),
        restartOn: iso(addDays(start, -1)),
        restartApproximate: season.approximate,
        cyclesSkipped: normalizePeriod(line.period) === 'annual' ? 0 : offMonths,
        seasonOffMonths: offMonths,
      };
    }

    // R7 — wanted, barely used, and a cheaper way to have it exists.
    const cheaper = cheaperTierFor(profile, line);
    if (wouldMiss !== 'not-at-all' && months !== undefined && months >= 2 && cheaper) {
      return {
        action: Action.DOWNGRADE, ruleId: 'R7', confidence: cheaper.priced ? 'high' : 'medium',
        why: [
          `You said you would miss this, and you have not used it in ${lastUsedPhrase(lastUsed)}.`,
          `That is an argument for a cheaper version of it, not for losing it: ${cheaper.description}.`,
        ],
        downgradeTo: cheaper,
      };
    }

    // R8 — not used, not wanted.
    if (months !== undefined && months >= 2 && wouldMiss === 'not-at-all') {
      return {
        action: Action.CANCEL, ruleId: 'R8', confidence: 'high',
        why: [`You last used it ${lastUsedPhrase(lastUsed)} and said you would not miss it.`],
      };
    }

    // R10 — the integrity rule. Small, and still wanted.
    //
    // An engine graded on the size of its headline number will always drift
    // towards recommending eight cancellations the customer regrets. This is
    // the floor that stops it, and it fires before the marginal-usage rules
    // below on purpose.
    if (monthly !== null && monthly < TRIVIAL_MONTHLY && wouldMiss !== 'not-at-all') {
      return {
        action: Action.KEEP, ruleId: 'R10', confidence: 'high',
        why: [`This is ${money(annualCostOf(line.price, line.period))} a year and you said you `
          + `would miss it. Not worth the phone call.`],
      };
    }

    // Marginal: wanted a bit, used rarely, nothing cheaper to move to.
    if (months !== undefined && months >= 6 && wouldMiss === 'a-bit') {
      return {
        action: Action.CANCEL, ruleId: 'R8b', confidence: 'medium',
        why: [`Six months without opening it, against "I would miss it a bit". On those two `
          + `answers this is worth more to you as money than as a subscription — but it is `
          + `closer than the others, so it is your call.`],
      };
    }

    if (months !== undefined && months <= 0.5) {
      return {
        action: Action.KEEP, ruleId: 'R6b', confidence: 'medium',
        why: ['You used it this month. Whatever else is true, it is not a forgotten charge.'],
      };
    }

    // R12 — wanted, and not being used. The tension is the finding.
    //
    // This rule exists because R11 below used to swallow these cases and tell
    // the customer "we do not have enough from you to call this one either
    // way" while `needs` was EMPTY — they had answered all three questions.
    // Eight of the 72 answer combinations landed here, and they are the ones
    // where an honest engine is worth the most: high cost, low usage, high
    // stated attachment. A $720-a-year gym, never used, "would miss it a lot"
    // is the archetype, and the report said nothing and blamed the customer
    // for it. See docs/HOME-SAVINGS-AUDIT.md, Defect 1.
    //
    // It is deliberately still a REVIEW. "I would miss it" against "I have not
    // opened it" is a real disagreement between two true answers, and an
    // intention is not a use — but neither is it ours to overrule. What
    // changes is that the reason is true and the number is on the page.
    if (months !== undefined && months >= 2 && wouldMiss !== 'unknown'
        && wouldMiss !== 'not-at-all' && lastUsed !== 'unknown') {
      const annualCost = annualCostOf(line.price, line.period);
      const strong = wouldMiss === 'a-lot';
      const why = [
        `${lastUsed === 'never'
          ? 'You have never used it'
          : `You last used it ${lastUsedPhrase(lastUsed)}`} and said you would miss it `
          + `${strong ? 'a lot' : 'a bit'}. Those two answers pull in opposite directions, `
          + `and only one of them is a fact about what you have actually done.`,
      ];
      if (annualCost) {
        why.push(`It is ${money(annualCost)} a year. That is what the intention is costing `
          + `while it stays an intention.`);
      }
      return {
        action: Action.REVIEW, ruleId: 'R12', confidence: 'medium',
        why,
        firstStep: annualCost
          ? `Put a date in the diary to use it in the next three weeks. If the date comes and `
            + `goes, you have your answer and ${money(annualCost)} a year back.`
          : `Put a date in the diary to use it in the next three weeks. If the date comes and `
            + `goes, you have your answer.`,
      };
    }

    // Nothing decisive, because something is genuinely missing. Say which.
    return {
      action: Action.REVIEW, ruleId: 'R11', confidence: 'none',
      why: ['We do not have enough from you to call this one either way.'],
      needs: [
        lastUsed === 'unknown' ? 'when you last used it' : null,
        wouldMiss === 'unknown' ? 'whether you would miss it' : null,
      ].filter(Boolean),
    };
  }

  function lastUsedPhrase(lastUsed) {
    return {
      'this-week': 'this week',
      'this-month': 'this month',
      '2-3-months': 'two or three months ago',
      '6-plus-months': 'more than six months ago',
      never: 'never',
      unknown: 'at some point you could not place',
    }[lastUsed] || 'at some point';
  }

  // A cheaper tier, described — and priced only when we hold a real price.
  //
  // Streaming has a verified tier table, so a downgrade there carries a dollar
  // figure. Everything else gets a described change and an unpriced saving,
  // because a downgrade saving invented from a guessed tier price is exactly
  // the fabrication the honesty rules exist to prevent.
  function cheaperTierFor(profile, line) {
    if (profile.tiers && profile.tiers.length > 1 && isFinite(line.price) && line.price > 0
        && normalizePeriod(line.period) === 'monthly') {
      const cheapest = profile.tiers.slice().sort((a, b) => a.price - b.price)[0];
      if (cheapest && cheapest.price < line.price - 0.5) {
        return {
          priced: true,
          name: cheapest.name,
          price: cheapest.price,
          monthlySaving: round2(line.price - cheapest.price),
          description: `${profile.displayName} ${cheapest.name} is ${money(cheapest.price)} a `
            + `month against the ${money(line.price)} you are paying`,
          givesUp: cheapest.adFree === false ? 'You will see ads.' : null,
        };
      }
      return null;
    }
    if (profile.cheaperTierHint) {
      return { priced: false, description: profile.cheaperTierHint, givesUp: null };
    }
    return null;
  }

  /* -------------------------------------------------------------- safety

     This pass can only ever downgrade an action to something safer. It never
     turns a KEEP into a CANCEL. That is what makes the three rules testable
     as invariants over arbitrary input rather than as branches somebody has
     to go and find.
     ---------------------------------------------------------------------- */
  const LOSES_ACCESS = [Action.CANCEL, Action.ROTATE, Action.CANCEL_AND_RETURN, Action.DOWNGRADE];

  function applySafety(d, line, profile, today) {
    const cautions = [];
    let out = d;

    // Every block below tests against the action the usage rules produced, not
    // against the action as it stands after an earlier block. Testing the
    // running value meant the first block to fire silenced all the others: a
    // shared music plan that also holds the customer's playlists came back
    // citing the data risk and never mentioning that somebody else in the
    // house uses it daily, because by then the action was no longer a cancel.
    // Every reason that applies is a reason the customer needs.
    const wouldLoseAccess = LOSES_ACCESS.includes(d.action);

    // A later block adds its reason but does not replace a more specific
    // answer with a vaguer one. KEEP_UNTIL already prevents the loss AND
    // carries the date the decision is actually due, so a subsequent REVIEW
    // has nothing to add to the action — only to the reasons. Without this,
    // an annual Adobe plan came back as "review" citing file access and
    // dropped the March renewal date, which was the useful part.
    function block(action, ruleId, why, extra) {
      const keepsAction = out.action === Action.KEEP_UNTIL && action === Action.REVIEW;
      out = Object.assign({}, out, extra || {}, {
        action: keepsAction ? out.action : action,
        ruleId: keepsAction ? out.ruleId : ruleId,
        alsoBlockedBy: keepsAction ? (out.alsoBlockedBy || []).concat(ruleId) : out.alsoBlockedBy,
        blockedFrom: out.blockedFrom || out.action,
        why: [why].concat(out.why || []),
        confidence: 'high',
      });
    }

    // R1 — a prepaid annual plan, mid-term.
    //
    // The most expensive mistake this product can make, and the one the usage
    // signal points straight at: an annual plan used twice looks like the
    // worst line on the page. Cancelling it today refunds nothing, and in
    // several categories costs an early-termination fee on top. The decision
    // is real and it is worth a lot — it is just not due today.
    const renewal = toDate(line.renewalDate);
    const prepaidAnnual = normalizePeriod(line.period) === 'annual' && line.prepaid !== false;
    if (prepaidAnnual && wouldLoseAccess) {
      if (renewal && renewal > today) {
        const decideOn = addDays(renewal, -14);
        block(Action.KEEP_UNTIL, 'R1',
          `This is an annual plan you have already paid for, and it runs to `
          + `${prettyDate(renewal)}. Cancelling it today refunds nothing`
          + `${profile.contractRisk ? ' and may cost an early-termination fee on top' : ''}.`,
          {
            actOn: iso(decideOn > today ? decideOn : today),
            decisionDueOn: iso(decideOn > today ? decideOn : today),
            renewalDate: iso(renewal),
            worthAtRenewal: annualCostOf(line.price, line.period),
          });
      } else {
        block(Action.REVIEW, 'R1b',
          'This is an annual plan and you did not tell us when it renews, so we are not going '
          + 'to tell you to cancel it — on an annual plan the date is the whole decision.',
          { needs: ['the renewal date'] });
      }
    }

    // R2 — bundled. Cancelling takes something else with it.
    const bundledWith = line.bundledWith || profile.bundleParent || null;
    if (bundledWith && wouldLoseAccess && d.action !== Action.DOWNGRADE) {
      block(Action.REVIEW, 'R2',
        `${profile.bundleWarning || `This is bundled with ${bundledWith}, and cancelling it `
          + `drops all of that, not just the part you stopped using.`} `
        + `Treat what follows as the ${profile.displayName} part of a bigger decision.`);
      cautions.push({ kind: 'bundle', text: `Bundled with ${bundledWith}.` });
    }

    // R3 — it is holding the customer's own data.
    //
    // "Barely used" is the most common answer about cloud storage and the
    // worst possible basis for cancelling it. This is not a saving the report
    // is entitled to claim.
    if ((line.holdsData === true || profile.holdsData)
        && (d.action === Action.CANCEL || d.action === Action.CANCEL_AND_RETURN)) {
      block(Action.REVIEW, 'R3',
        profile.dataWarning || 'Cancelling this loses content of yours that is stored in it.',
        { firstStep: profile.firstStep || 'Export anything you want to keep before you cancel.' });
    }

    // R4 — somebody else uses it.
    if (line.usedBy === 'someone-else-too' && wouldLoseAccess) {
      block(Action.REVIEW, 'R4',
        'Someone else in your house uses this, so it is not a decision you can make on your '
        + 'own — and it is not one we are going to make for you.',
        { askFirst: true });
      cautions.push({ kind: 'household', text: 'Shared. Ask before you act.' });
    }

    // R5 — a promotional or legacy rate.
    //
    // Cancelling a rate that is no longer offered is frequently a permanent
    // loss that dwarfs the saving, and it is invisible in every usage signal.
    // The caution attaches to EVERY promotional line, whatever the action.
    //
    // It used to sit inside the `wouldLoseAccess` branch below, which meant a
    // KEEP never reached it: a customer who declared a promotional rate on a
    // service they use weekly was told "you are getting what you pay for.
    // Nothing to do. Leave it as it is." — with no mention that the price is
    // about to rise. A $35/month promo reverting to $89 is $648 a year, the
    // largest single line in most households, and it was silently dropped at
    // the exact point the engine was most confident. The rule's own comment
    // says a promo rate "is invisible in every usage signal"; gating it behind
    // a usage-driven action was the contradiction. See
    // docs/HOME-SAVINGS-AUDIT.md, Defect 2.
    if (line.promoRate === true) {
      cautions.push({
        kind: 'promo',
        text: 'Promotional or legacy rate — you will not get it back. Find out what the '
          + 'standard price is and when yours changes to it: that date is worth more than '
          + 'anything else on this line.',
      });
    }

    if (line.promoRate === true && wouldLoseAccess) {
      if (d.action === Action.ROTATE || d.action === Action.CANCEL_AND_RETURN) {
        block(Action.REVIEW, 'R5a',
          'You are on a promotional or legacy rate. Rotating this means giving the rate up: '
          + 'you would come back at the current list price, and the saving would not survive '
          + 'the round trip.');
      } else if (d.action === Action.CANCEL) {
        block(Action.REVIEW, 'R5b',
          'You are on a promotional or legacy rate, so this is worth more than the monthly '
          + 'figure suggests. Find out what the current price is before you cancel — if it is '
          + 'much higher, keeping a cheap thing you rarely use can still be the right call.');
      }
      // The promo caution is pushed unconditionally above, for every action —
      // pushing it again here would print it twice on a cancel.
    }

    // Not a block, but a caution the customer would be angry to find out later.
    if (profile.contractRisk && (d.action === Action.CANCEL || d.action === Action.CANCEL_AND_RETURN)
        && profile.contractWarning) {
      cautions.push({ kind: 'contract', text: profile.contractWarning });
    }

    return Object.assign({}, out, { cautions: (out.cautions || []).concat(cautions) });
  }

  /* -------------------------------------------------------------- pricing */
  function applyPricing(d, line, profile) {
    const period = normalizePeriod(line.period);
    const hasPrice = isFinite(line.price) && Number(line.price) > 0;
    const annual = annualCostOf(line.price, period);

    let amount = 0;
    let kind = SavingKind.NONE;
    let basis = null;

    if (d.action === Action.CANCEL || d.action === Action.CANCEL_AND_RETURN) {
      if (!hasPrice) { kind = SavingKind.UNPRICED; basis = 'You did not tell us what this costs.'; }
      else if (d.action === Action.CANCEL) {
        amount = annual; kind = SavingKind.CONFIRMED;
        basis = period === 'annual'
          ? `${money(line.price)} a year, stopped.`
          : `${money(line.price)} a month for twelve months.`;
      } else {
        // Cancel-and-return skips cycles, not a year. Same arithmetic as a
        // rotation; the difference is what it costs you to come back.
        const cycles = d.cyclesSkipped || 0;
        amount = round2(Number(line.price) * cycles);
        kind = cycles > 0 ? SavingKind.CONDITIONAL : SavingKind.NONE;
        basis = `${cycles} monthly ${cycles === 1 ? 'cycle' : 'cycles'} at ${money(line.price)}`
          + ` — not the full year.`;
      }
    } else if (d.action === Action.ROTATE) {
      const cycles = d.cyclesSkipped || 0;
      if (!hasPrice) { kind = SavingKind.UNPRICED; basis = 'You did not tell us what this costs.'; }
      else {
        amount = round2(Number(line.price) * cycles);
        kind = cycles > 0 ? SavingKind.CONDITIONAL : SavingKind.NONE;
        basis = `${cycles} monthly ${cycles === 1 ? 'cycle' : 'cycles'} at ${money(line.price)}`
          + ` — not the full year.`;
      }
    } else if (d.action === Action.DOWNGRADE) {
      if (d.downgradeTo && d.downgradeTo.priced && hasPrice) {
        amount = round2(d.downgradeTo.monthlySaving * 12);
        kind = SavingKind.CONFIRMED;
        basis = `${money(d.downgradeTo.monthlySaving)} a month for twelve months.`;
      } else {
        kind = SavingKind.UNPRICED;
        basis = 'We do not hold a verified price for the cheaper plan, so we have not put a '
          + 'figure on this one.';
      }
    } else if (d.action === Action.KEEP_UNTIL) {
      amount = 0; kind = SavingKind.NONE;
      basis = `Nothing today. The decision on ${prettyDate(d.renewalDate)} is worth `
        + `${money(d.worthAtRenewal)} a year — today's is worth nothing.`;
    } else if (d.action === Action.RESTART) {
      amount = 0; kind = SavingKind.NONE;
      basis = hasPrice ? `This will cost you ${money(annual)} a year.` : null;
    }

    // A promo or bundle makes any figure provisional, whatever produced it.
    if (kind === SavingKind.CONFIRMED || kind === SavingKind.CONDITIONAL) {
      if (line.promoRate === true || line.bundledWith || profile.bundleParent) {
        kind = SavingKind.AT_RISK;
        basis = (basis ? basis + ' ' : '')
          + 'Shown but not counted: a promotional rate or a bundle means this may not survive '
          + 'a round trip.';
      }
    }

    // An unpriced line never gets an estimated figure, and it never gets a
    // recommendation stated as settled either. The provisional call is carried
    // so the write-up can say which way it points without pretending to know
    // what it is worth.
    let action = d.action;
    let provisional = null;
    let needs = d.needs;
    if (!hasPrice && (action === Action.CANCEL || action === Action.ROTATE
        || action === Action.CANCEL_AND_RETURN || action === Action.DOWNGRADE)) {
      provisional = action;
      action = Action.REVIEW;
      // Without this the line came out of the renderer telling the customer to
      // "check the thing named above, then decide" — the generic review step,
      // because nothing had recorded WHY this particular review was a review.
      // The one thing it needs is the amount, and it should ask for it.
      needs = (needs || []).concat('what this costs');
    }

    return Object.assign({}, d, {
      action,
      needs,
      provisionalAction: provisional,
      saving: { amount: round2(amount), kind, basis },
      annualCost: annual,
      monthlyCost: monthlyEquivalent(line.price, period),
    });
  }

  /* ------------------------------------------------------------ what to do */
  function stepFor(d, line, profile) {
    const name = profile.displayName;
    switch (d.action) {
      case Action.CANCEL:
        return profile.manage.url
          ? `Cancel it before your next charge: ${profile.manage.url}`
          : `Cancel it before your next charge. ${profile.manage.hint}`;
      case Action.CANCEL_AND_RETURN:
        return `Cancel it now and put ${prettyDate(d.restartOn)} in your calendar to sign up `
          + `again. ${profile.manage.url || profile.manage.hint}`;
      case Action.ROTATE:
        return `Put it on hold now and set a reminder for ${prettyDate(d.restartOn)}. `
          + `${profile.manage.url || profile.manage.hint}`;
      case Action.DOWNGRADE:
        return d.downgradeTo && d.downgradeTo.priced
          ? `Switch to ${d.downgradeTo.name}. ${profile.manage.url || profile.manage.hint}`
          : `Look for ${d.downgradeTo ? d.downgradeTo.description : 'a cheaper plan'} in your `
            + `account settings. ${profile.manage.url || profile.manage.hint}`;
      case Action.KEEP_UNTIL:
        return `Set a reminder for ${prettyDate(d.decisionDueOn)} and decide then. Turn off `
          + `auto-renewal now if you can — that is reversible and cancelling is not.`;
      case Action.RESTART:
        return `Sign up again. ${profile.manage.url || profile.manage.hint}`;
      case Action.REVIEW:
        if (d.askFirst) return `Ask whoever else uses it. If they want it, this line is settled.`;
        if (d.firstStep) return d.firstStep;
        if (d.needs && d.needs.length) {
          // Concrete, because "tell us" on its own is a promise with no
          // mechanism behind it. The free scorecard is the mechanism: it runs
          // this same engine in the browser, costs nothing and can be re-run
          // as often as they like.
          return `Add ${d.needs.join(' and ')} to your scorecard at `
            + `streamnavigator.ai/subscriptions — it is free and re-runs instantly — or reply `
            + `to your receipt with it and we will re-issue this line`
            + `${d.provisionalAction === Action.CANCEL
              ? '. On what you have told us so far it points at cancelling, and we will say so '
                + 'with the figure once we have one' : ''}.`;
        }
        if (d.cautions && d.cautions.length) return d.cautions[0].text;
        return `Read the reason above and decide it yourself — we are not going to decide it for you.`;
      default:
        // A KEEP that carries a caution is not "nothing to do". The promo
        // caution in particular lands almost exclusively on keeps — it is the
        // rate you are happy with today that changes underneath you — so
        // printing "leave it as it is" over the top of it would put the engine
        // back where Defect 2 found it.
        if (d.cautions && d.cautions.length) {
          return `Keep it — and then: ${d.cautions[0].text}`;
        }
        return `Nothing to do. Leave it as it is.`;
    }
  }

  function headlineFor(d, profile) {
    const name = profile.displayName;
    switch (d.action) {
      case Action.KEEP_UNTIL: return `Keep ${name} until ${prettyDate(d.renewalDate)}`;
      case Action.ROTATE: return `Rotate ${name} — back on ${prettyDate(d.restartOn)}`;
      case Action.CANCEL_AND_RETURN: return `Cancel ${name}, return ${prettyDate(d.restartOn)}`;
      case Action.CANCEL: return `Cancel ${name}`;
      case Action.DOWNGRADE: return `Downgrade ${name}`;
      case Action.RESTART: return `Restart ${name}`;
      case Action.REVIEW: return `${name} — your call, not ours`;
      default: return `Keep ${name}`;
    }
  }

  /* ---------------------------------------------------------------- decide */
  function decide(line, today) {
    const t = toDate(today) || (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
    const l = Object.assign({}, line, { period: normalizePeriod(line.period) });
    const profile = profileFor(l.name);

    let d = baseDecision(l, profile, t);
    d = applySafety(d, l, profile, t);
    d = applyPricing(d, l, profile);

    return Object.assign({
      name: profile.displayName,
      serviceId: profile.serviceId,
      category: profile.category,
      categoryLabel: profile.categoryLabel,
      price: isFinite(l.price) && l.price > 0 ? round2(l.price) : null,
      period: l.period,
      canPause: profile.canPause,
      manage: profile.manage,
      lastUsed: l.lastUsed || 'unknown',
      wouldMiss: l.wouldMiss || 'unknown',
      usedBy: l.usedBy || 'unknown',
      status: l.status === 'cancelled' ? 'cancelled' : 'active',
    }, d, {
      actionLabel: ACTION_LABELS[d.action] || d.action,
      headline: headlineFor(d, profile),
      doThis: stepFor(d, l, profile),
      cautions: d.cautions || [],
    });
  }

  /* --------------------------------------------------------------- analyze */
  // Order: by what is at stake, largest first, so the report opens on the line
  // that matters. An unpriced or blocked line sorts by what it would have been
  // worth, not to zero — a $60/month annual plan the customer must decide about
  // in March is not a footnote.
  function stakeOf(d) {
    if (d.saving && d.saving.amount) return d.saving.amount;
    if (d.worthAtRenewal) return d.worthAtRenewal;
    if (d.annualCost) return d.annualCost;
    return 0;
  }

  const ACTION_RANK = {
    cancel: 0, cancel_and_return: 1, downgrade: 2, rotate: 3,
    keep_until: 4, restart: 5, review: 6, keep: 7,
  };

  function analyze(input, options) {
    const opts = options || {};
    const today = toDate(opts.today) || (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
    const lines = (Array.isArray(input && input.lines) ? input.lines : [])
      .filter((l) => l && String(l.name || '').trim());

    const decisions = lines.map((l) => decide(l, today));

    decisions.sort((a, b) => {
      const r = (ACTION_RANK[a.action] ?? 9) - (ACTION_RANK[b.action] ?? 9);
      if (r !== 0) return r;
      return stakeOf(b) - stakeOf(a);
    });

    // Totals, by kind, never across kinds. See SavingKind.
    const totals = {
      confirmedAnnual: 0, conditionalAnnual: 0, atRiskAnnual: 0,
      unpricedLines: 0, reviewLines: 0,
    };
    let monthlySpend = 0;
    let annualSpend = 0;
    let pricedLines = 0;

    for (const d of decisions) {
      if (d.monthlyCost) { monthlySpend += d.monthlyCost; pricedLines += 1; }
      if (d.annualCost) annualSpend += d.annualCost;
      const k = d.saving && d.saving.kind;
      if (k === SavingKind.CONFIRMED) totals.confirmedAnnual += d.saving.amount;
      else if (k === SavingKind.CONDITIONAL) totals.conditionalAnnual += d.saving.amount;
      else if (k === SavingKind.AT_RISK) totals.atRiskAnnual += d.saving.amount;
      else if (k === SavingKind.UNPRICED) totals.unpricedLines += 1;
      if (d.action === Action.REVIEW) totals.reviewLines += 1;
    }

    totals.confirmedAnnual = round2(totals.confirmedAnnual);
    totals.conditionalAnnual = round2(totals.conditionalAnnual);
    totals.atRiskAnnual = round2(totals.atRiskAnnual);

    const counts = {};
    for (const d of decisions) counts[d.action] = (counts[d.action] || 0) + 1;

    // Lines the same household is paying for twice. Not a recommendation on
    // its own — which one to keep depends on what they actually watch, and
    // this engine does not know that — but it is worth naming.
    const overlaps = detectOverlap(decisions);

    return {
      generatedAt: iso(today),
      catalogVerified: CATALOG_VERIFIED,
      lineCount: decisions.length,
      pricedLines,
      monthlySpend: round2(monthlySpend),
      annualSpend: round2(annualSpend),
      totals,
      counts,
      overlaps,
      decisions,
    };
  }

  // Duplicate coverage. Two music services, three streaming services, two
  // cloud storage plans — the household is buying the same thing twice.
  const OVERLAP_GROUPS = [
    { id: 'streaming', label: 'video streaming', min: 3, test: (d) => d.category === 'streaming' },
    { id: 'music', label: 'music', min: 2, test: (d) => d.category === 'music' },
    { id: 'cloud-storage', label: 'cloud storage', min: 2, test: (d) => d.category === 'cloud-storage' },
    { id: 'ai-assistant', label: 'AI assistants', min: 2, test: (d) => d.category === 'ai-assistant' },
    { id: 'meal-kit', label: 'meal kits', min: 2, test: (d) => d.category === 'meal-kit' },
    { id: 'security', label: 'security software', min: 2, test: (d) => d.category === 'security' },
  ];

  function detectOverlap(decisions) {
    const out = [];
    for (const g of OVERLAP_GROUPS) {
      const hit = decisions.filter((d) => g.test(d) && d.status === 'active');
      if (hit.length < g.min) continue;
      const priced = hit.filter((d) => d.annualCost);
      out.push({
        id: g.id,
        label: g.label,
        names: hit.map((d) => d.name),
        count: hit.length,
        combinedAnnual: priced.length === hit.length
          ? round2(priced.reduce((s, d) => s + d.annualCost, 0))
          : null,
        note: `You are paying for ${hit.length} ${g.label} services. Which one to drop depends `
          + `on what you actually use them for, which is not something we can decide from what `
          + `you told us — but paying for ${hit.length} is the kind of thing worth looking at `
          + `deliberately rather than by accident.`,
      });
    }
    return out;
  }

  /* ------------------------------------------------------------- scorecard

     The free, pre-payment preview. Deterministic, so it costs nothing to run
     on a typed list — which is the entire reason it can be free, and the
     reason /closing's scorecard works.

     It shows COUNTS and TOTALS. It does not show which line is which, what
     the recommendation is, the restart dates, or the cancellation links. That
     is what the paid report is.
     ---------------------------------------------------------------------- */
  function buildScorecard(analysis) {
    const a = analysis;
    const actionable = (a.counts.cancel || 0) + (a.counts.cancel_and_return || 0)
      + (a.counts.downgrade || 0) + (a.counts.rotate || 0);
    return {
      lineCount: a.lineCount,
      pricedLines: a.pricedLines,
      monthlySpend: a.monthlySpend,
      annualSpend: a.annualSpend,
      actionableLines: actionable,
      confirmedAnnual: a.totals.confirmedAnnual,
      conditionalAnnual: a.totals.conditionalAnnual,
      atRiskAnnual: a.totals.atRiskAnnual,
      reviewLines: a.totals.reviewLines,
      unpricedLines: a.totals.unpricedLines,
      restartLines: a.counts.restart || 0,
      keepUntilLines: a.counts.keep_until || 0,
      overlaps: a.overlaps.map((o) => ({ label: o.label, count: o.count })),
      // The honest headline, chosen the same way the closing scorecard chooses
      // its own: lead with the strongest TRUE statement, and when there is
      // nothing to find, say that plainly rather than manufacturing concern.
      headline: scorecardHeadline(a, actionable),
      nothingFound: actionable === 0 && (a.counts.keep_until || 0) === 0 && (a.counts.restart || 0) === 0,
    };
  }

  function scorecardHeadline(a, actionable) {
    if (a.totals.confirmedAnnual > 0) {
      return `${actionable} of your ${a.lineCount} subscriptions `
        + `${actionable === 1 ? 'is' : 'are'} worth acting on. `
        + `${money(a.totals.confirmedAnnual)} a year, confirmed.`;
    }
    if (a.totals.conditionalAnnual > 0) {
      return `Nothing here is dead, but ${money(a.totals.conditionalAnnual)} a year is sitting `
        + `in subscriptions you only use for part of the year.`;
    }
    if ((a.counts.keep_until || 0) > 0) {
      return `Nothing to cancel today — but you have ${a.counts.keep_until} annual `
        + `${a.counts.keep_until === 1 ? 'plan' : 'plans'} with a decision date coming that is `
        + `worth real money.`;
    }
    if (a.totals.reviewLines > 0) {
      return `We found nothing you should cancel outright. ${a.totals.reviewLines} `
        + `${a.totals.reviewLines === 1 ? 'line needs' : 'lines need'} a decision only you can make.`;
    }
    return `We checked all ${a.lineCount} and found nothing you should stop paying for. `
      + `That is worth knowing, and you found it out for free.`;
  }

  /* ------------------------------------------------------------ sufficiency

     The same rules the page gates its own button on, so a customer can never
     reach checkout with input this would then reject — and calling the
     endpoint directly cannot bypass the page either.

     Before this existed, posting a single character as the whole description
     returned 200 and a submission id ready for a $49 checkout. Verified
     against production on 2026-09-19; see docs/SUBSCRIPTIONS-AUDIT.md.
     ---------------------------------------------------------------------- */
  function checkSufficiency(formData) {
    const missing = [];
    const lines = Array.isArray(formData && formData.lines) ? formData.lines : [];
    const usable = lines.filter((l) => l && String(l.name || '').trim());

    if (!usable.length) {
      missing.push({
        key: 'lines',
        label: 'Add at least one subscription',
        why: 'There is nothing to review until you name something you pay for.',
      });
      return { sufficient: false, missing };
    }

    const noPrice = usable.filter((l) => !(isFinite(Number(l.price)) && Number(l.price) > 0));
    if (noPrice.length === usable.length) {
      missing.push({
        key: 'price',
        label: 'Add what at least one of these costs',
        why: 'Every figure in your report is arithmetic on the prices you give us. Without one '
          + 'we can tell you what to think about, but not what it is worth — and that is not '
          + 'worth paying for.',
      });
    }

    const unanswered = usable.filter((l) => {
      if (l.status === 'cancelled') return false;   // the restart path asks different questions
      const used = LAST_USED.includes(l.lastUsed) && l.lastUsed !== 'unknown';
      const miss = WOULD_MISS.includes(l.wouldMiss) && l.wouldMiss !== 'unknown';
      const by = USED_BY.includes(l.usedBy) && l.usedBy !== 'unknown';
      return !(used && miss && by);
    });
    if (unanswered.length) {
      missing.push({
        key: 'answers',
        label: unanswered.length === usable.length
          ? 'Answer the three questions on each subscription'
          : `Answer the three questions on ${unanswered.length} of them`
            + ` (${unanswered.slice(0, 3).map((l) => String(l.name).trim()).join(', ')}`
            + `${unanswered.length > 3 ? ', …' : ''})`,
        why: 'When you last used it, whether you would miss it, and who else uses it. Those '
          + 'three answers are what decide the recommendation — a bank statement cannot '
          + 'supply them and neither can we.',
      });
    }

    const annualNoDate = usable.filter((l) => normalizePeriod(l.period) === 'annual'
      && l.prepaid !== false && !toDate(l.renewalDate));
    if (annualNoDate.length) {
      missing.push({
        key: 'renewalDate',
        label: `Add the renewal date for ${annualNoDate.map((l) => String(l.name).trim()).slice(0, 3).join(', ')}`,
        why: 'On an annual plan the date is the whole decision. Without it we will not tell you '
          + 'to cancel, because cancelling a prepaid year part-way through refunds nothing.',
      });
    }

    return { sufficient: missing.length === 0, missing };
  }

  /* ----------------------------------------------------- free-text fallback

     A customer who pastes "Netflix $19.99, Hulu 18.99/mo, gym" gets those
     lines parsed into the structured shape with the three answers left
     unknown — which the sufficiency check then asks them to fill in, on a
     form that already has their subscriptions in it. This exists so that
     pasting a list is a head start rather than a dead end.

     It never invents a price and never guesses an answer.
     -------------------------------------------------------------------- */
  const PRICE_RE = /(?:[$£€]\s*)(\d+(?:[.,]\d{1,2})?)|(\d+[.,]\d{2})(?!\d)/;
  const ANNUAL_RE = /\b(?:\/|per\s*)?(?:yr|year|annual(?:ly)?|a year)\b/i;

  function parseList(text) {
    const out = [];
    const seen = new Set();
    String(text || '')
      .split(/[\n;]+|,(?![^$]*\d{2}\b)/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((raw) => {
        const priceMatch = raw.match(PRICE_RE);
        const price = priceMatch
          ? Number(String(priceMatch[1] || priceMatch[2]).replace(',', '.'))
          : null;
        const name = raw
          .replace(PRICE_RE, ' ')
          .replace(/\b(?:\/|per\s*)?(?:mo|month|monthly|yr|year|annual(?:ly)?|a month|a year)\b/gi, ' ')
          // "Adobe CC $719.88/year" loses the price, then loses the word
          // "year", and what is left on the line is "Adobe CC /". Strip the
          // punctuation those two removals stranded, at either end.
          .replace(/^[\s/|:,.·–—-]+|[\s/|:,.·–—-]+$/g, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
        if (!name) return;
        const key = name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
          name,
          price: price && price > 0 ? price : null,
          period: ANNUAL_RE.test(raw) ? 'annual' : 'monthly',
          lastUsed: 'unknown', wouldMiss: 'unknown', usedBy: 'unknown',
          status: 'active',
        });
      });
    return out;
  }

  return {
    CATALOG_VERIFIED, Action, ACTION_LABELS, SavingKind, CATEGORIES,
    LAST_USED, WOULD_MISS, USED_BY, TRIVIAL_MONTHLY, OVERLAP_GROUPS,
    decide, analyze, buildScorecard, checkSufficiency, parseList,
    profileFor, categoryFor, seasonOf, inSeasonMonthCount, isInSeason, nextSeasonStart,
    detectOverlap, lastUsedPhrase,
    money, round2, toDate, iso, prettyDate, annualCostOf, monthlyEquivalent, normalizePeriod,
  };
}));
