# Demo recording plan

Oct 11, 2026 (rewritten in the afternoon around "decisions that protect the design"). This replaces the "Demo script" section of the Build Plan. It assumes Interpretability (codename harness) from `SPEC.md` plus the navigation work in `NAVIGATION_PLAN.md`, and Scout as built from `DEMO_REPO_SPEC.md`:
- live services (Claude, Claude web search, SEC EDGAR);
- embedded Postgres (PGlite with pgvector);
- a web app;
- 17 commits, tagged `demo-start`.

## The story

**Interpretability is observability and better system design, for agents and for humans.** Both look at the same live map of the system:
- **what it is:** domains, layers, and the edges between them;
- **what's changing:** the plan as ghosts, the edits as they land;
- **why it's built that way:** decisions that live on the code they protect.

**How each side uses the map:**
- **Humans** use it to see the system they didn't write, to steer the agent's plan before any code exists, and to decide the architecture in a sentence.
- **Agents** use it to plan within the design: they query the same graph instead of reading files, and decisions arrive in their context exactly when a plan touches what a decision governs.

**The failure this prevents** is the one every team knows. Someone builds a feature on an assumption. Weeks later, someone else makes a reasonable change to something shared, and the feature quietly breaks. (It happened to the founder at a past job: a sales-funnel tracker broke when someone changed URL flags.)

**The pitch lines**
- **Hook:** "Writing code got free. Understanding it didn't." Developers already spent about 58% of their time on comprehension (Xia et al., 2018). In METR's 2025 trial, experienced developers using AI were 19% slower and still believed they had been sped up.
- **Thesis:** "Observability tells you what your system did. Interpretability shows what your agents are doing to it, and why it's built the way it is."
- **Close:** "Chat is the right input and the wrong output."

**What each beat proves**

| # | Beat | You do | Interpretability shows | For |
| --- | --- | --- | --- | --- |
| 1 | Ask (split screen) | Same prompt to plain Claude Code and to Interpretability: "Describe Scout's architecture, and anything risky or over-engineered." | Left, a wall of text. Right, the answer on the map: six domains, three paths to Claude where the design says one, one of them sending personal data unredacted | Humans and agents: the same graph answers both |
| 2 | Fix a bug | "Model usage doesn't count web searches. Can you add search costs to the usage page?" | The first plan builds a second cost ledger; you point at the existing one; the plan moves | Humans steering the plan |
| 3 | Add a feature | "Can we add a tool that summarizes a prospect's latest 10-K?" | The plan copies a shortcut around the gateway: red edge before any code; Claude asks A or B; your answer becomes a decision, a test, and an entry in Alike | Humans deciding the design |
| 4 | A conflicting change | Fresh session: "We're seeing account numbers in briefs. Can we redact every long number?" | The plan touches code DR-4 protects: the decision lights up on the cell and the approval card, and Claude scopes the change so the 10-K tool keeps working | Agents and humans: the design defends itself |
| 4b | Reuse | (Extended) "Can we add a tool that summarizes earnings call transcripts?" | The shortcut shows struck through, "rejected in DR-4"; the tool reuses the filing mode | Agents designing with memory |
| 4c | Teammate | (Extended) the same request in plain Claude Code, no Interpretability | Alike gives that agent DR-4 and it takes the same route | Memory beyond the tool (Alike) |
| 5 | Living map | (Extended) "Let reps follow an account and get a daily digest" | New code with no home; the cartographer proposes a domain with scores | The design keeps up |
| 6 | Audit | (Recorded) a later tool calls the gateway without filing mode | An advisory finding that cites DR-4 | What rules can't express |
| 7 | Quiet change | (Optional) "Encrypt phone numbers at rest" | One column, nothing amber, nothing red | Signal, not noise |

## Cuts

| Cut | Length | Beats | Use |
| --- | --- | --- | --- |
| **Core** | about 3:05 | Hook, Load, 1 (split screen), 2, 3, 4, Close | The submission video and the live demo |
| **Extended** | about 4:30 | Core plus 4b, 4c, 5, 6 (and 7) | Judges' follow-up, a longer slot, the website |
| **Minimum** | about 2:15 | Hook, Load, 3, 4b, Close | If beat 4's decision markers or N6–N10 aren't ready: runs on what's built |

