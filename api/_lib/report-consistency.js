// Does the report contradict itself?
//
// Written out of docs/REPORT-CONSISTENCY-AUDIT.md, which audited the shipped
// Closing and HOA reports figure by figure and set out the thing to build:
//
//   A product that COMPUTES its numbers cannot contradict itself. A product
//   that asks a model for them will, and no amount of checking fully fixes
//   that. Every fix that stuck moved a quantity to having one home and
//   computed the rest.
//
// So this module does two different jobs, and the order matters. It DERIVES
// the quantities that are derivable — overwriting whatever the model wrote,
// because the arithmetic is ours and there is nothing to negotiate — and it
// CHECKS the prose around them, because prose cannot be derived and a figure
// invented there reaches the customer exactly as if it had been audited.
//
// The six contradiction classes the audit names, and where each is handled:
//
//   1  a total contradicting its own parts      derived, never asked for
//   2  one quantity stated twice, differently   checked against the known set
//   3  a figure contradicting its own section   checked against the known set
//   4  a fact asserted from memory              structural: Closing's findings
//                                               are computed and HOA's carry
//                                               API citations; enforced here
//                                               by refusing an uncited finding
//   5  a required field satisfied emptily       repaired from the engine's own
//                                               record of what it could not do
//   6  research advertised but not performed    tests/claims.test.js, plus the
//                                               citation rule for class 4
//
// Nothing here throws and nothing here withholds a customer's report. A report
// that fails a check is still a report: the problems are logged, recorded on
// the stored row for the next audit to read, and — where the fix is
// unambiguous — applied.

'use strict';

const { figuresIn, proseFigureMatches, point } = require('./money-text');

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// walking a report's prose
// ---------------------------------------------------------------------------

// Every string a customer actually reads, each with a label, so a problem can
// name where it is rather than merely that it exists.
//
// closing_body is deliberately absent. It holds the letters, which are
// assembled in code from the audit's own figures (api/_lib/closing-emails.js)
// and are not the model's writing — checking them would be checking our own
// arithmetic against itself. Their being assembled is also the fix for the
// audit's one real defect: there were once TWO copies of those letters, one
// assembled and one written by the model, differing in subject, tone and
// wording, and the customer signed their name to whichever one they opened.
function prosePieces(report) {
  const out = [];
  const push = (label, value) => {
    if (typeof value === 'string' && value.trim()) out.push({ label, text: value });
  };

  push('the headline', report.headline);
  push('the summary', report.summary);
  push('the risk rationale', report.risk_rationale);

  (report.key_numbers || []).forEach((kn, i) => {
    if (!kn) return;
    push(`key number ${i + 1} (${kn.label || 'unlabelled'})`, kn.value);
  });

  (report.sections || []).forEach((s, i) => {
    if (!s) return;
    const title = s.title || `section ${i + 1}`;
    (Array.isArray(s.items) ? s.items : []).forEach((item, j) => {
      push(`"${title}", point ${j + 1}`, item);
    });
  });

  (report.findings || []).forEach((f, i) => {
    if (!f) return;
    push(`finding ${i + 1} (${f.concern || f.title || 'untitled'})`, f.detail);
  });

  for (const key of ['short_term_risk', 'mid_term_risk']) {
    const block = report[key];
    if (!block) continue;
    const label = key === 'short_term_risk' ? 'the 12-month risk' : 'the 1-5 year risk';
    push(`${label} rationale`, block.rationale);
    push(`${label} basis`, block.basis);
  }

  if (report.reserve_health) push('the reserve assessment', report.reserve_health.assessment);

  (report.missing_or_uncertain || []).forEach((m, i) => push(`missing/uncertain ${i + 1}`, m));

  return out;
}

// ---------------------------------------------------------------------------
// closing
// ---------------------------------------------------------------------------

// Every dollar quantity the audit established, as { low, high } points. This is
// the set the write-up is allowed to contain. The prompt has always said so —
// "never state a dollar figure that is not present in the findings you were
// given" — and until now nothing checked whether it had.
function knownClosingFigures({ findings = [], extraction = null, totalImpact = null }) {
  const known = [];
  const add = (n) => { const p = point(n); if (p && p.low !== 0) known.push(p); };

  for (const f of findings) {
    if (!f) continue;
    add(f.charged);
    add(f.expected);
    add(f.variance);
    add(f.dollarImpact);
    // detail carries the working — a per-diem, a permitted cushion, a monthly
    // payment. Those get quoted in the write-up and are legitimately ours.
    for (const v of Object.values(f.detail || {})) add(v);
  }

  add(totalImpact);

  if (extraction) {
    add(extraction.loan_amount);
    add(extraction.purchase_price);
    const amt = (o) => (o && isNum(o.value) ? o.value : null);
    add(amt(extraction.monthly_principal_interest));
    for (const v of Object.values(extraction.loan_calculations || {})) {
      add(isNum(v) ? v : amt(v));
    }
    for (const v of Object.values(extraction.section_totals || {})) add(amt(v));
    for (const v of Object.values(extraction.cash_to_close || {})) add(amt(v));
    for (const li of extraction.line_items || []) add(li && li.amount);
    for (const p of extraction.prorations || []) add(p && p.amount);
    for (const c of extraction.seller_credits_on_cd || []) add(c && c.amount);
  }

  return known;
}

