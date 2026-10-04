// Copy and figures from /closing.html.
window.SPEC = { scenes: [
  { type: 'hook', dur: 3.6, eyebrow: 'Closing Disclosure Audit', text: 'Before you sign, know what you’re actually paying.', accent: 'actually paying.' },
  { type: 'ledger', dur: 4.8, eyebrow: 'Loan Estimate → Closing Disclosure',
    head: ['Section A — Origination', ''],
    rows: [['Processing fee', '$670 → $670'], ['Underwriting fee', '$995 → $1,295', true], ['Credit report', '$44 → $44']],
    note: 'Lender fees cannot increase without a documented changed circumstance.',
    foot: '$300.00 — possible post-closing refund', footColor: 'ok' },
  { type: 'checks', dur: 4.2, total: 28, label: 'named checks',
    items: ['Monthly payment amortises the stated loan terms', 'APR is not below the note rate', 'Finance charge covers the interest the payments produce',
      'Prepaid interest matches the per-diem and closing date', 'No charge appears twice under different names', 'Escrow cushion is within the RESPA limit',
      'No zero-tolerance charge increased', 'The 10% basket did not exceed its limit', 'The CD reflects the price, credits and dates you agreed'] },
  { type: 'finding', dur: 4.0, eyebrow: 'A sample report',
    title: 'Prepaid interest matches the per-diem and closing date — failed', amt: '$575.40',
    p: 'Section F bills 22 days. Your disbursement date leaves 8 days of interest to month end.',
    basis: '22 days × $41.10 = $904.20 charged. 8 days × $41.10 = $328.80 correct.',
    pill: ['Changeable now', 'ok'] },
  { type: 'outro', dur: 3.4, product: 'Closing Disclosure Audit', tag: 'Free scorecard first.', url: 'streamnavigator.ai/closing', fine: '$59 per closing audited.' },
] };
