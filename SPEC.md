# Interpretability: build spec

**Text in, architecture out.** Interpretability is a diagram-first shell around real Claude Code. You talk to the agent in a chat pane; a domain × layer map of the target repo shows, live, what each turn plans and does to the architecture; and the agent stops to ask you before it crosses a rule. Decisions you make become rules that later sessions are checked against.

The theme is giving people time back. Agents made writing code nearly free, but understanding and checking it did not get cheaper. Every feature below exists to cut reading, rework or re-explaining, and the time ledger counts those savings.

## 1. Repos

Two separate git repos, side by side:

```
workspace/
  harness/        this tool (npm workspaces monorepo)
  scout-agent/    the demo target, built separately from DEMO_REPO_SPEC.md
```

The target must be its own repo. The coding agent runs with its working directory there, the map is computed over it, and `domains.yaml` plus `decisions/` are committed into it. The tool's own code must never appear on the map.

```
harness/
  package.json              npm workspaces
  packages/core/            pure TypeScript, no I/O beyond fs reads; fully unit-tested
    src/schema.ts           zod schema for domains.yaml
    src/events.ts           event types and the reducer
    src/mapper.ts           path → cell, table → owner
    src/imports.ts          regex import parser + relative-path resolver
    src/writes.ts           db.insert / db.update scanner
    src/facts.ts            whole-repo scan: files, imports, writes, cross-domain edges
    src/rules.ts            the invariant checker (one function, three call sites)
    src/plan.ts             plan → ghost footprint
    src/ledger.ts           per-turn and session counters
    test/                   uses fixtures/scout-agent.domains.yaml
  apps/server/              Node + Hono + ws + @anthropic-ai/claude-agent-sdk
    src/index.ts            HTTP + websocket; serves the shell in production
    src/bus.ts              append-only event log (.harness/events.jsonl in the target) + broadcast
    src/repo.ts             load, full scan, file watcher
    src/session.ts          the coding session (streaming input, modes, hooks, canUseTool)
    src/harness-tools.ts    in-process MCP server: submit_plan, cell_for, domain, who_writes, decisions_for
    src/turns.ts            turn lifecycle, git baselines, turn records
    src/decisions.ts        decisions/DR-n.md, invariant updates, Alike instructions
    src/cartographer.ts     one-shot map proposal
  apps/shell/               Vite + React + Zustand
  fixtures/scout-agent.domains.yaml
```

Run: `HARNESS_REPO=../scout-agent npm run dev` (server on 4310, shell on 5173).

## 2. Hard rules

1. **No model calls in the hot path.** Hooks, the mapper, the import parser and the rule checker are deterministic and fast. Model calls (the cartographer) never block the coding session.
2. **Every piece of UI state is a pure reduction of the event log.** Footprint, ghosts, ledger, summary, provenance and replay are all `reduce(events)`. Replay is "reduce up to index i".
3. **Interpretability writes to the target repo only in three places:** `domains.yaml`, `decisions/`, `.harness/` (gitignored). The coding session is the only thing that edits product code.
4. **Facts win on structure, the user wins on meaning, the agent wins only on stated intent**, and intent is always checked against facts.

## 3. The map (`domains.yaml`)

Schema: see `fixtures/scout-agent.domains.yaml`. Domains are columns, layers are rows (rows come from the file, not hard-coded). Each cell lists path globs and, for data cells, owned tables. `neutral` paths never create edges; `ignore` paths are skipped. Files that match no cell land in an **Unassigned** column.

**Tests** are assigned to a domain by its `tests` globs. A test file counts as part of that domain for the rule checker's import rules and the footprint and is listed in the inspector, but it is not drawn in a cell and draws no edges. Tests may write any table: seeding fixture rows is setup, not a product write, so `owns_writes` skips them.

**Edges are derived, never declared.** A cross-domain edge exists when a file in domain A imports a file in domain B. Flow down a column is implied and not drawn. The import parser handles `import … from '…'`, `import('…')` and `export … from '…'`. It resolves relative paths by trying the specifier as written, then `.ts`, `.tsx`, `/index.ts`, `/index.tsx`, and maps a `.js` specifier to `.ts`. It ignores bare package and `node:` imports (Scout has none that matter).

**Writes:** a regex scan for `db.insert(` and `db.update(` followed by a string literal in any quote style gives `{file, table}` pairs.

## 4. Invariants: one checker, three call sites

```ts
type Violation = { invariant: string; reason: string; file: string; detail: string; options: [string, string] };
function check(map: DomainMap, delta: FactDelta): Violation[];
```

