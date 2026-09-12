/* =========================================================================
   navigator-streaming-engine.js — the subscription optimiser, in ONE place.

   This used to be pasted inline into both streaming.html and dashboard.html.
   The two copies drifted: on 2026-09-12 the dashboard had Netflix Premium at
   $26.99 and Peacock Select at $8.99 while the marketing page still said
   $24.99 and $7.99, because a price refresh on 2026-08-25 only landed in one
   file. A customer comparing the two pages saw different numbers for the same
   subscription. One catalog, one engine, loaded by both pages, is the fix —
   and tests/streaming-engine.test.js fails the build if an inline `const
   SERVICES = {` ever reappears in either page.

   Loaded as a plain script (sets window.StreamingEngine) and as a CommonJS
   module (for the test suite). No dependencies, no network, no LLM: analyze()
   is a pure function of its inputs plus the date you hand it.

   PRICING. Every figure below is a published US list price, verified by hand
   on the date in CATALOG_VERIFIED. There is no pricing API for these
   services, so re-pricing means re-running that research by hand. Entries
   carry `checked` so a stale one is visible rather than silently wrong; the
   pages render CATALOG_VERIFIED next to every dollar figure they show.

   Sources for the 2026-09-12 pass: Tom's Guide 2026 streaming price roundup,
   DealNews HBO Max tier breakdown (upd. 2026-08-16), Variety (ESPN Unlimited
   increase effective 2026-09-17), Variety/NoDQ (Peacock increase effective
   2026-09-17), DealNews Disney+ bundle page. Services not re-verified in that
   pass keep their earlier `checked` date and are listed as such.
   ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StreamingEngine = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The date the price catalog below was last verified by hand. Rendered on
  // every page that shows a dollar figure derived from it — a number the
  // customer can date is a number they can check.
  const CATALOG_VERIFIED = '2026-09-12';

  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  const SERVICES = {
    netflix: { id:'netflix', name:'Netflix', checked:'2026-09-12',
      tiers:[ {id:'ads', name:'Standard with Ads', price:8.99, adFree:false, streams:2},
              {id:'standard', name:'Standard', price:19.99, adFree:true, streams:2},
              {id:'premium', name:'Premium', price:26.99, adFree:true, streams:4} ],
      sports:[], kidFriendly:true,
      flagship:['stranger things','wednesday','squid game','the crown','bridgerton','emily in paris','outer banks'] },

    max: { id:'max', name:'HBO Max', checked:'2026-09-12',
      tiers:[ {id:'ads', name:'With Ads', price:10.99, adFree:false, streams:2},
              {id:'adfree', name:'Ad-Free', price:18.49, adFree:true, streams:2},
              {id:'ultimate', name:'Ultimate', price:22.99, adFree:true, streams:4} ],
      sports:['nhl','mlb','college'], kidFriendly:false,
      flagship:['house of the dragon','the last of us','euphoria','the white lotus','hacks','peacemaker'] },

    hulu: { id:'hulu', name:'Hulu', checked:'2026-09-12',
      tiers:[ {id:'ads', name:'With Ads', price:11.99, adFree:false, streams:2},
              {id:'noads', name:'No Ads', price:18.99, adFree:true, streams:2} ],
      sports:[], kidFriendly:false,
      flagship:['the bear','only murders in the building','shogun','american horror story',"handmaid's tale"] },

    // Disney+ collapsed its middle tier: the current standalone lineup is
    // Basic (with ads) and Premium (no ads). The old three-tier shape made
    // the optimiser recommend a "No Ads $16.99" plan that no longer exists.
    disney: { id:'disney', name:'Disney+', checked:'2026-09-12',
      tiers:[ {id:'ads', name:'Basic with Ads', price:11.99, adFree:false, streams:2},
              {id:'premium', name:'Premium (No Ads)', price:18.99, adFree:true, streams:4} ],
      sports:['college'], kidFriendly:true,
      flagship:['the mandalorian','andor','loki','moana','marvel','star wars','percy jackson'] },

    paramount: { id:'paramount', name:'Paramount+', checked:'2026-09-12',
      tiers:[ {id:'essential', name:'Essential', price:8.99, adFree:false, streams:2},
              {id:'showtime', name:'with Showtime', price:13.99, adFree:true, streams:3} ],
      sports:['nfl','college','other_soccer'], kidFriendly:false,
      flagship:['yellowstone','landman','tulsa king','star trek','1923','mayor of kingstown'] },

    peacock: { id:'peacock', name:'Peacock', checked:'2026-09-12',
      tiers:[ {id:'select', name:'Select', price:8.99, adFree:false, streams:2},
              {id:'premium', name:'Premium', price:12.99, adFree:false, streams:3},
              {id:'premiumplus', name:'Premium Plus', price:19.99, adFree:true, streams:3} ],
      sports:['nfl','nba','mlb','epl','college'], kidFriendly:true,
      flagship:['the office','days of our lives','poker face','love island usa','bel-air'] },

    youtubetv: { id:'youtubetv', name:'YouTube TV', checked:'2026-08-25',
      tiers:[ {id:'entertainment', name:'Entertainment Plan', price:54.99, adFree:false, streams:3},
              {id:'sports', name:'Sports Plan', price:64.99, adFree:false, streams:3},
              {id:'sportsnews', name:'Sports + News Plan', price:71.99, adFree:false, streams:3},
              {id:'base', name:'Base Plan (all channels)', price:82.99, adFree:false, streams:3} ],
      sports:['nfl','nba','mlb','nhl','college'], kidFriendly:true,
      flagship:[] },

    appletv: { id:'appletv', name:'Apple TV', checked:'2026-09-12',
      tiers:[ {id:'standard', name:'Apple TV', price:12.99, adFree:true, streams:6} ],
      sports:['mls'], kidFriendly:true,
      flagship:['ted lasso','severance','slow horses','the morning show','foundation','silo'] },

    primevideo: { id:'primevideo', name:'Amazon Prime Video', checked:'2026-08-25',
      tiers:[ {id:'ads', name:'With Ads', price:8.99, adFree:false, streams:3},
              {id:'noads', name:'Ad-Free', price:11.99, adFree:true, streams:3},
              {id:'withprime', name:'Bundled with Prime', price:14.99, adFree:false, streams:3} ],
      sports:['nfl'], kidFriendly:true,
      flagship:['the boys','fallout','reacher','the wheel of time','invincible','jack ryan'] },

    // ESPN Unlimited rose from $29.99 to $31.99 effective 2026-09-17. The
    // Disney+/Hulu/ESPN bundle below was explicitly held at $35.99, which is
    // why that bundle now beats the standalone by a much wider margin.
    espn: { id:'espn', name:'ESPN', checked:'2026-09-12',
      tiers:[ {id:'select', name:'ESPN Select', price:12.99, adFree:false, streams:2},
              {id:'unlimited', name:'ESPN Unlimited', price:31.99, adFree:false, streams:2} ],
      sports:['nfl','nba','mlb','nhl','college','laliga'], kidFriendly:false,
      flagship:[] },

    discoveryplus: { id:'discoveryplus', name:'Discovery+', checked:'2026-08-25',
      tiers:[ {id:'ads', name:'With Ads', price:5.99, adFree:false, streams:2},
              {id:'noads', name:'Ad-Free', price:9.99, adFree:true, streams:2} ],
      sports:[], kidFriendly:false,
      flagship:['deadliest catch','the pioneer woman','moonshiners','my 600-lb life'] },

    starz: { id:'starz', name:'Starz', checked:'2026-08-25',
      tiers:[ {id:'standard', name:'Starz', price:11.99, adFree:true, streams:2} ],
      sports:[], kidFriendly:false,
      flagship:['power','outlander','the girlfriend experience'] },

    amcplus: { id:'amcplus', name:'AMC+', checked:'2026-08-25',
      tiers:[ {id:'standard', name:'AMC+', price:10.99, adFree:true, streams:2} ],
      sports:[], kidFriendly:false,
      flagship:['the walking dead','better call saul','interview with the vampire'] },

    fubotv: { id:'fubotv', name:'Fubo', checked:'2026-08-25',
      tiers:[ {id:'sports', name:'Sports Plan', price:64.99, adFree:false, streams:3},
              {id:'pro', name:'Pro Plan', price:88.99, adFree:false, streams:3} ],
      sports:['nfl','nba','mlb','nhl','college','other_soccer'], kidFriendly:true,
      flagship:[] },

    slingtv: { id:'slingtv', name:'Sling TV', checked:'2026-08-25',
      tiers:[ {id:'onecolor', name:'Orange or Blue', price:45.99, adFree:false, streams:1},
              {id:'both', name:'Orange + Blue', price:65.99, adFree:false, streams:4} ],
      sports:['nfl','nba','mlb','nhl','college','other_soccer'], kidFriendly:true,
      flagship:[] },

    crunchyroll: { id:'crunchyroll', name:'Crunchyroll', checked:'2026-08-25',
      tiers:[ {id:'fan', name:'Fan', price:9.99, adFree:true, streams:1},
              {id:'megafan', name:'Mega Fan', price:13.99, adFree:true, streams:4},
              {id:'ultimatefan', name:'Ultimate Fan', price:17.99, adFree:true, streams:6} ],
      sports:[], kidFriendly:false,
      flagship:['one piece','jujutsu kaisen','attack on titan','demon slayer','my hero academia'] },

    mlbtv: { id:'mlbtv', name:'MLB.TV', checked:'2026-08-25',
      tiers:[ {id:'allteams', name:'All Teams', price:29.99, adFree:true, streams:2} ],
      sports:['mlb'], kidFriendly:false,
      flagship:[] },

    nbaleaguepass: { id:'nbaleaguepass', name:'NBA League Pass', checked:'2026-08-25',
      tiers:[ {id:'teampass', name:'Team Pass', price:13.99, adFree:true, streams:2},
              {id:'standard', name:'Standard', price:16.99, adFree:true, streams:2},
              {id:'premium', name:'Premium', price:24.99, adFree:true, streams:2} ],
      sports:['nba'], kidFriendly:false,
      flagship:[] },

    nflplus: { id:'nflplus', name:'NFL+', checked:'2026-08-25',
      tiers:[ {id:'regular', name:'Regular', price:6.99, adFree:false, streams:2},
              {id:'premium', name:'Premium', price:14.99, adFree:true, streams:2} ],
      sports:['nfl'], kidFriendly:false,
      flagship:[] },
  };

  const BUNDLES = [
    { id:'disneyhulumax', services:['disney','hulu','max'], price:{ads:19.99, noads:32.99}, name:'Disney+ / Hulu / HBO Max Trio Bundle' },
    { id:'disneyhuluespn', services:['disney','hulu','espn'], price:{ads:35.99, noads:44.99}, name:'Disney+ / Hulu / ESPN Unlimited Bundle' },
    { id:'disneyhulu', services:['disney','hulu'], price:{ads:12.99, noads:19.99}, name:'Disney+ / Hulu Duo Bundle' },
  ];

  // Direct links to each service's own account/plan page — this is the
  // mechanism behind "we tell you, you make the change": every actionable
  // card links straight here rather than StreamNavigator executing anything.
  const MANAGE_URLS = {
    netflix:'https://www.netflix.com/account',
    max:'https://www.max.com/settings/subscription',
    hulu:'https://secure.hulu.com/account',
    disney:'https://www.disneyplus.com/account/subscription',
    paramount:'https://www.paramountplus.com/account/',
    peacock:'https://www.peacocktv.com/account/subscription',
    youtubetv:'https://tv.youtube.com/subscription/',
    appletv:'https://tv.apple.com/settings',
    primevideo:'https://www.amazon.com/mc/pipelines/subscription',
    espn:'https://www.espn.com/subscription/manage',
    discoveryplus:'https://www.discoveryplus.com/account',
    starz:'https://www.starz.com/account',
    amcplus:'https://www.amcplus.com/account',
    fubotv:'https://www.fubo.tv/welcome/account',
    slingtv:'https://www.sling.com/account',
    crunchyroll:'https://www.crunchyroll.com/account/membership',
    mlbtv:'https://www.mlb.com/account',
    nbaleaguepass:'https://www.nba.com/leaguepass/account',
    nflplus:'https://www.nfl.com/account/profile',
    disneyhulumax:'https://www.disneyplus.com/account/subscription',
    disneyhuluespn:'https://www.disneyplus.com/account/subscription',
    disneyhulu:'https://www.disneyplus.com/account/subscription',
  };

  function manageLink(serviceId, name) {
    const url = MANAGE_URLS[serviceId] || `https://www.google.com/search?q=${encodeURIComponent((name || serviceId) + ' manage subscription')}`;
    const label = MANAGE_URLS[serviceId] ? `Manage on ${name || serviceId}` : `Search: manage ${name || serviceId}`;
    return { url, label };
  }

  const SPORT_SEASONS = {
    nfl: {startMonth:9, endMonth:2, label:'NFL season (Sep–Feb)'},
    nba: {startMonth:10, endMonth:6, label:'NBA season (Oct–Jun)'},
    mlb: {startMonth:4, endMonth:10, label:'MLB season (Apr–Oct)'},
    nhl: {startMonth:10, endMonth:6, label:'NHL season (Oct–Jun)'},
    epl: {startMonth:8, endMonth:5, label:'Premier League season (Aug–May)'},
    laliga: {startMonth:8, endMonth:5, label:'La Liga season (Aug–May)'},
    bundesliga: {startMonth:8, endMonth:5, label:'Bundesliga season (Aug–May)'},
    mls: {startMonth:2, endMonth:12, label:'MLS season (Feb–Dec)'},
    other_soccer: {startMonth:8, endMonth:5, label:'European club season (Aug–May)'},
    college: {startMonth:9, endMonth:1, label:'College football season (Sep–Jan)'}
  };
  const SPORT_LABELS = {
    nfl:'NFL', nba:'NBA', mlb:'MLB', nhl:'NHL',
    epl:'EPL', laliga:'La Liga', bundesliga:'Bundesliga', mls:'MLS', other_soccer:'Other Soccer',
    college:'College Football'
  };

  function activeMonths(season) {
    const { startMonth, endMonth } = season;
    if (startMonth <= endMonth) return endMonth - startMonth + 1;
    return (12 - startMonth + 1) + endMonth;
  }

  // Is this sport being played in the month of `today`? The engine used to
  // have no concept of "now" at all, so on 12 September — five days into the
  // NFL season — it told NFL households to pause their NFL services.
  function isSportInSeason(sportKey, today) {
    const season = SPORT_SEASONS[sportKey];
    if (!season) return false;
    const m = (today instanceof Date ? today : new Date()).getMonth() + 1;
    return season.startMonth <= season.endMonth
      ? (m >= season.startMonth && m <= season.endMonth)
      : (m >= season.startMonth || m <= season.endMonth);
  }

  function fmt(n) { return '$' + Number(n).toFixed(2).replace(/\.00$/, ''); }
  function cheapest(tiers) { return [...tiers].sort((a, b) => a.price - b.price)[0]; }
  function cheapestAdFree(tiers) {
    const f = [...tiers].filter((t) => t.adFree).sort((a, b) => a.price - b.price);
    return f[0] || cheapest(tiers);
  }
  function round2(n) { return Math.round(n * 100) / 100; }

  function favoritesMatch(favorites, flagship) {
    return favorites.some((f) => {
      const fl = String(f).trim().toLowerCase();
      if (!fl) return false;
      return flagship.some((t) => t.includes(fl) || fl.includes(t));
    });
  }

  /* -----------------------------------------------------------------------
     analyze(input, options)

     options.today — a Date. Defaults to now. Every seasonal decision is made
     against this, so "pause ESPN" in June and "keep ESPN" in September are
     different answers to the same inputs, which is the entire point of a
     timing product.

     THE SAVINGS INVARIANT. savingsYearly is the SUM of the disclosed actions'
     annualSaving values — it is not recomputed from a recommended total. It
     used to be `(currentTotal - recommendedMonthly) * 12`, which let the
     engine bank savings from changes it never told the customer to make: a
     household on ESPN Unlimited was shown $605.64/yr, $204 of which came from
     an ESPN downgrade that appeared in no card on the page. Deriving the
     headline from the cards makes that arithmetically impossible, and
     tests/streaming-engine.test.js asserts the invariant holds.

     Pauses with no known restart date (a general, non-seasonal pause) are
     deliberately worth ZERO in the annual headline. We cannot honestly
     annualise a pause when we do not know when it ends, so those are reported
     separately as pausedMonthlyUpside — a rate, clearly labelled, not a
     projection dressed up as a number.
     ----------------------------------------------------------------------- */
  function analyze(input, options) {
    const opts = options || {};
    const today = opts.today instanceof Date ? opts.today : new Date();
    const {
      subscriptions = [], customSubscriptions = [], favorites = [], sports = [],
      household = 1, adsOk = true, kidsImportant = false, budget = Infinity,
    } = input;

    const currentTotal = subscriptions.reduce((sum, s) => {
      const svc = SERVICES[s.serviceId];
      const tier = svc.tiers.find((t) => t.id === s.tierId) || svc.tiers[0];
      return sum + tier.price;
    }, 0) + customSubscriptions.reduce((sum, c) => sum + c.price, 0);

    const actionsMap = {};
    const kept = {};
    // Several services need two cards (downgrade AND pause). actionsMap is
    // keyed by service, so extras live here and are concatenated at the end.
    const extraActions = [];

    function addAction(key, action) { actionsMap[key] = action; }

    // Custom services typed in by the customer: not in the catalog, so no
    // tier, sport or title matching is possible. Usage frequency only.
    customSubscriptions.forEach((c) => {
      const freqScore = { daily:4, weekly:3, occasionally:2, rarely:1, never:0 }[c.frequency] ?? 1;
      if (freqScore === 0) {
        addAction(c.id, { service:c.id, name:c.name, action:'cancel',
          reason: `You said you never open ${c.name} — cancelling frees up ${fmt(c.price)}/mo.`,
          amount: c.price, annualSaving: round2(c.price * 12) });
        return;
      }
      if (freqScore <= 1) {
        addAction(c.id, { service:c.id, name:c.name, action:'pause',
          reason: `You rarely open ${c.name}. Pause it and save ${fmt(c.price)}/mo for as long as it's off — we can't date a restart for a service we don't have a catalog entry for.`,
          amount: c.price, annualSaving: 0, monthlyWhilePaused: c.price, undated: true });
        kept[c.id] = { tierId:'custom', monthly: c.price, score: freqScore, name: c.name, pausedUndated: true };
        return;
      }
      addAction(c.id, { service:c.id, name:c.name, action:'keep',
        reason: `${c.name} isn't in our catalog, so we can't check its plans or what's on it — but you watch it often enough that it's worth keeping.`,
        amount: 0, annualSaving: 0 });
      kept[c.id] = { tierId:'custom', monthly: c.price, score: freqScore, name: c.name };
    });

    subscriptions.forEach((sub) => {
      const svc = SERVICES[sub.serviceId];
      const currentTier = svc.tiers.find((t) => t.id === sub.tierId) || svc.tiers[0];
      const freqScore = { daily:4, weekly:3, occasionally:2, rarely:1, never:0 }[sub.frequency] ?? 1;

      let score = freqScore;
      const favMatch = favoritesMatch(favorites, svc.flagship);
      if (favMatch) score += 3;
      const sportMatches = sports.filter((sp) => svc.sports.includes(sp));
      score += sportMatches.length * 2;
      if (kidsImportant && svc.kidFriendly) score += 1;

      // "Never" is explicit and beats every other signal.
      if (freqScore === 0) {
        addAction(svc.id, { service: svc.id, action:'cancel',
          reason: `You said you never open ${svc.name} — cancelling frees up ${fmt(currentTier.price)}/mo.`,
          amount: currentTier.price, annualSaving: round2(currentTier.price * 12) });
        return;
      }
      if (score === 0) {
        addAction(svc.id, { service: svc.id, action:'cancel',
          reason: `You rated usage as "${sub.frequency}" with no matching shows or sports — cancelling frees up ${fmt(currentTier.price)}/mo.`,
          amount: currentTier.price, annualSaving: round2(currentTier.price * 12) });
        return;
      }

      // ---- pick the right plan for how they actually use it ----
      let idealTier;
      if (svc.id === 'youtubetv') {
        const wantsSports = sportMatches.length > 0;
        const wantsGeneral = freqScore >= 3;
        if (wantsSports && wantsGeneral) idealTier = svc.tiers.find((t) => t.id === 'sportsnews');
        else if (wantsSports) idealTier = svc.tiers.find((t) => t.id === 'sports');
        else if (wantsGeneral) idealTier = svc.tiers.find((t) => t.id === 'base');
        else idealTier = svc.tiers.find((t) => t.id === 'entertainment');
      } else {
        idealTier = adsOk ? cheapest(svc.tiers) : cheapestAdFree(svc.tiers);
        if (household >= 4) {
          const need = svc.tiers.filter((t) => t.streams >= 3 && (adsOk || t.adFree)).sort((a, b) => a.price - b.price);
          if (need.length) idealTier = need[0];
        }
      }

      // A tier change is ALWAYS its own card, whatever else happens to this
      // service. This is the fix for the phantom downgrade: the engine may
      // only ever price a pause against a tier it has told the customer to
      // move to.
      const downgradeSaving = round2(currentTier.price - idealTier.price);
      const hasDowngrade = downgradeSaving > 0.01;
      if (hasDowngrade) {
        const card = { service: svc.id, action:'downgrade',
          reason: `Switch ${svc.name} to "${idealTier.name}" — it covers how you actually use it and saves ${fmt(downgradeSaving)}/mo.`,
          amount: downgradeSaving, annualSaving: round2(downgradeSaving * 12) };
        addAction(svc.id, card);
      }

      // ---- seasonal: this service is mainly here for a sport ----
      const seasonalOnly = svc.id !== 'youtubetv' && sportMatches.length > 0 && freqScore <= 2 && !favMatch;
      if (seasonalOnly) {
        const sp = sportMatches[0];
        const season = SPORT_SEASONS[sp];
        const months = activeMonths(season);
        const offMonths = 12 - months;
        const startName = MONTH_NAMES[season.startMonth - 1];
        const endName = MONTH_NAMES[season.endMonth - 1];
        const inSeason = isSportInSeason(sp, today);
        // The pause is priced against idealTier, which is legitimate now
        // that a downgrade card above has actually told them to switch.
        const seasonalAnnual = round2(idealTier.price * offMonths);
        const key = hasDowngrade ? svc.id + ':season' : svc.id;
        const card = inSeason
          ? { service: svc.id, action:'pause-later',
              reason: `Keep ${svc.name} for now — the ${season.label} is on. Pause it when the season ends after ${endName} to save ${fmt(idealTier.price)}/mo through the off-season.`,
              amount: idealTier.price, annualSaving: seasonalAnnual, restartMonth: startName, pauseAfter: endName }
          : { service: svc.id, action:'pause',
              reason: `You mainly use ${svc.name} for ${SPORT_LABELS[sp]}, and the ${season.label} isn't on right now. Pause it today to save ${fmt(idealTier.price)}/mo, and restart around ${startName}.`,
              amount: idealTier.price, annualSaving: seasonalAnnual, restartMonth: startName };
        if (hasDowngrade) extraActions.push(Object.assign({ key }, card)); else addAction(svc.id, card);
        kept[svc.id] = { tierId: idealTier.id, monthly: idealTier.price * (months / 12), score, seasonal:true, sport: sp };
        return;
      }

      // ---- general: nothing they named is on it and they barely watch ----
      // This is the branch that did not exist. Pause used to be reachable
      // ONLY through the seasonal path above, so a household that followed
      // no sport could never be told to pause anything — and naming a
      // favourite show actively suppressed the only pause the engine had.
      // "Rarely" is a strong enough signal on its own. "Occasionally" is not
      // — that only becomes a pause when the customer has named things they
      // watch and none of them are on this service.
      const namedSomething = favorites.length > 0 || sports.length > 0;
      const generalPause = !favMatch && sportMatches.length === 0
        && (freqScore <= 1 || (freqScore <= 2 && namedSomething));
      if (generalPause) {
        const why = (favorites.length && freqScore > 1)
          ? `nothing you told us you watch is on ${svc.name}`
          : `you told us you watch it ${sub.frequency}`;
        const key = hasDowngrade ? svc.id + ':pause' : svc.id;
        const card = { service: svc.id, action:'pause',
          reason: `Pause ${svc.name} — ${why}, so it's ${fmt(idealTier.price)}/mo for something you're not using. We can't put a date on restarting it from this page; track it in the dashboard and we'll watch the schedule and tell you when something you follow is back.`,
          amount: idealTier.price, annualSaving: 0, monthlyWhilePaused: idealTier.price, undated: true };
        if (hasDowngrade) extraActions.push(Object.assign({ key }, card)); else addAction(svc.id, card);
        kept[svc.id] = { tierId: idealTier.id, monthly: idealTier.price, score, pausedUndated: true };
        return;
      }

      // ---- keep ----
      if (!hasDowngrade) {
        const reason = favMatch
          ? `You're watching something on ${svc.name} — it's already on the right plan for how you use it.`
          : `${svc.name} is already on the right plan for how you use it.`;
        addAction(svc.id, { service: svc.id, action:'keep', reason, amount: 0, annualSaving: 0 });
      }
      kept[svc.id] = { tierId: idealTier.id, monthly: idealTier.price, score };
    });

    // ---- sports the customer follows that nothing they own covers ----
    const coveredSports = new Set();
    Object.entries(kept).forEach(([sid, k]) => {
      if (k.seasonal) coveredSports.add(k.sport);
      else if (SERVICES[sid]) SERVICES[sid].sports.forEach((sp) => coveredSports.add(sp));
    });
    const alreadySubscribed = new Set(subscriptions.map((s) => s.serviceId));

    sports.filter((sp) => !coveredSports.has(sp)).forEach((sp) => {
      const candidates = Object.values(SERVICES)
        .filter((s) => s.sports.includes(sp) && !alreadySubscribed.has(s.id) && !kept[s.id]);

      if (!candidates.length) {
        if (sp === 'bundesliga') {
          addAction('bundesliga-info', { service:'bundesliga', action:'info',
            reason: 'Bundesliga doesn\'t need a new subscription — most matches stream free via Fandango, with select games also on USA Network and Peacock.',
            amount: 0, annualSaving: 0 });
        }
        return;
      }

      candidates.sort((a, b) => Math.min(...a.tiers.map((t) => t.price)) - Math.min(...b.tiers.map((t) => t.price)));
      const pick = candidates[0];
      const tier = cheapest(pick.tiers);
      const season = SPORT_SEASONS[sp];
      const months = activeMonths(season);
      const startName = MONTH_NAMES[season.startMonth - 1];
      addAction(pick.id, { service: pick.id, action:'add',
        reason: `Add ${pick.name} (${tier.name}) around ${startName} to catch ${SPORT_LABELS[sp]} for ${fmt(tier.price)}/mo — pause or cancel once the season wraps.`,
        amount: -tier.price, annualSaving: round2(-tier.price * months) });
      kept[pick.id] = { tierId: tier.id, monthly: tier.price * (months / 12), score: 99, seasonal:true, sport: sp, added:true };
      alreadySubscribed.add(pick.id);
    });

    // ---- bundles ----
    let bundleRec = null;
    for (const bundle of BUNDLES) {
      const members = bundle.services.filter((id) => kept[id] && !kept[id].seasonal && !kept[id].pausedUndated);
      if (members.length !== bundle.services.length) continue;
      const sumPrice = members.reduce((s, id) => s + kept[id].monthly, 0);
      const bundlePrice = adsOk ? bundle.price.ads : bundle.price.noads;
      if (bundlePrice < sumPrice - 0.01) { bundleRec = { bundle, members, sumPrice, bundlePrice }; break; }
    }
    if (bundleRec) {
      // The bundle supersedes the per-service tier cards for its members —
      // otherwise a downgrade and a bundle would both claim the same dollars.
      bundleRec.members.forEach((id) => {
        delete actionsMap[id];
        kept[id].monthly = 0;
        kept[id].bundled = true;
      });
      const saving = round2(bundleRec.sumPrice - bundleRec.bundlePrice);
      addAction(bundleRec.bundle.id, { service: bundleRec.bundle.id, action:'bundle',
        reason: `Switch ${bundleRec.members.map((id) => SERVICES[id].name).join(' + ')} to the ${bundleRec.bundle.name} — saves ${fmt(saving)}/mo over paying for the right plan on each separately.`,
        amount: saving, annualSaving: round2(saving * 12) });
      kept[bundleRec.bundle.id] = { tierId: adsOk ? 'ads' : 'noads', monthly: bundleRec.bundlePrice, score: 99, isBundle:true };
    }

    // ---- budget trimming ----
    function recommendedTotalRaw() {
      return Object.values(kept).reduce((s, k) => s + (k.monthly || 0), 0);
    }
    let guard = 0;
    while (recommendedTotalRaw() > budget && guard < 30) {
      guard++;
      const trimmable = Object.entries(kept)
        .filter(([, k]) => !k.isBundle && (k.monthly || 0) > 0 && !k.added)
        .sort((a, b) => (a[1].score ?? 0) - (b[1].score ?? 0));
      if (!trimmable.length) break;
      const [id, k] = trimmable[0];
      const name = SERVICES[id] ? SERVICES[id].name : (k.name || (BUNDLES.find((b) => b.id === id) || {}).name || id);
      const svc = SERVICES[id];
      const full = svc ? (svc.tiers.find((t) => t.id === k.tierId) || {}).price || k.monthly : k.monthly;
      addAction(id, { service: id, name: k.name, action:'cancel',
        reason: `To fit your ${fmt(budget)}/mo budget, cancel ${name} outright — it scored lowest on usage, shows and sports fit.`,
        amount: full, annualSaving: round2(full * 12) });
      delete kept[id];
    }

    const actions = Object.values(actionsMap).concat(extraActions.map((a) => {
      const copy = Object.assign({}, a); delete copy.key; return copy;
    }));

    // THE INVARIANT: the headline is the sum of the cards, full stop.
    const savingsYearly = round2(actions.reduce((s, a) => s + (a.annualSaving || 0), 0));
    const pausedMonthlyUpside = round2(actions.reduce((s, a) => s + (a.monthlyWhilePaused || 0), 0));
    const recommendedMonthly = round2(Math.max(0, currentTotal - savingsYearly / 12));

    return {
      currentTotal: round2(currentTotal),
      recommendedMonthly,
      savingsYearly: Math.max(0, savingsYearly),
      pausedMonthlyUpside,
      catalogVerified: CATALOG_VERIFIED,
      actions,
    };
  }

  return {
    CATALOG_VERIFIED, MONTH_NAMES, SERVICES, BUNDLES, MANAGE_URLS,
    SPORT_SEASONS, SPORT_LABELS,
    analyze, manageLink, activeMonths, isSportInSeason,
    fmt, cheapest, cheapestAdFree, favoritesMatch,
  };
}));
