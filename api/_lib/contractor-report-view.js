'use strict';

// One contractor report, rendered into the generic shape the PDF builder and
// the emailed copy already understand.
//
// api/_lib/pdf-report.js renders headline / summary / key_numbers / sections /
// missing_or_uncertain / emails, which is what every other product produces.
// Contractor produces a richer structure — ranked findings, each with its
// evidence kind, its citation and the figure it rests on — and the web page
// renders that structure directly.
//
// Rather than teach the PDF builder a second vocabulary, or flatten the
// findings at generation time and lose the structure the page needs, the
// conversion happens here, once, on the way out. Same words in both places,
// which is the thing docs/REPORT-CONSISTENCY-AUDIT.md exists about.

const { Severity, Actionability } = require('./contractor-audit');

const SEVERITY_HEADING = {
  [Severity.CONFIRMED_ERROR]: 'Arithmetic errors on the estimate itself',
  [Severity.EXCEEDS_LEGAL_LIMIT]: 'Above a legal limit, or below a legal minimum',
  [Severity.MISSING_PROTECTION]: 'Protections missing from the contract',
  [Severity.OUTSIDE_PUBLISHED_RANGE]: 'Price against published national ranges',
  [Severity.QUOTE_SPREAD]: 'Your quotes, side by side',
  [Severity.CHANGE_ORDER_RISK]: 'What could become a change order',
  [Severity.SALES_PRESSURE]: 'Sales practice and stale claims',
  [Severity.VERIFY_YOURSELF]: 'For you to verify',
  [Severity.WITHIN_NORMS]: 'Checks that ran and passed',
};

// The order sections appear in, which is the severity order the audit already
// ranked by. Listed explicitly so a new severity cannot silently land at the
// bottom of the PDF because nobody updated a sort.
const SECTION_ORDER = [
  Severity.CONFIRMED_ERROR,
  Severity.EXCEEDS_LEGAL_LIMIT,
  Severity.MISSING_PROTECTION,
  Severity.OUTSIDE_PUBLISHED_RANGE,
  Severity.QUOTE_SPREAD,
  Severity.CHANGE_ORDER_RISK,
  Severity.SALES_PRESSURE,
  Severity.VERIFY_YOURSELF,
  Severity.WITHIN_NORMS,
];

const ACTION_LABEL = {
  [Actionability.BEFORE_SIGNING]: 'Before you sign',
  [Actionability.BEFORE_WORK_STARTS]: 'Before work starts',
  [Actionability.VERIFY]: 'Verify yourself',
  [Actionability.ALREADY_SIGNED]: 'If you have already signed',
  [Actionability.NONE]: null,
};

function money(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// One finding as the flat lines the PDF prints. The title carries the money and
// the timing, because a reader skimming a PDF sees titles and nothing else.
function renderFinding(finding) {
  const lines = [];
  const amount = money(finding.dollarImpact);
  const timing = ACTION_LABEL[finding.actionability];
  const head = [
    finding.title,
    amount ? `— ${amount}` : null,
    timing ? `[${timing}]` : null,
  ].filter(Boolean).join(' ');

  lines.push(head);
  if (finding.basis) lines.push(`   ${finding.basis}`);
  if (finding.recommendedAction) lines.push(`   What to do: ${finding.recommendedAction}`);
  if (finding.citation) lines.push(`   Source: ${finding.citation}`);
  return lines.join('\n');
}

// The headline figures. Deliberately few: a homeowner deciding whether to sign
// needs the coverage count, the money in dispute, and the price of the job.
// Everything else is in the findings.
function keyNumbers(report) {
  const out = [];
  const coverage = report.coverage || {};
  out.push({
    label: 'Checks run',
    value: `${coverage.checks_run} of ${coverage.checks_total} that apply to a ${report.category} estimate`,
  });

  const quotes = (report.quotes || []).filter((q) => Number.isFinite(Number(q.total_price)));
  if (quotes.length === 1) {
    out.push({ label: 'Contract price', value: money(quotes[0].total_price) });
  } else if (quotes.length > 1) {
    const prices = quotes.map((q) => Number(q.total_price));
    out.push({
      label: `${quotes.length} quotes`,
      value: `${money(Math.min(...prices))} to ${money(Math.max(...prices))}`,
    });
  }

  // Only the findings whose figure is a discrepancy or a statutory overage.
  // A published-range distance is not money anyone owes anyone and must not be
  // summed into a headline that implies it is.
  const disputed = (report.findings || [])
    .filter((f) => f.impactKind === 'arithmetic_discrepancy' || f.impactKind === 'amount_above_a_statutory_cap')
    .reduce((s, f) => s + (Number(f.dollarImpact) || 0), 0);
  if (disputed > 0) {
    out.push({ label: 'Arithmetic and statutory difference', value: money(disputed) });
  }

  return out;
}

function toGenericReportShape(report) {
  const r = report || {};
  const findings = Array.isArray(r.findings) ? r.findings : [];
  const sections = [];

  if (Array.isArray(r.do_first) && r.do_first.length) {
    sections.push({
      title: 'Do these first',
      items: r.do_first.map((s, i) => `${i + 1}. ${s}`),
    });
  }

  for (const severity of SECTION_ORDER) {
    const mine = findings.filter((f) => f.severity === severity);
    if (!mine.length) continue;
    // The passed checks are listed by title alone. Their basis is the figure
    // that satisfied them, which matters on screen where it is one click away
    // and turns a PDF into forty paragraphs of things that were fine.
    const items = severity === Severity.WITHIN_NORMS
      ? mine.map((f) => `${f.title}${f.basis ? ` — ${f.basis}` : ''}`)
      : mine.map(renderFinding);
    sections.push({ title: SEVERITY_HEADING[severity] || severity, items });
  }

  const quotes = (r.quotes || []);
  if (quotes.length) {
    sections.push({
      title: 'Estimates read',
      items: quotes.map((q) => [
        q.label,
        q.contractor_name ? `— ${q.contractor_name}` : null,
        money(q.total_price) ? `— ${money(q.total_price)}` : null,
        q.license_number ? `— licence ${q.license_number}` : null,
      ].filter(Boolean).join(' ')),
    });
  }

  const couldNotRun = (r.coverage && r.coverage.could_not_run) || [];
  const unreadable = r.unreadable || [];

  return {
    headline: r.headline || 'Your contractor estimate report',
    headline_tag: r.category ? `${r.category} estimate` : null,
    summary: r.summary || '',
    key_numbers: keyNumbers(r),
    sections,
    missing_or_uncertain: unreadable.concat(couldNotRun),
    // The PDF builder takes letters as named keys or as a list; the contractor
    // emails are already a list, one per contractor with something to ask.
    emails: Array.isArray(r.emails) ? r.emails.map((e) => ({
      who: e.to || e.quote,
      email: { to: e.to, subject: e.subject, body: e.body },
    })) : [],
  };
}

module.exports = {
  toGenericReportShape,
  SEVERITY_HEADING,
  SECTION_ORDER,
  _internal: { renderFinding, keyNumbers, money },
};
