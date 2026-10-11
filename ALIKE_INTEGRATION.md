# Alike integration: current state and proposed redesign

Oct 11, 2026. A note for whoever owns the harness server. It proposes changes to how Interpretability uses Alike, motivated by demo beats 3 and 4 in `DEMO_PLAN.md`. Nothing here is decided. Check every Alike API detail against Alike's docs and `VERIFY.md` before building; items marked **unverified** are assumptions.

## The value we want to show

- **Alike on its own (basic memory):** it remembers what was decided, attaches it to code paths, and gives it to any agent working there. It is advisory: it can't tell whether the code still follows the decision, and a file created later has no anchor.
- **Alike plus Interpretability (architectural memory):** the decision is attached to the architecture, e.g. "research tools never read outreach data", not to the files involved that day. So:
  1. it covers code that doesn't exist yet;
  2. it shapes the plan before any code (the rejected approach shows struck through);
  3. it is checked against the code (load scan, edit gate, auditor);
  4. it has provenance on the map ("decided in session 1, DR-4").
- **Alike's part:** carrying the decision to agents and teammates who never open Interpretability.

**Pitch line:** "Alike remembers what we decided. Interpretability makes it part of the architecture, so it holds for code nobody has written yet."

## What Interpretability does today

Code: `apps/server/src/decisions.ts` (`recordFork`, `repoAnchor`) and `apps/server/src/session.ts` (`notes`, `afterAlike`).