`FactDelta` is a set of added imports and added writes, each with its source file. The three kinds:

| Kind | Fires when |
| --- | --- |
| `only_via` | a file outside `allowed_from` domains imports a `targets` path |
| `owns_writes` | a file outside the owner domain writes the table |
| `no_edge` | a file in `from` imports a file in `to` |

Exceptions (paths) suppress a violation. Each violation carries two options: **A** comply (for `only_via` on Scout: "route through `gateway.complete()`"), **B** add an exception for this path and record why.

The three call sites, all using the same function:

1. **Load:** full repo scan. On Scout, finds exactly one: DR-1 in `src/tools/news-summarize.ts`. It shows red on load.
2. **Plan:** run on the declared dependencies and files in `submit_plan`.
3. **Edit:** run in the `PreToolUse` hook on the imports and writes that the edit would add (diff the `new_string`/`content` against the current file).

## 5. Events

```ts
type HarnessEvent = {
  id: string; t: number;
  session: string;          // coding session id
  turn: string | null;
  kind:
    | 'repo_scanned' | 'map_proposed' | 'map_confirmed' | 'file_assigned'
    | 'violation_found'
    | 'turn_started' | 'looked' | 'cursor'
    | 'planned' | 'plan_violation' | 'fork_asked' | 'fork_answered' | 'plan_approved'
    | 'gate_blocked' | 'edited' | 'edge_added' | 'edge_removed'
    | 'test_result' | 'decision_recorded' | 'turn_ended';
  cell?: { domain: string; layer: string };
  path?: string;
  data?: Record<string, unknown>;   // e.g. { step: 2 }, { added: 18, removed: 2 }, { invariant: 'DR-1' }
};
```

The server appends every event to `.harness/events.jsonl` and broadcasts it over the websocket. The shell holds the array and derives everything from it.

## 6. The coding session

One long-lived streaming session:

```ts
query({
  prompt: chatMessages(),                     // AsyncIterable<SDKUserMessage> fed by the chat pane
  options: {
    cwd: REPO,
    permissionMode: 'plan',
    systemPrompt: { type: 'preset', preset: 'claude_code', append: brief() },
    mcpServers: { harness: harnessTools },    // createSdkMcpServer; user-scope MCP servers (Alike) still load
    allowedTools: ['mcp__interpretability__*', 'mcp__alike__record_decision', 'mcp__alike__resolve_work_item', 'mcp__alike__describe_entity_kind'],
    hooks: { PreToolUse: [...], PostToolUse: [...] },
    canUseTool,                                // intercepts ExitPlanMode for approval
  },
});
```

**`brief()`** contains: the map (domains, purposes, cell paths), every standing decision from `decisions/` (with the invariant it qualifies and the option it rejected), and these rules:

> Before editing anything, call `mcp__interpretability__submit_plan` with numbered steps. Each step lists the exact file paths it will create or modify and any new imports it adds (from path → to path). If the result contains violations, stop and ask the user to choose between the two options it gives, in one short message, then wait. Never work around a violation. After the user answers, resubmit the plan, then exit plan mode.

The brief does **not** list the seeded invariants (`source: cartographer`). They are enforced at plan and edit time instead. Stated up front, they would make the agent comply silently, so the user never sees the choice and nothing gets recorded. Once the user answers a fork, the resulting decision is in every later brief, and the next session follows it without asking. That contrast, asked once and then remembered, is the memory beat of the demo.

**Turn flow:**

1. User message → `turn_started` (record `git rev-parse HEAD` and a `git stash create` snapshot as the baseline).
2. Plan mode: Claude reads (`looked`, `cursor`), then calls `submit_plan`. The server maps paths to cells, builds ghost cells and ghost edges, and runs the checker → `planned` (+ `plan_violation`). The tool result returns the ghost summary and, if violated, the reason plus options A/B with an instruction to ask.
3. Claude asks → `fork_asked`. The user answers in chat → `fork_answered` → decision written (§8). Claude resubmits.
4. Claude calls `ExitPlanMode` → `canUseTool` holds it, the shell shows an **Approve plan** button (typing "approve" also works) → `plan_approved` → allow, then `session.setPermissionMode('acceptEdits')`.
5. Edits: hooks emit `cursor`, `gate_blocked`, `edited`, `edge_added` / `edge_removed`. Ghost cells fill as their files are edited; the step counter advances.
6. Result message → `turn_ended` with the plan-versus-built diff and git `--numstat` totals; write `.harness/turns/<id>.json`; `setPermissionMode('plan')` for the next turn.

