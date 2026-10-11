# Diagram-First Coding Harness — Hackathon Build Plan

Oct 10, 2026 · @John

The harness is a diagram-first shell on top of Claude Code: you talk to the agent in chat, a domain × layer map shows what each turn does to your system, and the agent stops and asks when it's about to cross an invariant.

**For the build, two specs are the source of truth as of Oct 11:** `SPEC.md` (the harness) and `DEMO_REPO_SPEC.md` (Scout, the demo repo). This doc keeps the reasoning behind them.

## Decision log

Everything below was decided on Oct 10; newest first. The sections after this reflect the current decisions.

| Decision | Why | Replaces |
| --- | --- | --- |
| Demo repo is Scout, an agentic sales research system with mocked APIs | Representative of what an AI audience builds; the gateway rule reads instantly; one existing gateway bypass shows red on load | TicketDrop, a ticketing web app |
| Two repos: harness and the demo target | The agent works inside the target, and the tool's own code must not appear on the map | One monorepo |
| Pitch is time: less reading, rework and re-explaining | Matches the judging criteria; the bottleneck moved from writing code to understanding it | A general observability pitch |
| Time ledger shows counts; minutes come only from a measured baseline | Avoided costs are invisible without the "without" side | Claimed time savings |
| Answered forks become enforced rules in git, pushed to Alike | Memory the code can't forget; Alike's own memory is extracted from conversation and isn't checked against code | Memory as reminders only |
| The plan is the scope | Plan mode already states intent, so no extra model call | Inferring scope from the prompt |
| Own regex import scanner for load and edits | One code path, milliseconds, consistent results | dependency-cruiser plus Graphify on the critical path |
| Sponsors: Alike only | The only one that strengthens the core story | Keewano, Sparta, Dial |
| Three owners for the graph: code for facts, a cartographer agent for meaning, the coding agent for intent | The audited can't be the auditor, and the parts that change on every edit are exactly what code computes precisely | The coding agent maintaining the graph through a skill |
| Every level is a rollup of one fact graph through one mapping | Nothing to keep in sync between levels | A separate graph per level |
| Plans show as ghosts, edits fill them in, unplanned edits show amber | One map covers planning, progress and drift, and the fork surfaces before any code exists | Updating the map only during implementation |
| Live activity: agent cursor, fill-in progress, edge draw-in, replay | Biggest visual payoff for the cost, all from one event stream | Static footprints only |
| Five levels, depth always local | Class-level wiring helps inside one component and is a hairball across the system | Two zoom levels, then code |
| Own the shell, borrow the harness | Diagram-first layout, with real Claude Code underneath through the Agent SDK | Building a new harness |
| Distribute through adapters on one graph server | Meet people inside Claude Code, Cursor and Codex | A harness-only product |
| Keep model calls out of the blocking path | Deterministic checks run in milliseconds inside hooks | Worry that the graph would lag the agent |
| Blocks are domain × layer cells | Layer boxes light up on every feature; domains reveal overreach | Layer graph of containers |
| Alerts are exception-driven and ranked | A passive diagram gets ignored after a few minutes | Watching a live graph |
| Text in, architecture out | Text has no skill tax; gestures need architectural vocabulary | Graph as contract with a gesture grammar |
| Build-first demo around one fork | The difference is deciding before code is written | Rescuing a messy repo |
| Drop Dial | Approving by SMS without the diagram undercuts the thesis | Approve-by-text |
| Multiplayer map is a vision slide | The strongest business story, but not buildable in a day | — |

## Idea and selling point

You keep talking to your coding agent in text; a live map of your product shows what each turn did to its architecture, and the agent stops before crossing a line you drew.

**One-liner:** Text in, architecture out.

**Contrast line:** Graphify gives the agent a map of your code; this gives you a map of what the agent is doing to it.

**The bottleneck (theme: give people their time back).** Agents now change code faster than people can follow. The time goes to re-reading diffs, re-explaining context, and untangling structure that drifted while nobody was looking. Chat shows what the agent said, not what it did to your system.

**Thesis.** Chat is the right input and the wrong output. Text has no skill tax, so it stays the way you give instructions. But a transcript can't show you that a change you asked for in Checkout also touched Accounts. The human's role has shifted from author to supervisor, and a supervisor needs a map, not a log.

