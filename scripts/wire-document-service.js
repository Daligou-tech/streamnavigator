#!/usr/bin/env node
// Switches the live endpoints over to the document-only service.
//
// Three files, three small edits:
//   api/closing-scorecard.js  source findings and the scorecard from runDocumentAudit
//   api/closing-answers.js    same, on the re-run after the two questions
//   closing.html              replace the benchmark coverage copy with check coverage
//
// A patch rather than replacement files: all three are ahead of main in your
// working copy, and handing you whole files would discard those edits.
//
// Safe to run twice. Verifies every anchor first and writes nothing unless all
// of them are found. Backups are written as <file>.bak.
//
// Run from the repo root:
//   node scripts/wire-document-service.js --dry-run
//   node scripts/wire-document-service.js

'use strict';

const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry-run');
const root = process.cwd();

// ---------------------------------------------------------------------------
// edits
// ---------------------------------------------------------------------------

const EDITS = [
  {
    file: 'api/closing-scorecard.js',
    marker: 'runDocumentAudit',
    replacements: [
      {
        what: 'import the service',
        from: "const { checkScorecardRateLimit, hashIp, clientIp } = require('./_lib/rate-limit');",
        to: "const { checkScorecardRateLimit, hashIp, clientIp } = require('./_lib/rate-limit');\n"
          + "const { runDocumentAudit } = require('./_lib/closing-service');",
      },
      {
        what: 'run the document-only audit',
        from: "  const { findings, skipped } = runClosingAudit(extraction, { answers, loanEstimates, contractTerms });",
        to:
`  // The document-only service. It runs the same engine with benchmarking
  // absent rather than merely disabled, adds the page 5 loan-math checks, and
  // returns a scorecard whose denominator is CHECKS rather than fees with rate
  // data. The tier it computes is ignored here: the block below already has
  // richer downgrade reasons because it can see which uploads were unusable.
  const audited = runDocumentAudit({
    extraction,
    answers,
    loanEstimates,
    contractTerms,
    unusableDocuments: [
      ...(leIndexes.length && !loanEstimates ? ['loan_estimate'] : []),
      ...(contractIndexes.length && !contractTerms ? ['purchase_contract'] : []),
    ],
  });
  const { findings, skipped } = audited;`,
      },
      {
        what: 'use the service scorecard as the base',
        from: "    ...buildScorecard(extraction, findings, skipped),\n    tier: effectiveTier,",
        to: "    ...audited.scorecard,\n    coverage_by_group: audited.coverage_by_group,\n    tier: effectiveTier,",
      },
    ],
  },

  {
    file: 'api/closing-answers.js',
    marker: 'runDocumentAudit',
    replacements: [
      {
        what: 'import the service',
        from: "const { runClosingAudit, buildScorecard } = require('./_lib/closing-extract');",
        to: "const { runClosingAudit, buildScorecard } = require('./_lib/closing-extract');\n"
          + "const { runDocumentAudit } = require('./_lib/closing-service');",
      },
      {
        what: 're-run through the service',
        from:
`      const { findings, skipped } = runClosingAudit(formData.extraction, {
        answers,
        loanEstimates: formData.loan_estimates || null,
        contractTerms: formData.contract_terms || null,
      });
      refreshed = {
        // Preserve the fields the scorecard endpoint computed that the audit
        // does not produce (tier, tolerance flags, mismatch detail).
        ...(formData.scorecard || {}),
        ...buildScorecard(formData.extraction, findings, skipped),
      };`,
        to:
`      const audited = runDocumentAudit({
        extraction: formData.extraction,
        answers,
        loanEstimates: formData.loan_estimates || null,
        contractTerms: formData.contract_terms || null,
      });
      refreshed = {
        // Preserve the fields the scorecard endpoint computed that the audit
        // does not produce (tier, tolerance flags, mismatch detail).
        ...(formData.scorecard || {}),
        ...audited.scorecard,
        coverage_by_group: audited.coverage_by_group,
      };`,
      },
    ],
  },

  {
    file: 'closing.html',
    marker: 'checks_blocked',
    replacements: [
      {
        what: 'replace the rate-data row with a checks-run row',
        from:
`    if (sc.cannot_benchmark_count) {
      rows.push(['Fees we have no rate data for',
        sc.benchmarkable_count
          ? sc.cannot_benchmark_count + ' of ' + sc.benchmarkable_count
          : String(sc.cannot_benchmark_count)]);
    }`,
        to:
`    // Checks, not fees. "10 of 14 fees, no rate data" measured a corpus we do
    // not claim to have, and its denominator was never reachable. This one is.
    if (sc.checks_total) {
      rows.push(['Checks run', sc.checks_run + ' of ' + sc.checks_total]);
    }
    if (sc.checks_blocked) {
      rows.push(['Checks needing another document', String(sc.checks_blocked)]);
    }`,
      },
      {
        what: 'replace the rate-data note with the evidence basis and unlocks',
        from:
`    if (sc.cannot_benchmark_count) {
      html += '<p class="scorecard-note"><strong>On the rate data:</strong> we only tell you a fee is '
        + 'high when we can show you the schedule or filing we measured it against. For '
        + sc.cannot_benchmark_count + ' of your fees we do not yet hold reliable data for this '
        + 'jurisdiction, so we say so rather than guessing. Those fees are still checked for '
        + 'duplication, arithmetic and internal consistency.</p>';
    }`,
        to:
`    // Self-contained escaper: these strings are server-side constants today,
    // but a future unlock could carry a filename and this file builds HTML by
    // string concatenation.
    var escH = function (v) {
      return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    };

    if (sc.evidence_basis) {
      html += '<p class="scorecard-note"><strong>What we checked against:</strong> '
        + escH(sc.evidence_basis) + '</p>';
    }

    // Every blocked check names a document the page can accept, so none of
    // these is a dead end.
    if (sc.unlocks && sc.unlocks.length) {
      html += '<div class="scorecard-unlocks">';
      for (var ui = 0; ui < sc.unlocks.length; ui++) {
        var u = sc.unlocks[ui];
        html += '<p class="scorecard-note"><strong>' + escH(u.title) + '</strong> — unlocks '
          + u.unlocks_count + (u.unlocks_count === 1 ? ' check. ' : ' checks. ')
          + escH(u.why) + '</p>';
      }
      html += '</div>';
    }`,
      },
    ],
  },
];

