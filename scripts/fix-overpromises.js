#!/usr/bin/env node
// Removes overpromises and vague quantifiers from the customer-facing copy, and
// adds the pre-payment coverage disclosure.
//
// The headline said: "We audit every charge against state and county rate
// schedules." With a corpus that holds Maryland transfer taxes and HMDA
// distributions, that sentence is false for every charge in every state we do
// not hold, which is most of them. It is the kind of promise that produces
// refund requests from customers who read it literally and were right to.
//
// Every replacement below either narrows a claim to what the corpus can
// actually support, or replaces a vague quantifier with a real number.
//
// Run from the repo root:
//   node scripts/fix-overpromises.js --dry-run
//   node scripts/fix-overpromises.js

'use strict';

const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry-run');
// The scorecard renderer this patch edits moved out of closing.html when the
// scorecard got its own URL. The patch itself is unchanged; only its target
// moved. Left pointing at closing.html, it reported "run wire-document-service
// first" on a tree where everything was already applied.
const TARGET = path.join(process.cwd(), 'closing-scorecard-view.js');
const MARKER = 'benchmark_coverage';

const EDITS = [
  {
    what: 'meta description: "audit every charge against rate schedules" -> what we actually do',
    from: '<meta name="description" content="Upload your Closing Disclosure. We audit every charge against state and county rate schedules, escrow and per-diem rules, and the arithmetic on the document itself — and find errors, overcharges, and fees your lender may need to correct before you close. $29–$59." />',
    to: '<meta name="description" content="Upload your Closing Disclosure. We check its arithmetic, its escrow and per-diem calculations, and — with your Loan Estimate — whether any fee rose beyond what the lending rules permit. Where we hold a published rate or comparison data for your county we say so; where we do not, we tell you which charges that applies to before you pay." />',
  },
  {
    what: 'hero subheading: same overpromise, plus "what it should be" for every charge',
    from: '<p class="sub">Upload your Closing Disclosure and get a free scorecard. We audit every charge against county and state rate schedules, escrow and per-diem rules, and the arithmetic on the document itself — then tell you what looks wrong, what it should be, and exactly what to ask for.</p>',
    to: '<p class="sub">Upload your Closing Disclosure and get a free scorecard. We recheck the document\'s own arithmetic, its escrow and per-diem calculations, and every figure in the Loan Calculations box. Add your Loan Estimate and we test whether any fee rose beyond what the lending rules permit. Before you pay anything, we name the charges we cannot price for your county.</p>',
  },
  {
    what: 'feature list: "what it should be" promised for every charge',
    from: '<li><span class="tick">✓</span> What each charge is, what it should be, and the schedule, rate filing, or rule we measured it against</li>',
    to: '<li><span class="tick">✓</span> What each finding is, the arithmetic, rule, published rate or comparison data behind it, and what to ask your lender</li>',
  },
  {
    what: 'vague: "several of your charges" -> name the sections',
    from: 'This decides which tolerance rule applies to several of your charges. If no written list was given, fees you might assume were flexible are often held to a stricter standard.',
    to: 'This decides which tolerance rule applies to the services in Section C of your Closing Disclosure. Without a written list, your lender cannot rely on the shopping exception, and those charges are tested at zero tolerance instead — meaning any increase over your Loan Estimate may be refundable.',
  },
  {
    what: 'FAQ: "cannot benchmark" jargon -> named categories',
    from: 'You will be told plainly. The free scorecard shows you the count before you pay anything, so you are never buying a report to find out there was nothing in it. Where we lack reliable data to judge a fee, we say "cannot benchmark" rather than guessing.',
    to: 'You will be told plainly. The free scorecard shows you the count before you pay anything, so you are never buying a report to find out there was nothing in it. It also names the exact charges we cannot price for your county — by name, not as a number — so you know what is and is not covered before you decide.',
  },
  {
    what: 'product description: "published rate schedules where we hold them" is vague about which',
    from: '<p class="desc">An independent audit of your Closing Disclosure against lending rules, its own arithmetic, and published rate schedules where we hold them — before you sign.</p>',
    to: '<p class="desc">An independent recheck of your Closing Disclosure: its own arithmetic, the federal lending rules, and — for the charges where we hold county data — a published rate or what comparable loans actually paid. The scorecard names which is which before you pay.</p>',
  },
];

// The pre-payment disclosure block, inserted after the evidence-basis note the
// wiring patch already added.
const DISCLOSURE_ANCHOR = `    if (sc.evidence_basis) {
      html += '<p class="scorecard-note"><strong>What we checked against:</strong> '
        + escH(sc.evidence_basis) + '</p>';
    }`;

const DISCLOSURE_INSERT = DISCLOSURE_ANCHOR + `

    // Named before payment. A customer must not buy a report to find out that
    // her title insurance was never priced.
    if (sc.benchmark_coverage) {
      var bc = sc.benchmark_coverage;
      html += '<div class="scorecard-coverage">';
      if (bc.priced_sentence) {
        html += '<p class="scorecard-note"><strong>Priced against a published rate:</strong> '
          + escH(bc.priced_sentence) + '</p>';
      }
      if (bc.distribution_sentence) {
        html += '<p class="scorecard-note"><strong>Compared to what other loans paid:</strong> '
          + escH(bc.distribution_sentence) + '</p>';
      }
      if (bc.not_priced_sentence) {
        html += '<p class="scorecard-note scorecard-note-gap"><strong>Not priced'
          + (bc.jurisdiction ? ' in ' + escH(bc.jurisdiction) : '') + ':</strong> '
          + escH(bc.not_priced_sentence) + '</p>';
      }
      html += '</div>';
    }`;

function main() {
  if (!fs.existsSync(TARGET)) {
    fail('closing-scorecard-view.js not found. Run this from the repository root.');
  }
  const src = fs.readFileSync(TARGET, 'utf8');

  if (src.includes(MARKER)) {
    console.log('Already applied (found "benchmark_coverage"). Nothing to do.');
    return;
  }
  if (!src.includes(DISCLOSURE_ANCHOR)) {
    fail('The evidence-basis block was not found.\n'
      + '  Run scripts/wire-document-service.js first — this patch builds on it.');
  }

  let out = src;
  const applied = [];
  const notFound = [];

  for (const e of EDITS) {
    const n = out.split(e.from).length - 1;
    if (n === 0) { notFound.push(e.what); continue; }
    if (n > 1) fail(`Ambiguous anchor (${n} matches) for: ${e.what}`);
    out = out.replace(e.from, e.to);
    applied.push(e.what);
  }

  out = out.replace(DISCLOSURE_ANCHOR, DISCLOSURE_INSERT);
  applied.push('pre-payment coverage disclosure block');

  // A copy patch that silently half-applies is worse than one that refuses:
  // the page would keep whichever overpromise did not match.
  if (notFound.length) {
    console.error('Refusing to patch. These lines have changed and were NOT found:\n');
    notFound.forEach((w) => console.error('  - ' + w));
    console.error('\nNothing was written. Fix these by hand or send me the current file.');
    process.exit(1);
  }

  if (DRY) {
    console.log(`Would apply ${applied.length} copy edits:`);
    applied.forEach((w) => console.log('  - ' + w));
    return;
  }

  fs.writeFileSync(TARGET + '.copy.bak', src);
  fs.writeFileSync(TARGET, out);
  console.log(`closing.html: ${applied.length} copy edits applied.`);
  applied.forEach((w) => console.log('  - ' + w));
  console.log('\nBackup at closing.html.copy.bak');
}

function fail(msg) {
  console.error('Refusing to patch.\n\n  ' + msg);
  process.exit(1);
}

main();
