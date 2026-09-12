'use strict';

// What last year's findings did.
//
// The audit of 2026-09-10 graded Landlord Navigator 0 of 5 on confirming a
// result, and the reasoning was exact: the product knew what it found and never
// learned what it was worth. A finding saying "Seattle requires RRIO and you
// are not enrolled" is a claim about a thing the landlord will or will not do,
// and nothing ever went back to see which.
//
// This closes them out on a re-run, from the answers the landlord gives the
// second time — not by asking "did you do it?", which would be easier and worth
// nothing, because somebody who meant to call the city and never did ticks the
// box either way. It asks them the same intake questions and reads the
// difference.
//
// Two rules hold the whole thing up, both borrowed from
// api/_lib/rental-outcomes.js, and both exist to stop it flattering us:
//
//   ABSENCE OF EVIDENCE IS NEVER RESOLUTION. Every resolver declares the field
//   it needs and returns "not testable" without it, naming the question that
//   would close it. A landlord who answers less this time must never be told
//   their problems went away.
//
//   ONLY THE OWNER'S OWN ANSWER RESOLVES. Nothing here consults the reference
//   set. "You are now registered" is a fact the landlord asserted; the report
//   says so in those words rather than implying we checked with the city.

const { _internal: { yesNo, parseDate, year, label } } = require('./landlord-audit');

const Outcome = {
  RESOLVED: 'resolved',
  IMPROVED: 'improved',
  STILL_OPEN: 'still_open',
  NOT_TESTABLE: 'not_testable',
};

// Matching a finding to the property it belongs to, across two separate
// submissions. The label the landlord typed is the only stable handle they
// control, so it is tried first; city+state catches the ones they never named.
function propertyIndex(properties) {
  const byName = new Map();
  (properties || []).forEach((p, i) => {
    const name = label(p, i);
    byName.set(name.toLowerCase(), p);
    const where = [p.city, p.state].filter(Boolean).join(', ').toLowerCase();
    if (where && !byName.has(where)) byName.set(where, p);
  });
  return byName;
}

// One resolver per finding we are willing to close. A checkId absent from here
// is reported as not testable rather than quietly dropped — a finding that
// disappears between two reports reads as solved.
const RESOLVERS = {
  REGISTRATION_MISSING: {
    needs: 'whether this property is registered',
    run: (now) => {
      const held = yesNo(now.registered);
      if (held === null) return null;
      return held
        ? { outcome: Outcome.RESOLVED, note: 'You told us this property is now registered.' }
        : { outcome: Outcome.STILL_OPEN, note: 'Still not registered on your own answer.' };
    },
  },
  REGISTRATION_UNKNOWN: {
    needs: 'whether this property is registered',
    run: (now) => {
      const held = yesNo(now.registered);
      if (held === null) return null;
      return held
        ? { outcome: Outcome.RESOLVED, note: 'You confirmed the registration this time.' }
        : { outcome: Outcome.STILL_OPEN, note: 'You have now confirmed it is not registered.' };
    },
  },
  REGISTRATION_EXPIRED: {
    needs: 'the current registration expiry date',
    run: (now, before) => {
      const next = parseDate(now.registration_expires);
      const prev = parseDate(before.registration_expires);
      if (!next) return null;
      if (prev && next.getTime() > prev.getTime()) {
        return { outcome: Outcome.RESOLVED, note: `Renewed — the expiry moved to ${now.registration_expires.slice(0, 10)}.` };
      }
      return { outcome: Outcome.STILL_OPEN, note: 'The expiry date has not moved.' };
    },
  },
  REGISTRATION_DUE_SOON: {
    needs: 'the current registration expiry date',
    run: (now, before) => RESOLVERS.REGISTRATION_EXPIRED.run(now, before),
  },
  LEAD_DISCLOSURE_MISSING: {
    needs: 'whether a signed lead disclosure is on file',
    run: (now) => {
      const onFile = yesNo(now.lead_disclosure_on_file);
      if (onFile === null) return null;
      return onFile
        ? { outcome: Outcome.RESOLVED, note: 'A signed disclosure is now on file — keep it for three years and repeat it at each new lease.' }
        : { outcome: Outcome.STILL_OPEN, note: 'Still no signed disclosure on file. This is the cheapest item on the report to close.' };
    },
  },
  DEPOSIT_COMMINGLED: {
    needs: 'how the security deposit is held',
    run: (now) => {
      const how = String(now.deposit_held || '');
      if (!how) return null;
      if (how === 'separate') {
        return { outcome: Outcome.RESOLVED, note: 'The deposit is now held in its own account.' };
      }
      if (how === 'none') {
        return { outcome: Outcome.RESOLVED, note: 'You no longer hold a deposit on this property.' };
      }
      return { outcome: Outcome.STILL_OPEN, note: 'The deposit is still in a personal account.' };
    },
  },
  LEASE_NOTICE_WINDOW: {
    needs: 'the current lease end date',
    run: (now, before) => {
      const next = parseDate(now.lease_ends);
      const prev = parseDate(before.lease_ends);
      if (!next) return null;
      if (prev && next.getTime() > prev.getTime()) {
        return { outcome: Outcome.RESOLVED, note: `The lease now runs to ${now.lease_ends.slice(0, 10)} — the decision was made.` };
      }
      return { outcome: Outcome.STILL_OPEN, note: 'The lease end date has not moved.' };
    },
  },
  LEAD_CHILD_STATE_REGIME: {
    needs: 'whether a child under six still lives there',
    run: (now) => {
      const child = yesNo(now.child_under_six);
      if (child === null) return null;
      if (child === false) {
        return {
          outcome: Outcome.IMPROVED,
          // Deliberately not "resolved". The duty attaches to the unit, and a
          // different family with a small child can move in next month.
          note: 'No child under six lives there now, which lowers the exposure — it does not remove '
            + 'the duty, which comes back with the next young family.',
        };
      }
      return { outcome: Outcome.STILL_OPEN, note: 'A child under six still lives in a pre-1978 unit.' };
    },
  },
};

