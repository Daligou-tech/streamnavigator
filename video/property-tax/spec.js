// Copy and figures from /property-tax.html.
window.SPEC = { scenes: [
  { type: 'hook', dur: 3.4, eyebrow: 'Property Tax Navigator', text: "Find out if you're overpaying on property taxes.", accent: 'overpaying' },
  { type: 'compare', dur: 5.0, kicker: 'Example finding', verdict: 'Worth appealing', kind: 'flag',
    items: [['Assessed value', '$300,000', '$360,000'], ['At your own tax rate', '≈ $720 more annually']] },
  { type: 'calls', dur: 4.4, title: 'A verdict, not a guess.',
    items: [['Worth appealing', 'With the dollar impact at your own tax rate.', 'flag'], ['Likely justified', 'With the reasoning behind it.', 'hold'], ['Nothing to flag', 'An honest answer either way.', 'ok']] },
  { type: 'hook', dur: 3.6, text: "You can't appeal an assessment you never checked.", accent: 'never checked.' },
  { type: 'outro', dur: 3.4, product: 'Property Tax Navigator', tag: 'From address to appeal package.', url: 'streamnavigator.ai/property-tax', fine: '$79 per property, delivered in a couple of minutes.' },
] };