- **Write only.** After a fork is answered, `recordFork` writes `decisions/DR-n.md`, updates `domains.yaml` and commits both. It then queues an instruction asking Claude to call `mcp__alike__record_decision` with exact arguments. A PostToolUse hook re-emits `decision_recorded` with `alike: true`, and the inspector shows "in Alike".
- **Anchors are the files that broke the rule.** `anchors: [{ kind: 'path', label: 'governs', path, repository }]`, one per violating file. With option A that file usually never gets written (beat 3's planned `src/tools/outreach-history.ts`). So in Alike the decision points at a path that doesn't exist, and a teammate's agent touching any other research tool won't be shown it.
- **The decision text is mostly the violation**, not the principle. The title is the user's first sentence when it's long enough, otherwise "`<file>` follows DR-3: …".
- **Recording depends on the model.** Claude has to make the tool call, which adds a step to the coding turn and can silently not happen ("If the Alike tools are unavailable, skip this silently").
- **Nothing reads Alike back.** The session brief uses `decisions/` in git only. Alike's hooks are deliberately off in harness sessions (`settingSources: ['project','local']`, VERIFY.md item 4).
- **Repository identity:** `HARNESS_REPO_SLUG`, else the origin remote, else `<git user>/<folder>`. The demo's fresh copies (`scripts/fresh-scout.sh`) have no remote, so `npm run demo` passes `HARNESS_REPO_SLUG`.

## Proposed changes

Roughly in order of value for the demo.

1. **Anchor decisions to the architecture.** For a decision on an `only_via` or `no_edge` invariant, anchor to the path globs of the cells on both sides of the rule: for DR-4, `src/tools/**` (Research tools › Logic) and `src/outreach/**`. Add the files where the chosen approach lives (e.g. `src/orchestrator/agent.ts`). For `owns_writes`, anchor to the owner's data cell and its `schema.sql`. Then Alike surfaces DR-4 whenever any agent touches any research tool, including ones written later.
   - **Unverified:** whether Alike path anchors accept globs or folders. If not, anchor to every existing file in those cells, and re-anchor when the cell gains files (the cartographer's turn-end pass is a natural place).
2. **Record the principle, not the incident.**
   - Title and outcome come from the invariant plus the user's answer: "DR-4: Research tools never read outreach data; the run loop passes outreach context in."
   - The rationale names the rejected option explicitly ("Rejected: a research tool that imports outreach code") and the invariant it refines (DR-3).
   - Beat 3 has the user answer in that form; Interpretability should still compose a principle when they just type "A".
3. **Record deterministically, off the model.** Write to Alike from the server, not by asking Claude to make a tool call. The paired `~/.alike/bin/alike` CLI can call `record_decision` (VERIFY.md (d)), or use Alike's HTTP API if there is one (**unverified**).
   - Run it asynchronously after the commit, never in the hot path, and emit `decision_recorded { alike: true }` when it succeeds.
   - This removes a model step from the turn and makes "in Alike" reliable on camera.
   - Keep the MCP path as a fallback.
4. **Read decisions back.**
   - At session start, fetch this repository's standing decisions from Alike (the Build Plan suggested `resolve_work_item`; **unverified** which call fits). Merge them with `decisions/`.
   - **Decisions Interpretability made** (they carry a DR id) are already known; just confirm they match.
   - **Decisions made elsewhere,** e.g. a teammate's plain Claude Code conversation that Alike captured, show as *proposed* rules on the map: dashed, marked "from Alike". Accepting one turns it into an invariant through the cartographer's proposal flow (NAVIGATION_PLAN §4.5); rejecting it is recorded.

   That closes the loop. Alike's conversational memory becomes enforced architecture (with your consent), and goes back to Alike with exact anchors.
5. **Show it on the map.**
   - **Plans:** a planned edge that a standing decision rejects is drawn struck through: "rejected in DR-4, session 1" (beat 4). The ledger's `rejectedOptionsBlocked` already counts it.
   - **Inspector:** a decision links to its Alike page and lists where it's anchored.
   - **Turn summary:** "1 decision recorded in Alike" alongside the ledger.
6. **Repository identity for fresh copies and takes.**
   - **Teammate beat:** Alike's hooks in a plain Claude Code session probably identify the repository by its git remote, and the copy has none. `fresh-scout.sh` should give the copy an origin URL for `johnz4021/scout-agent` with pushing disabled (`git remote set-url --push origin no-push`).
   - **Per-take slug:** decisions outlive a copy reset, so each take adds another DR-4 to Alike. A `--take N` option should set `HARNESS_REPO_SLUG=johnz4021/scout-agent-takeN` and the matching origin.
   - **Baselines:** the plain Claude Code baselines (DEMO_PLAN "Baselines") must run under a slug that never received a decision. Otherwise Alike feeds them DR-4 and the "without harness" timings are wrong.
7. **Lifecycle (later).** When a rule is loosened, retired or excepted (NAVIGATION_PLAN §4.4 "rule erosion"), update or retire the Alike decision too (**unverified** whether Alike supports updates). Dedupe by DR id so replays and retries don't create copies.

## Open questions for Alike

- Do path anchors accept globs or folders?
- Is there a server-side or HTTP way to record and read decisions without an agent session? (This was on the Build Plan's "ask at the event" list.)
- How do Alike's hooks pick the repository: remote URL, folder, something else?
- Can decisions be updated, retired or deleted (for rule changes and take resets)?
- Is there a stable URL per decision, for linking from the inspector?

## Done when

Follows the current storyline in `DEMO_PLAN.md` (DR-4 refines DR-1, the gateway).

- **Beat 3:** answering "A. Filings go through the gateway, in a filing mode that keeps figures intact." shows "DR-4 in Alike" within a few seconds, recorded by the server. Alike's entry has the principle as its title, the rejected option ("Add an exception for `src/tools/filing-summarize.ts`") in the rationale, and folder anchors:
  - `governs`: `src/tools/` (the side that asked: the violating file's domain, so every research tool written later is covered), plus the guarded providers (`vendor/llm-anthropic/`, `vendor/llm-openai/`, `vendor/embeddings/`);
  - `context`: `src/gateway/` (the gateway's cells collapse to their folder because every file in it is the gateway's);
  - one `applies_when` situation.
- **Beat 4:** in a fresh session, "We're seeing account numbers in briefs. Can we redact every long number?" plans on `src/gateway/redact.ts`; Interpretability (not Alike) marks it as touching what DR-4 protects and puts the decision in Claude's tool result. Alike's part is only that DR-4 is anchored on `src/gateway/`, so an agent outside Interpretability touching that folder is given it too.
- **Beat 4b:** in a fresh session, "Can we add a tool that summarizes earnings call transcripts?" plans through the gateway's filing mode, shows the struck-through edge citing DR-4 (session 1), and the ledger counts one rejected option blocked.
- **Beat 4c (teammate):** plain Claude Code in the same copy (same take slug), with Alike capture on for Claude, asked the 4b question, is given DR-4 by Alike (the `src/tools/` anchor) and takes the filing mode.
- **Isolation:** a new take (`--take N+1`) starts with no DR-4 in Alike, and baselines run with no decisions.

**What the decision protects stays out of Alike.** `protects` (the filing-mode symbols in `src/gateway/redact.ts` and the gateway test) is known only when the decision turn ends, after the entry was recorded. The device token has no update call (`update_entity` is MCP-only) and Alike doesn't dedupe decisions, so nothing is added later; no model step is added to do it either. The function-level markers are Interpretability's (`decisions/DR-n.md` `protects:`, `decision_touched` events); in Alike, the `src/gateway/` folder anchor covers the same files.

## Verified capabilities and what was built (Oct 11, later)

Checked read-only against Alike's MCP schemas, the paired CLI, the installed runtime (`@alikeai/setup` 0.2.1, `~/.alike/runtime/*`) and alike.help.

| Question | Answer |
| --- | --- |
| Globs or folders in path anchors? | **Folders, not globs.** `'dir/'` matches a boundary-safe prefix (`hook.mjs` `isAtOrUnder`), new files included. `src/tools/**` would never match. |
| Server-side recording? | **Yes:** the paired CLI (`alike it "<title>" --json '{…}'`) or `POST https://alike.network/api-general/mcp` with the device token. The token covers 5 tools only: `record_decision`, `get_entity`, `get_briefing`, `resolve_work_item`, `inspect_injections`. |
| Repository identity in hooks? | The `origin` remote reduced to `owner/name`, **lowercased**. With no remote, Alike falls back to the bare folder name, which can't hold path anchors. A remote that isn't reachable is fine. |
| Update / supersede / delete? | `update_entity(status:'superseded')` and `dismiss_entity` work through **MCP only**. There's no delete, and **no dedupe** for decisions. |
| Read back by repository? | No server-side filter. `list_entities` or `query_entities` (MCP only) can be filtered by `anchors[].repository` client-side. With the device token, only `get_entity(urn)`. |
| Stable URL? | No per-item web URL is documented. The URN (`urn:alike:decision:<hex>`) is stable. |
| Situation anchors? | Accepted and matched on the server. Prompt grounding works mostly from the title, so put the principle in it. |
| **Blocker** | With transcript capture off for Claude (`capture_harnesses: []`), Alike's hooks are **completely silent**, including injection. The teammate moment needs `npx @alikeai/setup --capture=claude`. |

**Built (commit "record decisions in Alike from the server"):**
- The server records with `alike it` after the DR commit, never in the turn.
- Anchors: the cell folders of both sides of the invariant (`governs` / `context`), plus an `applies_when` situation.
- The title states the principle; the rationale names the refined rule and the rejected option.
- `alike_urn:` is written into the DR file and committed, so a decision is recorded once.
- `decision_recorded { alike: true, urn }` is emitted.
- The MCP instruction is kept as a fallback.
- `repoSlug` follows Alike: `HARNESS_REPO_SLUG`, or origin, lowercased; there's no git-user fallback any more.

**Still to do:** see the open decisions in the harness session. They cover:
- capture on or off;
- `fresh-scout.sh --take N` with an origin remote and pushing disabled;
- dismissing the stale test DR-4 in Alike;
- reading foreign decisions (needs an MCP client in the server);
- supersede on rule changes (MCP).
