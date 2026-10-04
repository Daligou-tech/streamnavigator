// Copy from /buying.html.
window.SPEC = { scenes: [
  { type: 'hook', dur: 3.2, eyebrow: 'Purchase Navigator', text: 'What the deal actually costs you.', accent: 'actually costs you.' },
  { type: 'hook', dur: 3.2, text: 'The sticker price is never the real price.', accent: 'never' },
  { type: 'checks', dur: 5.4, total: 6, label: 'parts to every report',
    items: ['True total cost of ownership, not just the purchase price', 'Financing cost impact if you’re not paying cash', 'Expected maintenance and running costs over time',
      'Depreciation or resale-value expectations', 'How at least one realistic alternative compares', 'A clear buy/wait/reconsider recommendation'] },
  { type: 'calls', dur: 4.2, title: 'Based on the math, not on encouraging a purchase.',
    items: [['Buy', '', 'ok'], ['Wait', '', 'hold'], ['Reconsider', '', 'flag']] },
  { type: 'outro', dur: 3.6, product: 'Purchase Navigator', tag: 'Vehicles, major appliances, big-ticket items.', url: 'streamnavigator.ai/buying', fine: '$29 per report. Not charged until we can deliver it.' },
] };