**Time.** Before AI tools, professional developers already spent about 58% of their time on program comprehension ([Xia et al., IEEE TSE 2018](https://ink.library.smu.edu.sg/sis_research/3779)). In METR's 2025 trial, experienced open-source developers using AI took 19% longer and still believed they had been sped up; the time went to prompting, reviewing and integrating ([InfoQ](https://www.infoq.com/news/2025/07/ai-productivity)). The product removes three time sinks: reading diffs to see what changed (the footprint), redoing work after a wrong direction is found (the fork before code), and re-explaining decisions to each new session (design memory).

**What makes it different**

- **It observes the agent, not the codebase.** Static maps (Graphify, DeepWiki) describe code. This shows each turn's footprint, where the agent looked, and how far it strayed from what you asked.
- **Exception-driven.** Quiet when a turn stays in its stripe; loud on new coupling, writes into another domain's data, or edits outside scope.
- **Readable by anyone.** Boxes are named in product language (Checkout, Seat inventory) with the code underneath.
- **Works with the agent you already use.** Real Claude Code runs underneath; adapters for Cursor and Codex come later.

**Pitch lines:** "Chat is the right input and the wrong output." · "A normal change is a vertical stripe. Sideways spread is news."

## What the human does

The human supervises instead of authoring: four cheap actions, none of which need architectural vocabulary. Every instruction still goes through chat; there is no gesture grammar.

- **Point.** Click cells to make them nouns in your next message ("make these two stop talking"). Text is good at saying what you want and bad at saying which thing.
- **Judge.** Each turn ends with its footprint and a ranked summary. Approve or push back in chat.
- **Fence.** Mark a scope or a "don't touch" cell. The gate enforces it.
- **Interrupt.** See the agent wander into another domain and stop it before it writes code.

### What a block represents

A block is the smallest unit you'd have an opinion about: columns are product domains, rows are layers, so a normal change is a vertical stripe and sideways spread is news.

- **Size test:** 5–9 domains on screen, and a typical turn lights up 1–3 cells. If every turn lights everything, the map carries no signal; if there are 40 boxes, nobody reads it.
- **Why not layers:** Web, API and DB boxes light up on every feature. Quick-buy lit 3 of 3 in the first mockup.
- **Naming:** product language on the box; files and endpoints live in the inspector.
- **Depth is local:** you only see deeper wiring inside the thing you zoomed into, never the whole system at class level. Files appear only as evidence on what a turn touched. See the levels below.
- **Edges:** only edges between domains are drawn. Flow down a column is implied.

Scout, the demo repo (rows are read from the map, so an agent system gets Entry / Logic / Data / External):

|  | Channels | Agent loop | Research tools | Model gateway | Memory | Outreach |
| --- | --- | --- | --- | --- | --- | --- |
| Entry | HTTP, webhook, CLI | — | — | — | — | — |
| Logic | Validation | Run loop, planner, tool registry | Search, profile, news digest, news summary | complete(), embed(), redaction, fallback | Retrieval, vector index | Draft email, send |
| Data | — | runs | — | cost\_log | notes, embeddings | contacts, outreach\_log |
| External | — | — | Search, News, SEC EDGAR, Enrichment | OpenAI, Anthropic, Embeddings | — | CRM, Email |

### Levels of abstraction

Five levels, each a rollup of the same fact graph, and the agent's footprint carries through all of them: an edited cell is an edited endpoint is an edited function.

| Level | Shows | Built from |
| --- | --- | --- |
| Journeys | A user flow such as "buy a ticket" as a path across domains | Routes and UI entry points traced through the fact graph, named by the cartographer |
| Domains | The domain × layer grid | `domains.yaml` mapping over the fact graph |
| Inside a domain | Endpoints, tables, jobs | Parsed routes, the Prisma schema, job config |
| Wiring | One call chain across cells, e.g. EventCard → POST /orders/quick → reserve() → prisma.seat.update | Graphify's symbol graph, drawn as a trace; calls leaving the component are stubs labeled with their cell |
| Code | The file itself | — |

The wiring level is a trace rather than a full class graph because the question people have at that depth is "how does this get there?" Sunday ships Domains and Inside a domain; Journeys and the wiring trace are stretch.

### Signals, loudest first

1. A new dependency between domains (new coupling).
2. A write into data another domain owns (the invariant case).
3. Edits outside the domains the request named, or outside the agent's own plan.
4. A new external service or package.
5. Edits inside the requested stripe, which stay quiet.

Cell states on the map: looked at (dashed), edited (filled), edited outside scope (amber), touches an invariant (red). Mockups: [Figma, v2 page](https://www.figma.com/design/PsNVwSXxGSerMVsNnbomKu).

## What the agent gets

The agent is ordinary Claude Code. The harness adds the domain map as context, observes every tool call, and gates edits that cross an invariant.

- **Context, once per session.** The domain map and invariants are appended to Claude Code's system prompt. Scope is inferred from each prompt in the background for the canvas; it never delays the agent.
- **Plan.** Each turn starts in plan mode: the agent explores read-only, then calls `submit_plan` with the cells it will touch, the edges it will add, and numbered steps. Invariant checks run on the plan, so a fork surfaces before any code exists.
- **Graph tools (read-only MCP).** `cell_for(path)`, `domain(id)` (cells, invariants, files) and `who_writes(table)`, so the agent can check ownership while planning.
- **Observe.** Hooks on Read, Grep and Glob mark cells as looked at and move the agent cursor. Hooks after Edit and Write fill cells and recompute that file's cross-domain imports. These hooks return async, so they never slow the agent.
- **Gate (the backstop).** A pre-edit hook runs the same deterministic checks during editing: writes into data another domain owns, new imports across domains, edits outside a fence. On a hit it returns `permissionDecision: "deny"` with a reason that names the options and tells Claude to ask you.
- **Record.** Each answered fork becomes a decision (DR-n) in `decisions/` and in Alike, so later sessions inherit it.

## Plan versus built

Planning and implementation share one map: the plan draws a ghost footprint, edits fill it in, and anything done without being planned shows amber.

- **Plan.** Claude Code's plan mode explores without editing. `submit_plan` returns cells, edges and steps, drawn as dashed ghosts with step numbers. A ghost that crosses an invariant is red, and the agent asks you A or B before writing any code.
- **Approve.** You approve in chat, and the session switches from plan mode to editing.
- **Build.** As edits land, ghost cells fill solid and the step counter advances. That's progress, laid out on the architecture.
- **End-of-turn diff.** This is the overfitting detector: it shows when the agent strays from its own plan.

|  | Planned | Not planned |
| --- | --- | --- |
| Done | Solid | Amber: did something it didn't say it would |
| Not done | Ghost stays | — |

## Live activity

Every visual here comes from the same hook event stream, so each one is cheap once events flow. Each motion encodes a state change; nothing loops for decoration.

- **Agent cursor.** An avatar sits on the cell the agent is reading or editing and moves with it, like a collaborator's cursor in Figma. Teammates' agents later become more cursors.
- **Fill-in progress.** Ghosts fill as steps complete, with a step counter ("3 of 6").
- **Live diff counts.** Lines added and removed tick up on each cell.
- **Edge draw-in.** A new cross-domain edge draws itself when the import appears.
- **Tests on the map.** When the agent runs tests, the cells they cover flash green or red.
- **Replay scrubber.** Every event is logged, so you can scrub a turn to watch it again or catch up on what happened while you were away.

Priority for Sunday: cursor and pulse, then plan ghosts with the drift diff, then replay, then edge draw-in. Tests on cells and the wiring trace are stretch.

## Who maintains the graph

Three owners, split by the kind of knowledge each layer needs.

| Layer | Holds | Updated by | When |
| --- | --- | --- | --- |
| Facts | Files, symbols, imports, calls, table writes | Code: Graphify or tree-sitter, an import scan, an ORM scan. No LLM | Every edit, incrementally; full check at commit |
| Meaning | Domains, names, purposes, journeys, invariants | A cartographer agent, async. It proposes, you confirm | At setup, then on drift triggers |
| Intent | Plans, decisions | The coding agent (`submit_plan`) and you (your answers) | Every turn |

- **Levels are rollups.** One fact graph plus one mapping (`domains.yaml`); every level is that graph aggregated through the mapping, so nothing is maintained twice. An agent is needed only when the mapping itself is wrong or incomplete.
- **Why not the coding agent.** It's the thing being observed, and a self-reported map drifts. Bookkeeping also costs its context and gets skipped. Its only job is to state intent, which the facts then check.
- **Why not a parallel LLM for everything.** The parts that change on every edit are exactly what code computes precisely. An LLM there adds latency and cost, and makes the map flicker.
- **The cartographer.** A separate Agent SDK session with read-only tools and a cheaper model that never blocks the coding session. At setup it turns Graphify's communities and the folder structure into 5–9 proposed domains with names, purposes and suggested invariants. Drift triggers: files landing in Unassigned, a cell past a size limit, a dense new cluster of cross-domain edges. Each produces a proposal drawn as ghosts and accepted in chat, the same UI as plans.
- **Conflicts.** Facts win on structure, you win on meaning, and the agent wins only on intent, which is checked.
- **Sunday.** Facts run live; intent comes from `submit_plan`; the cartographer runs once for Scout, plus a "re-map" button. Drift triggers are a slide.

### What Graphify does, and where we differ

Graphify builds its graph when the skill is called (`/graphify .`), refreshes changed files with `--update`, and can rebuild on commit and branch checkout through git hooks. Its agent hooks don't update the graph; they fire before searches and file reads to steer the agent toward querying the graph instead. Nodes are symbols linked by calls, imports and inheritance, clustered into communities, with no hierarchy or zoom. A PR tool flags pull requests that touch the same community.

So Graphify is a commit-time snapshot built for agent retrieval. We use it as the fact extractor for the wiring level and the domain proposal. The gap we fill is live, per-turn, plan-versus-built, and layered for humans.

## Architecture

Own the shell, borrow the harness: a diagram-first web app whose chat pane drives real Claude Code through the Agent SDK, with a local graph server in between that watches and gates every tool call.

&#91;embedded content: architecture · shell, graph server, Claude Code\]

Your chat goes through the graph server to Claude Code, and every tool call Claude makes comes back through it. That's how the grid updates live and how the gate can stop an edit, without anyone rebuilding the agent.

### The pieces

- **Shell (web app).** The grid takes two-thirds of the screen, the chat pane the rest, with the turn summary and replay scrubber under the grid. It's the only window you need.
- **Graph server (the product core).** Holds `domains.yaml`, a path → cell index, cross-domain edges and invariant checks, the plan overlay, the per-turn footprint and the event log. Pushes every change to the shell over a websocket.
- **Claude Code via the Agent SDK.** Your agent, unchanged: same loop, tools, login, CLAUDE.md and settings. The server adds hooks, a small MCP server, and plan mode at the start of each turn.
- **Cartographer.** A second, read-only SDK session on a cheaper model that proposes domains and map changes. It never blocks the coding session.
- **Graphify.** The fact extractor for symbols and calls, run at setup and on commit. Its `graph.json` feeds the wiring level and the cartographer.
- **Repo.** `domains.yaml`, `decisions/DR-*.md`, Graphify's output, and the source.

This is not a new harness. The expensive part, the agent, stays Claude Code; only the window around it is ours.

### Latency: fast path and slow path

The graph is never the slow part as long as no model call sits in the blocking path.

- **Fast path (synchronous, in hooks, deterministic):** map a path to a cell, re-read one file's imports, regex-check an edit against invariants. Milliseconds, so the grid updates before the agent's next step and the gate can block instantly.
- **Slow path (asynchronous, never blocks):** anything that needs a model. That's inferring scope from your prompt, which starts when you hit enter, and naming domains, which happens once at setup.
- The only intentional wait is when the gate stops the agent and asks you.

### Representation

One config file in the repo describes the map; everything else is derived from the code.

```yaml
layers: [ui, api, data, jobs]
domains:
  - id: checkout
    name: Checkout
    purpose: Reserve seats, place orders
    cells:
      ui:   [apps/web/src/checkout/**]
      api:  [apps/api/src/orders/**]
      data: [seats, orders, holds]
      jobs: [apps/api/src/jobs/holds.ts]
    invariants:
      - id: DR-12
        rule: only Checkout writes seats
        check: { table: seats, writers: [checkout] }
```

- **Domains:** the agent proposes them once when a repo loads, and you confirm. Unmapped files land in an "Unassigned" column.
- **Cells:** files map to cells by glob; tables by name.
- **Edges:** derived, not declared. Cross-domain imports come from an import-graph tool; table writes come from scanning ORM calls (Prisma, so writes are greppable).
- **Decisions:** `decisions/DR-*.md` in git, mirrored to Alike.

### Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Shell | Vite + React + Zustand | Fast to scaffold |
| Grid | CSS grid + SVG overlay for edges | Fixed layout, so no graph layout engine |
| Motion | CSS transitions + SVG stroke animation | Agent cursor, fill-in, edge draw-in |
| Server | Node + Hono + `ws` | Holds graph, plan and turn state; logs events for replay |
| Per-edit facts | `dependency-cruiser` (or `madge`) + Prisma call scan | Deterministic imports and table writes in milliseconds |
| Commit-time facts | Graphify (`uv tool install graphifyy`) | Symbol graph across about 40 languages; communities seed domains |
| Agent | `@anthropic-ai/claude-agent-sdk` | Real Claude Code: `query()`, plan mode, hooks, MCP |
| Cartographer | Second SDK session, read-only, smaller model | Proposes meaning without touching the coding session |
| Decisions | `decisions/*.md` + Alike MCP | In git and in every later session |

### One turn, end to end

1. You type in the chat pane. The server opens a turn and infers scope in the background; a scope band appears on the grid.
2. Claude starts in plan mode and reads. The agent cursor moves and cells are marked looked at. It submits a plan: ghost cells, ghost edges, numbered steps.
3. Invariant checks run on the plan. A ghost that crosses one turns red, and Claude asks you A or B in chat before writing code.
4. You answer and approve in text. The session switches to editing.
5. Edits fill ghosts solid, diff counts tick, and new imports draw in as edges. The gate stays armed for anything unplanned that crosses an invariant.
6. When the result message arrives: the plan-versus-built diff (amber for unplanned work), the ranked summary, a decision written to `decisions/` and Alike, and the turn joins the replay log.

### Session wiring

```ts
import { query, type HookCallback, type PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

const observeRead: HookCallback = async (input) => {
  graph.looked((input as PreToolUseHookInput).tool_input); // path → cell → shell
  return { async: true };                                  // never delays the agent
};

const gate: HookCallback = async (input) => {
  const v = graph.check((input as PreToolUseHookInput).tool_input); // owned data, cross-domain import, fence
  if (!v) return {};
  shell.flag(v);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${v.reason}. Stop and ask the user to choose: ${v.options.join(" / ")}.`,
    },
  };
};

