// Works out which videos a commit range needs re-rendered, for the videos
// GitHub Action. Prints JSON: { render: [names], stale: [names] }.
//
//   node video/changed.js <base-sha> <head-sha>     changes between two commits
//   node video/changed.js --pages all|name,name     a hand-picked list
//
// render: the video's own script changed, or the shared engine did.
// stale:  the page changed but its video script did not. The videos hold
//         their own copy of the page's words, so re-rendering would change
//         nothing; these are listed so someone updates the script.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// video name -> the page it is made from
const PAGES = {
  index: 'index.html', streaming: 'streaming.html', contractor: 'contractor.html',
  'property-tax': 'property-tax.html', 'home-savings': 'home-savings.html',
  subscriptions: 'subscriptions.html', 'government-money': 'government-money.html',
  'home-maintenance': 'home-maintenance.html', landlord: 'landlord.html',
  insurance: 'insurance.html', buying: 'buying.html', rental: 'rental.html',
  hoa: 'hoa.html', closing: 'closing.html',
};
const ALL = Object.keys(PAGES);
const SHARED = /^video\/(engine\/|fonts\/|render\.js|synth\.js|build\.sh)/;

const args = process.argv.slice(2);
let render = [], stale = [];

if (args[0] === '--pages') {
  const want = (args[1] || 'all').trim();
  render = want === 'all' ? ALL : want.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = render.filter((n) => !PAGES[n]);
  if (bad.length) { console.error('Unknown video: ' + bad.join(', ') + '. Known: ' + ALL.join(', ')); process.exit(1); }
} else {
  const [base, head] = args;
  const valid = base && !/^0+$/.test(base) &&
    (() => { try { execSync(`git cat-file -e ${base}^{commit}`, { stdio: 'ignore' }); return true; } catch { return false; } })();
  // A new branch or a force-push has no usable base; fall back to the last commit.
  const range = valid ? `${base} ${head}` : `${head}~1 ${head}`;
  const files = execSync(`git diff --name-only ${range}`, { encoding: 'utf8' }).split('\n').filter(Boolean);
  if (files.some((f) => SHARED.test(f))) render = ALL;
  else render = ALL.filter((n) => files.some((f) => f.startsWith(`video/${n}/`)));
  stale = ALL.filter((n) => !render.includes(n) && files.includes(PAGES[n]));
}

render = render.filter((n) => fs.existsSync(path.join(__dirname, n)));
console.log(JSON.stringify({ render, stale }));
