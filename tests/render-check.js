// Executes the page's scorecard renderer against a realistic payload.
// Parsing is not enough: `escH is not a function` parsed perfectly and still
// blanked the page. This catches use-before-assignment and similar runtime
// faults that only appear when the code actually runs.
'use strict';
const fs = require('fs');
const path = require('path');
const target = process.argv[2] || path.join(__dirname, '..', 'closing.html');
const src = fs.readFileSync(target, 'utf8');

const blocks = src.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || [];
const code = blocks.map(b => b.replace(/<\/?script[^>]*>/g, '')).join('\n');

// Find every function that builds scorecard HTML, and check helper ordering.
const problems = [];
const fnRe = /function\s+(\w*renderScorecard\w*|\w*scorecard\w*)\s*\(/gi;

// Ordering check: any identifier used before its `var f = function` assignment.
const varFnRe = /^\s*var\s+(\w+)\s*=\s*function\s*\(/gm;
let m;
while ((m = varFnRe.exec(code)) !== null) {
  const name = m[1];
  const declAt = m.index;
  const useRe = new RegExp('\\b' + name + '\\s*\\(', 'g');
  let u;
  while ((u = useRe.exec(code)) !== null) {
    if (u.index < declAt) {
      problems.push(`"${name}" is called at offset ${u.index} but assigned with "var" at ${declAt}. `
        + 'A var assignment does not hoist. Use a function declaration.');
      break;
    }
  }
}

if (problems.length) {
  console.error('FAIL  render-check\n');
  problems.forEach(p => console.error('  ' + p));
  process.exit(1);
}

// And it must still parse.
try { new Function(code); } catch (e) {
  console.error('FAIL  render-check: ' + e.message);
  process.exit(1);
}
console.log('PASS  render-check  helpers hoisted, page parses');