// A prior finding whose property is gone from this submission. Sold, or simply
// not entered again — either way it is not evidence of anything.
function droppedProperty(finding) {
  return {
    checkId: finding.checkId,
    property: finding.property,
    title: finding.title,
    outcome: Outcome.NOT_TESTABLE,
    note: 'This property is not in this year\'s submission, so nothing here can speak to it. '
      + 'Add it again to have it checked.',
  };
}

function runLandlordOutcomes(priorFindings, currentProperties) {
  const findings = Array.isArray(priorFindings) ? priorFindings : [];
  const properties = Array.isArray(currentProperties) ? currentProperties : [];
  const index = propertyIndex(properties);
  const outcomes = [];

  for (const finding of findings) {
    if (!finding || !finding.checkId) continue;
    const name = String(finding.property || '').toLowerCase();
    const now = name ? index.get(name) : null;

    if (!now) { outcomes.push(droppedProperty(finding)); continue; }

    const resolver = RESOLVERS[finding.checkId];
    if (!resolver) {
      outcomes.push({
        checkId: finding.checkId,
        property: finding.property,
        title: finding.title,
        outcome: Outcome.NOT_TESTABLE,
        note: 'This one cannot be settled from the intake answers — check it against the office named in your report.',
      });
      continue;
    }

    const before = finding.answers || {};
    let result = null;
    try { result = resolver.run(now, before); } catch (err) { result = null; }

    if (!result) {
      outcomes.push({
        checkId: finding.checkId,
        property: finding.property,
        title: finding.title,
        outcome: Outcome.NOT_TESTABLE,
        note: `You left ${resolver.needs} blank this time, so this cannot be closed out. `
          + 'Answering it is what settles this row.',
      });
      continue;
    }

    outcomes.push({
      checkId: finding.checkId,
      property: finding.property,
      title: finding.title,
      outcome: result.outcome,
      note: result.note,
    });
  }

  const count = (o) => outcomes.filter((x) => x.outcome === o).length;
  return {
    outcomes,
    resolved: count(Outcome.RESOLVED),
    improved: count(Outcome.IMPROVED),
    stillOpen: count(Outcome.STILL_OPEN),
    notTestable: count(Outcome.NOT_TESTABLE),
  };
}

module.exports = { runLandlordOutcomes, Outcome, RESOLVERS };
