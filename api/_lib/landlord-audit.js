'use strict';

// The deterministic half of Landlord Navigator.
//
// Nothing in this file calls a model. Every finding here is produced by
// matching what the landlord told us about a specific property against
// data/landlord-jurisdictions.json, or by doing arithmetic on a date they
// gave us. If a check cannot run because a field was left blank, it is
// skipped by name rather than guessed at.
//
// Why this exists. Before it, the product was a single model call over a
// free-text paragraph, and the audit of 2026-09-10 found what that produces:
// a page selling "tracks relevant rules" and "required tenant notice periods
// for your area" on top of a system prompt that explicitly forbids the model
// from stating an exact notice period unless it is confident. The page was
// selling the one output the engine was instructed to withhold, and there was
// no reference set for it to be confident against — data/ was empty.
//
// The fix is the arrangement closing-audit.js and rental-audit.js already
// proved: decide deterministically, then hand the findings to the model as
// data to write up, never as documents to form an opinion about. What is
// different here is the input. Rental extracts numbers from statements;
// this reads structured answers from the intake form, which is why
// landlord.html now asks for a property's city, year built and lease end
// date instead of one textarea.
//
// The honesty rule this file is built around: it never states a fee, a
// renewal date or an ordinance number, because it does not hold any and a
// wrong one is worse for a landlord than no answer. Every finding ends by
// naming the office to confirm with, and every finding carries the
// confidence of the entry behind it.

const fs = require('node:fs');
const path = require('node:path');

// --- vocabulary -------------------------------------------------------------

// Ordered strongest first. The ladder is compliance-specific: "a programme
// applies and you told us you are not in it" and "this is likely to apply,
// confirm it" are different claims, and a report that blurs them is telling a
// landlord that a probably and a definitely carry the same weight.
const Severity = {
  // A named programme applies to this property and the owner's own answer says
  // they are not enrolled, or holds no record of meeting it.
  REQUIREMENT_UNMET: 'requirement_appears_unmet',
  // A date the owner supplied, subtracted from today.
  DEADLINE_NEAR: 'deadline_approaching',
  // The programme is likely to apply but the reference entry is not certain,
  // or the owner did not say whether they are enrolled.
  REQUIREMENT_LIKELY: 'requirement_likely_applies',
  // An obligation that exists nearly everywhere, whose detail is local.
  VERIFY_LOCALLY: 'verify_with_local_authority',
  // We hold nothing for this jurisdiction. Named, never silent.
  COVERAGE_GAP: 'jurisdiction_not_covered',
  // The check ran and there is nothing to do. This is a result, not filler.
  WITHIN_NORMS: 'within_norms',
};

const SEVERITY_ORDER = {
  [Severity.REQUIREMENT_UNMET]: 0,
  [Severity.DEADLINE_NEAR]: 1,
  [Severity.REQUIREMENT_LIKELY]: 2,
  [Severity.VERIFY_LOCALLY]: 3,
  [Severity.COVERAGE_GAP]: 4,
  [Severity.WITHIN_NORMS]: 5,
};

// What the finding rests on. The distinction that matters to a landlord is
// between something that follows from their own answer, something we hold a
// reference entry for, and something that is general knowledge about how
// rental law works. Only the first two survive a phone call to the city.
const EvidenceKind = {
  OWNER_STATED: 'owner_answer',
  DATE_ARITHMETIC: 'arithmetic_on_owner_date',
  FEDERAL_RULE: 'federal_rule',
  JURISDICTION_HIGH: 'reference_entry:established',
  JURISDICTION_CHECK: 'reference_entry:confirm_first',
  NONE: 'no_reference_held',
};

const Actionability = {
  ACT_NOW: 'actionable_now',
  BEFORE_NEXT_LEASE: 'actionable_before_next_lease',
  AT_RENEWAL: 'actionable_at_renewal',
  CONFIRM_FIRST: 'confirm_before_acting',
};

// --- the reference set ------------------------------------------------------

let CORPUS = null;

function corpus() {
  if (CORPUS) return CORPUS;
  try {
    const file = path.join(__dirname, '..', '..', 'data', 'landlord-jurisdictions.json');
    CORPUS = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // An unreadable reference set must not take the product down. Every
    // jurisdiction then reports as uncovered, which is the honest outcome and
    // exactly what the customer would be told anyway.
    CORPUS = { federal: {}, states: {}, cities: {} };
  }
  return CORPUS;
}

const STATE_BY_NAME = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'district of columbia': 'DC',
};

