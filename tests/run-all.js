#!/usr/bin/env node
// Run every suite. Exit non-zero if any fails.
// Wire into vercel.json buildCommand so a broken audit fails the deploy.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const suites = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();
let failed = 0;

for (const s of suites) {
  process.stdout.write(s.padEnd(34));
  try {
    process.stdout.write(execFileSync('node', [path.join(dir, s)], { encoding: 'utf8' }));
  } catch (err) {
    failed += 1;
    process.stdout.write('FAILED\n');
    process.stdout.write((err.stdout || '') + (err.stderr || ''));
  }
}

if (failed) {
  console.error(`\n${failed} suite(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${suites.length} suites passed.`);
