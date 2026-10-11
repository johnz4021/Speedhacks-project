#!/usr/bin/env bash
# Make a throwaway git repo from the core fixture (mirrors Scout's layout) for running the server/shell.
# Usage: scripts/sandbox.sh [dir] [--no-map]   → prints the dir; then HARNESS_REPO=<dir> npm run dev
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dir="${1:-${TMPDIR:-/tmp}/harness-sandbox}"
rm -rf "$dir" && mkdir -p "$dir"
cp -R "$here/packages/core/test/fixture-repo/." "$dir/"
[[ "${2:-}" == "--no-map" ]] || cp "$here/fixtures/scout-agent.domains.yaml" "$dir/domains.yaml"
cd "$dir"
git init -q && git add -A && git -c user.email=sandbox@harness -c user.name=sandbox commit -qm "sandbox: scout fixture"
echo "$dir"