## Shot list (core cut)

Timings are for the edited video. Agent turns run 2–5 minutes in real time; speed them up 4–8x in the edit, but keep the fork moment (Claude asking A or B) and beat 4's "DR-4 lights up" moment in real time.

### 0:00–0:15 Hook

- **On screen:** title card, then the two numbers.
- **Say:** "Writing code got free. Understanding it didn't. Agents change code faster than we can follow, so the time goes to reading diffs, redoing work, and fixing what quietly broke."

### 0:15–0:40 Load: meet Scout

- **On screen:**
  1. Scout's app (pre-recorded clip, sped up). A live research run on Symbotic: the trail fills in, real Q3 revenue, a drafted email.
  2. Cut to Interpretability pointed at the Scout copy. The skeleton appears instantly, then the cartographer's map assembles: 6 domains, 5 layers.
  3. One cell is red.
- **Say:** "This is Scout, a sales research agent: Claude, web search, SEC filings, a Postgres database, a CRM and email. I didn't write any of it. Here's its design in ten seconds, and one thing already breaks it."

### 0:40–1:15 Beat 1: Ask, split screen (observability)

**Left: plain Claude Code** in a terminal. **Right: Interpretability.** Same model, same question, same Scout copy, both started at the same moment.

- **Type, on both sides:** "Describe Scout's architecture, and anything risky or over-engineered."
- **Left (plain Claude Code):** it reads file after file for a minute or two, then prints a long answer. It's probably accurate. Let it scroll; don't cut it short.
- **Right (Interpretability):**
  1. The map is already on screen from Load. Claude answers from the graph tools (`trace`, `graph_neighbors`) rather than by reading files. The reply is a few lines, and each path in it is a link that flies the map there.
  2. The "Start research" journey plays: UI page → `POST /api/runs` → run loop → tool registry → tools → gateway → Claude.
  3. The risky part is drawn, not described. There are three paths to Claude where the design says one:
     - **through the gateway:** redacted and cost-logged, which is the design;
     - **from `news-summarize.ts` straight to `vendor/llm-anthropic`:** red, the contact's details unredacted and uncosted;
     - **from `vendor/search` and `vendor/news` to the SDK:** amber, uncosted.
  4. Inset of Scout's app: the news talking points say "Talking Points for Maya Ortiz", while the company profile shows a `name 1` marker.
- **Caption, as counts and never minutes:** the real numbers from the take, e.g. "84 lines to read" on the left and "3 cells to look at" on the right.
- **Say:** "Same model, same question. One gives me an essay about my system; the other shows me my system. The design says one door to the model. There are three, and one hands over customer data."

**Keep it fair, so it doesn't look staged**
- **Same model and effort on both sides.** Plain Claude Code: `--model opus` (Claude Opus 5.5).
  - Interpretability's coding session is pinned with `HARNESS_MODEL` (default `claude-opus-5-5`; landing in wave 3). It skips user settings, so also set `HARNESS_EFFORT=high` to match your Claude Code default effort.
- **Plain Claude Code runs stock and read-only:**
  ```
  cd ../scout-run && claude --safe-mode --permission-mode plan --model opus
  ```
  - `--safe-mode` turns off hooks, MCP servers (so no Alike), skills, plugins and CLAUDE.md files.
  - `--permission-mode plan` means it can't change anything.
  - It points at the same copy `npm run demo` made, so there's no second Scout and nothing extra running.
- **Start both together,** and record the split screen in one take. If you speed it up, speed up both sides equally.
- **Treat the left side's answer as good, just long.** The point is the format: a transcript versus a map.

### 1:15–1:40 Beat 2: Fix a bug (steer the plan)

