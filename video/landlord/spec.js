// Copy from /landlord.html.
window.SPEC = { scenes: [
  { type: 'hook', dur: 3.6, eyebrow: 'Landlord Navigator', text: 'Find out what your rentals are actually required to do.', accent: 'actually required' },
  { type: 'checks', dur: 5.2, total: 10, label: 'checks, run against every property you enter',
    items: ['Registration and licensing', 'Registration renewal', 'Federal lead disclosure', 'A child under six in an older unit', 'State lead certification',
      'Periodic inspection programmes', 'Documents that must go with the lease', 'How the security deposit is held', 'Notice window before a lease ends', 'Permits for planned work'] },
  { type: 'calls', dur: 3.6, title: 'Every finding carries one of three.',
    items: [['Checked and fine', '', 'ok'], ['Likely — confirm first', '', 'hold'], ['Appears unmet', '', 'flag']] },
  { type: 'hook', dur: 4.0, text: 'Most landlords find out what they were required to do from the notice.', accent: 'from the notice.',
    lede: 'Ten minutes of answers is a cheaper way to find out.' },
  { type: 'outro', dur: 3.4, product: 'Landlord Navigator', tag: 'Checked property by property, city by city.', url: 'streamnavigator.ai/landlord', fine: '$149, once. Every property you own.' },
] };
