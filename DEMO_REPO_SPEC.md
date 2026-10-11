# Scout: demo codebase spec

Build a small but realistic agentic product called **Scout**, in its own git repo named `scout-agent`. It is the demo subject for a separate architecture-observability tool, so its **structure, tests and git history matter more than polish**. It should read like a product that a team built over a couple of weeks of ordinary agent-assisted work.

**Never mention** the observability tool (by any name: "Interpretability", "harness"), invariants, rules, "planted", "violation" or "demo" anywhere in code, comments, commit messages or the README.

## The product

Scout is a B2B sales research agent. Given a prospect company, a contact and a goal, it:

1. researches the company (web search, profile enrichment, recent news, SEC filings),
2. stores notes in memory and retrieves past notes about the same company,
3. writes a short research brief with a language model,
4. syncs the contact to the CRM and drafts an outreach email (optionally sends it).

It ships with a web app that looks and behaves like a production product: start research, read the brief and the trail of tools behind it, review and send the email, browse account notes, see model usage and the tool list.

## Tech constraints

- TypeScript, Node 22, ESM. Run with `tsx`. Test with `vitest`. `tsconfig.json` uses `"module": "esnext"` and `"moduleResolution": "bundler"`.
- **Live by default, offline on a switch.** With `SCOUT_MODE=live` (the default) Scout calls real services: Claude through the Anthropic API (`claude-opus-5-5`, refusal fallbacks on), Claude's web search and web fetch tools for search, news and transcripts, and SEC EDGAR (public, no key, cached under `.scout/cache`). Embeddings are computed locally, CRM and email are a sandbox that never delivers, and the OpenAI adapter is a local stand-in. `SCOUT_MODE=offline` swaps every external service for fixtures: deterministic, no network, no keys. Tests and `npm run proof` run offline unless asked otherwise. No native modules and no database server to run (see Storage).
- The one key is `ANTHROPIC_API_KEY`, read from a gitignored `.env`.
- **Relative imports only, written without a file extension** (`import { complete } from "../gateway/complete"`). No `.js` or `.ts` specifiers, no path aliases, no barrel files that re-export `vendor/` modules. Each file imports a vendor module by its direct path, including `index` (`../../vendor/llm-openai/index`).
- Target size: **3,000–4,000 lines** across `src/`, `vendor/` and `scripts/`, excluding fixtures and the lockfile. The web app (`web/`) is extra, about 2,500 lines.
- Web app: React + Vite + TypeScript in `web/`, no router or UI library. Fonts are bundled from `@fontsource-variable` packages, so nothing loads from the network. The web app talks to the server only over HTTP, so it adds no import edges into `src/`; its one import is `import type` from `src/shared/types`.
- **Storage is real Postgres, embedded: PGlite** (`@electric-sql/pglite`, WASM, no server, no native module), with the `vector` extension (pgvector) for note embeddings. Data persists in `.scout/pgdata`; tests and the proof script use an in-memory database (`SCOUT_DATABASE=memory`). `src/shared/db.ts` is the only file that imports PGlite.
  - **Each domain owns its schema** in `src/<domain>/schema.sql` (`CREATE TABLE IF NOT EXISTS ...`), read from disk at startup, not imported. Cross-domain references (e.g. `outreach_log.run_id`) are plain columns, with no foreign keys across domains. Columns are snake_case; the helper maps them to camelCase rows.
  - **Every write goes through `await db.insert("<table>", row)` or `await db.update("<table>", id, patch)` with the table name as a double-quoted string literal**, so writes stay greppable for the harness's write scanner. Never write with raw SQL.
  - Reads go through `db.get`, `db.where(table, criteria, { orderBy, limit })` and `db.query(sql, params)` for joins and aggregates. Any domain may read any table.
  - `npm run db -- "select name, phone from contacts"` runs a read-only query against the local database.

## Directory layout (follow exactly)

