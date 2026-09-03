#!/usr/bin/env node
// Runs every suite in this folder and reports them one line each.
//
// The folder holds two styles: the pre-existing suites use node:test and emit
// TAP, the newer ones print "N/N passed". Both run under plain `node`, so this
// runner just normalises the output rather than caring which is which.
//
// Failures print their detail; passes print one line. Dumping 114 TAP blocks
// for a suite that passed buries the one that did not.
//
// Run: node tests/run-all.js
//      node tests/run-all.js --verbose     show output for passing suites too
//      node tests/run-all.js closing       run only suites matching "closing"

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const filter = argv.find((a) => !a.startsWith('--'));

const suites = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (!suites.length) {
  console.error(filter ? `No suite matches "${filter}".` : 'No .test.js files found.');
  process.exit(1);
}

function summarise(output) {
  const plain = output.match(/(\d+)\/(\d+) passed/);
  if (plain) return `${plain[1]}/${plain[2]} passed`;
  const pass = output.match(/^# pass (\d+)/m);
  const fail = output.match(/^# fail (\d+)/m);
  if (pass) {
    const p = Number(pass[1]);
    const f = fail ? Number(fail[1]) : 0;
    return `${p}/${p + f} passed`;
  }
  return 'completed';
}

const failed = [];
let ran = 0;

for (const s of suites) {
  let output = '';
  let ok = true;
  try {
    output = execFileSync('node', [path.join(dir, s)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
    });
  } catch (err) {
    ok = false;
    output = (err.stdout || '') + (err.stderr || '');
  }
  ran += 1;

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${s.padEnd(40)} ${summarise(output)}`);

  if (!ok) {
    failed.push(s);
    const lines = output.split('\n');
    const marks = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /^not ok \d+ - /.test(l) || /^\s+x /.test(l));
    if (marks.length) {
      for (const { l, i } of marks.slice(0, 10)) {
        console.log('        ' + l.trim());
        const detail = lines.slice(i + 1, i + 12)
          .find((x) => /Expected|AssertionError|Error:/.test(x));
        if (detail) console.log('          ' + detail.trim().slice(0, 160));
      }
      if (marks.length > 10) console.log(`        ...and ${marks.length - 10} more`);
    } else {
      console.log(output.split('\n').slice(-15).map((l) => '        ' + l).join('\n'));
    }
  } else if (verbose) {
    console.log(output.split('\n').map((l) => '        ' + l).join('\n'));
  }
}

console.log('');
if (failed.length) {
  console.error(`${failed.length} of ${ran} suites failed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`All ${ran} suites passed.`);
