# Harness navigation: build plan for the context graph

**Text in, architecture out, at every depth.** Today the map is one fixed level: a domain × layer grid. This plan turns it into a navigable context graph. You can move from journeys to domains to files to functions to code without losing your place, and the agent's live activity (reading, planning, editing, getting blocked) stays visible and rolled up at whatever depth you are looking at.

This plan extends `SPEC.md`; it does not replace it. Every rule in `CLAUDE.md` still holds: no model calls in the hot path, UI state is a reduction of the event log, one checker with three call sites, and Harness writes only to `domains.yaml`, `decisions/` and `.harness/` in the target.

Research behind this plan (October 2026): three surveys covering interaction and visual references, rendering and layout tech with benchmarks, and code-fact extraction with benchmarks. Their key numbers are quoted inline. Their sources include Sourcetrail, Structurizr/C4, IcePanel, Nx, Kiali, Windsurf Codemaps, van Wijk & Nuij 2003, Heer & Robertson 2007, Furnas's degree of interest, Holten's edge bundling, and Wedge.

## 1. Principles

1. **One fact graph, one containment tree, many projections.** There is a single graph:
   - *containment*: repo → domain → cell → file → symbol, plus tables, vendors, routes and entries;
   - *leaf edges*: imports, calls, writes, handles, uses, implements.

   Every level is a projection of that graph through the current *view*, meaning which nodes are expanded and where the focus is. Nothing is maintained twice. The Build Plan already called the levels rollups of one fact graph; this makes it literal.
2. **One coordinate system.** The domain × layer grid stays the anchor at every depth.
   - Expanding a domain widens its column in place. The other columns compress into thin spines that keep their badges.
   - Cells open *inside* the cell. A normal change stays a vertical stripe at every depth.
   - Spatial memory is the point. Kuhn et al. found that layouts clustered by topic confuse people; a stable cartographic layout helps them. Separate pages per level, as in Structurizr, lose your place every time you drill down.
3. **Depth is local, formalized as degree of interest (DOI).** What is visible is decided by an interest score with a budget.
   - Interest = how important a node is (planned, violating, the agent is there, edited this turn) minus its distance from your focus.
   - Expand until the budget is spent: about 20–30 detailed nodes in focus and at most about 50 visible entities. Path-finding gets hard above 50 nodes in dense graphs.
   - DOI decides *what* is visible. It never distorts geometry: Cockburn found fisheye distortion hurts target acquisition.
