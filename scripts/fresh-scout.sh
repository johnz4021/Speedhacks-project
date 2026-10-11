#!/usr/bin/env bash
# A fresh, disposable copy of Scout for one harness session.
#
# The original (../scout-agent) is never touched: each run clones it at a tag
# (default demo-start) into ../scout-run, so whatever the session changes
# (code, domains.yaml, decisions/, .harness/, the database) is thrown away next time.
#
# Usage: scripts/fresh-scout.sh [--map] [--with-data] [--keep] [--offline]
#   --map        start from fixtures/scout-agent.domains.yaml (skip the cartographer)
#   --with-data  copy the original's database (its runs and notes) instead of seeding a fresh one
#   --keep       keep the previous run as ../scout-run-<time> instead of deleting it
#   --offline    seed the offline sample companies instead of the live ones
#   --take N     give the copy its own Alike repository: origin https://github.com/johnz4021/scout-agent-takeN.git
#                (pushing disabled), so each recording take (and each baseline) starts with no decisions in Alike.
#                Without it the copy's origin is johnz4021/scout-agent, matching HARNESS_REPO_SLUG's default.
#
# Environment: SCOUT_SRC (original), SCOUT_RUN_DIR (copy), SCOUT_REF (tag or commit), SCOUT_PORT (default 8788)
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
src="$(cd "${SCOUT_SRC:-$here/../scout-agent}" && pwd)"
dest="${SCOUT_RUN_DIR:-$(dirname "$src")/scout-run}"
ref="${SCOUT_REF:-demo-start}"
port="${SCOUT_PORT:-8788}"

map=0 with_data=0 keep=0 mode="live" take=""
while (( $# )); do
  case "$1" in
    --map) map=1 ;;
    --with-data) with_data=1 ;;
    --keep) keep=1 ;;
    --offline) mode="offline" ;;
    --take) shift; take="${1:?--take needs a value}" ;;
    --take=*) take="${1#--take=}" ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
slug="johnz4021/scout-agent${take:+-take$take}"

[[ "$dest" != "$src" ]] || { echo "refusing: the run directory is the original" >&2; exit 1; }
git -C "$src" rev-parse -q --verify "$ref^{commit}" >/dev/null || { echo "no $ref in $src" >&2; exit 1; }

# Copy-on-write where the filesystem supports it (APFS, btrfs), plain copy otherwise.
clone_path() {
  [[ -e "$1" ]] || return 0
  mkdir -p "$(dirname "$2")"
  cp -cR "$1" "$2" 2>/dev/null || cp -R --reflink=auto "$1" "$2" 2>/dev/null || cp -R "$1" "$2"
}

# Stop anything still serving the previous copy.
if pids="$(lsof -ti "tcp:$port" 2>/dev/null)" && [[ -n "$pids" ]]; then
  echo "stopping the process on :$port"
  kill $pids 2>/dev/null || true
  sleep 1
fi

if [[ -d "$dest" ]]; then
  if (( keep )); then
    mv "$dest" "$dest-$(date +%Y%m%d-%H%M%S)"
  else
    rm -rf "$dest"
  fi
fi

echo "cloning $src @ $ref -> $dest"
git clone -q "$src" "$dest"
git -C "$dest" checkout -q -B session "$ref"
# Alike's hooks identify a repository by its origin remote (owner/name, lowercased), so the copy gets one that
# matches HARNESS_REPO_SLUG. Pushing is disabled: nothing in the session can push anywhere.
git -C "$dest" remote set-url origin "https://github.com/$slug.git"
git -C "$dest" remote set-url --push origin no-push

# Things git doesn't carry: dependencies, the API key, the SEC cache, the built web app.
clone_path "$src/node_modules" "$dest/node_modules"
clone_path "$src/.env" "$dest/.env"
clone_path "$src/.scout/cache" "$dest/.scout/cache"
clone_path "$src/web/dist" "$dest/web/dist"

cd "$dest"
if (( with_data )) && [[ -d "$src/.scout/pgdata" ]]; then
  if lsof -ti tcp:8787 >/dev/null 2>&1; then
    echo "note: something is running on :8787; if it's the original Scout, stop it first so its database is copied cleanly"
  fi
  clone_path "$src/.scout/pgdata" "$dest/.scout/pgdata"
  echo "copied the original's database"
else
  SCOUT_MODE="$mode" npm run --silent seed
fi
[[ -d web/dist ]] || npm run --silent build >/dev/null

if (( map )); then
  cp "$here/fixtures/scout-agent.domains.yaml" domains.yaml
  git add domains.yaml
  git -c user.name="Interpretability" -c user.email="interpretability@localhost" commit -qm "chore: add domains map"
  echo "added domains.yaml from fixtures"
fi

cat <<EOF

Fresh Scout at $dest (branch "session" at $ref; the original is untouched).

  Interpretability:  cd $here && HARNESS_REPO=$dest HARNESS_REPO_SLUG=$slug npm run dev
  Scout:    cd $dest && PORT=$port npm run dev:api      # app + API on http://localhost:$port, reloads server code

Run this script again for a clean slate. The web app is served prebuilt; after the agent edits web/, run "npm run build" in the copy.
EOF