// What the audit says this document costs the buyer, added up. Computed, never
// asked for — this is contradiction class 1, and once the total is derived the
// only way a headline can disagree with the findings beneath it is if something
// other than the findings produced it.
function totalDollarImpact(findings) {
  const total = (findings || [])
    .filter((f) => f && isNum(f.dollarImpact) && f.severity !== 'within_norms')
    .reduce((sum, f) => sum + f.dollarImpact, 0);
  return round2(total);
}

// Below this, chasing a figure costs more attention than the figure is worth.
// It also keeps page numbers, day counts and percentages that happen to carry a
// dollar sign out of the stream.
const TRIVIAL = 50;

function checkClosingConsistency({ report, findings = [], extraction = null }) {
  const problems = [];
  if (!report) return { problems, totalImpact: 0, known: [] };

  const totalImpact = totalDollarImpact(findings);
  const known = knownClosingFigures({ findings, extraction, totalImpact });

  for (const piece of prosePieces(report)) {
    for (const fig of figuresIn(piece.text, { signed: true })) {
      const magnitude = Math.max(Math.abs(fig.value.low), Math.abs(fig.value.high));
      if (magnitude < TRIVIAL) continue;
      if (known.some((k) => proseFigureMatches(fig.value, k))) continue;
      // The sign is read but not policed. A report may legitimately describe a
      // $412.33 overcharge as "-$412.33 to you", so a figure that matches once
      // flipped is the same figure, not an invention.
      const flipped = { low: -fig.value.high, high: -fig.value.low };
      if (known.some((k) => proseFigureMatches(flipped, k))) continue;
      problems.push({
        class: 'originated_figure',
        where: piece.label,
        figure: fig.raw.trim(),
        message: `${piece.label} states ${fig.raw.trim()}, which is not any figure the audit computed.`,
      });
    }
  }

  return { problems, totalImpact, known };
}

// ---------------------------------------------------------------------------
// hoa
// ---------------------------------------------------------------------------

const PERCENT_RE = /(\d+(?:\.\d+)?)\s*%/;

function firstMoney(value) {
  const found = figuresIn(String(value == null ? '' : value), { signed: true });
  return found.length ? found[0].value : null;
}

function firstPercent(value) {
  const m = PERCENT_RE.exec(String(value == null ? '' : value));
  return m ? Number(m[1]) : null;
}

// Percent funded is the reserve balance over the fully funded balance. The HOA
// engine runs that as real Python through the code-execution tool, which is why
// the audit found all twenty-one figures reconciling — but the result still
// arrives as a STRING the model typed, and a string typed out of a correct
// calculation is one transcription away from a wrong one. Where both inputs are
// present the figure is recomputed here and the string replaced, so the
// quantity has one home rather than two that happen to agree.
//
// Returns what changed, for the caller to log and the tests to assert on.
function deriveHoaReserveFigures(report) {
  const changes = [];
  const rh = report && report.reserve_health;
  if (!rh) return changes;

  const balance = firstMoney(rh.reserve_balance);
  const fully = firstMoney(rh.fully_funded_balance);
  if (!balance || !fully || fully.low <= 0) return changes;

  const computed = (balance.low / fully.low) * 100;
  const rounded = computed >= 10 ? Math.round(computed) : round2(computed);
  const stated = firstPercent(rh.percent_funded);

  // Half a point of disagreement is rounding, not a contradiction.
  if (stated !== null && Math.abs(stated - computed) <= 0.55) return changes;

  const replacement = `${rounded}%`;
  changes.push({
    field: 'reserve_health.percent_funded',
    from: rh.percent_funded,
    to: replacement,
    basis: `${rh.reserve_balance} / ${rh.fully_funded_balance}`,
  });
  rh.percent_funded = replacement;

  // And anywhere the header repeats it, so the two cannot disagree on screen.
  for (const kn of report.key_numbers || []) {
    if (!kn || !/funded/i.test(String(kn.label))) continue;
    const knStated = firstPercent(kn.value);
    if (knStated === null || Math.abs(knStated - computed) <= 0.55) continue;
    changes.push({ field: `key_numbers[${kn.label}]`, from: kn.value, to: replacement });
    kn.value = replacement;
  }

  return changes;
}