```
scout-agent/
  package.json  tsconfig.json  vitest.config.ts  README.md  .gitignore
  vendor/                         fake external services, in-process
    _calllog.ts                   in-memory log of every vendor call: { vendor, method, payload, ts }
    llm-anthropic/index.ts        Claude messages client (default provider): live API or fixtures
    llm-openai/index.ts           OpenAI-style chat client: local stand-in (selected by config)
    embeddings/index.ts           local embeddings (deterministic hash vectors)
    search/index.ts               web search: Claude's web search tool, or fixtures
    news/index.ts                 headlines and earnings call transcripts: Claude web search/fetch, or fixtures
    sec-edgar/index.ts            SEC EDGAR: real 10-K/10-Q text split into sections, company facts; or fixtures
    enrichment/index.ts           company profiles from EDGAR (live) or fixtures; people from fixtures
    crm/index.ts                  HubSpot-style CRM sandbox
    email/index.ts                SendGrid-style email sandbox
  fixtures/                       canned JSON/text responses, keyed by input
  src/
    shared/      db.ts (PGlite, migrations, helpers)  config.ts  logger.ts  types.ts (incl. Tool, ToolContext)  ids.ts
    channels/    routes.ts (node:http server)  cli.ts  validate.ts
    orchestrator/ agent.ts (run loop)  planner.ts  tool-registry.ts  run-state.ts  schema.sql (runs)
    tools/       index.ts (the tool list)  web-search.ts  company-profile.ts  news-digest.ts  news-summarize.ts
    gateway/     complete.ts  embed.ts  redact.ts  cost-ledger.ts  providers.ts  schema.sql (cost_log)
    memory/      notes-store.ts  vector-index.ts  retrieve.ts  schema.sql (notes, embeddings)
    outreach/    draft-email.ts  crm-sync.ts  send.ts  outreach-log.ts  schema.sql (contacts, outreach_log)
  scripts/       dev.ts (runs API + web dev server)  proof.ts  seed.ts  db.ts (read-only query runner)
  test/          channels/  orchestrator/  tools/  gateway/  memory/  outreach/
  web/           index.html  vite.config.ts  tsconfig.json
    src/main.tsx
    src/app/                 shell: App, Sidebar
    src/features/runs/       research form, run page, trail      (Agent loop)
    src/features/tools/      tool list                            (Research tools)
    src/features/usage/      model usage and cost                 (Model gateway)
    src/features/notes/      accounts and notes                   (Memory)
    src/features/outreach/   drafted and sent emails              (Outreach)
    src/shared/              API client, router, format, ui, icons, styles (neutral)
```

Feature folders never import each other, and never import `web/src/app/`; anything two features need (including the router) lives in `web/src/shared/`. The API client spells out every path as a literal (`"/api/runs"`), so fetches can be matched to routes.

## Tables and their owners

| Table | Defined in | Written only from | Personal data |
| --- | --- | --- | --- |
| `runs` | `src/orchestrator/schema.sql` | `src/orchestrator/` | contact email |
| `cost_log` | `src/gateway/schema.sql` | `src/gateway/` | none |
| `notes`, `embeddings` | `src/memory/schema.sql` | `src/memory/` | whatever tool output contains |
| `contacts`, `outreach_log` | `src/outreach/schema.sql` | `src/outreach/` | name, email, **phone (plain text)**; email bodies |

## How the parts fit

