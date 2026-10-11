# Harness

A diagram-first shell around real Claude Code: chat on the left, a live domain × layer map of the target repo on the right, and a gate that makes the agent ask before it crosses an architecture rule. **Read `SPEC.md` before starting**, and follow its build order (§13), starting with the verification step.

## Rules

- **No model calls in the hot path.** Hooks, the mapper, the import parser and the rule checker must be deterministic and fast. The only model call Harness makes itself is the cartographer, and it never blocks the coding session.
- **UI state is a pure reduction of the event log** (`packages/core/src/events.ts`). Don't keep separate mutable state for footprint, ghosts, ledger or replay.
- **The rule checker is one function with three call sites** (load scan, `submit_plan`, edit hook). Don't fork its logic.
- **Harness writes to the target repo only** in `domains.yaml`, `decisions/` and `.harness/`. Product code in the target is edited only by the coding session.
- **Don't guess Agent SDK APIs.** Check https://code.claude.com/docs/en/agent-sdk/typescript and https://code.claude.com/docs/en/agent-sdk/hooks.
- TypeScript strict. `packages/core` has vitest tests for the mapper, import parser, write scanner, checker, plan mapping and ledger, all against `fixtures/scout-agent.domains.yaml`.
- Local only: no auth, no deployment, no database.

## Commands

```
npm i
HARNESS_REPO=../scout-agent npm run dev    # server :4310, shell :5173
npm test                                   # packages/core
```

## Context

- The target repo is built separately from `DEMO_REPO_SPEC.md`. Until it exists, test core against a small fixture repo under `packages/core/test/fixture-repo/` that mirrors its layout, including the one gateway bypass in `src/tools/news-summarize.ts`.
- Visual reference: Figma file "Diagram-first harness — product mockup", page "v2 · Domain grid".
- The demo is about time saved: keep the ledger counters exact (SPEC §9) and never display estimated minutes in the UI.