const session = query({
  prompt: chatPane.messages(), // AsyncIterable<SDKUserMessage> fed by the chat pane
  options: {
    cwd: REPO,
    permissionMode: "plan",               // explore read-only, then call submit_plan
    planModeInstructions: PLAN_RULES,     // "submit cells, edges and steps before asking to edit"
    systemPrompt: { type: "preset", preset: "claude_code", append: graph.domainBrief() },
    mcpServers: { graph: graphTools },
    hooks: {
      PreToolUse: [
        { matcher: "Read|Grep|Glob", hooks: [observeRead] },
        { matcher: "Edit|Write", hooks: [gate] },
      ],
      PostToolUse: [{ matcher: "Edit|Write", hooks: [markEditedAndRecheckImports] }],
    },
  },
});

// after you approve the plan in chat:
// await session.setPermissionMode("acceptEdits");

for await (const msg of session) chatPane.render(msg);
```

From the SDK docs: a deny's reason is shown to Claude so it doesn't simply retry; async hook outputs can't block, so they're only for observation; a single deny wins over any other hook's allow.

### Distribution (after Sunday)

The graph server is the product; each surface is a thin adapter.

- **VS Code extension:** the grid as a main editor tab beside whichever agent's chat sidebar you use. Cursor is built on VS Code, so one extension covers both.
- **Claude Code CLI:** one install command writes hooks and MCP config (the Graphify and Alike pattern); the grid opens in a browser tab.
- **File watcher fallback:** footprints from edits for any agent, including Codex, at the cost of "looked at".
- **Multiplayer (vision):** one shared map showing every teammate's agent footprints live, so collisions show up before merge.

## Sponsor tools

Integrate Alike, the one sponsor that extends the core idea; add Keewano only if the core works by mid-afternoon; put Sparta on the future-work slide; skip Dial and Darwin. All APIs below were checked against each company's docs on Oct 10.

| Sponsor | What it is | Fit with the core story | Decision |
| --- | --- | --- | --- |
| [Alike](https://alike.help) | Shared memory for coding agents, built from conversations and attached to code paths | Complementary: Alike remembers what was decided; we check that the code still does it, and hand Alike confirmed decisions with exact anchors | **Build** (invite in hand) |
| [Keewano](https://docs.keewano.com) | Event-sequence database for agents | Would be a third store for the same events; analytics-shaped data model | Skip unless it runs a prize track and the core loop is done |
| [Sparta](https://www.usesparta.co) | Local replicas of Stripe and Zendesk for testing agents | Tests runtime behavior, not structure; would be logo placement | Skip |
| [Dial](https://docs.getdial.ai) | Phone and SMS for agents | Approving by text undercuts the thesis | Skip |
| Darwin | Search engine for agents | None | Skip |

### Alike: decisions that outlive the session

Every fork you answer becomes an Alike decision, so the next session, yours or a teammate's, gets the rule before it edits. Alike's demo shows exactly this "stopped before the rework" moment, which makes it a natural pairing.

- Connect: remote MCP at `https://alike.network/api-general/mcp`, Streamable HTTP, OAuth sign-in in the browser (no API key). For Claude Code: `claude mcp add --transport http alike https://alike.network/api-general/mcp`, then `/mcp` to sign in. SDK sessions load your Claude Code settings by default, so the Alike server should come along; confirm the sign-in carries over.
- Write: when you answer a fork, the agent calls `record_decision` with your rationale and code anchors (`repository`, `branch`, `paths` = the affected cells' files).
- Read: at session start, `resolve_work_item` with the `git_branch` anchor; returned decisions show on cells as invariants.
- Access: signup can require a 6-character invite code (closed beta). Get one from their team at the event, or join the waitlist tonight.

### Keewano: architecture history (stretch)

Log each turn's footprint, every gate that fired, and how you answered as events, then let the agent answer "why does Billing depend on Auth?" by tracing back to the decision event.

- Write: `POST https://api.keewano.com/event/ingress/v1/json/in` with an SDK-type project key in the `k-token` header. A batch carries `dataSessionId`, an incrementing `batch`, `userId` (use a UUID per graph node), and `events: [{ eventTypeId, timestamp, data }]`.
- Custom event types need ids ≥ 2000, registered once via `POST /json/custom`, with `customEventsHash` set on each batch. Plan: 2000 turn, 2001 cell touched, 2002 gate fired, 2003 answered, 2004 new cross-domain edge; `data` = a short JSON string.
- Read: remote MCP at `https://api.keewano.com/mcp` with a personal access token (`kwpat-…`) in `k-token`. It drops straight into the Agent SDK as `{ type: "http", url, headers }`.
- Fit caveat: the data model is built for product analytics (users, installs, numeric event ids), so the mapping is a stretch. Worth it only if the core is done.

### Sparta: future work

Sparta runs agents against local replicas of external services; Stripe and Zendesk are in public beta, free during beta. Slide idea: an external-service node such as Stripe carries a Sparta test that verifies the integration matches the drawn edges.

## Sunday schedule

Get the live footprint and agent cursor working by hour 3, plan ghosts by 4 and the gate by 5, then freeze features an hour before demos.

&#91;embedded content: Sunday build order · hours from start\]

The riskiest piece, the gate stopping Claude and Claude asking in chat, sits mid-day, once there's a grid to show it on. Test early that Claude reliably asks after a deny instead of trying another route; the demo rests on it. Edit the rows to match the event's real start and demo times.

**Cut lines**

- Footprint or cursor not live by hour 3: drive them from a file watcher (edits only) and drop "looked at".
- Plan ghosts unreliable by hour 4: skip plan mode; keep the footprint and the edit-time gate.
- Gate unreliable by hour 5: show the fork from a recorded run and keep everything else live.
- Behind at hour 6: keep decisions in `decisions/` only; Alike and replay become slides.
- Ahead at hour 6: inside-a-domain zoom, then tests on cells, then the wiring trace.
- Never on Sunday: gestures, the editor extension, other agents' adapters, multiplayer, cartographer drift triggers.

**Demo script (about 3 minutes)**

| Time | Beat | What judges see | Time line to say |
| --- | --- | --- | --- |
| 0:00 | Problem | The 58% and METR numbers | "Writing code got free. Understanding it didn't." |
| 0:20 | Load | Point it at Scout; files stream into cells; the cartographer proposes 6 domains and 3 rules | "3,000 lines you didn't write; the architecture in ten seconds." |
| 0:40 | Existing problem | The news summarizer's cell is red: it calls the model provider directly, skipping redaction; the proof script attributes the leaks to that one file | "The map told you where, before you read a line." |
| 1:00 | Ask, and it plans | "Add a tool that summarizes a prospect's latest 10-K." The cursor moves; ghosts appear; the plan copies the news tool, so its edge to the provider is red | — |
| 1:20 | Fork before code | Claude asks A or B; you answer "A, through the gateway" | "Caught before a line was written. Without it, this took *\[baseline\]* minutes to find and fix." |
| 1:40 | Build | Ghosts fill, diff counts tick, nothing amber | "*\[N\]* lines changed. You checked *\[K\]* cells." |
| 2:10 | Memory | Fresh session: "add a tool that summarizes earnings calls" plans through the gateway citing DR-4; DR-4 is in Alike | "Session two didn't ask again." |
| 2:30 | Proof and ledger | The new tools add zero leaks; the remaining ones match the one red cell; the ledger totals; a replay scrub | "That's the time we give back: less reading, less redoing." |
| 2:45 | Close | Slide: adapters, then a shared map with teammates' agents as cursors | "Chat is the right input and the wrong output." |

Name Claude Code on stage: "this is the agent you already use, now you can see what it's doing to your system." Draw the architecture slide in the grid itself if there's time.

## Open questions and risks

The biggest risk is Claude trying another route after the gate fires instead of asking; the biggest unknown is Alike access.

**Tonight**

- [ ] Dispatch the Scout build from `DEMO_REPO_SPEC.md` in its own repo
- [ ] Start the harness build from `SPEC.md`, beginning with the 30-minute verification step
- [ ] Add Alike at user scope so SDK sessions in the Scout repo see it: `claude mcp add --scope user --transport http alike https://alike.network/api-general/mcp`, then `/mcp` to sign in
- [ ] Once Scout exists: run the baseline (plain Claude Code, same 10-K prompt) and record the times

**Ask at the event**

- [ ] Does each sponsor run its own prize track, and what does it judge on? This decides whether Keewano is worth two hours.
- [ ] Alike: an invite code, and whether there is a server-side API for writing decisions without going through an agent's MCP session
- [ ] Alike: does an OAuth sign-in done in Claude Code carry over to Agent SDK sessions? If not, record decisions from one interactive session instead

**Risks and fallbacks**

| Risk | Fallback |
| --- | --- |
| Claude tries another route after a deny instead of asking | The reason names the options and says to ask; add a CLAUDE.md rule; test it tonight |
| The agent skips `submit_plan` or plans vaguely | Require it in the plan-mode instructions; if it's missing, show the footprint only |
| The gate fires on legitimate edits | Keep Sunday's checks narrow: owned-table writes and new cross-domain imports only |
| Domain mapping is messy on a real repo | The cartographer proposes, you confirm once; unmapped files go to an "Unassigned" column |
| Graphify setup or extraction is slow | Run it once tonight and commit `graph.json`; the live fast path doesn't depend on it |
| Animations distract instead of inform | Every motion encodes a state change; nothing loops |
| A live turn is slow on stage | Keep Scout small; have a recorded run ready |
| Alike invite doesn't come through | Keep `decisions/` in git and show Alike as a slide |
| Conference wifi slows remote MCP | Alike is optional; the core runs on localhost plus the Claude API |

**Sources**

- [Claude Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript), [Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks), [Agent SDK custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)
- [Alike home](https://alike.dev), [Alike MCP server](https://alike.help/reference/mcp-server), [Alike MCP tools](https://alike.help/reference/mcp-tools), [Alike decisions](https://alike.help/use/decisions), [Alike in your agent](https://alike.help/use/in-your-agent), [Alike sign-up](https://alike.help/get-started/sign-up)
- [Xia et al., Measuring program comprehension (2018)](https://ink.library.smu.edu.sg/sis_research/3779), [InfoQ on the METR study](https://www.infoq.com/news/2025/07/ai-productivity)
- [Graphify](https://github.com/Graphify-Labs/graphify)
- [Mockups in Figma](https://www.figma.com/design/PsNVwSXxGSerMVsNnbomKu) (v2 page is current)