// Names a landlord actually types, mapped to the key the reference set uses.
// Missing a match here costs a real finding — someone who writes "St. Paul"
// has the same Fire Certificate of Occupancy obligation as someone who writes
// it out — so this list is worth extending whenever a live submission misses.
const CITY_ALIASES = {
  'st paul': 'saint paul', 'st. paul': 'saint paul',
  'nyc': 'new york', 'new york city': 'new york', 'brooklyn': 'new york',
  'queens': 'new york', 'the bronx': 'new york', 'bronx': 'new york',
  'staten island': 'new york', 'manhattan': 'new york',
  'washington dc': 'washington', 'washington d.c.': 'washington', 'dc': 'washington',
  'philly': 'philadelphia',
  'ft lauderdale': 'fort lauderdale', 'ft. lauderdale': 'fort lauderdale',
  'kc': 'kansas city', 'kcmo': 'kansas city',
  'sf': 'san francisco', 'la': 'los angeles',
  'nola': 'new orleans',
};

function normState(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return STATE_BY_NAME[s.toLowerCase()] || null;
}

function normCity(raw) {
  const c = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!c) return null;
  return CITY_ALIASES[c] || c;
}

function cityEntry(property) {
  const city = normCity(property.city);
  const state = normState(property.state);
  if (!city || !state) return null;
  return corpus().cities[`${city}-${state.toLowerCase()}`] || null;
}

function stateEntry(property) {
  const state = normState(property.state);
  if (!state) return null;
  return corpus().states[state] || null;
}

function placeName(property) {
  const state = normState(property.state);
  const city = String(property.city || '').trim();
  if (city && state) return `${city}, ${state}`;
  return city || state || 'the location given';
}

// --- small helpers ----------------------------------------------------------

