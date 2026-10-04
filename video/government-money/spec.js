// Copy and figures from /government-money.html.
window.SPEC = { scenes: [
  { type: 'hook', dur: 3.8, eyebrow: 'Government Money Finder', text: 'Which rebates and credits actually apply to you — and which don’t.', accent: 'actually apply to you', accentOk: true },
  { type: 'ledger', dur: 4.4, eyebrow: 'One line, as it appears',
    head: ['Your shortlist', ''], rows: [['Federal efficiency credit — heat pumps', 'on your list']],
    noteLabel: 'Why you.', noteKind: 'ok', note: 'You own your home and told us a heat pump was installed.',
    foot: '2 on the shortlist · 5 to confirm · 21 ruled out', footColor: 'ok' },
  { type: 'calls', dur: 3.8, title: 'Twenty-eight programs, checked against your household.',
    items: [['2', 'on the shortlist', 'ok'], ['5', 'to confirm', 'hold'], ['21', 'ruled out, each with its reason', 'flag']] },
  { type: 'finding', dur: 4.2, eyebrow: 'A sample report',
    title: 'Ruled out: renter’s property tax relief', amt: '',
    p: 'You told us you own. This one is for renters.',
    basis: 'Named rather than quietly dropped, so you can see it was considered.',
    cite: 'Ruled out by: tenure', pill: ['not for you', 'flag'] },
  { type: 'outro', dur: 3.4, product: 'Government Money Finder', tag: 'Nine questions. A free scorecard.', url: 'streamnavigator.ai/government-money', fine: '$39 for the full report. We hold no current amounts and never state one.' },
] };
