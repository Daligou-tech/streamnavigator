/* =========================================================================
   navigator-streaming-engine.js — the whole product, in one file.

   StreamNavigator answers one question per subscription:

       Should I be paying for this right now, and if not, when do I
       start again?

   Everything here exists to answer that with a DATE and a DOLLAR FIGURE
   the customer can check. There is no scoring, no "how often do you watch
   it" slider, no AI. A recommendation is a function of three facts:

       1. what the customer said they watch
       2. when that content is actually on (TVmaze, free, public)
       3. when the customer's next charge lands

   Loaded as a plain script (sets window.StreamingEngine) and as a CommonJS
   module (for the test suite). No dependencies, no key, no paid data.

   PRICING. Every figure is a published US list price, verified by hand on
   the date in CATALOG_VERIFIED. There is no pricing API for these services,
   so re-pricing means re-running that research by hand. Entries carry
   `checked` so a stale one is visible rather than silently wrong, and the
   pages render CATALOG_VERIFIED next to every dollar figure.

   Sources for the 2026-09-12 pass: Tom's Guide 2026 streaming price roundup,
   DealNews HBO Max tier breakdown (upd. 2026-08-16), Variety (ESPN Unlimited
   increase effective 2026-09-17), Variety/NoDQ (Peacock increase effective
   2026-09-17), DealNews Disney+ bundle page.
   ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StreamingEngine = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CATALOG_VERIFIED = '2026-09-12';

  // What StreamNavigator itself costs. One tier. Read by the pages and by
  // tests/streaming-claims.test.js so the number cannot drift between them.
  const PRICING = {
    annualCents: 1999,
    label: '$19.99',
    period: 'per year',
    // A customer should feel they are keeping much more than they pay. At
    // $19.99 an average household clears roughly 6:1 and a heavy one 15:1.
    // Above ~$29/yr the median household drops under 4:1 and the product
    // starts losing to a calendar reminder, which is free.
    maxDefensibleCents: 2900,
  };

  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  /* -----------------------------------------------------------------------
     canPause — whether the service offers a real pause/hold, or whether
     "suspending" actually means cancelling and resubscribing.

     This changes the advice, so it is worth carrying. On a cancel-only
     service the customer keeps access to the end of the period they have
     already paid for, which is why the recommendation is always dated to
     the renewal rather than "do it now". Checked by hand; services change
     these policies, so it is stated as guidance, not gospel.
     ----------------------------------------------------------------------- */
  const SERVICES = {
    netflix: { id:'netflix', name:'Netflix', checked:'2026-09-12', canPause:false,
      tiers:[ {id:'ads', name:'Standard with Ads', price:8.99, adFree:false, streams:2},
              {id:'standard', name:'Standard', price:19.99, adFree:true, streams:2},
              {id:'premium', name:'Premium', price:26.99, adFree:true, streams:4} ],
      sports:[], kidFriendly:true,
      flagship:['stranger things','wednesday','squid game','the crown','bridgerton','emily in paris','outer banks'] },

    max: { id:'max', name:'HBO Max', checked:'2026-09-12', canPause:false,
      tiers:[ {id:'ads', name:'With Ads', price:10.99, adFree:false, streams:2},
              {id:'adfree', name:'Ad-Free', price:18.49, adFree:true, streams:2},
              {id:'ultimate', name:'Ultimate', price:22.99, adFree:true, streams:4} ],
      sports:['nhl','mlb','college'], kidFriendly:false,
      flagship:['house of the dragon','the last of us','euphoria','the white lotus','hacks','peacemaker'] },

    hulu: { id:'hulu', name:'Hulu', checked:'2026-09-12', canPause:true,
      tiers:[ {id:'ads', name:'With Ads', price:11.99, adFree:false, streams:2},
              {id:'noads', name:'No Ads', price:18.99, adFree:true, streams:2} ],
      sports:[], kidFriendly:false,
      flagship:['the bear','only murders in the building','shogun','american horror story',"handmaid's tale"] },

    // Disney+ collapsed its middle tier: the current standalone lineup is
    // Basic (with ads) and Premium (no ads).
    disney: { id:'disney', name:'Disney+', checked:'2026-09-12', canPause:false,
      tiers:[ {id:'ads', name:'Basic with Ads', price:11.99, adFree:false, streams:2},
              {id:'premium', name:'Premium (No Ads)', price:18.99, adFree:true, streams:4} ],
      sports:['college'], kidFriendly:true,
      flagship:['the mandalorian','andor','loki','moana','marvel','star wars','percy jackson'] },

    paramount: { id:'paramount', name:'Paramount+', checked:'2026-09-12', canPause:false,
      tiers:[ {id:'essential', name:'Essential', price:8.99, adFree:false, streams:2},
              {id:'showtime', name:'with Showtime', price:13.99, adFree:true, streams:3} ],
      sports:['nfl','college','other_soccer'], kidFriendly:false,
      flagship:['yellowstone','landman','tulsa king','star trek','1923','mayor of kingstown'] },

    peacock: { id:'peacock', name:'Peacock', checked:'2026-09-12', canPause:false,
      tiers:[ {id:'select', name:'Select', price:8.99, adFree:false, streams:2},
              {id:'premium', name:'Premium', price:12.99, adFree:false, streams:3},
              {id:'premiumplus', name:'Premium Plus', price:19.99, adFree:true, streams:3} ],
      sports:['nfl','nba','mlb','epl','college'], kidFriendly:true,
      flagship:['the office','days of our lives','poker face','love island usa','bel-air'] },

    youtubetv: { id:'youtubetv', name:'YouTube TV', checked:'2026-08-25', canPause:true,
      tiers:[ {id:'entertainment', name:'Entertainment Plan', price:54.99, adFree:false, streams:3},
              {id:'sports', name:'Sports Plan', price:64.99, adFree:false, streams:3},
              {id:'sportsnews', name:'Sports + News Plan', price:71.99, adFree:false, streams:3},
              {id:'base', name:'Base Plan (all channels)', price:82.99, adFree:false, streams:3} ],
      sports:['nfl','nba','mlb','nhl','college'], kidFriendly:true,
      flagship:[] },

    appletv: { id:'appletv', name:'Apple TV', checked:'2026-09-12', canPause:false,
      tiers:[ {id:'standard', name:'Apple TV', price:12.99, adFree:true, streams:6} ],
      sports:['mls'], kidFriendly:true,
      flagship:['ted lasso','severance','slow horses','the morning show','foundation','silo'] },

    primevideo: { id:'primevideo', name:'Amazon Prime Video', checked:'2026-08-25', canPause:false,
      tiers:[ {id:'ads', name:'With Ads', price:8.99, adFree:false, streams:3},
              {id:'noads', name:'Ad-Free', price:11.99, adFree:true, streams:3},
              {id:'withprime', name:'Bundled with Prime', price:14.99, adFree:false, streams:3} ],
      sports:['nfl'], kidFriendly:true,
      // Prime Video bundled with Prime carries shipping, music and more. The
      // engine must never tell someone to cancel that as if it were only a
      // streaming service.
      nonStreamingBenefits:'withprime',
      flagship:['the boys','fallout','reacher','the wheel of time','invincible','jack ryan'] },

    espn: { id:'espn', name:'ESPN', checked:'2026-09-12', canPause:false,
      tiers:[ {id:'select', name:'ESPN Select', price:12.99, adFree:false, streams:2},
              {id:'unlimited', name:'ESPN Unlimited', price:31.99, adFree:false, streams:2} ],
      sports:['nfl','nba','mlb','nhl','college','laliga'], kidFriendly:false,
      flagship:[] },

    discoveryplus: { id:'discoveryplus', name:'Discovery+', checked:'2026-08-25', canPause:false,
      tiers:[ {id:'ads', name:'With Ads', price:5.99, adFree:false, streams:2},
              {id:'noads', name:'Ad-Free', price:9.99, adFree:true, streams:2} ],
      sports:[], kidFriendly:false,
      flagship:['deadliest catch','the pioneer woman','moonshiners','my 600-lb life'] },

    starz: { id:'starz', name:'Starz', checked:'2026-08-25', canPause:false,
      tiers:[ {id:'standard', name:'Starz', price:11.99, adFree:true, streams:2} ],
      sports:[], kidFriendly:false,
      flagship:['power','outlander','the girlfriend experience'] },

    amcplus: { id:'amcplus', name:'AMC+', checked:'2026-08-25', canPause:false,
      tiers:[ {id:'standard', name:'AMC+', price:10.99, adFree:true, streams:2} ],
      sports:[], kidFriendly:false,
      flagship:['the walking dead','better call saul','interview with the vampire'] },

    fubotv: { id:'fubotv', name:'Fubo', checked:'2026-08-25', canPause:true,
      tiers:[ {id:'sports', name:'Sports Plan', price:64.99, adFree:false, streams:3},
              {id:'pro', name:'Pro Plan', price:88.99, adFree:false, streams:3} ],
      sports:['nfl','nba','mlb','nhl','college','other_soccer'], kidFriendly:true,
      flagship:[] },

    slingtv: { id:'slingtv', name:'Sling TV', checked:'2026-08-25', canPause:true,
      tiers:[ {id:'onecolor', name:'Orange or Blue', price:45.99, adFree:false, streams:1},
              {id:'both', name:'Orange + Blue', price:65.99, adFree:false, streams:4} ],
      sports:['nfl','nba','mlb','nhl','college','other_soccer'], kidFriendly:true,
      flagship:[] },

    crunchyroll: { id:'crunchyroll', name:'Crunchyroll', checked:'2026-08-25', canPause:false,
      tiers:[ {id:'fan', name:'Fan', price:9.99, adFree:true, streams:1},
              {id:'megafan', name:'Mega Fan', price:13.99, adFree:true, streams:4},
              {id:'ultimatefan', name:'Ultimate Fan', price:17.99, adFree:true, streams:6} ],
      sports:[], kidFriendly:false,
      flagship:['one piece','jujutsu kaisen','attack on titan','demon slayer','my hero academia'] },

    mlbtv: { id:'mlbtv', name:'MLB.TV', checked:'2026-08-25', canPause:false,
      tiers:[ {id:'allteams', name:'All Teams', price:29.99, adFree:true, streams:2} ],
      sports:['mlb'], kidFriendly:false, flagship:[] },

    nbaleaguepass: { id:'nbaleaguepass', name:'NBA League Pass', checked:'2026-08-25', canPause:false,
      tiers:[ {id:'teampass', name:'Team Pass', price:13.99, adFree:true, streams:2},
              {id:'standard', name:'Standard', price:16.99, adFree:true, streams:2},
              {id:'premium', name:'Premium', price:24.99, adFree:true, streams:2} ],
      sports:['nba'], kidFriendly:false, flagship:[] },

    nflplus: { id:'nflplus', name:'NFL+', checked:'2026-08-25', canPause:false,
      tiers:[ {id:'regular', name:'Regular', price:6.99, adFree:false, streams:2},
              {id:'premium', name:'Premium', price:14.99, adFree:true, streams:2} ],
      sports:['nfl'], kidFriendly:false, flagship:[] },
  };

  const BUNDLES = [
    { id:'disneyhulumax', services:['disney','hulu','max'], price:{ads:19.99, noads:32.99}, name:'Disney+ / Hulu / HBO Max bundle' },
    { id:'disneyhuluespn', services:['disney','hulu','espn'], price:{ads:35.99, noads:44.99}, name:'Disney+ / Hulu / ESPN Unlimited bundle' },
    { id:'disneyhulu', services:['disney','hulu'], price:{ads:12.99, noads:19.99}, name:'Disney+ / Hulu bundle' },
  ];

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

  /* -----------------------------------------------------------------------
     Sports calendar. Typical US season windows with a typical start DATE,
     not just a month, because a restart recommendation needs a day to name.
     These are typical, not a live schedule — nothing here claims to know
     when a particular game is on, and the UI says "around" for that reason.
     Reviewed annually; there is no free per-league schedule feed worth the
     complexity, and month-level accuracy is enough to decide a billing cycle.
     ----------------------------------------------------------------------- */
  const SPORT_SEASONS = {
    nfl:        { startMonth:9,  startDay:4,  endMonth:2,  label:'NFL season',              short:'Sep–Feb' },
    nba:        { startMonth:10, startDay:21, endMonth:6,  label:'NBA season',              short:'Oct–Jun' },
    mlb:        { startMonth:3,  startDay:27, endMonth:10, label:'MLB season',              short:'Mar–Oct' },
    nhl:        { startMonth:10, startDay:7,  endMonth:6,  label:'NHL season',              short:'Oct–Jun' },
    epl:        { startMonth:8,  startDay:15, endMonth:5,  label:'Premier League season',   short:'Aug–May' },
    laliga:     { startMonth:8,  startDay:15, endMonth:5,  label:'La Liga season',          short:'Aug–May' },
    bundesliga: { startMonth:8,  startDay:22, endMonth:5,  label:'Bundesliga season',       short:'Aug–May' },
    mls:        { startMonth:2,  startDay:22, endMonth:12, label:'MLS season',              short:'Feb–Dec' },
    other_soccer:{startMonth:8,  startDay:15, endMonth:5,  label:'European club season',    short:'Aug–May' },
    college:    { startMonth:8,  startDay:30, endMonth:1,  label:'College football season', short:'Aug–Jan' },
  };
  const SPORT_LABELS = {
    nfl:'NFL', nba:'NBA', mlb:'MLB', nhl:'NHL', epl:'Premier League', laliga:'La Liga',
    bundesliga:'Bundesliga', mls:'MLS', other_soccer:'European soccer', college:'College Football',
  };

  // ------------------------------------------------------------------ dates
  const DAY = 86400000;
  function toDate(v) {
    if (v instanceof Date) { const d = new Date(v); d.setHours(0, 0, 0, 0); return d; }
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return new Date(v.slice(0, 10) + 'T00:00:00');
    return null;
  }
  function iso(d) { return d ? d.toISOString().slice(0, 10) : null; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function daysBetween(a, b) { return Math.round((toDate(b) - toDate(a)) / DAY); }
  function advance(d, billingPeriod) {
    const x = new Date(d);
    if (billingPeriod === 'annual') x.setFullYear(x.getFullYear() + 1);
    else x.setMonth(x.getMonth() + 1);
    return x;
  }
  function prettyDate(v) {
    const d = toDate(v);
    if (!d) return '';
    return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
  }
  function prettyDateYear(v) {
    const d = toDate(v);
    if (!d) return '';
    return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }
  function fmt(n) { return '$' + Number(n).toFixed(2).replace(/\.00$/, ''); }
  function round2(n) { return Math.round(n * 100) / 100; }

  function isSportInSeason(sportKey, today) {
    const s = SPORT_SEASONS[sportKey];
    if (!s) return false;
    const m = (toDate(today) || new Date()).getMonth() + 1;
    return s.startMonth <= s.endMonth
      ? (m >= s.startMonth && m <= s.endMonth)
      : (m >= s.startMonth || m <= s.endMonth);
  }
  // The next date this sport's season starts, as an actual day.
  function nextSeasonStart(sportKey, today) {
    const s = SPORT_SEASONS[sportKey];
    if (!s) return null;
    const t = toDate(today) || new Date();
    let d = new Date(t.getFullYear(), s.startMonth - 1, s.startDay || 1);
    if (d < t) d = new Date(t.getFullYear() + 1, s.startMonth - 1, s.startDay || 1);
    return d;
  }

  /* -----------------------------------------------------------------------
     lookupShow — the one live data call in the product. TVmaze is free,
     needs no key, allows 20 calls / 10s, and is CC BY-SA (attribution is on
     both pages). Runs in the customer's own browser; nothing is sent to us.

     TVmaze's "next episode" only ever points at a FUTURE, scheduled episode.
     It goes blank while a show is actively airing but has no date posted for
     the next one, so "no next date" must not be read as "nothing is on".
     currentlyAiring is derived from the PREVIOUS episode being recent and
     the show's own status still being Running.
     ----------------------------------------------------------------------- */
  async function lookupShow(query, fetchImpl) {
    const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    const title = String(query || '').trim();
    if (!title || !doFetch) return null;
    try {
      const res = await doFetch('https://api.tvmaze.com/singlesearch/shows?q='
        + encodeURIComponent(title) + '&embed[]=nextepisode&embed[]=previousepisode');
      if (!res.ok) return { query: title, found: false, nextAirDate: null, currentlyAiring: false, status: null };
      const data = await res.json();
      const emb = data && data._embedded ? data._embedded : {};
      const nextAirDate = emb.nextepisode ? emb.nextepisode.airdate : null;
      const prevAirDate = emb.previousepisode ? emb.previousepisode.airdate : null;
      let currentlyAiring = false;
      if (prevAirDate && data.status === 'Running') {
        const days = daysBetween(prevAirDate, new Date());
        if (days >= 0 && days <= 10) currentlyAiring = true;
      }
      return {
        query: title, found: true, id: data.id || null, name: data.name || title,
        status: data.status || null, nextAirDate, prevAirDate, currentlyAiring,
        checkedAt: iso(new Date()),
      };
    } catch (err) {
      return null;
    }
  }

  /* -----------------------------------------------------------------------
     decide() — the whole product, for one subscription.

     Returns { action, headline, why, evidence[], actBy, restartDate,
               savings, cycles, confidence, ... }

     action is one of:
       keep     — something they watch is on now, or lands before they pay again
       suspend  — nothing is on, and nothing lands before the charge after next
       restart  — it's paused and something they watch is back (or imminent)
       watch    — paused, nothing scheduled: stay off, we keep checking

     RULES, and why each exists:

     * Suspending is only worth doing if it skips at least one charge. A
       recommendation that saves nothing is noise, so a suspend must skip a
       whole billing cycle to be issued at all.
     * A suspend must clear MIN_PAUSE_DAYS. Cancelling and resubscribing three
       weeks later costs the customer two chores to save part of one month;
       churn like that is what makes people stop trusting the product.
     * Annual plans are prepaid. Telling someone to cancel one mid-term
       forfeits the months they bought. Only actionable near the renewal.
     * A restart only ever fires against a REAL date. If nothing is
       scheduled, the answer is "stay off, we're still watching" — never a
       calendar guess, because that is an instruction to start paying with
       nothing to watch.
     ----------------------------------------------------------------------- */
  const MIN_PAUSE_DAYS = 45;
  const ACT_WINDOW_DAYS = 7;     // surface a suspend within a week of the charge
  const RESTART_LEAD_DAYS = 2;   // tell them 2 days before they need it back

  function nextRenewalFrom(sub, today) {
    const t = toDate(today);
    let d = toDate(sub.renewalDate);
    if (!d) return null;
    let guard = 0;
    while (d < t && guard++ < 500) d = advance(d, sub.billingPeriod);
    return d;
  }

  function decide(sub, items, today, opts) {
    const o = opts || {};
    const t = toDate(today) || new Date();
    const svc = SERVICES[sub.serviceId] || null;
    const name = sub.name || (svc && svc.name) || sub.serviceId;
    const price = Number(sub.price) || 0;
    const period = sub.billingPeriod === 'annual' ? 'annual' : 'monthly';
    const status = sub.status === 'paused' ? 'paused' : 'active';
    // Match on whichever key the caller has. Comparing loosely here would
    // make every untagged item match every service whose id is also absent,
    // so both sides must be present before they can be equal.
    const tagged = (items || []).filter((i) => (
      (i.serviceId != null && sub.serviceId != null && i.serviceId === sub.serviceId)
      || (i.service_name != null && i.service_name === name)
    ));

    const evidence = [];

    // ---- what is on right now, and what is next ----
    let airingNow = null;
    let next = null; // { date, label, approximate }

    for (const it of tagged) {
      if (it.kind === 'sport') {
        if (isSportInSeason(it.title, t)) {
          const s = SPORT_SEASONS[it.title];
          airingNow = airingNow || { label: `${SPORT_LABELS[it.title] || it.title} is in season`, detail: s ? `${s.label} runs ${s.short}` : '' };
        } else {
          const d = nextSeasonStart(it.title, t);
          if (d && (!next || d < next.date)) {
            next = { date: d, label: `${SPORT_LABELS[it.title] || it.title} starts`, approximate: true };
          }
        }
        evidence.push({
          kind: 'sport', title: SPORT_LABELS[it.title] || it.title,
          state: isSportInSeason(it.title, t) ? 'in season' : 'off-season',
          nextDate: isSportInSeason(it.title, t) ? null : iso(nextSeasonStart(it.title, t)),
          source: 'StreamNavigator season calendar', approximate: true,
        });
        continue;
      }
      // a show
      if (it.currentlyAiring) {
        airingNow = airingNow || { label: `${it.title} is airing new episodes`, detail: it.prevAirDate ? `latest episode ${prettyDate(it.prevAirDate)}` : '' };
      }
      const nd = toDate(it.nextAirDate);
      if (nd && nd >= t && (!next || nd < next.date)) {
        next = { date: nd, label: `${it.title} returns`, approximate: false };
      }
      evidence.push({
        kind: 'show', title: it.title,
        state: it.currentlyAiring ? 'airing now' : (nd ? 'scheduled' : (it.found === false ? 'not found' : 'no date announced')),
        nextDate: nd ? iso(nd) : null,
        lastAired: it.prevAirDate || null,
        source: 'TVmaze', checkedAt: it.checkedAt || null,
      });
    }

    const renewal = nextRenewalFrom(sub, t);
    const daysToRenewal = renewal ? daysBetween(t, renewal) : null;

    const base = {
      serviceId: sub.serviceId, name, price, billingPeriod: period, status,
      renewalDate: iso(renewal), daysToRenewal, evidence,
      canPause: svc ? svc.canPause !== false : false,
      tracked: tagged.length,
      annualCost: round2(price * (period === 'annual' ? 1 : 12)),
    };

    // ---- nothing tagged: we cannot honestly decide ----
    if (!tagged.length) {
      return Object.assign(base, {
        action: 'untracked',
        headline: `Tell us what you watch on ${name}`,
        why: `We won't guess. Name one show or sport you watch on ${name} and we'll tell you exactly when it's worth paying for — and when it isn't.`,
        savings: 0, confidence: 'none',
      });
    }

    // ---- paused already ----
    if (status === 'paused') {
      if (airingNow) {
        return Object.assign(base, {
          action: 'restart',
          headline: `Restart ${name}`,
          why: `${airingNow.label}${airingNow.detail ? ` (${airingNow.detail})` : ''}. It's worth paying for again.`,
          restartDate: iso(t), savings: 0, confidence: 'high',
        });
      }
      if (next && daysBetween(t, next.date) <= RESTART_LEAD_DAYS + 1) {
        return Object.assign(base, {
          action: 'restart',
          headline: `Restart ${name} before ${prettyDate(next.date)}`,
          why: `${next.label} ${next.approximate ? 'around' : 'on'} ${prettyDateYear(next.date)}. Turn it back on the day before so you don't miss it.`,
          restartDate: iso(addDays(next.date, -1)), savings: 0,
          confidence: next.approximate ? 'medium' : 'high',
        });
      }
      if (next) {
        return Object.assign(base, {
          action: 'watch',
          headline: `Keep ${name} off until ${prettyDate(next.date)}`,
          why: `${next.label} ${next.approximate ? 'around' : 'on'} ${prettyDateYear(next.date)} — that's ${daysBetween(t, next.date)} days away. We'll remind you two days before.`,
          restartDate: iso(addDays(next.date, -1)),
          savings: round2(price * cyclesBetween(t, next.date, period)),
          confidence: next.approximate ? 'medium' : 'high',
        });
      }
      return Object.assign(base, {
        action: 'watch',
        headline: `Keep ${name} off — nothing is scheduled`,
        why: `Nothing you follow on ${name} has an announced return date yet. No date, no reminder — we will not tell you to start paying again on a guess.`,
        restartDate: null, savings: round2(price * (period === 'annual' ? 1 : 12)),
        savingsIsRate: true, confidence: 'high',
      });
    }

    // ---- active, and something is on ----
    if (airingNow) {
      return Object.assign(base, {
        action: 'keep',
        headline: `Keep ${name}`,
        why: `${airingNow.label}${airingNow.detail ? ` — ${airingNow.detail}` : ''}. You're getting what you're paying for.`,
        savings: 0, confidence: 'high',
      });
    }

    // ---- active, something lands before the next charge ----
    if (next && renewal && next.date <= renewal) {
      return Object.assign(base, {
        action: 'keep',
        headline: `Keep ${name}`,
        why: `${next.label} ${next.approximate ? 'around' : 'on'} ${prettyDateYear(next.date)}, before your ${prettyDate(renewal)} renewal. Cancelling now would only mean paying to switch it back on.`,
        savings: 0, confidence: next.approximate ? 'medium' : 'high',
      });
    }

    // ---- active, nothing on: is suspending actually worth it? ----
    const gapDays = next ? daysBetween(t, next.date) : null;
    const suspendUntil = next ? next.date : null;
    // With a known return date the saving is exact: the charges that fall in
    // the gap. With no return date we still know ONE thing for certain — a
    // suspend is only ever issued when it skips at least the next charge —
    // so we bank exactly that one cycle and report the rest as a monthly
    // rate. Crediting zero was worse than dishonest, it was useless: a
    // household told to cancel three services was shown "you save $0" and
    // "you're $19.99 behind", which is the opposite of what had just
    // happened. Crediting a guess at the gap length would have been the
    // other failure. One cycle is the number we can actually stand behind.
    const cycles = renewal ? cyclesBetween(renewal, suspendUntil, period) : (suspendUntil ? cyclesBetween(t, suspendUntil, period) : null);
    const guaranteedCycles = cycles === null ? 1 : cycles;
    const savings = round2(price * guaranteedCycles);

    // Too short to be worth the chore.
    if (gapDays !== null && gapDays < MIN_PAUSE_DAYS) {
      return Object.assign(base, {
        action: 'keep',
        headline: `Keep ${name} — not worth switching off`,
        why: `Nothing you follow is on right now, but ${next.label.toLowerCase()} ${next.approximate ? 'around' : 'on'} ${prettyDateYear(next.date)} — only ${gapDays} days away. Cancelling and resubscribing for that gap isn't worth the hassle.`,
        savings: 0, confidence: 'high',
      });
    }

    // (A return that lands on or before the next charge is already a KEEP
    // above, so by here cycles is always >= 1: a suspend issued from this
    // point always skips at least one real charge.)

    // Annual plans are prepaid — only actionable as the renewal approaches.
    if (period === 'annual' && daysToRenewal !== null && daysToRenewal > 14) {
      return Object.assign(base, {
        action: 'keep',
        headline: `Don't cancel ${name} yet — it's an annual plan`,
        why: `Nothing you follow is on, but you've prepaid through ${prettyDateYear(renewal)}. Cancelling now forfeits the rest of the year instead of saving anything. We'll tell you two weeks before it renews.`,
        savings: 0, decideOn: iso(addDays(renewal, -14)), confidence: 'high',
      });
    }

    const actBy = renewal ? addDays(renewal, -1) : null;
    const verb = base.canPause ? 'Pause' : 'Cancel';
    const mechanic = base.canPause
      ? `${name} lets you pause without losing your account.`
      : `${name} has no pause, so cancel — you keep access until ${renewal ? prettyDateYear(renewal) : 'the end of the period you have already paid for'}, and your profile and watchlist are kept if you come back.`;

    const whenBack = next
      ? `${next.label} ${next.approximate ? 'around' : 'on'} ${prettyDateYear(next.date)}, so restart ${prettyDateYear(addDays(next.date, -1))}.`
      : `Nothing you follow on ${name} has an announced return date yet, so we can't tell you when to come back — and we won't invent a date.`;

    const lastOn = evidence.filter((e) => e.lastAired).sort((a, b) => (a.lastAired < b.lastAired ? 1 : -1))[0];

    return Object.assign(base, {
      action: 'suspend',
      headline: `${verb} ${name}${actBy ? ` before ${prettyDate(actBy)}` : ''}`,
      why: [
        lastOn ? `${lastOn.title} last aired ${prettyDateYear(lastOn.lastAired)}.` : `Nothing you follow on ${name} is on right now.`,
        whenBack,
        mechanic,
      ].join(' '),
      actBy: iso(actBy),
      actionable: daysToRenewal === null ? true : daysToRenewal <= (period === 'annual' ? 14 : ACT_WINDOW_DAYS),
      restartDate: next ? iso(addDays(next.date, -1)) : null,
      cycles: guaranteedCycles, savings,
      // No return date: the saving above is a floor, and every further
      // month off is worth another `price`. The UI must say both.
      openEnded: cycles === null,
      monthlyWhileOff: cycles === null ? round2(price) : 0,
      confidence: next ? (next.approximate ? 'medium' : 'high') : 'medium',
    });
  }

  // How many charges fall in [from, until)? That is exactly what a suspend
  // saves — not "months of not watching", which is not what a customer is
  // billed for.
  function cyclesBetween(from, until, billingPeriod) {
    const a = toDate(from);
    const b = toDate(until);
    if (!a) return null;
    if (!b) return null;
    let n = 0;
    let d = new Date(a);
    let guard = 0;
    while (d < b && guard++ < 500) { n++; d = advance(d, billingPeriod); }
    return n;
  }

  /* -----------------------------------------------------------------------
     analyze() — runs decide() across a whole household and adds the two
     cross-service savings that no per-subscription rule can see: a tier that
     is bigger than the household needs, and a bundle that beats paying
     separately.

     THE SAVINGS INVARIANT: savingsYearly is the SUM of the actions shown.
     It is never derived from a recommended total, because that let the
     engine bank changes it never told the customer to make.
     ----------------------------------------------------------------------- */
  function analyze(input, options) {
    const opts = options || {};
    const today = toDate(opts.today) || toDate(new Date());
    const { subscriptions = [], watchlist = [], household = 1, adsOk = false, overrides = {} } = input;

    const decisions = [];
    const actions = [];
    let currentMonthly = 0;

    for (const sub of subscriptions) {
      const svc = SERVICES[sub.serviceId];
      const tier = svc ? (svc.tiers.find((t) => t.id === sub.tierId) || svc.tiers[0]) : null;
      const price = sub.price != null ? Number(sub.price) : (tier ? tier.price : 0);
      const monthly = sub.billingPeriod === 'annual' ? price / 12 : price;
      currentMonthly += monthly;

      const d = decide(Object.assign({}, sub, { price }), watchlist, today, opts);
      d.overridden = !!overrides[sub.serviceId];
      decisions.push(d);

      // A suspend the customer has dismissed still shows, but stops counting.
      if (d.action === 'suspend' && !d.overridden) {
        actions.push({
          type: 'suspend', serviceId: sub.serviceId, name: d.name,
          annualSaving: round2(d.savings),
          monthlyWhileOff: round2(d.monthlyWhileOff || 0),
          detail: d.headline,
        });
      }
      if (d.action === 'watch' && !d.overridden && d.savingsIsRate) {
        actions.push({
          type: 'staying-off', serviceId: sub.serviceId, name: d.name,
          annualSaving: 0, monthlyWhileOff: round2(d.price), detail: d.headline,
        });
      }
    }

    // ---- tier right-sizing (only for services we are keeping) ----
    const keeping = decisions.filter((d) => d.action === 'keep' || d.action === 'restart');
    for (const d of keeping) {
      const svc = SERVICES[d.serviceId];
      if (!svc || d.overridden) continue;
      // NEVER downgrade a service the customer is keeping for a sport.
      // Sports tiers differ by which games they carry, not by ads or stream
      // count, and this catalog does not model that. Recommending Peacock
      // Select to someone watching NFL, or ESPN Select to someone watching
      // the games on Unlimited, would take away the exact thing they are
      // paying for. A saving that costs the customer what they wanted is
      // worse than no saving, so this stays suppressed until the catalog
      // knows which tier carries which rights.
      if (d.evidence.some((e) => e.kind === 'sport')) {
        d.tierNote = `We're not suggesting a cheaper ${svc.name} plan because you watch sports on it — cheaper tiers carry different games, and we don't track which.`;
        continue;
      }
      const sub = subscriptions.find((s) => s.serviceId === d.serviceId);
      const currentTier = svc.tiers.find((t) => t.id === sub.tierId);
      if (!currentTier) continue;
      let ideal = adsOk ? cheapest(svc.tiers) : cheapestAdFree(svc.tiers);
      if (household >= 3) {
        const need = svc.tiers.filter((t) => t.streams >= 3 && (adsOk || t.adFree)).sort((a, b) => a.price - b.price);
        if (need.length) ideal = need[0];
      }
      const saving = round2(currentTier.price - ideal.price);
      if (saving > 0.01) {
        actions.push({
          type: 'downgrade', serviceId: d.serviceId, name: d.name,
          annualSaving: round2(saving * 12), monthlyWhileOff: 0,
          detail: `Move to "${ideal.name}" — ${household >= 3 ? 'still enough streams for your household' : 'everything you watch, ' + fmt(saving) + '/mo less'}.`,
          from: currentTier.name, to: ideal.name, tierId: ideal.id,
        });
        d.suggestedTier = { id: ideal.id, name: ideal.name, price: ideal.price, saving };
      }
    }

    // ---- bundles (only across services we are keeping at full price) ----
    const keptIds = new Set(keeping.map((d) => d.serviceId));
    let bundle = null;
    for (const b of BUNDLES) {
      if (!b.services.every((id) => keptIds.has(id))) continue;
      const sum = b.services.reduce((s, id) => {
        const sub = subscriptions.find((x) => x.serviceId === id);
        const svc = SERVICES[id];
        const dec = decisions.find((x) => x.serviceId === id);
        const tierId = (dec && dec.suggestedTier) ? dec.suggestedTier.id : sub.tierId;
        const tier = svc.tiers.find((t) => t.id === tierId) || svc.tiers[0];
        return s + tier.price;
      }, 0);
      const price = adsOk ? b.price.ads : b.price.noads;
      if (price < sum - 0.01) { bundle = { b, sum, price }; break; }
    }
    if (bundle) {
      // The bundle supersedes the per-service downgrades it covers, or both
      // would claim the same dollars.
      for (let i = actions.length - 1; i >= 0; i--) {
        if (actions[i].type === 'downgrade' && bundle.b.services.includes(actions[i].serviceId)) actions.splice(i, 1);
      }
      const saving = round2(bundle.sum - bundle.price);
      actions.push({
        type: 'bundle', serviceId: bundle.b.id, name: bundle.b.name,
        annualSaving: round2(saving * 12), monthlyWhileOff: 0,
        detail: `${bundle.b.services.map((id) => SERVICES[id].name).join(' + ')} together cost ${fmt(bundle.price)}/mo instead of ${fmt(bundle.sum)}.`,
      });
    }

    const savingsYearly = round2(actions.reduce((s, a) => s + (a.annualSaving || 0), 0));
    const monthlyWhileOff = round2(actions.reduce((s, a) => s + (a.monthlyWhileOff || 0), 0));
    const currentAnnual = round2(currentMonthly * 12);

    return {
      today: iso(today),
      currentMonthly: round2(currentMonthly),
      currentAnnual,
      optimisedAnnual: round2(Math.max(0, currentAnnual - savingsYearly)),
      savingsYearly,
      savingsMonthly: round2(savingsYearly / 12),
      monthlyWhileOff,
      feeAnnual: round2(PRICING.annualCents / 100),
      netSavingsYearly: round2(savingsYearly - PRICING.annualCents / 100),
      catalogVerified: CATALOG_VERIFIED,
      decisions, actions,
    };
  }

  /* -----------------------------------------------------------------------
     Stored row -> engine input.

     These live here rather than in dashboard.html because three callers need
     exactly the same mapping: the dashboard row, the dashboard's analyzer,
     and the daily cron that sends the emails. When they each had their own,
     they drifted — and a dashboard that disagrees with the email it just
     sent you is worse than either being wrong on its own.
     ----------------------------------------------------------------------- */
  const SERVICE_ALIASES = {
    hbomax:'max', max:'max', hbo:'max',
    primevideo:'primevideo', amazonprimevideo:'primevideo', prime:'primevideo', amazonprime:'primevideo',
    disney:'disney', disneyplus:'disney',
    appletv:'appletv', appletvplus:'appletv', apple:'appletv',
    youtubetv:'youtubetv', discoveryplus:'discoveryplus', amcplus:'amcplus', crunchyroll:'crunchyroll',
    paramountplus:'paramount', paramount:'paramount', peacock:'peacock', hulu:'hulu', netflix:'netflix',
    espn:'espn', espnplus:'espn', starz:'starz', fubotv:'fubotv', fubo:'fubotv',
    slingtv:'slingtv', sling:'slingtv', mlbtv:'mlbtv', nbaleaguepass:'nbaleaguepass', nflplus:'nflplus',
  };
  function matchServiceId(name) {
    const norm = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (SERVICE_ALIASES[norm]) return SERVICE_ALIASES[norm];
    for (const id in SERVICES) {
      if (SERVICES[id].name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm) return id;
    }
    return null;
  }
  function nearestTier(svc, price) {
    let best = svc.tiers[0];
    let bestDiff = Infinity;
    svc.tiers.forEach((t) => { const d = Math.abs(t.price - price); if (d < bestDiff) { bestDiff = d; best = t; } });
    return best;
  }
  function rowToSubscription(row) {
    const matchId = matchServiceId(row.service_name);
    const price = Number(row.monthly_price) || 0;
    return {
      serviceId: matchId || ('row:' + row.id),
      name: row.service_name,
      price,
      tierId: matchId ? nearestTier(SERVICES[matchId], price).id : null,
      billingPeriod: row.billing_period === 'annual' ? 'annual' : 'monthly',
      renewalDate: row.next_renewal_date || null,
      status: row.status === 'paused' ? 'paused' : 'active',
    };
  }
  // favorite_watches rows already carry the air dates the daily job keeps
  // fresh, so every surface reasons about the same data.
  function favoriteToItem(f) {
    return {
      kind: f.kind,
      service_name: f.service_name,
      title: f.title,
      nextAirDate: f.next_air_date || null,
      currentlyAiring: !!f.currently_airing,
      checkedAt: f.checked_at ? String(f.checked_at).slice(0, 10) : null,
    };
  }

  function cheapest(tiers) { return [...tiers].sort((a, b) => a.price - b.price)[0]; }
  function cheapestAdFree(tiers) {
    const f = [...tiers].filter((t) => t.adFree).sort((a, b) => a.price - b.price);
    return f[0] || cheapest(tiers);
  }
  // Which catalog service is a title's flagship home? Used to suggest a
  // service when the customer names a show before picking one.
  function serviceForTitle(title) {
    const t = String(title || '').trim().toLowerCase();
    if (!t) return null;
    for (const id in SERVICES) {
      if (SERVICES[id].flagship.some((f) => f.includes(t) || t.includes(f))) return id;
    }
    return null;
  }

  return {
    CATALOG_VERIFIED, PRICING, MONTH_NAMES, SERVICES, BUNDLES, MANAGE_URLS,
    SPORT_SEASONS, SPORT_LABELS, MIN_PAUSE_DAYS, RESTART_LEAD_DAYS, ACT_WINDOW_DAYS,
    analyze, decide, lookupShow, manageLink,
    isSportInSeason, nextSeasonStart, nextRenewalFrom, cyclesBetween,
    serviceForTitle, cheapest, cheapestAdFree,
    SERVICE_ALIASES, matchServiceId, nearestTier, rowToSubscription, favoriteToItem,
    fmt, round2, toDate, iso, addDays, daysBetween, advance, prettyDate, prettyDateYear,
  };
}));