function parseDate(value) {
  if (!value) return null;
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

function daysBetween(from, to) {
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

function yesNo(value) {
  if (value === true || value === 'yes' || value === 'true') return true;
  if (value === false || value === 'no' || value === 'false') return false;
  return null;   // "not sure", or never answered
}

function year(value) {
  const n = Number(String(value === null || value === undefined ? '' : value).trim());
  return Number.isInteger(n) && n > 1500 && n <= 2100 ? n : null;
}

function confidenceOf(entry) {
  return entry && entry.confidence === 'check' ? 'check' : 'high';
}

function evidenceFor(entry) {
  return confidenceOf(entry) === 'check'
    ? EvidenceKind.JURISDICTION_CHECK
    : EvidenceKind.JURISDICTION_HIGH;
}

// Every finding that rests on a reference entry says so in the same words, so
// a landlord reading twelve of them learns the vocabulary once.
function hedge(entry) {
  return confidenceOf(entry) === 'check'
    ? 'Our reference entry for this one is marked confirm-first, so treat it as likely rather than settled until the office below confirms it.'
    : 'This programme is long-standing and well documented, so the question is not whether it exists but whether this property is in it.';
}

function label(property, index) {
  const name = String(property.label || '').trim();
  if (name) return name;
  const line = String(property.line1 || '').trim();
  if (line) return line;
  return `Property ${index + 1}`;
}

// --- the checks -------------------------------------------------------------
//
// Each entry declares what it needs before it can run, so a blank field turns
// into a named skip the customer can act on rather than a check that quietly
// did not happen. `run` returns a finding, an array of them, or null for
// "ran, nothing to say".

const CATALOG = [
  {
    id: 'REGISTRATION',
    label: 'rental registration or licensing',
    needs: (p) => !!normState(p.state),
    run: (p, ctx) => {
      const city = cityEntry(p);
      const state = stateEntry(p);
      const reg = (city && city.registration) || (state && state.registration) || null;
      const authority = reg && reg.authority;
      const where = placeName(p);

      // Nothing held for this jurisdiction. Named, because the alternative is a
      // landlord in an uncovered city reading a clean report and believing they
      // were checked.
      if (!city && !(state && state.registration)) {
        return {
          checkId: 'REGISTRATION_NOT_COVERED',
          property: ctx.name,
          title: `We hold no registration reference for ${where}`,
          severity: Severity.COVERAGE_GAP,
          evidence: EvidenceKind.NONE,
          actionability: Actionability.CONFIRM_FIRST,
          basis: `Our reference set covers a specific list of jurisdictions and ${where} is not on it. `
            + 'That is a statement about what we hold, not about this property — a registration '
            + 'programme may well exist there.',
          recommendedAction: `Call the city or county housing, permits or code enforcement office for ${where} `
            + 'and ask one question: "do I need to register or licence a residential rental here?" '
            + 'It is a five-minute call and it is the single most common thing self-managing landlords miss.',
          verifyWith: `the housing or code enforcement office for ${where}`,
          confidence: 'check',
        };
      }

      if (reg && reg.required === false) {
        return {
          checkId: 'REGISTRATION_NOT_REQUIRED',
          property: ctx.name,
          title: `No general rental registration to hold in ${where}`,
          severity: Severity.WITHIN_NORMS,
          evidence: evidenceFor(reg),
          actionability: Actionability.CONFIRM_FIRST,
          basis: reg.note
            || `${where} does not run a general rental registry, so for most landlords there is nothing to register.`,
          recommendedAction: 'Nothing to do here. Worth knowing so you do not go looking for a licence that does not exist.',
          verifyWith: authority || `the housing office for ${where}`,
          confidence: confidenceOf(reg),
        };
      }

      if (!reg || reg.required !== true) return null;

      const held = yesNo(p.registered);
      const programme = reg.programme || 'a rental registration or licence';

      if (held === true) {
        return {
          checkId: 'REGISTRATION_HELD',
          property: ctx.name,
          title: `Registered under ${programme}`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.OWNER_STATED,
          actionability: Actionability.AT_RENEWAL,
          basis: `${where} requires ${programme}, and you told us this property holds it. `
            + 'The thing to watch from here is the renewal, not the enrolment.',
          recommendedAction: 'Nothing to do now. Put the renewal in your calendar the day it is issued.',
          verifyWith: authority,
          confidence: confidenceOf(reg),
        };
      }

      if (held === false) {
        return {
          checkId: 'REGISTRATION_MISSING',
          property: ctx.name,
          title: `${where} requires ${programme}, and this property is not enrolled`,
          severity: confidenceOf(reg) === 'high'
            ? Severity.REQUIREMENT_UNMET
            : Severity.REQUIREMENT_LIKELY,
          evidence: evidenceFor(reg),
          actionability: Actionability.ACT_NOW,
          basis: `You told us this property is not registered. ${where} runs ${programme}. ${hedge(reg)} `
            + 'An unregistered rental is not only a fine risk: in a number of places it affects what a '
            + 'landlord can enforce against a tenant, which is the expensive part.',
          recommendedAction: `Contact ${authority} and ask what registering this property requires and what it costs. `
            + 'Do this before your next lease signing or renewal, not after.',
          verifyWith: authority,
          confidence: confidenceOf(reg),
        };
      }

      return {
        checkId: 'REGISTRATION_UNKNOWN',
        property: ctx.name,
        title: `${where} requires ${programme} — you did not say whether this property holds it`,
        severity: Severity.REQUIREMENT_LIKELY,
        evidence: evidenceFor(reg),
        actionability: Actionability.CONFIRM_FIRST,
        basis: `${where} runs ${programme}. ${hedge(reg)} You left the registration question blank for this `
          + 'property, so we cannot tell you whether you are covered — only that the requirement exists.',
        recommendedAction: `Check your records for a current registration or licence. If you cannot find one, `
          + `contact ${authority}.`,
        verifyWith: authority,
        confidence: confidenceOf(reg),
      };
    },
  },

  {
    id: 'REGISTRATION_EXPIRY',
    label: 'registration renewal date',
    // Only meaningful when they actually gave us a date; a landlord with no
    // registration is already covered by the check above.
    silentSkip: true,
    needs: (p) => !!parseDate(p.registration_expires),
    run: (p, ctx) => {
      const due = parseDate(p.registration_expires);
      const days = daysBetween(ctx.asOf, due);
      const when = due.toISOString().slice(0, 10);
      const reg = (cityEntry(p) && cityEntry(p).registration)
        || (stateEntry(p) && stateEntry(p).registration) || null;
      const authority = (reg && reg.authority) || `the housing office for ${placeName(p)}`;

      if (days < 0) {
        return {
          checkId: 'REGISTRATION_EXPIRED',
          property: ctx.name,
          title: `Registration lapsed ${Math.abs(days)} days ago`,
          severity: Severity.REQUIREMENT_UNMET,
          evidence: EvidenceKind.DATE_ARITHMETIC,
          actionability: Actionability.ACT_NOW,
          basis: `You gave ${when} as the expiry date. That is ${Math.abs(days)} days before today, `
            + 'so on your own figures this property is currently operating unregistered.',
          recommendedAction: `Renew immediately through ${authority}, and ask whether a late renewal carries a `
            + 'penalty or requires a fresh inspection.',
          verifyWith: authority,
          confidence: 'high',
          daysOut: days,
        };
      }
      if (days <= 90) {
        return {
          checkId: 'REGISTRATION_DUE_SOON',
          property: ctx.name,
          title: `Registration renews in ${days} days`,
          severity: Severity.DEADLINE_NEAR,
          evidence: EvidenceKind.DATE_ARITHMETIC,
          actionability: Actionability.ACT_NOW,
          basis: `You gave ${when} as the expiry date, which is ${days} days from today. Where renewal `
            + 'requires an inspection to be booked first, ninety days is not a lot of room.',
          recommendedAction: `Start the renewal now, and ask ${authority} whether an inspection has to be `
            + 'completed before the current registration lapses.',
          verifyWith: authority,
          confidence: 'high',
          daysOut: days,
        };
      }
      return {
        checkId: 'REGISTRATION_CURRENT',
        property: ctx.name,
        title: `Registration runs for another ${days} days`,
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.DATE_ARITHMETIC,
        actionability: Actionability.AT_RENEWAL,
        basis: `You gave ${when} as the expiry date, ${days} days from today.`,
        recommendedAction: 'Nothing to do now.',
        verifyWith: authority,
        confidence: 'high',
        daysOut: days,
      };
    },
  },

  {
    id: 'LEAD_FEDERAL',
    label: 'federal lead-paint disclosure',
    needs: (p) => year(p.year_built) !== null,
    run: (p, ctx) => {
      const built = year(p.year_built);
      const rule = corpus().federal && corpus().federal.lead_disclosure;
      if (!rule) return null;

      if (built >= 1978) {
        return {
          checkId: 'LEAD_NOT_TARGET_HOUSING',
          property: ctx.name,
          title: `Built in ${built}, so the federal lead rules do not reach it`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.FEDERAL_RULE,
          actionability: Actionability.CONFIRM_FIRST,
          basis: `The federal lead disclosure duty applies to housing built before 1978. You gave ${built}.`,
          recommendedAction: 'Nothing to do. This is one of the few compliance questions a build year settles outright.',
          verifyWith: rule.authority,
          confidence: 'high',
        };
      }

      const onFile = yesNo(p.lead_disclosure_on_file);
      if (onFile === true) {
        return {
          checkId: 'LEAD_DISCLOSURE_ON_FILE',
          property: ctx.name,
          title: `Pre-1978, and you hold a signed lead disclosure`,
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.OWNER_STATED,
          actionability: Actionability.BEFORE_NEXT_LEASE,
          basis: `Built ${built}, so the federal disclosure duty applies, and you told us a signed disclosure `
            + 'is on file. Keep it for three years and repeat it at every new lease.',
          recommendedAction: 'Nothing to do now. Redo the disclosure with any new tenant, not just the first.',
          verifyWith: rule.authority,
          confidence: 'high',
        };
      }

      return {
        checkId: 'LEAD_DISCLOSURE_MISSING',
        property: ctx.name,
        title: `Built ${built} with no signed lead disclosure on file`,
        severity: onFile === false ? Severity.REQUIREMENT_UNMET : Severity.REQUIREMENT_LIKELY,
        evidence: EvidenceKind.FEDERAL_RULE,
        actionability: Actionability.BEFORE_NEXT_LEASE,
        basis: `${rule.obligation} You gave ${built} as the build year`
          + (onFile === false
            ? ', and told us no signed disclosure is on file.'
            : ', and did not confirm a signed disclosure is on file.')
          + ` ${rule.why_it_matters}`,
        recommendedAction: 'Get the EPA lead hazard pamphlet and the standard disclosure form — both are free from '
          + 'the EPA and HUD — and have every current tenant sign the disclosure at the next renewal, then keep '
          + 'the signed copy. This is a paperwork fix you can complete yourself in an afternoon, and it is the '
          + 'highest-value hour on this whole report.',
        verifyWith: rule.authority,
        confidence: 'high',
      };
    },
  },

  {
    id: 'LEAD_CHILD',
    label: 'lead hazard where a young child lives',
    silentSkip: true,
    needs: (p) => year(p.year_built) !== null && yesNo(p.child_under_six) !== null,
    run: (p, ctx) => {
      const built = year(p.year_built);
      if (built >= 1978 || yesNo(p.child_under_six) !== true) return null;

      const st = stateEntry(p);
      const lead = st && st.lead && st.lead.beyond_federal ? st.lead : null;
      const where = placeName(p);

      return {
        checkId: lead ? 'LEAD_CHILD_STATE_REGIME' : 'LEAD_CHILD_GENERAL',
        property: ctx.name,
        title: lead
          ? `A child under six in a ${built} unit — ${lead.programme} goes further than disclosure`
          : `A child under six lives in a ${built} unit`,
        severity: Severity.REQUIREMENT_UNMET,
        evidence: lead ? evidenceFor(lead) : EvidenceKind.FEDERAL_RULE,
        actionability: Actionability.ACT_NOW,
        basis: lead
          ? `${lead.what_it_adds} You told us this unit was built in ${built} and that a child under six lives `
            + `there, which is the combination the programme is written around. ${hedge(lead)}`
          : `Pre-1978 paint plus a resident child under six is the fact pattern that turns a disclosure `
            + 'question into a health and liability one. Many states add duties on top of the federal '
            + `disclosure in exactly this situation, and we hold no entry for ${where} saying whether it is one of them.`,
        recommendedAction: lead
          ? `Contact ${lead.authority} and ask what this property is required to have done and by when. `
            + 'Do not wait for a complaint to start this — in a regime of this kind the owner\'s duty does not '
            + 'depend on having known about the paint.'
          : `Ask your state health department what a pre-1978 rental with a resident child under six is required `
            + 'to do beyond the federal disclosure. Then do the federal disclosure regardless.',
        verifyWith: lead ? lead.authority : 'your state department of public health',
        confidence: lead ? confidenceOf(lead) : 'check',
      };
    },
  },

  {
    id: 'LEAD_STATE',
    label: 'state lead certification beyond the federal rule',
    silentSkip: true,
    needs: (p) => year(p.year_built) !== null && !!normState(p.state),
    run: (p, ctx) => {
      const built = year(p.year_built);
      const st = stateEntry(p);
      const lead = st && st.lead && st.lead.beyond_federal ? st.lead : null;
      // The child-present case is stronger and already covered above; this is
      // the one that catches the landlord who thinks disclosure is the end of it.
      if (built >= 1978 || !lead || yesNo(p.child_under_six) === true) return null;

      return {
        checkId: 'LEAD_STATE_REGIME',
        property: ctx.name,
        title: `${st.name} adds ${lead.programme} on top of the federal disclosure`,
        severity: Severity.REQUIREMENT_LIKELY,
        evidence: evidenceFor(lead),
        actionability: Actionability.CONFIRM_FIRST,
        basis: `${lead.what_it_adds} This property was built in ${built}, which puts it in scope. ${hedge(lead)}`,
        recommendedAction: `Ask ${lead.authority} whether this unit needs a current inspection or certificate, `
          + 'and what it takes to get one.',
        verifyWith: lead.authority,
        confidence: confidenceOf(lead),
      };
    },
  },

  {
    id: 'INSPECTION',
    label: 'periodic inspection programme',
    silentSkip: true,
    needs: (p) => !!cityEntry(p),
    run: (p, ctx) => {
      const city = cityEntry(p);
      const insp = city && city.inspection;
      if (!insp || !insp.periodic) return null;
      const authority = (city.registration && city.registration.authority)
        || `the housing office for ${placeName(p)}`;
      return {
        checkId: 'INSPECTION_PROGRAMME',
        property: ctx.name,
        title: `${placeName(p)} inspects rentals on a cycle, not on complaint`,
        severity: Severity.VERIFY_LOCALLY,
        evidence: evidenceFor(insp),
        actionability: Actionability.CONFIRM_FIRST,
        basis: 'This city runs periodic inspections of registered rentals rather than waiting for a tenant to '
          + 'complain, so an inspection will arrive whether or not anything is wrong. Landlords who are '
          + 'surprised by one tend to fail it on things they could have fixed in a weekend.',
        recommendedAction: `Ask ${authority} when this property is next in the inspection cycle and what the `
          + 'inspector checks. Then walk the property against that list before they do.',
        verifyWith: authority,
        confidence: confidenceOf(insp),
      };
    },
  },

  {
    id: 'LEASE_ATTACHMENT',
    label: 'documents that must be attached to the lease',
    silentSkip: true,
    needs: (p) => !!(cityEntry(p) && cityEntry(p).lease_attachment),
    run: (p, ctx) => {
      const att = cityEntry(p).lease_attachment;
      if (!att || att.required !== true) return null;
      return {
        checkId: 'LEASE_ATTACHMENT_REQUIRED',
        property: ctx.name,
        title: `${placeName(p)} requires a document attached to every lease`,
        severity: Severity.REQUIREMENT_LIKELY,
        evidence: evidenceFor(att),
        actionability: Actionability.BEFORE_NEXT_LEASE,
        basis: `The requirement is ${att.document}. ${hedge(att)} This is the cheapest obligation on this report `
          + 'to meet and one of the more expensive to have missed, because the remedy usually runs to the tenant.',
        recommendedAction: `Get the current version from ${att.authority}, attach it to every lease and every `
          + 'renewal from here, and keep the tenant-signed acknowledgement with the lease.',
        verifyWith: att.authority,
        confidence: confidenceOf(att),
      };
    },
  },

  {
    id: 'LEASE_NOTICE',
    label: 'notice window before the lease ends',
    needs: (p) => !!parseDate(p.lease_ends),
    run: (p, ctx) => {
      const ends = parseDate(p.lease_ends);
      const days = daysBetween(ctx.asOf, ends);
      const when = ends.toISOString().slice(0, 10);
      if (days < 0) {
        return {
          checkId: 'LEASE_ALREADY_ENDED',
          property: ctx.name,
          title: `The lease end date you gave was ${Math.abs(days)} days ago`,
          severity: Severity.VERIFY_LOCALLY,
          evidence: EvidenceKind.DATE_ARITHMETIC,
          actionability: Actionability.ACT_NOW,
          basis: `You gave ${when}, which has passed. A tenancy that continues past its end date usually `
            + 'converts to something month-to-month, and the notice rules for ending that are often different '
            + 'from the ones for declining to renew.',
          recommendedAction: 'Establish in writing what the tenancy is now, before you need to give notice on it. '
            + 'Your state landlord-tenant office or a local landlord association can tell you what a holdover '
            + 'tenancy becomes where you are.',
          verifyWith: 'your state landlord-tenant or consumer protection office',
          confidence: 'high',
          daysOut: days,
        };
      }
      if (days <= 150) {
        return {
          checkId: 'LEASE_NOTICE_WINDOW',
          property: ctx.name,
          title: `Lease ends in ${days} days — the notice window is open or about to be`,
          severity: Severity.DEADLINE_NEAR,
          evidence: EvidenceKind.DATE_ARITHMETIC,
          actionability: Actionability.ACT_NOW,
          basis: `You gave ${when}, which is ${days} days from today. Required notice for non-renewal is set by `
            + 'state and sometimes city law and commonly runs from thirty to ninety days, occasionally longer for '
            + 'a tenancy of several years. We do not state your exact period, because it is the kind of number '
            + 'that changes and a wrong one here costs you the whole notice. What the arithmetic does say is '
            + `that ${days} days is inside the range where the decision has to be made rather than deferred.`,
          recommendedAction: 'Decide now whether you are renewing, then confirm your required notice period with '
            + 'your state landlord-tenant office or a local landlord association and serve it in writing with '
            + 'proof of delivery. If you are renewing, that is also the moment to redo any disclosure this report '
            + 'flags — a renewal is a new lease for most of these purposes.',
          verifyWith: 'your state landlord-tenant or consumer protection office',
          confidence: 'high',
          daysOut: days,
        };
      }
      return {
        checkId: 'LEASE_NOTICE_CLEAR',
        property: ctx.name,
        title: `Lease runs another ${days} days`,
        severity: Severity.WITHIN_NORMS,
        evidence: EvidenceKind.DATE_ARITHMETIC,
        actionability: Actionability.AT_RENEWAL,
        basis: `You gave ${when}, ${days} days out, which is outside any ordinary notice window.`,
        recommendedAction: 'Nothing to do now.',
        verifyWith: 'your state landlord-tenant or consumer protection office',
        confidence: 'high',
        daysOut: days,
      };
    },
  },

  {
    id: 'DEPOSIT',
    label: 'how the security deposit is held',
    needs: (p) => !!p.deposit_held,
    run: (p, ctx) => {
      const how = String(p.deposit_held);
      if (how === 'none') return null;

      const st = stateEntry(p);
      const rule = st && st.deposit;
      const city = cityEntry(p);
      const cityRule = city && city.deposit_rules;

      if (how === 'separate') {
        return {
          checkId: 'DEPOSIT_SEPARATE',
          property: ctx.name,
          title: 'Deposit held separately from your own money',
          severity: Severity.WITHIN_NORMS,
          evidence: EvidenceKind.OWNER_STATED,
          actionability: Actionability.CONFIRM_FIRST,
          basis: 'You told us the deposit for this property sits in its own account. That is the arrangement '
            + 'every state that regulates deposits is looking for, and it is the one that survives a dispute.',
          recommendedAction: 'Nothing to do. If your state requires the account to pay interest or to sit at an '
            + 'in-state bank, confirm those two details as well.',
          verifyWith: (rule && rule.authority) || 'your state attorney general or consumer protection office',
          confidence: 'high',
        };
      }

      if (how !== 'commingled') return null;

      // A city with its own stricter deposit regime counts as strict even where
      // the state has nothing. Chicago is the case this was written for: the
      // RLTO sets its own rules for holding, receipting and returning a
      // deposit, and reporting a commingled deposit there as a general
      // verify-locally note would rank the report's most expensive finding
      // below a permit question.
      const strict = !!(rule && rule.separate_account_required)
        || !!(cityRule && cityRule.stricter_than_state);
      const named = rule && rule.separate_account_required ? st.name : placeName(p);
      return {
        checkId: 'DEPOSIT_COMMINGLED',
        property: ctx.name,
        title: strict
          ? `${named} sets its own rules for holding a deposit, and yours is in a personal account`
          : 'Deposit is mixed in with your own money',
        severity: strict ? Severity.REQUIREMENT_UNMET : Severity.VERIFY_LOCALLY,
        evidence: strict
          ? evidenceFor(rule && rule.separate_account_required ? rule : cityRule)
          : EvidenceKind.OWNER_STATED,
        actionability: Actionability.ACT_NOW,
        basis: (strict
          ? (rule && rule.separate_account_required
            ? `${st.name} requires a residential security deposit to be held apart from the landlord's own funds. `
              + (rule.note ? `${rule.note} ` : '')
            : `${placeName(p)} sets its own rules for how a residential deposit is held, and they are stricter `
              + 'than the state\'s. ')
          : 'Most states regulate how a deposit is held, and holding one in a personal account is the most '
            + 'common way a landlord loses a deposit dispute they would otherwise have won. ')
          + 'You told us this deposit sits in a personal account. '
          + (cityRule && cityRule.note ? `${cityRule.note} ` : '')
          + 'The exposure here is not the deposit — it is that many deposit statutes attach a penalty '
          + 'to mishandling that is a multiple of the deposit itself, plus the tenant\'s legal costs.',
        recommendedAction: 'Open a separate account for tenant deposits this week and move them, then send each '
          + 'tenant written notice of where their deposit is held. Confirm with the office below whether your '
          + 'state also requires interest, a specific kind of bank, or a receipt within a set number of days.',
        verifyWith: (cityRule && cityRule.authority)
          || (rule && rule.authority)
          || 'your state attorney general or consumer protection office',
        confidence: strict
          ? confidenceOf(rule && rule.separate_account_required ? rule : cityRule)
          : 'check',
      };
    },
  },

  {
    id: 'PERMIT',
    label: 'permits for planned work',
    silentSkip: true,
    needs: (p) => !!String(p.planned_work || '').trim(),
    run: (p, ctx) => {
      const work = String(p.planned_work).trim();
      const built = year(p.year_built);
      const preLead = built !== null && built < 1978;
      return {
        checkId: 'PERMIT_PLANNED_WORK',
        property: ctx.name,
        title: `Planned work: ${work}`,
        severity: Severity.VERIFY_LOCALLY,
        evidence: EvidenceKind.OWNER_STATED,
        actionability: Actionability.CONFIRM_FIRST,
        basis: `You told us you are planning ${work} at this property. Whether that needs a permit is set by `
          + `the building department for ${placeName(p)} and turns on the scope, not the cost. `
          + (preLead
            ? `This unit predates 1978, so there is a second question on top of the permit: work that disturbs `
              + 'paint in pre-1978 housing generally has to be done by a contractor certified for lead-safe '
              + 'renovation, and using an uncertified one is the landlord\'s problem, not the contractor\'s.'
            : 'Unpermitted work tends to surface at the worst moment — at sale, at refinance, or when an '
              + 'insurer asks about it after a claim.'),
        recommendedAction: `Call the building department for ${placeName(p)} before you sign with a contractor, `
          + 'and ask two things: does this scope need a permit, and does the contractor need to pull it. '
          + (preLead
            ? 'Then ask any bidder for their lead-safe renovation certification in writing before you accept a quote.'
            : 'Get the permit number in writing from whoever pulls it.'),
        verifyWith: `the building or permits department for ${placeName(p)}`,
        confidence: 'high',
      };
    },
  },
];

// --- ranking ----------------------------------------------------------------

function rankFindings(findings) {
  return findings.slice().sort((a, b) => {
    const bySeverity = (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99);
    if (bySeverity !== 0) return bySeverity;
    // Within a severity, the soonest date first. A renewal fourteen days out
    // and one eighty days out are not the same errand.
    const aDays = Number.isFinite(a.daysOut) ? a.daysOut : Number.POSITIVE_INFINITY;
    const bDays = Number.isFinite(b.daysOut) ? b.daysOut : Number.POSITIVE_INFINITY;
    if (aDays !== bDays) return aDays - bDays;
    return String(a.property || '').localeCompare(String(b.property || ''));
  });
}

// --- portfolio-level observations -------------------------------------------

// One finding that is about the set rather than any member of it. A landlord
// running one lease template across three states is the single most common
// way a portfolio produces the same mistake three times.
function portfolioFindings(properties) {
  const states = [...new Set(properties.map((p) => normState(p.state)).filter(Boolean))];
  if (states.length < 2) return [];
  return [{
    checkId: 'PORTFOLIO_MULTI_STATE',
    property: null,
    title: `Your properties sit in ${states.length} states: ${states.join(', ')}`,
    severity: Severity.VERIFY_LOCALLY,
    evidence: EvidenceKind.OWNER_STATED,
    actionability: Actionability.BEFORE_NEXT_LEASE,
    basis: 'Notice periods, deposit handling, entry rules and disclosure duties are set state by state and '
      + 'sometimes city by city. A portfolio in more than one state cannot run on one lease template, and the '
      + 'failure mode is quiet: the template is correct where it was written and wrong everywhere else.',
    recommendedAction: 'Treat each state as its own lease. Where a finding in this report names a state office, '
      + 'that answer applies to the properties in that state only.',
    verifyWith: 'a landlord association in each state you hold property in',
    confidence: 'high',
  }];
}

// --- entry point ------------------------------------------------------------

function runLandlordAudit(input) {
  const properties = Array.isArray(input && input.properties) ? input.properties.filter(Boolean) : [];
  const asOf = parseDate(input && input.asOf) || new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');

  const findings = [];
  const skipped = [];
  const runnablePerProperty = CATALOG.filter((c) => !c.silentSkip).length;
  let checksRun = 0;

  properties.forEach((property, index) => {
    const ctx = { name: label(property, index), asOf };

    for (const entry of CATALOG) {
      let ok = false;
      try { ok = !!entry.needs(property); } catch (err) { ok = false; }
      if (!ok) {
        if (!entry.silentSkip) skipped.push(`${ctx.name}: ${entry.label}`);
        continue;
      }
      if (!entry.silentSkip) checksRun += 1;

      let result = null;
      try {
        result = entry.run(property, ctx);
      } catch (err) {
        // One malformed answer must not cost this landlord the other checks on
        // the other properties.
        if (!entry.silentSkip) {
          checksRun -= 1;
          skipped.push(`${ctx.name}: ${entry.label} (could not be run)`);
        }
        continue;
      }
      for (const finding of (Array.isArray(result) ? result : [result])) {
        if (finding) findings.push(finding);
      }
    }
  });

  findings.push(...portfolioFindings(properties));

  // Which jurisdictions we actually held something for. Reported as a pair,
  // never as a count, for the reason the closing scorecard names its gaps: a
  // landlord who is told "four checks passed" and not told that two of their
  // cities were uncovered has been told the wrong thing.
  const covered = [];
  const uncovered = [];
  for (const p of properties) {
    const where = placeName(p);
    if (cityEntry(p) || (stateEntry(p) && stateEntry(p).registration)) {
      if (!covered.includes(where)) covered.push(where);
    } else if (!uncovered.includes(where)) {
      uncovered.push(where);
    }
  }

  return {
    findings: rankFindings(findings),
    skipped,
    checksRun,
    checksTotal: runnablePerProperty * properties.length,
    propertyCount: properties.length,
    coverage: { covered, uncovered },
  };
}

module.exports = {
  runLandlordAudit,
  rankFindings,
  CATALOG,
  Severity,
  SEVERITY_ORDER,
  EvidenceKind,
  Actionability,
  _internal: { normCity, normState, cityEntry, stateEntry, parseDate, daysBetween, yesNo, year, label },
};
