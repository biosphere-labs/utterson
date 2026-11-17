#!/usr/bin/env bash
# Release check: clone the repo fresh at a tag, install, test and build, exactly as a consumer or a new machine would.
# Catches what a long-lived checkout hides (stale node_modules, a file missing from git).
#   scripts/clean-check.sh main
set -euo pipefail
tag="${1:?usage: scripts/clean-check.sh TAG}"
dir="$(cd "$(dirname "$0")/.." && pwd)/temp/clean-check-$tag"
rm -rf "$dir"
gh repo clone biosphere-labs/utterson "$dir" -- -q
cd "$dir"
git checkout -q "$tag"
npm install --silent
npm test 2>&1 | grep -E "^ℹ (pass|fail)"
if npm test 2>&1 | grep -qE "^ℹ fail [1-9]"; then echo "clean check FAILED at $tag"; exit 1; fi
npm run build --silent
test -f dist/index.js && test -f dist/sandbox/child.mjs
echo "clean check passed at $tag"