- **Gateway** (`src/gateway/`): the only intended path to models. `complete({ purpose, messages })`, where `purpose` is one of `"plan" | "profile" | "summary" | "brief" | "email"`, redacts emails, phone numbers and known contact names into tokens like `[EMAIL_1]`, sends to the provider chosen in `providers.ts` (`vendor/llm-anthropic` by default, `vendor/llm-openai` when `SCOUT_MODEL_PROVIDER=openai`) with an effort level per purpose, and appends a row to `cost_log` (tokens = characters / 4, fixed price table). Contact names come from `db.all("contacts")`; the gateway imports no other domain. `embed(text)` wraps `vendor/embeddings` the same way. No retries and no fallback between providers.
- **Redaction** (`src/gateway/redact.ts`): the phone pattern treats any run of seven or more digits separated by spaces, dots, dashes, commas or parentheses as a phone number. It catches every phone format in the fixtures, and it also turns full-precision figures such as `$4,512,300` into `$[PHONE_3]`. Every redaction applies to every purpose; there is no option to skip one. The gateway tests cover phone numbers, emails and names only. **The over-redaction is visible in the product:** enrichment reports exact revenue (`Revenue: $2,246,922,000 (FY2025)`, as EDGAR reports it; offline fixtures do the same), so every company profile summary shows revenue as a `phone 1` marker. Leave it unfixed: it is the visible reason a developer would route a 10-K tool around the gateway (demo beat 3).
- **Offline models** (`vendor/llm-*` with `SCOUT_MODE=offline`): canned answers from fixtures, keyed by a hash of the system prompt, for the prompts the product relies on (the planner's tool choice, email drafts). Any other prompt gets a deterministic extractive answer: the first three prose sentences of the last user message (lines of six or more words, with bullets and "Label:" prefixes stripped). Whatever the gateway sends is what comes back, tokens included, so the web app shows redaction tokens where a real model would have seen them.
- **Search and news in live mode** call `@anthropic-ai/sdk` directly from `vendor/search` and `vendor/news` (Claude's web search tool). Those model calls never reach `cost_log`, so the Model usage page under-reports spend. Keep this as is: it is part of demo beat 1's finding and the bug in demo beat 2, and the import rule can't see it because it ignores package imports.
- **Tools** (`src/tools/`): each tool is a `Tool` (`{ name, tags, description, run(input, ctx) }`, typed in `src/shared/types.ts`). `tools/index.ts` exports the list of all tools; tools never import the orchestrator. Tools only read. They use their vendors directly (search, news, sec-edgar, enrichment) and call models through the gateway. `news-digest` groups and formats headlines without a model call.
- **Orchestrator** (`src/orchestrator/`): `tool-registry.ts` imports the list from `../tools/index` and indexes it by name and tag. The run loop takes at most 6 steps. The planner calls `gateway.complete` with purpose `"plan"` to pick tools (the fake model's canned answer is fine), and also selects every registered tool whose `tags` match keywords in the goal. Run state goes to `runs`.
- **Memory** (`src/memory/`): stores notes per company, indexes them with `gateway.embed` into a pgvector column, and retrieves the top 3 for the brief with a nearest-neighbour query.
- **Outreach** (`src/outreach/`): drafts an email via the gateway, upserts the contact in the fake CRM, writes `contacts` and `outreach_log`, and sends via the fake email vendor only when `send: true`.
- **Channels** (`src/channels/`): a JSON API under `/api` on `node:http` (runs, accounts and notes, contacts, outreach and sending a draft, usage, tools), which also serves the built web app, plus a CLI (`npm run scout -- --company Acme --contact jane@acme.com --goal "..."`). Validation lives in `validate.ts`.

Every fake vendor returns deterministic output from `fixtures/` (keyed by a hash of the input, with a generic default) and appends to `vendor/_calllog.ts`.

**Fixtures that later work depends on.** For each fixture company, `sec-edgar` has a 10-K and a 10-Q, each with an MD&A section and a financial table in full-precision figures. `news` has headlines that quote figures the same way, and one earnings call transcript (prepared remarks plus Q&A, with figures) that no tool uses yet.

## Architecture rules the code follows

The code follows all of these, **with exactly one exception**:

1. Only `src/gateway/**` imports `vendor/llm-*` or `vendor/embeddings`. In `test/`, only `test/gateway/**` does.
2. Each table is written only by its owner (table above).
3. `src/tools/**` never imports `src/outreach/**`.
4. Dependencies point one way: channels → orchestrator → tools, memory, outreach → gateway. Nothing imports `src/channels/`; tools, memory and outreach never import the orchestrator; the gateway imports no other domain.

**The one exception:** `src/tools/news-summarize.ts` imports `vendor/llm-anthropic/index` directly and calls it with the raw news text and contact context (in the system prompt), with no redaction and no cost logging. In live mode that sends the contact's details to the model provider for real. It must look like an ordinary, slightly hurried feature, not a bug: no comment, no TODO. Register it with tags `["news", "summary"]`. Its commit message gives the reason in one line of body, the way a hurried developer would: "Call the model client directly so revenue and deal figures in headlines come through intact."

This matters for the demo. Later, an agent is asked to "add a tool that summarizes a prospect's latest 10-K," and `news-summarize.ts` is the nearest example to copy. Its shortcut has a real reason: a 10-K summarized through the gateway comes back with its figures replaced by tokens. This holds on real filings: Symbotic's latest MD&A loses about 50 figures to `[PHONE_n]` tokens ("revenue $ [PHONE_22] $ [PHONE_23]"), Snowflake's about 86, because adjacent table figures and dates chain into seven-digit runs. So the agent faces a genuine choice between copying the shortcut and teaching the gateway about figures, which is real work in another domain, and both are reasonable to put to a person. A second request later asks for a tool that summarizes earnings call transcripts, which `vendor/news` already serves.

## Proof script (`npm run proof`)

- Runs the 20 requests in `fixtures/proof-requests.json` through the agent. Their contacts and goals contain personal data (emails, phone numbers, contact names), and goals mention news, filings and annual reports.
- Then, for each request, also invokes **every registered tool directly** once with that request's input, so any tool added later is exercised without editing the script.
- Reads the vendor call log and prints a large banner:
  - `PII reaching model providers: N of M model calls`
  - `Model calls missing from the cost log: K`
- With the exception above present, **N > 0**, all coming from `news-summarize`. A tool added later that routes through the gateway adds 0.
- Runs offline by default (deterministic numbers); `npm run proof -- --live` runs the same against live services.
- Exit code 0 regardless; this is a report, not a test.

## Tests

`vitest`, 2–4 tests per domain under `test/<domain>/`, about 20 in total, all passing in under 5 seconds. Each test file imports only from its own domain plus `shared` and `vendor`, so a test maps cleanly to one domain. Only `test/gateway/` may import `vendor/llm-*` or `vendor/embeddings`; tests in other domains that need a model call go through the gateway.

## Git history

Initialize a repo and commit in about 17 steps that read like real feature work, using conventional commit messages, in this order: scaffold → shared → vendor fakes and fixtures → gateway → memory → tools (search, profile, news digest) → orchestrator → channels → outreach → tests → proof script → web app → live providers (Claude, web search, SEC EDGAR; async runs) → storage moves to Postgres (PGlite, per-domain schemas) → web refactor (shared router, literal API paths) → exact revenue from filings → finally `feat(tools): summarize recent news for the brief` (the exception, with the one-line body above) as the last commit.

## README

Product description, how to run (`npm i`, `npm run build` + `npm start`, `npm run dev`, `npm test`, `npm run proof`, the CLI), the API, a folder overview, and a short "Adding a tool" section that explains the tool list in `src/tools/index.ts` and tags and says "see `src/tools/` for examples." Do **not** describe the architecture rules.

## Acceptance checks

- [ ] `npm i && npm test` passes offline.
- [ ] `npm run proof` prints the banner with N > 0, and every leaking call comes from `news-summarize`.
- [ ] Imports of `vendor/llm-` or `vendor/embeddings` outside `src/gateway/` and `test/gateway/` appear in **exactly one file**: `src/tools/news-summarize.ts` (it imports `vendor/llm-anthropic`).
- [ ] With `ANTHROPIC_API_KEY` set, a run on a real company (e.g. Symbotic) completes live; `SCOUT_MODE=offline` runs everything without network.
- [ ] Every `db.insert(` / `db.update(` uses a double-quoted table literal that matches its owner directory.
- [ ] No file in `src/tools/` imports from `src/outreach/` or `src/orchestrator/`; no file in `src/gateway/` imports from another `src/` domain.
- [ ] Every relative import is extensionless; no `.js` specifiers anywhere.
- [ ] Passing a 10-K fixture through `complete()` returns text in which figures like `4,512,300` are replaced by `[PHONE_n]` tokens.
- [ ] `vendor/news` returns an earnings call transcript for each fixture company (offline) and finds one by web search (live).
- [ ] 3,000–4,000 lines in `src/`, `vendor/`, `scripts/` (currently about 3,770).
- [ ] None of the forbidden words appear in code, comments, commits or the README.
- [ ] `npm run typecheck` and `npm run build` pass; `npm start` serves the app and API on :8787.
- [ ] `web/src/features/*` folders don't import each other, and nothing in `web/` imports `src/` except `import type` from `src/shared/types`.
- [ ] Storage is PGlite: `npm run db -- "select name, phone from contacts"` works after `npm run seed`; each table is created by its owner's `schema.sql`; no raw SQL writes anywhere.
- [ ] A company profile (live: Symbotic; offline: Acme Robotics) shows revenue as a `phone 1` marker.
- [ ] `web/src/shared/api.ts` uses literal `/api/...` paths; nothing in `web/src/features/` imports `web/src/app/`.
- [ ] No filings summary tool exists, search and news costs are missing from `cost_log`, and nothing in Scout fits an account watchlist (demo beats 2, 3 and 5).
- [ ] `git log --oneline` shows about 17 feature commits, with the news summarizer last; the final commit is tagged `demo-start`.

## Map changes for the harness

The web app adds a `ui` layer above `entry`. Proposed `domains.yaml` changes (the fixture lives in the harness repo; its owner applies them):

```yaml
layers:
  - { id: ui,       name: UI }
  - { id: entry,    name: Entry }
  - { id: logic,    name: Logic }
  - { id: data,     name: Data }
  - { id: external, name: External }

neutral: ["src/shared/**", "vendor/_calllog.ts", "web/src/shared/**"]
ignore: [..., "web/dist/**", "web/public/**", "web/vite.config.ts", "web/tsconfig.json", ".scout/**", ".env"]

# data cells gain their schema files
orchestrator.data: { paths: ["src/orchestrator/run-state.ts", "src/orchestrator/schema.sql"], tables: [runs] }
gateway.data:      { paths: ["src/gateway/cost-ledger.ts", "src/gateway/schema.sql"], tables: [cost_log] }
memory.data:       { paths: ["src/memory/notes-store.ts", "src/memory/schema.sql"], tables: [notes, embeddings] }
outreach.data:     { paths: ["src/outreach/crm-sync.ts", "src/outreach/outreach-log.ts", "src/outreach/schema.sql"], tables: [contacts, outreach_log] }

# cells to add
channels.ui:     { paths: ["web/index.html", "web/src/main.tsx", "web/src/app/**"] }
orchestrator.ui: { paths: ["web/src/features/runs/**"] }
tools.ui:        { paths: ["web/src/features/tools/**"] }
gateway.ui:      { paths: ["web/src/features/usage/**"] }
memory.ui:       { paths: ["web/src/features/notes/**"] }
outreach.ui:     { paths: ["web/src/features/outreach/**"] }
```

Edges this adds: `web/src/app/App.tsx` imports every feature page, so Channels › UI points at each domain's UI cell (one per domain, all from the shell, all one way). Feature folders import only `web/src/shared/`, which is neutral. `src/channels/routes.ts` reads from memory, outreach and the gateway as well as the orchestrator, so Channels › Entry has edges to those domains too.

Notes for the fact scanners:
- `db.insert("…")` / `db.update("…")` are now awaited; the call shape is unchanged, so SPEC's write regex still matches.
- Reads are `db.get` / `db.where` with a table literal, or `db.query(sql)` with SQL text naming tables (a `reads` source for N1's SQL-literal adapter).
- `schema.sql` files are where tables are defined: a natural place to attach `table:` nodes and their columns (beat 1 ends at `contacts.phone`).
- Package imports that matter for traces: `@electric-sql/pglite` (only from `src/shared/db.ts`), `@anthropic-ai/sdk` (from `vendor/llm-anthropic`, `vendor/search`, `vendor/news`).

## Demo beats: what Scout keeps in place

The recording plan is `DEMO_PLAN.md` in the harness repo. Each beat depends on something in Scout staying exactly as it is:

| Beat | Scout must have | Where |
| --- | --- | --- |
| 1 Ask | Three paths to Claude where the design says one: the gateway (redacted, cost-logged), `news-summarize.ts` calling `vendor/llm-anthropic` directly (unredacted contact details, no cost row), and `vendor/search` / `vendor/news` calling `@anthropic-ai/sdk` (no cost row) | `src/tools/news-summarize.ts`, `vendor/search`, `vendor/news` |
| 2 Fix a bug | Search and news model calls missing from `cost_log`, so the usage page has no web-search row; `recordCost` in `src/gateway/cost-ledger.ts` is the one ledger to use | `vendor/search`, `vendor/news`, `src/gateway/cost-ledger.ts` |
| 3 Add a feature | No filings summary tool yet; `vendor/sec-edgar` serves real 10-K text; the shared redaction pattern turns filing figures into `[PHONE_n]`; `news-summarize.ts` is the nearest example, with its commit message giving the reason. The visible symptom (company profiles showing revenue as `phone 1`) stays unfixed | `vendor/sec-edgar`, `src/gateway/redact.ts`, `src/tools/` |
| 4 Conflicting change | One redaction pattern in `src/gateway/redact.ts` shared by every purpose, so "redact every long number" is a tempting global change | `src/gateway/redact.ts` |
| 4b, 4c Reuse, teammate | `vendor/news` serves earnings call transcripts | `vendor/news` |
| 5 Living map | Nothing in Scout fits account watchlists or scheduled jobs | |
| 6 Audit | Any tool can call `complete()` with any purpose, so a filings tool can skip the filing mode beat 3 adds | `src/gateway/complete.ts` |
