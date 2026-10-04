// Copy and figures from /insurance.html.
window.SPEC = { scenes: [
  { type: 'hook', dur: 3.4, eyebrow: 'Insurance Navigator', text: 'Check your renewal before you accept it.', accent: 'before you accept it.' },
  { type: 'compare', dur: 5.0, kicker: 'Example finding', verdict: 'Worth challenging', kind: 'flag',
    items: [['Dwelling coverage', '$340,000', '$310,000'], ['Premium', '$2,000', '$2,300']] },
  { type: 'hook', dur: 3.8, text: 'Renewals auto-approve if you do nothing.', accent: 'do nothing.', lede: 'Spend two minutes checking first.' },
  { type: 'calls', dur: 4.0, title: 'Compared line by line against your old policy.',
    items: [['Premium', '', ''], ['Limits', '', 'hold'], ['Deductibles', '', 'flag'], ['Coverage', '', 'ok']] },
  { type: 'outro', dur: 3.4, product: 'Insurance Navigator', tag: 'Auto, home, renters, umbrella.', url: 'streamnavigator.ai/insurance', fine: '$79 per renewal.' },
] };