- **On screen:** Scout's Model usage page lists planning, briefs and summaries, but no web search, though every run searches.
- **Type:** "Model usage doesn't count web searches, so our Anthropic bill is higher than Scout says. Can you add search costs to the usage page?"
- **Expected first plan:** a new search-cost tracker, either a `search_costs` table or a counter in Research tools › Data. It's a second ledger next to the gateway's `cost_log`.
- **You:** shift-click `src/gateway/cost-ledger.ts#recordCost` and say "Record it in the ledger we already have."
- **The plan moves:** `vendor/search` and `vendor/news` call `recordCost` after each Claude call. The ghost leaves Research tools › Data. The usage page needs no change, because it already groups by task.
- **Approve and build.** A "Web search" row appears on the usage page.
- **Say:** "The first plan built a second ledger. One click on the map put the fix where costs already live."

### 1:40–2:20 Beat 3: Add a feature (the design decision)

- **Type:** "Can we add a tool that summarizes a prospect's latest 10-K?"
- **Expected plan:** a new `src/tools/filing-summarize.ts` that copies `news-summarize.ts` and calls Claude directly, because the gateway's redaction turns filing figures into `[PHONE_n]`. The ghost edge Research tools → Model gateway › External turns red (DR-1: model providers only through the gateway).
- **Claude asks:** "This breaks DR-1. A: summarize through the gateway and give it a filing mode that keeps figures intact. B: add an exception for this tool."
- **You answer with the principle:** "A. Filings go through the gateway, in a filing mode that keeps figures intact."
- **Recorded, before the build starts:**
  - `decisions/DR-4.md` is committed, and `domains.yaml` links DR-4 to DR-1.
  - The server records DR-4 in Alike: the chat shows "DR-4 in Alike".
  - A 3-second cut to Alike's entry: the principle as the title, the rejected option, anchors on `src/tools/` and `src/gateway/`.
- **Build:** ghosts fill two columns, both planned:
  - Research tools › Logic: the tool;
  - Model gateway › Logic: the filing mode, plus a gateway test, "filing mode keeps figures intact".
- **In Scout:** the new 10-K step shows real figures ("revenue of $2,246,922,000").
- **Say:** "The shortcut showed up on the map before any code, and I decided. That answer is now part of the design: a rule in the repo, a test, and a memory in Alike."

### 2:20–2:50 Beat 4: A conflicting change (the design defends itself)

- **On screen:** a fresh session, framed as "a teammate, a week later". Type: "We're seeing account numbers in briefs. Can we redact every long number, not just phone numbers?"
- **The trap:** the obvious change widens the shared redaction pattern for every caller. That would quietly turn the 10-K summaries back into `[PHONE_n]`, and nobody would notice until a rep did.
- **Expected:**
  1. The plan's ghost lands on `src/gateway/redact.ts`, a file DR-4 governs. A DR-4 marker lights on the Model gateway › Logic cell, and the approval card says "Touches what DR-4 protects: filing mode keeps figures intact (decided in session 1)".
  2. Claude, whose context received DR-4 at that moment, scopes the plan: "Per DR-4, I'll redact long numbers for every purpose except filing mode, and extend the filing test."
  3. Approve and build. Beat 3's test runs green alongside the new one. Inset of Scout: the brief shows account numbers as markers, and the 10-K summary still shows its figures.
- **Say:** "This is how products break: someone changes something shared, and a decision made weeks ago quietly stops being true. Here the decision lives on the code it protects, so the agent and I both saw it before the change."

### 2:50–3:05 Ledger and close

- **On screen:** the session's ledger, then a replay scrub through beats 3 and 4.
- **Ledger counts** (SPEC §9): lines changed, cells to review, forks caught before code, rejected options blocked.
- **Say:** "[N] lines changed, [K] cells to review, one design decision made and kept. Chat is the right input and the wrong output."
- Minutes appear only in the voiceover, taken from the baseline runs below. Never put them on the UI.

## Extended beats

### Beat 4b: Reuse (about 25 s)

- **Type,** in a fresh session after beat 4: "Can we add a tool that summarizes earnings call transcripts?"
- **On screen:**
  - The plan doesn't build its own model call. The direct edge to the provider shows struck through, "rejected in DR-4, session 1".
  - The tool uses the gateway's filing mode from beat 3. The ledger's "rejected options blocked" ticks to 1.
