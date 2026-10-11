#!/usr/bin/env bash
# One command for a session against Scout: a fresh copy of Scout, Scout's app on :8788,
# and the harness (:4310 server, :5173 shell) pointed at the copy.
#
# Usage: npm run demo [-- options]
#   --no-map    let the cartographer propose the map (default: start from fixtures/scout-agent.domains.yaml)
#   --replace   stop what is already running first (Interpretability on :4310 / :5173, Scout on :8788);
#               without it, the script refuses to touch a running session
#   --take N    a separate Alike repository for this take (johnz4021/scout-agent-takeN); see fresh-scout.sh
#   --reuse     start on the existing copy as it is (e.g. at a checkpoint) instead of making a fresh one
#   --scout-only  start only Scout's app, without Interpretability (for plain Claude Code takes)
#   --with-data, --keep, --offline   passed to scripts/fresh-scout.sh
#
# Ctrl+C stops everything. Run it again for a clean slate; the original ../scout-agent is never touched.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
src="$(cd "${SCOUT_SRC:-$here/../scout-agent}" && pwd)"
run_dir="${SCOUT_RUN_DIR:-$(dirname "$src")/scout-run}"
port="${SCOUT_PORT:-8788}"
slug="${HARNESS_REPO_SLUG:-johnz4021/scout-agent}"

map="--map" replace=0 reuse=0 scout_only=0 pass=()
while (( $# )); do
  case "$1" in
    --no-map) map="" ;;
    --replace) replace=1 ;;
    --reuse) reuse=1 ;;
    --scout-only) scout_only=1 ;;
    --take) shift; take="${1:?--take needs a value}"; pass+=(--take "$take") ;;
    --take=*) take="${1#--take=}"; pass+=(--take "$take") ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) pass+=("$1") ;;
  esac
  shift
done
[[ -z "${take:-}" ]] || slug="johnz4021/scout-agent-take$take"

listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true; }

# Never stop a running session unless asked: a live Interpretability or Scout may be mid-take on this copy.
busy=""
for p in 4310 5173 "$port"; do [[ -n "$(listening "$p")" ]] && busy="$busy :$p"; done
if [[ -n "$busy" ]]; then
  if (( replace )); then
    echo "stopping what is running on$busy"
    for p in 4310 5173 "$port"; do pids="$(listening "$p")"; [[ -z "$pids" ]] || kill $pids 2>/dev/null || true; done
    sleep 1
  else
    echo "Already running on$busy (Interpretability and/or Scout, maybe mid-take)." >&2
    echo "Stop it, or add --replace to stop it for you." >&2
    exit 1
  fi
fi

if (( reuse )); then
  [[ -d "$run_dir/.git" ]] || { echo "no copy at $run_dir to reuse; run npm run demo first" >&2; exit 1; }
  echo "reusing $run_dir as it is ($(git -C "$run_dir" log -1 --format='%h %s'))"
else
  SCOUT_RUN_DIR="$run_dir" SCOUT_PORT="$port" "$here/scripts/fresh-scout.sh" ${map:+"$map"} ${pass[@]+"${pass[@]}"} >/dev/null
  echo "fresh Scout ready at $run_dir (from demo-start)"
fi
echo "  Scout app  http://localhost:$port"
(( scout_only )) || echo "  Interpretability    http://localhost:5173"
echo

if (( scout_only )); then
  echo "Interpretability is not running: edits in this copy go unobserved."
  cd "$run_dir"
  exec env PORT="$port" npm run --silent dev:api
fi

cd "$here"
exec npx concurrently -k -n scout,harness -c green,blue \
  "cd '$run_dir' && PORT=$port npm run --silent dev:api" \
  "HARNESS_REPO='$run_dir' HARNESS_REPO_SLUG='$slug' npm run dev"
