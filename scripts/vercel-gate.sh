#!/usr/bin/env bash
#
# Vercel "Ignored Build Step" gate. Wired up in vercel.json as `ignoreCommand`.
#
# Vercel's convention is inverted from a normal exit code:
#
#     exit 0  ->  IGNORE the build. Nothing deploys. The last good production
#                 deployment keeps serving.
#     exit 1  ->  CONTINUE with the build.
#
# So a failing test suite exits 0 here. That is not a typo.
#
# Why this exists: GitHub Actions cannot block a Vercel git deployment. Before
# this file, `tests` ran red on every push from run #1 to run #58 and every one
# of those commits deployed to production anyway. A red suite that still ships
# is a suite nobody has a reason to read.
#
# Failure modes are deliberately asymmetric:
#
#   - Tests fail            -> block the deploy. Bad code should not go live.
#   - npm ci fails          -> allow the deploy. A registry outage or a network
#                              blip is not evidence about this commit, and a
#                              gate that cannot install must not become an
#                              outage of its own.
#
# Escape hatch: set SKIP_TEST_GATE=1 as a Vercel environment variable to ship
# without the gate. Use it for a hotfix when the suite is red for an unrelated
# reason, and take it back out afterwards.
#
set -uo pipefail

cd "$(dirname "$0")/.."

if [ "${SKIP_TEST_GATE:-}" = "1" ]; then
  echo "SKIP_TEST_GATE=1 — deploying without running the suite."
  exit 1   # continue the build
fi

echo "Installing dependencies for the test gate..."
if ! npm ci --no-audit --no-fund; then
  echo "WARNING: npm ci failed. This says nothing about the commit, so the"
  echo "deploy is allowed through rather than blocked. Check the install logs."
  exit 1   # continue the build
fi

if bash scripts/ci.sh; then
  echo "Suite green — continuing with the build."
  exit 1   # continue the build
fi

echo ""
echo "=============================================================="
echo " BUILD BLOCKED — the test suite failed on this commit."
echo " Nothing was deployed. The previous production deployment is"
echo " still serving. Scroll up for the failing suite."
echo "=============================================================="
exit 0     # ignore the build