- **Say:** "A different feature, in a file that didn't exist when we decided, and it reused the design instead of working around it."

### Beat 4c: Teammate without Interpretability (about 15 s)

- **On screen:** plain Claude Code (no Interpretability) in the same Scout copy, with the same request as 4b. Alike gives that agent DR-4, and it uses the filing mode.
- **Say:** "Alike makes sure every agent hears the decision; Interpretability makes sure the code honors it."
- **Alike's transcript capture is on for Claude Code** (it has to be: with capture off, Alike's hooks are silent, including injection). Run each take under its own `--take N` so this take's DR-4 is the only one Alike holds for the repository.

### Beat 5: Living map (about 45 s)

- **Type:** "Let reps follow an account and get a daily digest of new filings and news."
- **On screen:**
  1. New files appear in `src/watchlist/`, a scheduled job and a `watchlists` table. They land in Unassigned with a faint "probably a new domain?" guess.
  2. At turn end the cartographer proposes a **Watchlists** domain as ghosts, with scores ("turns would light 2 cells; 0 unassigned; no decisions broken").
  3. You accept, and `domains.yaml` is committed.
- **Say:** "The design keeps up with the code, but only changes when I say so."

### Beat 6: Audit (about 30 s, recorded)

- **Setup:** a later turn adds a tool that sends filing text through `complete()` without filing mode. No rule is broken (it goes through the gateway), so the gate stays quiet, but it contradicts DR-4.
- **On screen:** after the turn, an amber "audit" badge: "DR-4 says filings use filing mode; `src/tools/…:NN` calls `complete()` without it." Promote it to a rule, or dismiss it.
- **Say:** "Rules catch what they can express. The auditor catches the rest, and it cites what you decided."

### Beat 7: Quiet change (optional, about 20 s)

- **Type:** "Encrypt phone numbers at rest."
- **On screen:** the ghosts and then the edits stay in Outreach (`schema.sql`, `crm-sync.ts`), plus a key in config. Nothing amber, nothing red.
- **Say:** "Most changes look like this: one column, nothing to review. You only get pulled in when it matters."

## Prerequisites

### Scout (owned by the Scout session)

| Item | Status |
| --- | --- |
| Live services, web app, async runs, Postgres, 17 commits tagged `demo-start` | Done |
| Beat 1: the gateway bypass in `news-summarize.ts`; search and news calling the SDK outside the gateway | Present; keep them |
| Beat 2: search and news costs missing from `cost_log` and the usage page | Present; keep it |
| Beat 3: the 10-K inputs (`vendor/sec-edgar` `latestFiling` / `filingText`), redaction that mangles filing figures, `news-summarize.ts` as the nearest example, its commit message giving the reason | Present |
| Beat 3's visible symptom: company profiles show revenue as `phone 1` | Present; leave it unfixed (it motivates the shortcut) |
| Beat 4: one shared redaction pattern in `src/gateway/redact.ts` for every purpose | Present |
| Beats 4b, 4c: `vendor/news` serves earnings call transcripts | Present |
| Beat 5: nothing in Scout fits watchlists | Present |

No Scout code changes are needed for this storyline.

### Interpretability (owned by the harness session)

