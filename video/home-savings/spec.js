// Copy and figures from /home-savings.html.
window.SPEC = { scenes: [
  { type: 'hook', dur: 3.4, eyebrow: 'Home Savings Navigator', text: 'You are probably renting a modem you could own.', accent: 'renting a modem' },
  { type: 'ledger', dur: 4.6, eyebrow: 'Example bill',
    head: ['Internet — monthly statement', '$89.00/mo'],
    rows: [['Performance Pro 400', '$62.00'], ['Equipment rental — gateway', '$15.00', true], ['Inside wire maintenance', '$5.99', true], ['Broadcast TV fee', '$6.01']],
    foot: '$251.88 confirmed · promotion ends 30 Nov', footColor: 'ok' },
  { type: 'finding', dur: 4.4, eyebrow: 'A sample report',
    title: 'Stop renting the gateway from your internet provider', amt: '$180.00/yr',
    p: 'You pay $15 a month to rent it — $180 a year, every year, forever.',
    basis: 'Buying your own is a one-off of roughly $60–$160, so it pays for itself in 4–11 months.',
    cite: 'Check H1 · equipment rental line on your bill', pill: ['Confirmed', 'ok'] },
  { type: 'hook', dur: 3.8, text: 'Most households find two. Some find five.', accent: 'Some find five.', accentOk: true,
    lede: 'You will know which before you pay anything.' },
  { type: 'outro', dur: 3.6, product: 'Home Savings Navigator', tag: 'Free scorecard first. No bank login, ever.', url: 'streamnavigator.ai/home-savings', fine: '$49 for the full report, charged once.' },
] };
