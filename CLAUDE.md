# Interpretability

A diagram-first shell around real Claude Code: chat on the left, a live domain × layer map of the target repo on the right, and a gate that makes the agent ask before it crosses an architecture rule. **Read `SPEC.md` before starting**, and follow its build order (§13), starting with the verification step.

## Rules

- **No model calls in the hot path.** Hooks, the mapper, the import parser and the rule checker must be deterministic and fast. The only model call Interpretability makes itself is the cartographer, and it never blocks the coding session.
- **UI state is a pure reduction of the event log** (`packages/core/src/events.ts`). Don't keep separate mutable state for footprint, ghosts, ledger or replay.
- **The rule checker is one function with three call sites** (load scan, `submit_plan`, edit hook). Don't fork its logic.
- **Interpretability writes to the target repo only** in `domains.yaml`, `decisions/` and `.harness/`. Product code in the target is edited only by the coding session.
- **Don't guess Agent SDK APIs.** Check https://code.claude.com/docs/en/agent-sdk/typescript and https://code.claude.com/docs/en/agent-sdk/hooks.
- TypeScript strict. `packages/core` has vitest tests for the mapper, import parser, write scanner, checker, plan mapping and ledger, all against `fixtures/scout-agent.domains.yaml`.
- Local only: no auth, no deployment, no database.

## Commands

```
npm i
npm run demo                               # fresh copy of Scout + Scout's app (:8788) + harness (server :4310, shell :5173)
HARNESS_REPO=<path> npm run dev            # harness against any other repo; scripts/sandbox.sh makes a fixture one
npm test                                   # packages/core
```

## Running against Scout

- **`../scout-agent` is the original and stays untouched.** It is pinned at the git tag `demo-start`. Never set `HARNESS_REPO` to it and never edit it during harness or demo work: the harness writes `domains.yaml`, `decisions/` and `.harness/` into its target, and the coding session edits product code there.
- **`npm run demo`** (`scripts/demo.sh`) runs every session against a disposable copy:
  1. `scripts/fresh-scout.sh` clones `demo-start` into `../scout-run`, on a branch with no remote. It carries over `node_modules`, `.env` and the SEC cache, seeds a fresh database, and adds `domains.yaml` from `fixtures/`.
  2. It starts Scout's app on :8788 and the harness with `HARNESS_REPO=../scout-run`.
- **Clean slate:** Ctrl+C, then `npm run demo` again. Options:
  - `--no-map` lets the cartographer propose the map.
  - `--with-data` copies the original's database.
  - `--keep` archives the previous copy.
  - `--offline` uses Scout's fixture companies.
  - `--replace` stops a harness already on :4310/:5173.
- **Changing Scout itself** (not a session) happens in `../scout-agent`, following `DEMO_REPO_SPEC.md`. Then `git tag -f demo-start` so new copies pick it up. Scout's code, comments and commits never mention the harness or the demo.
- **Recording** follows `DEMO_PLAN.md`.

## Context

- The target repo, Scout, is built separately from `DEMO_REPO_SPEC.md` and lives at `../scout-agent` (see "Running against Scout"). Unit tests in core use the small fixture repo under `packages/core/test/fixture-repo/`, which mirrors its layout, including the one gateway bypass in `src/tools/news-summarize.ts`. Scout now also has per-domain `schema.sql` files and embedded Postgres; mirror them in the fixture when tests need them.
- Visual reference: Figma file "Diagram-first harness — product mockup", page "v2 · Domain grid".
- The demo is about time saved: keep the ledger counters exact (SPEC §9) and never display estimated minutes in the UI.