| Beat | Needs | Status | Fallback if not ready |
| --- | --- | --- | --- |
| Load | Cartographer, assembling animation | Built (N5) | `--map` loads `fixtures/scout-agent.domains.yaml` |
| 1 | Trace and journeys, the graph tools, route adapter for Scout's route table; **the coding session pinned to the same model as plain Claude Code**; Claude told to answer from the graph; an `overview` tool; the three classes of path to Claude drawn at once; paths in the reply as links | Journeys, trace, graph tools and route adapter built. In progress (wave 3): `HARNESS_MODEL` (default Opus 5.5) and `HARNESS_EFFORT` (set `high` to match your Claude Code default), the brief rule, `overview`, the shared three-class classifier, path links | Claude answers with the graph tools; the red edge plus inspector provenance |
| 2 | Plans naming functions, shift-click to point | Built (plan steps may name symbols; messages carry pointed-at nodes) | Cell-level ghosts; type the path |
| 3 | Gate, fork, decision; Alike recording from the server with folder anchors | Built | Show `decisions/DR-4.md` in git if Alike fails |
| **4** | **New: decisions as markers on the code they govern** (see below) | **In progress (wave 3):** contracts built (`decision_touched`, `protects`, leaf markers); server matching and the reminder in Claude's tool result, plus the cell marker and approval-card line | DR-4 is in the session brief, so Claude may scope the change anyway; show beat 3's test catching the naive version |
| 4b | Struck-through "rejected in DR-n" edge, rejected-options counter | Built | The block reason "You decided this in DR-4" |
| 4c | Alike capture on for Claude Code; a per-take Alike repository | Done: capture is on, and `npm run demo -- --take N` gives each take its own repository | Cut |
| 5 | Cartographer proposals | Engine built (N5); the proposal UI (ghosts with scores, accept/reject) in progress (wave 3) | Cut |
| 6 | Auditor, with this storyline's case (filing text through `complete()` without filing mode) | Auditor built (it's generic: it checks a turn against standing decisions' rationale); findings UI in progress (wave 3) | Cut |

**New capability for beat 4: decisions as markers on the code they govern.**
- **Anchors:** a decision records the files and functions that implement the chosen option (for DR-4: the filing-mode function in `src/gateway/redact.ts` or `complete.ts`, and the test), in addition to the invariant's folders.
- **When a plan touches one:**
  - the plan step's ghost cell shows a marker for that decision;
  - the approval card lists "Touches what DR-n protects: <principle>";
  - the decision text goes into Claude's next tool result, so the agent sees it at the moment it matters, not just once in the brief.
- **Deterministic:** path and symbol matching against plan steps (`submit_plan` steps can already name `path#symbol`), with no model in the loop.
- **Also on edits:** the same check runs on edits (PostToolUse), so an unplanned edit to protected code shows the marker too.
- **Optional:** the auditor's plan review (NAVIGATION_PLAN D8) adds a second, model-based check.
- **Alike:** add the same function anchors to the DR-4 entry, so a teammate's agent touching that function is given it.

**What changed from the previous storyline** (outreach history, DR-4 refining DR-3):
- DR-4 now refines **DR-1** (the gateway), not DR-3. Gate, fork, decision recording, Alike recording and folder anchors are unchanged and reused.
- The struck-through rejected edge and its counter move from beat 4 to beat 4b, and still apply: the rejected option is "a research tool calling the provider directly".
- The auditor's demo case changes to filing text through `complete()` without filing mode. This was NAVIGATION_PLAN N9's original example.
- Beat 2's bug changes from "revenue shows as phone 1" to "search costs missing from usage". The revenue symptom stays unfixed in Scout as beat 3's motivation.
- Beats 3, 4, 4b and 4c must run **in order on the same Scout copy**, because each depends on the previous build and on DR-4 (see "Recording setup").

**Notes for the harness**
- The leak and the default provider are `vendor/llm-anthropic`, not `vendor/llm-openai`.
- Apply the map changes in `DEMO_REPO_SPEC.md` § Map changes: the UI row, and each `schema.sql` in its domain's Data cell.
- Scout's storage is embedded Postgres. Writes keep the `await db.insert("table", row)` shape; reads also arrive as `db.query(sql)`; the `schema.sql` files define the tables.
- Package imports that matter for beat 1: `@anthropic-ai/sdk` (from `vendor/llm-anthropic`, `vendor/search`, `vendor/news`) and `@electric-sql/pglite` (from `src/shared/db.ts`).
- Alike: see `ALIKE_INTEGRATION.md`. Recording is server-side with folder anchors and principle-first wording. Alike can't add anchors after recording through the device token, so DR-4's protected functions reach Alike only through its folder anchors. The "done when" lines are being updated to this storyline (wave 3).
- The stale test DR-4 in Alike is dismissed. Record every take and baseline under its own `--take N`.
- Capture is on, so Alike also extracts "decisions" and "tasks" from development sessions. Dismiss today's extracted items from test runs before recording, so they don't reach takes or baselines.

