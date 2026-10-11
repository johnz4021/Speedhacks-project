# Contracts for the NAVIGATION_PLAN lanes

These files are the shared interfaces. Lanes build against them in parallel. Change a contract only with the integrator's sign-off, because every lane depends on it.

| File | Defines |
| --- | --- |
| `facts.ts` | `FileFacts` (Tier 1, per file), `SemanticFacts` (Tier 2), `SymbolFact`, `CallFact`, `RouteFact`, `EntryFact`, `SymbolDiff` |
| `graph.ts` | `ContextGraph`, `GraphNode`, `GraphEdge`, `ViewState`, `LeafActivity`, `Rollup`, `Projection`, plus id helpers |
| `cartography.ts` | `DriftSignal`, `HistoryTurn`, `MapScore`, `MapProposal`, `ProposalChange`, `Label`, `AuditFinding`, `DEFAULT_THRESHOLDS` |
| `api.ts` | The signatures each lane implements (`BuildGraph`, `Project`, `ScoreMap`, `DetectDrift`, …) and `TurnActivity` |

The event kinds and reducer support for all new events (`facts_changed`, `facts_resolved`, `call_added`, `drift_detected`, `map_proposed { proposal }`, `map_proposal_resolved`, `labels_updated`, `audit_finding`, `maintenance_run`, and `edited.symbols`) are already in `../events.ts`. Lanes **emit** these events. They do not change the reducer; ask the integrator if a lane needs reducer state that isn't there.

Shared test fixture: `test/scout-facts.ts` gives `FileFacts` for `test/fixture-repo`, with hand-written symbols, calls and routes for the files the demo touches.

## File ownership

| Lane | Owns | May append to |
| --- | --- | --- |
| Facts (N1) | `src/facts.ts`, `src/imports.ts`, `src/writes.ts`, `src/facts/**`; server `repo.ts`, `git.ts` | `src/index.ts`, `src/view.ts` (exports), `packages/core/package.json` |
| Graph (N2) | `src/graph/**` | `src/index.ts`, `src/view.ts` |
| Cartography (N5 engine) | `src/cartography/**`; server `living-map/**` | `src/index.ts`, `src/view.ts`; server `index.ts` (a small wiring block) |
| Renderer (N0 → N3/N4) | `apps/shell/**` (new work under `src/v2/`) | `apps/shell/package.json` |

`events.ts`, `rules.ts`, `schema.ts` and `contracts/**` belong to the integrator.