**Hooks:**

| Hook | Matcher | Does | Blocking |
| --- | --- | --- | --- |
| PreToolUse | `Read\|Grep\|Glob` | `looked` + `cursor` for the file or search path | no (return `{ async: true }`) |
| PreToolUse | `Edit\|Write\|MultiEdit` | run the checker on the added imports/writes; on a hit return `permissionDecision: 'deny'` with the reason, options and "ask the user"; emit `gate_blocked` | yes, deterministic, < 20 ms |
| PostToolUse | `Edit\|Write\|MultiEdit` | `edited` (+/− lines), recompute that file's imports → edge events | no |
| PostToolUse | `Bash` | if the command ran `vitest`, parse results → `test_result` per test domain (stretch) | no |

**File watcher** (chokidar on the target, minus `ignore`): any write not already reported by a hook becomes an `edited` event marked `unattributed`. Hooks give attribution and gating; the watcher guarantees completeness, since shell commands can write files without passing through the edit hooks.

**Interpretability MCP tools** (all read-only except `submit_plan`, which only records intent): `submit_plan(steps[{ n, text, files[], imports[{ from, to }] }])`, `cell_for(path)`, `domain(id)`, `who_writes(table)`, `decisions_for(paths[])`.

## 7. Plan versus built

- **Ghosts:** planned cells are drawn dashed with their step numbers; planned edges are dashed; a ghost that violates an invariant is red.
- **Fill-in:** a ghost cell turns solid when a file mapped to it is edited.
- **End-of-turn diff:** planned and done is solid; planned and not done stays a ghost; **done but not planned is amber**, which is how the map shows the agent straying from its own plan.
- **New versus existing violations:** a violation found on load is drawn red, with a badge on its cell counting the files involved. A violation raised by this turn's plan or edits must look different from the map before the turn, even when it repeats an existing one (on Scout, the 10-K plan copies `news-summarize.ts` into the same red cell and toward the same provider). Its ghost edge gets its own lane, offset from any solid edge between the same cells, and the cell gets a separate **new** badge naming the file.

## 8. Design memory

When a fork is answered:

1. Write `decisions/DR-<n>.md` with front matter `{ id, title, outcome, status: made, type: standing, invariant, anchors: { paths }, rejected: "<option B text>" }` and a short rationale body.
2. Update `domains.yaml`: link the decision to the invariant (option A), or add the path to the invariant's `exceptions` with the DR id (option B). Commit both files and only those (`git commit -- domains.yaml decisions/DR-<n>.md`), so the coding session's uncommitted edits stay out of the commit.
3. Tell Claude, in the next tool result, to record it in Alike with `mcp__alike__record_decision`, giving it the exact arguments: `title`, `outcome`, `rationale` (including the rejected option), `decision_type: standing`, `status: made`, and one path anchor per governed file, `{ kind: path, label: governs, path, repository: owner/name }` (field names checked with `describe_entity_kind`, see VERIFY.md). Emit `decision_recorded` when the call succeeds.

Memory is then used three ways:

- **Provenance:** clicking an edge or cell shows the decisions and turns behind it ("added in turn 3, DR-4").
- **Session brief:** every standing decision goes into `brief()` for every new session (§6).
- **Rejected options stay rejected:** when a plan or edit hits an invariant that has a linked decision, the violation reason says "You decided this in DR-4: <title>," and the ledger counts it as a rejected option blocked.

## 9. Time ledger and turn summary

Counts only; minutes appear only in the pitch, taken from the baseline run (§12).

| Counter | Definition |
| --- | --- |
| Lines changed | git `--numstat` added + removed, turn baseline → turn end |
| Cells to review | cells with a finding of severity 1–3 below |
| Forks caught before code | `plan_violation` events resolved before any `edited` event in the turn |
| Rejected options blocked | violations that cited an existing decision |

Severity for the turn summary, loudest first: **1** invariant hit (red) · **2** new cross-domain edge or new external (amber, one glance) · **3** unplanned edit (amber) · **4** everything else in the plan (quiet).

## 10. Load and the cartographer

