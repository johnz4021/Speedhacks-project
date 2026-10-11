# Renaming "Harness" → **Interpretability** (done Oct 11)

**Decision:** public name **Interpretability**. Renamed everything people see: the UI wordmark and title, docs and pitch lines, the MCP server (`mcp__interpretability__*`), the session brief and deny/notice text, Alike decision text ("Decided in Interpretability session N"), and the commit identity in Scout copies. Kept the internal codename: package scope `@harness/*`, `HARNESS_*` environment variables, the `.harness/` folder, file names like `harness-tools.ts`, and the branch `harness-build`. The Build Plan stays as history.

---


Oct 11, 2026. **Do this after the harness build session's lanes have merged:** the code names below are in files those lanes are editing.

## Decide first

- **Public name: a plain noun you can say in a sentence**, not a brand.
  - Front-runners: **Oversight** ("I'm building oversight for coding agents") and **Interpretability** ("I'm building interpretability for coding agents").
  - Pitch with both: "I'm building oversight for coding agents: human interpretability for the code they write."
- **Internal codename:** rename everything, or keep `harness` in code (package scope, env vars, `.harness/`) and change only what people see. Keeping it is cheaper and safe. The one place viewers might notice it is the MCP tool names in Claude's tool calls (`mcp__harness__submit_plan`).
- **Check** the chosen word against existing products and domains before it goes on a slide.

## What to change

Size as of Oct 11: about 60 source files across `apps/shell`, `packages/core` and `apps/server`, plus every doc. Scout never mentions the harness (by rule), so Scout needs no changes.

| Area | Where | Visible to viewers? | Notes |
| --- | --- | --- | --- |
| Product name in the UI | shell title, wordmark, empty states ("Start it with HARNESS_REPO=…") | Yes | Do this even if the codename stays |
| Pitch and plans | `DEMO_PLAN.md` (say-lines, pitch), `SPEC.md` title and intro, `NAVIGATION_PLAN.md`, `CLAUDE.md`, `ALIKE_INTEGRATION.md`, `VERIFY.md` | In the pitch | Leave the Build Plan as history |
| MCP server name | `apps/server/src/session.ts`, `harness-tools.ts`, the session brief, plan-mode instructions, tests | Yes, in Claude's tool calls | Changes every `mcp__harness__*` name. Update the brief, `allowedTools` and the tests together |
| Folder written into targets | `.harness/` (events log, facts, labels) | Barely | Update readers and writers, `.gitignore` entries, `scripts/fresh-scout.sh` comments, `DEMO_REPO_SPEC.md` map ignores |
| Environment variables | `HARNESS_REPO`, `HARNESS_REPO_SLUG`, `HARNESS_ALIKE`, `HARNESS_CARTOGRAPHER*`, `HARNESS_FRESH`, `HARNESS_PERF_STRICT`, `HARNESS_SERVER_PORT`, `HARNESS_LABELS`, `HARNESS_PATHS`, `HARNESS_OWN`, `HARNESS_TEST_TMP` | No | Also `scripts/demo.sh`, `scripts/fresh-scout.sh`, docs |
| Package scope | `@harness/core`, `@harness/server`, `@harness/shell`: package.json names, imports, tsconfig references | No | Then `npm i` to refresh the lockfile |
| Commit identity in copies | `fresh-scout.sh` commits `domains.yaml` as "Harness" | Slightly | |
| Scout's banned words | `DEMO_REPO_SPEC.md` "Never mention" list | n/a | Add the new name; keep "harness" too |
| Alike | decision titles and rationale text | In Alike | Nothing there says "harness" today; check after the integration work |
| Repo and branch names | `Speedhacks-project`, branch `harness-build` | No | Optional |

## Done when

- `npm test` (147+ tests) and `npm run typecheck` pass, and `npm run demo` brings up both apps.
- A full plan, fork and build turn runs against a fresh Scout copy, and Claude calls the renamed MCP tools.
- `grep -ri harness` outside `node_modules`, the Build Plan and git history finds only what you chose to keep.