// ---------------------------------------------------------------------------

function main() {
  const results = [];

  // Pass 1: verify everything before writing anything.
  for (const edit of EDITS) {
    const full = path.join(root, edit.file);
    if (!fs.existsSync(full)) {
      fail(`Not found: ${edit.file}. Run this from the repository root.`);
    }
    const src = fs.readFileSync(full, 'utf8');

    if (src.includes(edit.marker)) {
      results.push({ edit, src, patched: null, skip: true });
      continue;
    }

    let out = src;
    for (const r of edit.replacements) {
      const count = out.split(r.from).length - 1;
      if (count === 0) {
        fail(`${edit.file}: could not find the anchor for "${r.what}".\n`
          + '  The file has moved on from what this patch expects. Nothing was written.');
      }
      if (count > 1) {
        fail(`${edit.file}: the anchor for "${r.what}" appears ${count} times. `
          + 'Placement is ambiguous. Nothing was written.');
      }
      out = out.replace(r.from, r.to);
    }

    if (edit.file.endsWith('.js')) {
      try {
        // eslint-disable-next-line no-new-func
        new Function(out);
      } catch (err) {
        fail(`${edit.file}: the patched result would not parse — ${err.message}. Nothing was written.`);
      }
    }

    results.push({ edit, src, patched: out, skip: false });
  }

  // The inserted block declares its own escaper. Guard against a collision if
  // the page later grows one with the same name in the same scope.
  const html = results.find((r) => r.edit.file === 'closing.html');
  if (html && !html.skip && /\bvar escH\b|\bfunction escH\b/.test(html.src)) {
    fail('closing.html: an escH already exists and the patch declares one. Nothing was written.');
  }

  // Pass 2: write.
  for (const r of results) {
    if (r.skip) {
      console.log(`${r.edit.file}: already wired (found "${r.edit.marker}"). Skipped.`);
      continue;
    }
    if (DRY) {
      const delta = r.patched.split('\n').length - r.src.split('\n').length;
      console.log(`${r.edit.file}: would apply ${r.edit.replacements.length} edits (${delta >= 0 ? '+' : ''}${delta} lines)`);
      r.edit.replacements.forEach((x) => console.log(`    - ${x.what}`));
      continue;
    }
    const full = path.join(root, r.edit.file);
    fs.writeFileSync(full + '.bak', r.src);
    fs.writeFileSync(full, r.patched);
    console.log(`${r.edit.file}: patched (${r.edit.replacements.length} edits). Backup at ${r.edit.file}.bak`);
  }

  if (!DRY) console.log('\nNext: node test/run-all.js');
}

function fail(msg) {
  console.error('Refusing to patch.\n');
  console.error('  ' + msg);
  process.exit(1);
}

main();