## Rehearsal: make the agent's first move predictable

The demo depends on Claude's first plan. Run each beat at least 3 times against a fresh copy and log what it proposed.

| Beat | Want first | If it goes straight to the right answer |
| --- | --- | --- |
| 1 | Left: a long but correct essay. Right: a short reply with links, plus the drawn trace | If plain Claude Code's answer is short, keep it: the contrast is text versus map, not length. If Interpretability's Claude reads many files instead of using the graph tools, check that the session brief tells it to query the graph first |
| 2 | A second cost tracker (new table or counter) | Keep "add search costs to the usage page", which points at the UI. If it writes `cost_log` from `vendor/search`, the gate fires instead (DR-2, only the gateway writes `cost_log`): also a good beat, with the fork from beat 3 arriving early. If it goes straight to `recordCost`, show the plan confirming one ledger and move on |
| 3 | A direct model call copied from `news-summarize.ts` | Keep "Can we add a tool that summarizes…" and don't mention the gateway. If it plans through the gateway, check that the figures-to-phone problem shows in its exploration (it reads `redact.ts`?). If not, fall back to the earlier outreach-history fork, which is still supported |
| 4 | The global widening of the redaction pattern | First check, in a session without DR-4, that the naive plan really widens the pattern globally. With the marker, Claude should scope it; if it widens anyway, check that DR-4's text reached the tool result and says "filing mode keeps figures intact" |
| 4b | No direct call; struck-through edge citing DR-4 | Either outcome works: the plan avoids the direct call from the start, or it plans it, is blocked with "You decided this in DR-4", and replans |

## Baselines for the voiceover

Per SPEC §12, minutes come only from measured runs.

1. Make a fresh copy under its own `--take` name, so Alike has no decisions for it.
2. In plain Claude Code, without Interpretability (`claude --safe-mode --model opus`), run the beat 2, 3 and 4 prompts exactly as typed above. Time each one. Beat 1's comparison is filmed live, not measured here.
3. Record what it built:
   - did it make a second ledger, the bypass, or the global widening?
   - did beat 4's change break the 10-K summaries, and how long did it take to notice and fix?
   - how many lines would you have had to read?
4. If plain Claude Code gets one right first time, drop the minutes claim for that beat and lean on lines to review and the design being kept.

## Recording setup

**Screen**
- 1920×1080 at 125% browser zoom, one browser window, no bookmarks bar. Do Not Disturb on, Dock hidden.
- Tabs: Interpretability (http://localhost:5173), Scout's app (http://localhost:8788), Alike.
- **Beat 1's split screen:** a terminal on the left (large font, about 18 pt, colours close to the shell's) running plain Claude Code in `../scout-run`, and the browser on the right. Record both in one capture.

**Scout during recording: always a fresh copy**

`../scout-agent` is the untouched original, pinned at `demo-start`. Every session runs against a disposable clone:

```
npm run demo -- --take 7        # fresh copy at demo-start, Scout's app on :8788, Interpretability on :5173
```

- Ctrl+C stops everything; `npm run demo` again is a clean slate.
- **Options:**
  - `--reuse` starts on the existing copy as it is (e.g. at a checkpoint) instead of making a fresh one.
  - `--scout-only` starts only Scout's app, for plain Claude Code takes.
  - `--replace` stops whatever is already running; without it, the script refuses to touch a live session.
  - `--no-map` films the cartographer.
  - `--with-data` copies the original's database (pre-run research).
  - `--keep` archives the previous copy.
  - `--offline` uses the sample companies.
  - `--take N` gives the copy its own Alike repository.
- **Ports:** Scout is served by `dev:api` on :8788 and reloads server code. Run `npm run build` in the copy if the agent edits `web/`.