1. `repo_scanned`: full fact scan (§3).
2. If `domains.yaml` is missing, run the **cartographer**: a separate one-shot `query()` with read-only tools, a smaller model, and `outputFormat` set to the `domains.yaml` JSON schema. Input: the file tree, the import edges and the table writes. Ask it for 5–9 domains in product language, layers suited to the repo, and invariants it can infer from the facts (sole importers of a vendor, sole writers of a table, absent edges). → `map_proposed`.
3. The shell plays the map assembling (`file_assigned` events, staggered about 15 ms apart) and shows the proposal; the user clicks **Confirm** → `map_confirmed`, file written. If the proposal is off, load `fixtures/scout-agent.domains.yaml` instead.
4. Full rule scan → `violation_found` (Scout: DR-1 in `news-summarize.ts`, red).

## 11. The shell

- **Layout:** chat pane on the left (380 px); the grid fills the rest; the turn summary and replay scrubber sit under the grid; the ledger sits top right. The mockups are in Figma, "v2 · Domain grid" page.
- **Cell states:** looked = dashed indigo outline · edited = indigo fill · unplanned = amber · invariant hit = red · ghost = dashed outline at 50% opacity with step badges.
- **Agent cursor:** a small avatar pinned to the current cell, labeled "Claude · reading `retrieve.ts`", easing between cells in 250 ms.
- **Edges:** SVG overlay routed through the gaps between cells; new edges draw in with a stroke-dashoffset animation.
- **Diff counts:** a +/− badge on each edited cell, ticking up.
- **Inspector:** click a cell or edge to see its paths, tables, invariants and provenance.
- **Replay:** a scrubber over the event index; dragging re-reduces the log.
- **Motion rule:** animate only state changes; nothing loops.

## 12. Baseline run, for the pitch

Copy `scout-agent` at the demo commit. In plain Claude Code, run "Add a tool that summarizes a prospect's latest 10-K." Time it, then run `npm run proof`. If the new tool leaks personal data, time a follow-up turn that finds and fixes it. Those minutes are the "without" numbers the pitch converts the ledger into. If the baseline doesn't make the mistake, drop that comparison and lean on lines-to-review and memory.

## 13. Build order and acceptance checks

| # | Build | Done when |
| --- | --- | --- |
| 0 | **Verify first** (30 min) | (a) a custom MCP tool can be called in plan mode; (b) `canUseTool` receives `ExitPlanMode`; (c) after a hook deny with "ask the user," Claude asks instead of retrying; (d) the Alike MCP login from Claude Code is available inside an SDK session. Write results in `VERIFY.md`. Fallbacks: (a) require the plan as a fenced JSON block in the `ExitPlanMode` plan text and parse it; (b) approve via a chat message and switch mode on the next message. |
| 1 | `packages/core` | Unit tests pass; scanning Scout (or a small fixture copy until it exists) finds exactly one violation, DR-1 in `src/tools/news-summarize.ts`, and none in test files. The fixture covers extensionless, `.js` and directory-index imports. |
| 2 | Server + chat pane | Chatting with Claude Code from the browser works, with responses streaming. |
| 3 | Grid from the fixture map | Grid renders Scout with derived cross-domain edges; the DR-1 cell is red. |
| 4 | Live footprint | Reads move the cursor and mark cells; edits fill cells; a new import draws a new edge. |
| 5 | Plan flow | "Add a tool that summarizes a prospect's latest 10-K. Do it the way news-summarize does, so the figures come through exactly." produces ghosts (the bare prompt usually goes through the gateway with no fork; this one forked 3 of 3 on Scout); a gateway bypass in the plan shows red, distinct from the existing DR-1 edge, and Claude asks A/B; answering, approving and building fills the ghosts; anything unplanned ends amber. If Claude plans through the gateway without noticing that redaction mangles the filing's figures, the fork can't happen: note it in `VERIFY.md` and fall back to the edit gate, which fires when it reaches for the provider during the build. |
| 6 | Edit gate | An edit that adds a forbidden import is denied and Claude asks. |
| 7 | Memory | Answering writes the DR file and updates `domains.yaml`; Alike `record_decision` succeeds; edge provenance shows the DR; a fresh session asked to "add a tool that summarizes earnings call transcripts" (served by `vendor/news`) either follows DR-4 without asking, citing it, or gets blocked with "You decided this in DR-4." |
| 8 | Ledger, summary, replay | Counters match §9; the scrubber replays a full turn. |
| 9 | Cartographer + load animation | Loading Scout without `domains.yaml` proposes a usable map and DR-1 to DR-3; confirm writes the file. |
| 10 | Polish | Edge draw-in, easing, empty and error states. Record the backup video and the baseline run. |

## 14. Not today

Gestures, the editor extension, adapters for other agents, multiplayer, Keewano, Sparta, Graphify, the journeys and wiring-trace levels, cartographer drift triggers, scope inference from the prompt.
