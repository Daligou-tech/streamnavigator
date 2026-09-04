#!/usr/bin/env bash
#
# The full verification sequence, in one place.
#
# This used to live only inside .github/workflows/tests.yml, which meant there
# was no way to run what CI runs without pushing and waiting for an email. It is
# now called from three places — the workflow, `npm run ci`, and the Vercel
# ignored-build-step gate — so all three can never drift apart. Add a step here,
# not in the workflow.
#
# Does NOT install dependencies. The workflow installs with caching, the Vercel
# gate installs its own copy, and locally you already have node_modules.
#
set -euo pipefail

cd "$(dirname "$0")/.."

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# Every suite in tests/, not a filtered glob. The two styles of suite in there
# (node:test/TAP and the plain "N/N passed" ones) both run under this, and a
# filtered run is how seven suites once went unreported.
step "test suites"
npm test

# Parsing is not verifying. `escH is not a function` took the page down while
# the file parsed perfectly, so this executes the render path instead of just
# loading it. Not a .test.js file, so run-all.js does not pick it up on its own.
step "render check"
node tests/render-check.js

# Already-stale rows and collapsed coverage. The 30-day early warning runs on a
# schedule instead — see corpus-health.yml — so a push in December does not
# start failing for a reason unrelated to it.
step "corpus freshness"
node scripts/check-corpus-freshness.js --warn-days 0

# Every patch script is idempotent and refuses cleanly when already applied, so
# running them here is safe and answers a question that otherwise gets asked by
# hand: has this one actually been run? add-loan-calculations-schema.js sat
# unapplied for three iterations while seven checks stayed dark.
step "patch scripts are all applied"
for s in add-loan-calculations-schema fix-overpromises wire-document-service; do
  node "scripts/$s.js"
done

# A patch script that changed a tracked file means it had not been applied on
# main. Fail loudly rather than let the working tree silently differ from what
# is deployed. Skipped where there is no git checkout — the Vercel build
# container is not guaranteed to have one.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "::error::A patch script modified tracked files — it had not been applied on main:"
    git status --porcelain
    git --no-pager diff
    exit 1
  fi
fi

printf '\n\033[1mAll checks passed.\033[0m\n'