4. **Edges and activity roll up to the nearest visible ancestor.**
   - A rolled-up edge carries a count and its kinds, and the worst status by **max, never average** (Elmqvist & Fekete's aggregation guidelines). A violation three levels down is red at System level.
   - The agent cursor sits on the deepest visible ancestor of the file it is touching.
   - Edges that cross out of an expanded container leave through *ports* on its border (stubs).
5. **Facts win on structure, determinism first.**
   - Syntax facts are synchronous and cheap, and feed the gate and the live map.
   - Semantic facts (typed calls) are asynchronous and never block.
   - Model output (cartographer labels and proposals, auditor findings) is labelled as inferred. Structural changes need your confirmation, and nothing a model produces is trusted silently (§4).
6. **Motion encodes state changes only.**
   - Transitions are staged and interruptible, about 650 ms total. Heer & Robertson recommend about 1 s and "as long as needed, but no longer".
   - Nothing loops.
   - `prefers-reduced-motion` is honoured.

## 2. Levels

| Level | What you see | Built from | Entered by |
| --- | --- | --- | --- |
| **Journeys** | A numbered flow drawn *over* the System map, e.g. "Start research: UI page → `POST /api/runs` → run loop → tools → gateway → OpenAI". It plays back step by step and can branch. | Entries (routes, CLI, UI pages, `bin`), fetch → route matching, wiring traces. The cartographer names journeys; you confirm them. | Journey list (left rail) or ⌘K |
| **System** | The domain × layer grid, as today. Edges between domains carry a count and the worst status. | `domains.yaml` + facts | Default |
| **Domain** | One column expanded. Its cells become containers holding files, tables, vendors and routes, with edges inside the domain. Ports lead to the other columns, which are compressed. | Facts within the domain, ELK layout per cell | Double-click a column or cell, Enter, ⌘K |
| **Module** | One file expanded into rows for its symbols (functions, classes, methods, exported consts, routes). Call, write and use edges, one hop out. | Symbols and calls (syntactic first, typed later) | Double-click a file |
| **Code** | A docked code pane (CodeMirror 6) opened at the symbol. Gutters show this turn's diff, plan step badges and inline violations. | File text, the turn baseline, events | Double-click a symbol, or a path link in chat |

Two things cut across the levels:
- **Wiring trace.** Pick an entry or symbol and Harness computes the call chain to its sinks (vendors, tables). It expands only along that path and dims everything else.
- **Turn lens.** "This turn only" hides everything the current turn didn't plan, read or edit.

## 3. Architecture

```
target repo ──► Tier 1 facts (sync, oxc) ──┐                         ┌──► edit gate: check(map, delta)  (unchanged)
   │                                        ├──► ContextGraph (core) ─┤
   └──────────► Tier 2 facts (async, tsgo) ─┘        ▲                └──► project(graph, view, activity) ─► shell
                                                     │                          ▲
event log ── reduce ─► activity per leaf ────────────┘          view state: expanded, focus, lens, follow
     ▲
     └── cartographer + auditor (async agents, §4): drift → proposals, labels, findings ── you accept / reject
```

### 3.1 Facts (server)

**Tier 1: syntax facts.** Synchronous and per file. Target ≤ 5 ms per file, with a hard cap of 20 ms because the edit gate uses them.

- **Parser: oxc-parser** replaces the regex parser.
  - Measured on Scout, hono and excalidraw: 0.09–0.26 ms mean per file for imports and exports, and 0.4–1 ms with a full walk for symbols and calls.
  - The current regex takes **42 ms on one 972 KB generated file, so the gate takes over 80 ms**. That is a live bug (fix in N1).
- **Resolver: oxc-resolver** handles tsconfig `paths`, package `exports`/`imports` and workspaces, at 3–6 µs per import.
  - On excalidraw it resolves 3,347 of 4,096 imports; today's resolver gets 2,396.
  - Planned files that don't exist yet fall back to get-tsconfig `createPathsMatcher` plus the current resolver.
- **One pass collects:** imports and exports (with type-only flags), symbols, call sites (enclosing symbol and callee shape), writes, routes, and SQL literals.
- **Syntactic call edges** come from import bindings. Against typed edges on Scout they score 91–97% precision and 68–88% recall; the misses are mostly method calls.
- **Adapters:**
  - Writes: Scout's `db.insert/update`, Prisma, Drizzle, Knex, raw SQL (TypeORM comes in Tier 2).
  - Routes: Express, Hono, Fastify, Koa, and Next.js `app/` and `pages/`.
  - Entries: package.json `bin`/`scripts`, routes, UI routes.
  - Custom routers (like Scout's table of routes) use a pattern the user confirms in `domains.yaml`.
- **Size cap:** files over ~500 KB or minified use only the import/export record (2.6 ms at 972 KB).
- **`check()` keeps its signature.** The gate still checks only imports and writes. A `calls` field can be added to `FactDelta` later.

**Tier 2: semantic facts.** Asynchronous, in a child process, never blocking.

- **TypeScript 7 `typescript/unstable/sync`** (tsgo), pinned to 7.0.2, behind a `SemanticResolver` interface. The fallback is the TS 6 LanguageService (ts-morph).
  - Measured: opens a project in 0.07–0.42 s, and re-resolves a changed file in 1–8 ms.
  - The 7.0 blog says the API officially arrives in 7.1, which is why it is pinned and wrapped.
- **Produces** `calls` edges with `confidence: typed`, plus `implements` edges. Implements links a registry like Scout's `Tool.run` to its implementations, so traces can pass through dispatch.
- **Per file:** debounce ~150 ms, then `updateSnapshot` and re-resolve.
- **Results arrive as events** keyed by content hash. The reducer ignores results for stale hashes.
- **Python and Go (N11):** web-tree-sitter for syntax; pyright or gopls for semantics only when that toolchain is installed.
- **Rejected:**
  - stack-graphs: archived in September 2025.
  - SCIP: batch only, so at most for CI.
  - Graphify: name heuristics written in Python. It is a reference, not a dependency.

**Ids stay stable across edits.** They never contain line numbers.

| Kind | Id example |
| --- | --- |
| file | `src/tools/news-summarize.ts` |
| symbol | `src/tools/news-summarize.ts#newsSummarize.run` (`~2` for duplicates, `<cb1>` for anonymous callbacks) |
| route | `route:POST /api/runs` |
| table | `table:runs` |
| vendor | `vendor:vendor/llm-openai` or `vendor:@anthropic-ai/sdk` |
| entry | `entry:bin/scout`, `entry:page:/runs/{}` |
| journey | `journey:<slug>` |

Edge kinds:
- `contains`
- `imports` (with a typeOnly flag)
- `calls` (with `{ confidence: syntactic | typed | dispatch, count }`)
- `implements`
- `handles`
- `writes` and `reads`
- `uses`
- `fetches`
- `starts`

**Which symbols an edit changed.** Each symbol gets two hashes:
- `sigHash`: its normalized signature;
- `bodyHash`: its whitespace-normalized body.

Compare them before and after the edit to classify each symbol as added, removed, signature changed, body changed, or renamed. Renamed means removed plus added with the same `bodyHash`. Measured cost is 1.6–2.4 ms per file, done in PostToolUse, which doesn't block. `edited` events gain `symbols: { added, removed, sig, body, renamed }`. Diffing a file's outgoing edges gives `call_added` and `call_removed` events, which work like `edge_added`.

**Facts in the log stay pure.** Large fact sets go into content-addressed blobs under `.harness/facts/<hash>.json`, and events reference those blobs. The blobs never change, so replay stays a reduction. Events are snapshotted every N events so replay stays fast (N11).

### 3.2 Core model (`packages/core`, pure, tested)

- `buildGraph(map, facts, semantic?) → ContextGraph` builds the containment tree and the leaf edges. Files group by directory inside a cell when a cell holds more than about 12 files.
- `ViewState = { expanded: Set<id>, focus: id | null, lens: { kinds, turnOnly }, budget, follow }` is view-only state that lives in the shell. Replay reproduces the graph and activity. It reproduces the camera too, if we choose to log view events (decision D5).
- `project(graph, view, activity) → Projection` returns:
  - visible nodes, with rolled-up activity: looked, edited, +/−, ghost steps, worst violation (new or existing), cursor present, and counts;
  - aggregated edges, with count, kinds, worst status, ghost or new, and their own lane;
  - ports for edges that cross a boundary.
- `autoExpand(graph, activity, focus, budget) → expanded`: the DOI expansion used by Follow mode and the opening view.
- `trace(graph, from, sinks) → path[]`: shortest paths over `calls ∪ implements ∪ handles`. Hops within one cell are collapsed, and interface dispatch shows as "via registry".
- **Parity:** today's `cellViews` and `edgeViews` become `project()` with nothing expanded. Property tests over the demo log prove they give identical output.
- The activity reducer adds per-file and per-symbol state alongside the per-cell state it already tracks.

### 3.3 Renderer (`apps/shell`)

- **React Flow 12.12** (pinned `~12.12`; 13 is in prerelease) hosts the viewport and the DOM nodes.
  - Node components are memoized per id and subscribe to their own slice of the projection.
  - Edges are one SVG layer of precomputed paths: the existing gutter router at System level, and ELK's orthogonal sections inside containers.
  - Measured: zooming 500 nodes and 750 edges takes 4.5 ms per frame at p50. MIT licence. LikeC4 does drill-down on the same stack.
- **Layout:**
  - The top grid keeps today's deterministic `layout.ts`, with track sizes driven by the expanded children.
  - Each expanded container is laid out by **elkjs layered, one run per container, in a Web Worker**, bottom-up. Measured at about 100 ms for 500 files. One global hierarchical run took 2.4 s at 500 files and 11.5 s at 2,000.
  - Edgeless leaf sets use a `d3-hierarchy` treemap or ELK `rectpacking`.
  - Stability:
    - fixed node sizes per kind and level of detail;
    - input sorted by stable id, with `considerModelOrder` / `forceNodeModelOrder`;
    - a fixed seed, and interactive strategies when files are added live;
    - a cache keyed by a hash of the container, its children, its edges and the elkjs version;
    - vitest checks on how far positions move.
- **Transitions:** an xstate-style machine (as LikeC4 uses), cancellable at any point.
  1. Request the layout; the old frame stays on screen.
  2. 0–150 ms: fade out the edges that will change and the collapsing children.
  3. 150–450 ms: commit once, then **FLIP** the nodes with the Web Animations API, while the camera runs `fitBounds` in parallel. Measured at 3.6 ms per frame, against 40 ms per frame for calling `setNodes` every frame.
  4. 450–650 ms: new children fade in and edges draw in.
- **Camera:**
  - It follows the van Wijk & Nuij smooth zoom-and-pan path (ρ ≈ √2, via `d3.interpolateZoom` or React Flow's `interpolate: 'smooth'`, to be verified).
  - It is recomputed every frame, so Follow mode can retarget it mid-flight.
- **Level of detail by zoom bucket:**
  - far: chips with a fill and a count;
  - mid: titles;
  - near: full content and symbol rows.

  Domain and layer headers render in screen space so they stay crisp. Labels hide below 16 px, and only the focused node's children are labelled.
- **Navigation chrome:**
  - breadcrumbs (Journey › Domain › Cell › Module › Symbol);
  - back/forward history;
  - a hideable minimap (80% of users preferred having one);
  - ⌘K over domains, files, symbols, routes, decisions, turns and plan steps;
  - keyboard: arrows move between spatial neighbours, Enter dives, Esc goes up, `f` toggles Follow, `t` toggles the turn lens.
- **Off-screen activity** gets **Wedge** indicators, which were more accurate than Halo and arrows in the study.
- **Large views:**
  - above about 1,000 visible nodes, the least interesting containers auto-collapse and everything drops to chips;
  - above about 3,000, Harness switches to a **Sigma.js v4** read-only overview (WebGL) fed from the same layout cache (N11).
- **Rollout:** the old grid stays behind `?map=v1` until N3 reaches parity.

### 3.4 Agent-aware navigation: the graph as shared context

- **Follow Claude.** The view auto-expands around where the agent is working, and the camera follows it with hysteresis: it moves only when the agent's visible ancestor changes. Any manual navigation stops following, with a "Following Claude · Stop" pill as in Figma.
- **Point.** Shift-click nodes to add them as chips in the composer. The message then carries the resolved paths and symbols. This was the Build Plan's "click cells to make them nouns".
- **Links back.** Paths and symbols in Claude's replies become links that fly the camera there. Plan steps in the approval card do the same.
- **Plan ghosts at every depth.** `submit_plan` steps can name symbols (`path#symbol`), so ghosts appear at Module level too. The step counter tracks individual files, not cells.
- **Blocked is unmistakable.** `gate_blocked` and `fork_asked` stand out at every zoom level, and a Wedge points at them when they are off screen.
- **Agent tools.** Extend the read-only harness MCP tools with `graph_neighbors(id, kinds, hops)`, `trace(from, to?)` and `symbols_in(path)`, so Claude queries the same graph you look at. These answer from the graph without any model call, and nothing about them goes into the brief.

## 4. The living map: mapping and updating in production

The map has three owners, and only one of them is a model that maintains it:

| Layer | Owner | Updated |
| --- | --- | --- |
| **Facts:** files, imports, calls, writes, routes | Deterministic code (Tier 1 and Tier 2) | On every edit, in milliseconds. Never a model. |
| **Intent:** plans, fork answers | The coding agent proposes, the checker verifies, you decide | Every turn |
| **Meaning:** domains, boundaries, names, rules, journeys | **The cartographer**, a dedicated agent that runs continuously and proposes; you confirm | When drift is detected, at turn end, and when the repo is idle |

The coding agent never maintains the map: it is the thing being observed, and bookkeeping would cost its context. A second agent, the **auditor**, reads finished turns against your standing decisions and raises advisory findings. Neither agent ever blocks the coding session.

### 4.1 Four clocks

| Clock | What runs | Latency | Can block Claude? |
| --- | --- | --- | --- |
| **Per edit, sync** | Tier 1 facts for the edited file, the edit gate, map events (`edited`, `edge_added`, symbol diff) | ≤ 20 ms | Only the gate, deterministically |
| **Per edit, async** | Tier 2 typed calls for that file; label refresh for symbols whose `bodyHash` changed | 150 ms – 2 s | No |
| **Per turn end** | Drift metrics (deterministic); the cartographer, if a signal fired; the auditor's review of the turn | Seconds | No. Results queue as proposals and findings |
| **Idle or big change** | Full re-survey: the cartographer generates and scores candidate maps over all history. Triggered by idle time, a merge or branch switch, or a new package | Minutes | No |

Your accept/reject of a proposal runs on human time and never holds up a turn.

### 4.2 Onboarding a repo

1. **Instant skeleton (under 1 s, no model).** Tier 1 scans the repo. A deterministic first map (one domain per top-level source folder, layers from folder-name heuristics) renders straight away, so you are never looking at a spinner.
2. **History mining (seconds, no model).** `git log` provides co-change pairs (files changed in the same commit) and "commit footprints". Commits act as stand-in turns, so the map can be scored before Harness has run a single turn.
3. **Cartographer proposal (about a minute, model).** It generates K candidate maps (default 4). Each is scored deterministically (§4.5), and the best is shown assembling on the grid with its scores, for example "a typical commit lights 1.8 cells; 0 files unassigned".
4. **You confirm** (or pick another candidate, or edit in chat: "merge Memory into Agent loop"). `domains.yaml` is committed.
5. **Background fill-in.** Tier 2 indexes typed calls. The cartographer adds inferred labels: sub-group names inside domains, one-line symbol summaries, journey names.

### 4.3 Steady state while you build

| Happens during a turn | Deterministic update (immediate) | Model follow-up (async) |
| --- | --- | --- |
| Edit to a file already in a cell | Facts, edges, symbol diff, activity | Re-summarize changed symbols (cached by `bodyHash`) |
| New file that matches a cell's globs | Placed in that cell | Label it, if it starts a new sub-group |
| New file that matches nothing | Unassigned, with an instant faint guess ("probably Billing?") from its folder siblings and the majority domain of what it imports | Placement proposal at turn end |
| New folder or workspace package | Unassigned, and the guess is shown | A proposal at turn end for a new domain or a new cell |
| `submit_plan` | Ghosts, plan check | The plan text goes to the cartographer as intent context (purposes, sub-group names) |
| Fork answered | DR file, `domains.yaml` update (committed) | The auditor and cartographer read the new decision |
| Turn ends | Drift metrics recomputed | If a signal fired: scoped cartographer run, then a proposal. Auditor review runs either way |

The cartographer never runs on half-finished edits. Its proposals wait for `turn_ended`, and the only thing shown mid-turn is the instant deterministic guess.

### 4.4 Drift signals

These are deterministic and computed from facts plus the event log. Thresholds are configurable under a `cartography:` key in `domains.yaml`. A signal must persist across two turns before it triggers anything, so one odd turn doesn't cause churn.

| Signal | Metric | Default threshold | Likely proposal |
| --- | --- | --- | --- |
| Unplaced code | Files in Unassigned after `turn_ended` | > 0 | Place them, or add a cell or domain |
| **Turns too wide** | Median cells lit per turn over the last 10 turns (the Build Plan's size test, now measured) | > 3 | Re-cut domains |
| **Co-change across a boundary** | File pairs in different domains edited together in ≥ 3 of the last 20 turns or commits | Any pair | Move a file, or merge two domains |
| Coupling growth | Cross-domain edges between one pair of domains | +50% or +5 files since the map was confirmed | Review that boundary |
| Rule erosion | An invariant's exceptions, or option B answers to it | ≥ 3 exceptions, or B chosen twice | Loosen, split or retire the rule |
| Rule reinforcement | The same decision pattern (A on the same invariant for similar files) | 3 times | Propose a standing rule (auditor) |
| Bloated cell | Files in a cell | > 25, or > 40% of its domain | Split the cell or add sub-groups |
| New top-level code | New top-level folder or workspace package | Any | New domain |
| Stale label | A symbol's `bodyHash` changed since its summary was written | Any | Regenerate automatically |

### 4.5 The cartographer

**Runtime.** A separate Agent SDK session out of process, on the strongest model at high effort.
- Tools: read-only file tools plus the harness graph tools (`graph_neighbors`, `trace`, `symbols_in`, and new `map_metrics` and `history`).
- Settings: no user settings and no write tools.
- It never edits product code, never touches the coding session, and never changes `domains.yaml` without your accept.

**Input, scoped to the trigger:**
- the affected domains plus one hop;
- recent turns (prompts, plans, footprints);
- standing decisions and their rationale;
- git co-change;
- the current `domains.yaml`;
- **every proposal you have rejected**, which it must not repeat.

**Output** is structured JSON. The schema covers:
- placements;
- cell moves;
- domain new, split, merge or rename;
- purpose rewrites;
- rule add, retire or loosen;
- labels: sub-groups, symbol summaries, journey names.

**Candidates are scored deterministically, not by the model's own opinion.** Each candidate is scored by `scoreMap(map, facts, history)` in core, which is pure and tested:
- mean and median cells lit when past turns and commits are replayed against the candidate;
- modularity of the import graph across the candidate's domains;
- unassigned count, and how unevenly cell sizes are spread;
- how many existing decisions it would break;
- churn: how many files move, and how many ids change.

Only a candidate that beats the current map by a margin is shown, and between similar scores the smaller change wins.

**Stability rules:**
- A rename keeps the `id`; only the `name` changes.
- Moving files is preferred over re-cutting domains.
- At most one structural proposal is pending per domain.
- An accepted proposal never reshuffles layout outside its scope. The per-container layout cache (§3.3) guarantees this.

**Proposals use the same UI as plans.**
- The change is shown as ghosts: a proposed column dashed, files sliding in preview to their proposed cells, a rule badge dashed.
- Scores sit next to it: "turns would light 2.1 cells instead of 4.3 · 3 files move · no decisions broken".
- In chat you can accept, reject or amend ("yes, but call it Billing").
- Accepting writes and commits `domains.yaml` and emits `map_confirmed`.
- Rejecting is recorded as a decision (`decisions/DR-n.md`, `status: rejected`), so the cartographer never proposes that change again. This is the same "rejected options stay rejected" memory that forks use.

**Labels are applied automatically and marked as inferred.**
- Sub-group names, symbol summaries and journey names carry no rule weight. They are stored as content-addressed files under `.harness/labels/` and shown with an "inferred" marker.
- Confirming one moves it into `domains.yaml` (cells gain optional `components: [{ id, name, paths }]`).
- Each label is regenerated only when the hash of what it describes changes.

### 4.6 The auditor

**When it runs:**
- **after every turn**, on the turn's symbol-level diff, plan, decisions and fact delta;
- optionally **on each submitted plan**. Its note appears on the approval card while you read it; it never blocks Approve.

**What it checks:** whether the work contradicts your standing decisions in ways the three rule kinds can't express. For example: "DR-4 says filings go through the gateway with `redaction: "filings"`; `src/tools/filing-summarize.ts:31` calls `complete()` without it."

**Output:**
- **Advisory findings**, each with a confidence, the lines it refers to, and the decision it cites.
- They show as an "audit" badge (amber outline, inferred marker) at every level and are counted separately from the exact ledger.
- You can dismiss a finding (recorded, so it won't come back) or **promote** it into an enforced rule. Promoting goes through the cartographer's proposal flow.

**Rule mining:** when the same choice keeps being made (reinforcement, §4.4), it proposes making that choice a standing rule.

### 4.7 Events

The new events are all in the log, so the UI is still a reduction and replay covers maintenance too. Large payloads such as candidate maps and label sets live in content-addressed blobs that events reference.

- `drift_detected { signal, metric, value, threshold, scope }`
- `map_proposed` (extended): `{ proposal: id, trigger, candidates: blob, chosen, scores, changes, rationale }`
- `map_proposal_resolved { proposal, outcome: accepted | rejected | amended, decision? }`
- `labels_updated { blob, scope }`
- `audit_finding { id, decision?, files, lines, text, confidence }` and `audit_resolved { id, outcome: dismissed | promoted }`
- `maintenance_run { agent: cartographer | auditor, trigger, ms, cost }`. This feeds a separate Maintenance panel and never the ledger.

### 4.8 Guarantees

1. **Claude never waits on any model but itself.** The gate stays deterministic, and maintenance agents run out of process.
2. **The structure of the map changes only with your consent.** Every change is a commit to `domains.yaml` with a decision record, so it can be reviewed in a PR like any other change.
3. **Everything a model produced is marked inferred and cites its source.** Confidence is always visible.
4. **Map quality is measured, not asserted.** Turn width, co-change across boundaries and unassigned count show in a small map-health readout, and a trend over turns tells you when the map is going stale.
5. **It degrades gracefully.** If the cartographer or auditor is down, the map stays exact and live; only new labels, proposals and findings stop.

### 4.9 Teams and branches

- **The map lives in git.** `domains.yaml` and `decisions/` live in the repo, so each branch has its own map, and switching branches reloads it (an idle-clock trigger). Map changes from teammates arrive through ordinary PRs, with small diffs from the minimal-edit writer.
- **Conflicts are proposals.** Two people's accepted proposals that conflict in `domains.yaml` are resolved like any merge conflict. The cartographer can propose the merged map.
- **Multiplayer** (vision): one shared live map, with each teammate's agent as a separate cursor. The cartographer runs once per repo, not per person.

## 5. Visual direction (decision D1)

1. **Atlas (cartographic blueprint).** Calm and print-like.
   - Nested containers separated by hairlines, with one step of elevation per level.
   - A lightness ramp by depth (LCH theme from three inputs: base, accent and contrast).
   - Orthogonal edges routed through ports.
   - Map-style label placement with 300 ms fades.
   - **The agent is the only saturated colour.** Red and amber are reserved for rules.
   - Risk: it can look static, so liveness depends on small cues.
2. **Control Room (live telemetry).** Dark mission control in the spirit of Kiali and Datadog: dots flowing along active edges, arc rings showing each domain's status mix, glow on focus.
   - Risks: it turns into a Christmas tree, glow competes with violation red, and **continuous flow breaks the "nothing loops" rule**.
3. **Strata (depth-of-field canvas).** You literally fly into a cell.
   - Parent levels fade to about 10% opacity with a slight blur.
   - Typography changes with zoom.
   - The camera moves first, then the expansion happens, then edges appear.
   - Risks: blur is expensive, and it's easy to get lost without strong breadcrumbs and Wedges.

**Recommendation:** use Atlas as the base system, add Strata's camera and depth fade for transitions, and borrow one thing from Control Room: a single pulse that travels once along an edge when it is used or added, never looping.

## 6. Phases

| # | Build | Done when |
| --- | --- | --- |
| N0 | **Spike** (1–2 days, alongside N1/N2) | React Flow + ELK in a worker + FLIP + the camera, on real Scout facts and real node components. Research Tools expands from System to Domain level with ports. Zooming 500 nodes stays under 16.7 ms per frame at p95; a transition commit takes under 50 ms; the camera path is verified. Three static design comps (Atlas, Control Room, Strata) go to you for D1. Go/no-go on the stack. |
| N1 | **Tier 1 facts on oxc** | oxc-parser and oxc-resolver replace the regex parser and resolver, keeping `check()`'s signature. The gate stays under 20 ms on the 972 KB file. Path aliases and workspaces resolve. Symbols, syntactic calls, routes and write adapters work. Edits report which symbols changed. All 49 existing tests pass, plus new ones. Scout still has exactly one violation on load. |
| N2 | **ContextGraph, `project`, `autoExpand`** in core | Pure and tested. Parity tests show that `project()` with nothing expanded gives exactly today's `cellViews` and `edgeViews` on the demo log. Rollups use max severity. Ports and edge aggregation are covered by unit tests. |
| N3 | **New renderer at System parity** | Every current state works on React Flow: looked, edited, ghost, unplanned, existing and new violations, cursor, diff badges, edge lanes, inspector, replay and ledger. The demo turn looks at least as good as v1, which stays behind `?map=v1`. |
| N4 | **Domain level** | Expand and collapse in place. Sibling columns compress into spines. Ports and stubs. Aggregated edges show counts and the worst status. Staged transitions. Breadcrumbs, history, ⌘K, keyboard, minimap. Positions move less than a set threshold across edits (vitest). |
| N5 | **Living map: drift signals + cartographer** | `scoreMap` and every drift metric in core, pure and tested, including replaying past turns and git history. On a Scout copy, adding `src/billing/` with three files gives an instant faint guess mid-turn, then at turn end a scored proposal ("new domain Billing") shown as ghosts. Accept commits `domains.yaml`. Reject records a decision and is never proposed again. Onboarding produces the instant skeleton, then K scored candidates. Inferred sub-group labels appear in Domain view. |
| N6 | **Module level + Code pane** | Symbol rows and call edges (syntactic). Each symbol shows its own state (edited, ghost, violation). The CodeMirror pane shows the turn diff and step badges. A plan that names `path#symbol` shows symbol ghosts. |
| N7 | **Agent-aware navigation** | Follow Claude with hysteresis. Wedge indicators. Point → chips in the composer. Path links in chat. Blocked and fork states are visible at every level. The demo turn can be watched hands-free in Follow mode. |
| N8 | **Tier 2 semantic facts + Trace** | A tsgo child process sends typed calls and implements as events keyed by content hash. Edges are styled by confidence. Trace mode finds `routes.ts → … → vendor/llm-openai` through the tool registry. The agent's graph tools work. |
| N9 | **Auditor** | After each turn, findings are checked against standing decisions. On Scout, a filings tool that calls `complete()` without `redaction: "filings"` produces an advisory finding that cites DR-4 and the line. Dismiss is recorded. Promote turns it into a rule proposal. The ledger counters don't change. Optional plan review shows a note on the approval card. |
| N10 | **Journeys** | Entries are discovered, fetches are matched to routes, and journeys are computed. The cartographer names them asynchronously and you confirm. Overlay with numbered steps and playback. "Start research" on Scout plays end to end. |
| N11 | **Real-world scale and languages** | tree-sitter for Python and Go. A cartographer for large repos that works from sampled directory summaries. The Sigma overview above 3,000 nodes. Log snapshots. Performance budgets checked in CI. Tried on hono and excalidraw-sized repos. |

N0, N1 and N2 can run in parallel. N3 starts after the N0 go/no-go. N5 needs N4, because proposals render as ghosts in the expanded views; its scoring and metrics (core only) can start alongside N2. The hackathon demo keeps working on v1 throughout.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Layout jumps on small changes, losing the mental map | Layout per container, model order, fixed sizes, cache, interactive strategies, and position-delta tests |
| TS 7's API is officially unstable until 7.1 | Pin 7.0.2 behind `SemanticResolver`, with a TS 6 fallback. Tier 2 is optional; everything works on Tier 1 |
| oxc is pre-1.0 and ships weekly | Pin it. Its AST follows the ESTree shape, which limits churn |
| Performance falls short of the headless benchmarks | N0 spike on target hardware with real node components; budgets checked in CI |
| Edge clutter at Domain level | Aggregate edges, show only the focused node's edges by default, add lenses, and show counts as stroke width |
| Dynamic dispatch (registries, DI, events) breaks traces | `implements` edges; show `dispatch`/`inferred` confidence; never present a trace as complete |
| The event log grows large | Content-addressed fact blobs and snapshots |
| Licences | elkjs is dual EPL-2.0/GPL-3.0; using it unmodified is fine (get a legal check before shipping). libavoid is LGPL, optional and dynamically loaded. Avoid Cosmograph's CC-BY-NC packages and tldraw, which needs a licence key |
| The cartographer churns the map (a constant stream of proposals, or boundaries that keep moving) | Signals must persist across two turns; a proposal must beat the current map's score by a margin; one pending proposal per domain; rejections are permanent; churn counts against a candidate's score |
| Auditor false positives cause alert fatigue | Advisory only, with confidence shown; dismissals are permanent; findings sit outside the ledger; tune it on recorded turns before turning it on by default |
| Maintenance agents' cost and time on big repos | Scoped runs (affected domains plus one hop); content-hash caches for labels; full re-survey only when idle |
| Scope | Each phase leaves something you can demo; v1 stays the fallback |

## 8. Decisions for you

- **D1 Visual direction:** Atlas, Control Room, Strata, or the recommended hybrid. N0 produces comps to choose from.
- **D2 Navigation model:** the recommended nested grid driven by DOI (one coordinate system, expand in place), or a free infinite canvas with continuous semantic zoom (more cinematic, easier to get lost in).
- **D3 Semantic tier:** accept TS 7's unstable API, pinned with a fallback (recommended), or stay on TS 6 / ts-morph (stable, slower, more memory).
- **D4 Order:** agent-aware navigation (N7) before or after the living map (N5) and the deep levels (N6)? Recommended: N5 first, because it closes the gap in keeping meaning current; move N7 up if the demo matters sooner.
- **D5 Camera in replay:** should replay reproduce where you were looking? That means logging view events, and the camera becomes part of the record.
- **D6 Motion rule:** keep SPEC §11's "nothing loops". This rules out continuous particle flow.
- **D7 Labels:** apply inferred labels automatically (recommended, marked as inferred), or require confirmation for every label too?
- **D8 Auditor on plans:** review each submitted plan, adding a few seconds before its note appears on the approval card without blocking Approve, or review only finished turns?
- **D9 Drift thresholds:** start with the defaults in §4.4 and tune them on recorded Scout turns, or keep proposals manual-only ("re-map" button) at first?
