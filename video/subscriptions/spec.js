// Copy and figures from /subscriptions.html.
window.SPEC = { scenes: [
  { type: 'hook', dur: 3.4, eyebrow: 'Subscription Navigator', text: 'You are paying for something you stopped using.', accent: 'stopped using.' },
  { type: 'ledger', dur: 4.4, eyebrow: 'Example list',
    head: ['Your subscriptions', '11 lines · $104.91/mo'],
    rows: [['Hulu — cancel', '$227.88/yr', true], ['Peacock — rotate, back 15 Aug', '$15.98'], ['Adobe CC — keep until 14 Mar', '$0']],
    foot: '$227.88 confirmed · $15.98 conditional', footColor: 'ok' },
  { type: 'calls', dur: 4.2, title: 'One call on every line.',
    items: [['Downgrade', 'You want it. You do not want this tier.', 'hold'], ['Rotate', 'Off now, back on a named date.', 'ok'], ['Cancel', 'Stop paying. Coming back means signing up again.', 'flag'], ['Review', 'The decision is not ours to make. We say why.', '']] },
  { type: 'finding', dur: 4.4, eyebrow: 'A sample report',
    title: 'Keep Adobe Creative Cloud until 14 March', amt: '$0 today',
    p: 'You have used it twice. On the numbers this is the worst line on the page — and cancelling it today would still be a mistake.',
    basis: 'This is an annual plan you have already paid for. The decision on 14 March is worth $719.88 a year; today’s is worth nothing.',
    cite: 'Rule R1 · prepaid annual plan, mid-term' },
  { type: 'outro', dur: 3.4, product: 'Subscription Navigator', tag: 'Free scorecard first. No bank login, ever.', url: 'streamnavigator.ai/subscriptions', fine: '$29 for the full report, charged once.' },
] };