**Beats 3 → 4 → 4b run in one copy.** Don't reset between them. To retake beat 4 without redoing beat 3:
1. After a good beat 3, commit the build in the copy. Interpretability commits only `domains.yaml` and `decisions/`; the agent's code changes are left uncommitted:
   ```
   git -C ../scout-run add -A -- . ':!.harness' && git -C ../scout-run commit -qm "checkpoint after beat 3"
   ```
   Then stop with Ctrl+C.
2. Archive it: `npm run demo -- --keep --take N` makes a new copy and leaves the old one at `../scout-run-<time>`.
3. Start beat 4 from the checkpoint: `SCOUT_SRC=../scout-run-<time> SCOUT_REF=session npm run demo -- --no-map --take N`.
   - Use the same take number, so Alike holds the same DR-4.
   - `--no-map` keeps the checkpoint's `domains.yaml`, which links DR-4 to DR-1; the default would overwrite it with the fixture.

**Beat 4 comparison: plain Claude Code breaks it (two takes in the same copy, edited side by side)**

Both takes start from the same checkpoint in `../scout-run`, so plain Claude Code always sees exactly the design Interpretability left: no second repo to keep in sync.

1. **Checkpoint** after a good beat 3 (the commit above).
2. **Take A, plain Claude Code**, with Interpretability stopped so its file watcher doesn't log these edits into the session:
   - Ctrl+C `npm run demo`, then `npm run demo -- --reuse --scout-only`, which serves Scout alone on the same copy at :8788. (Or skip the Ctrl+C and add `--replace`.)
   - In a second terminal: `cd ../scout-run && claude --safe-mode --permission-mode acceptEdits --model opus`. Safe mode means no hooks and no MCP servers, so Alike can't hand it DR-4.
   - Paste beat 4's prompt: "We're seeing account numbers in briefs. Can we redact every long number, not just phone numbers?"
   - When it's done, start a Symbotic research run at :8788 with a goal that mentions the 10-K. The 10-K step comes back as `$[PHONE_1]`.
3. **Reset to the checkpoint**, undoing plain Claude Code's edits:
   ```
   git -C ../scout-run reset -q --hard && git -C ../scout-run clean -fdq -e .harness
   ```
   Take A's broken run stays in the app's history; ignore it or point at it.
4. **Take B, Interpretability:** Ctrl+C the lone Scout, then `npm run demo -- --reuse --take N`. This starts Scout and Interpretability on the same copy, at the checkpoint, keeping its `domains.yaml` and DR-4. Run beat 4 as scripted, then a Symbotic run where the 10-K step keeps its figures.
5. **In the edit:** A and B side by side, sped up equally, ending on the two 10-K results.
   - **Say:** "Same request, same model. Plain Claude Code made a reasonable change and broke a feature nobody was looking at. With the decision on the map, it didn't."

**Rehearse take A twice.** The copy contains `decisions/DR-4.md` and beat 3's test, and stock Claude Code may read or run them and avoid the trap. Keep whatever actually happens. If it reliably avoids it, say so honestly ("it only got it right because it happened to read the file").

**Takes:** record each beat as its own take, and do the voiceover afterwards.

**Changing Scout itself** (not a take) happens in `../scout-agent`; then `git tag -f demo-start`.

**Cost:** a live Scout run costs about 2–3 cents, and the agent turns are the main spend. Budget about 10 takes.

## Risks

| Risk | Fallback |
| --- | --- |
| Claude's first plan is already right (beats 2, 3, 4) | The rehearsal table above; keep the best recorded take |
| Beat 4's decision markers aren't built in time | DR-4 in the brief plus beat 3's test; or the Minimum cut |
| A live service is slow or down while recording | `SCOUT_MODE=offline`, with the fixture companies (switch the whole recording, not one shot) |
| Alike sign-in or capture isn't working | Show `decisions/DR-4.md` in git; cut 4c; Alike becomes a slide |
| Stale Alike memory leaks into a take or baseline | A new `--take N` per take; dismiss the old test DR-4 |
| Plain Claude Code takes several minutes on beat 1 | Speed up both halves of the split screen equally, and caption the real elapsed time of each |
| The map is too busy at System level | The UI row and router fix keep edges at 12 domain pairs; use the turn lens during beats |