function checkHoaConsistency({ report }) {
  const problems = [];
  if (!report) return { problems };

  for (const key of ['short_term_risk', 'mid_term_risk']) {
    const block = report[key];
    if (!block) continue;
    const low = firstMoney(block.estimated_per_unit_low);
    const high = firstMoney(block.estimated_per_unit_high);
    if (low && high && low.low > high.high) {
      problems.push({
        class: 'range_inverted',
        where: key,
        message: `${key} estimates ${block.estimated_per_unit_low} to ${block.estimated_per_unit_high}, which runs backwards.`,
      });
    }
    // An estimate with no basis is class 4 — a figure asserted rather than
    // worked out. The schema requires the field to exist; this requires it to
    // say something.
    if ((low || high) && !String(block.basis || '').trim()) {
      problems.push({
        class: 'unexplained_estimate',
        where: key,
        message: `${key} carries a per-unit estimate with no basis stated.`,
      });
    }
  }

  const rh = report.reserve_health || {};
  const balance = firstMoney(rh.reserve_balance);
  const fully = firstMoney(rh.fully_funded_balance);
  if (balance && fully && fully.low > 0) {
    const computed = (balance.low / fully.low) * 100;
    const stated = firstPercent(rh.percent_funded);
    if (stated !== null && Math.abs(stated - computed) > 0.55) {
      problems.push({
        class: 'derived_figure_disagrees',
        where: 'reserve_health.percent_funded',
        message: `percent funded reads ${rh.percent_funded} but ${rh.reserve_balance} over ${rh.fully_funded_balance} is ${round2(computed)}%.`,
      });
    }
  }

  // hoa.html promises that every finding cites the page it came from. A finding
  // that arrives with no valid citation has not met that promise, and shipping
  // it beside four that did is the honesty defect the audit calls class 6.
  //
  // An uncited finding that demoteUncitedFindings() has already moved below the
  // cited ones and marked is NOT that. It has been handled: it sits at the end
  // of the list, it is labelled on the page as drawn from the analysis rather
  // than quoted, and the reader is told to check it. Reporting it here anyway
  // put a permanent warning in the logs of every report that has one — and a
  // warning that always fires is one nobody reads, which is the failure the
  // offline harness had for months with its rental fixture.
  //
  // What this must still catch is a finding with no citation that nothing
  // marked: either the demotion did not run, or it ran before something else
  // added a finding.
  (report.findings || []).forEach((f, i) => {
    if (!f || f.uncited === true) return;
    const cites = Array.isArray(f.citations) ? f.citations.filter(Boolean) : [];
    if (!cites.length) {
      problems.push({
        class: 'uncited_finding',
        where: `finding ${i + 1}`,
        message: `"${f.concern || 'untitled'}" carries no citation and was not marked as uncited, `
          + 'so it reads on the page exactly like the findings that are sourced.',
      });
    }
  });

  return { problems };
}

// ---------------------------------------------------------------------------
// class 5 — a required field satisfied emptily
// ---------------------------------------------------------------------------

// missing_or_uncertain is required by both schemas and both descriptions say to
// use an empty array only when there is genuinely nothing to flag. On /buying
// the identical instruction produced `assumptions: []` under a seven-year total
// whose every input was assumed. An instruction is not a mechanism.
//
// The engine already knows what it could not do — which checks were skipped,
// which uploads were unreadable, which documents were never provided. Where the
// write-up left the field empty anyway, it is filled from that, in the engine's
// own words rather than the model's.
function seedMissingOrUncertain(report, candidates) {
  const existing = Array.isArray(report.missing_or_uncertain)
    ? report.missing_or_uncertain.filter((s) => typeof s === 'string' && s.trim())
    : [];
  const wanted = (candidates || []).filter((s) => typeof s === 'string' && s.trim());
  if (!wanted.length) {
    report.missing_or_uncertain = existing;
    return [];
  }

  // Matched on a prefix rather than in full: the model routinely says the same
  // thing in its own words, and appending a near-duplicate reads as padding.
  const seen = existing.map((s) => s.toLowerCase());
  const added = wanted.filter((s) => {
    const probe = s.toLowerCase().slice(0, 40);
    return !seen.some((e) => e.includes(probe));
  });
  report.missing_or_uncertain = existing.concat(added);
  return added;
}

module.exports = {
  prosePieces,
  knownClosingFigures,
  totalDollarImpact,
  checkClosingConsistency,
  deriveHoaReserveFigures,
  checkHoaConsistency,
  seedMissingOrUncertain,
  __internal: { firstMoney, firstPercent, TRIVIAL },
};
