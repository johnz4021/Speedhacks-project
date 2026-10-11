// Contract: the functions each lane implements, by signature. Lanes export these names from their own
// modules and re-export them from src/index.ts (and src/view.ts if browser-safe). Pure and deterministic.
import type { DomainMap } from '../schema';
import type { UIState } from '../events';
import type { FileFacts, SemanticFacts, SymbolDiff, SymbolFact } from './facts';
import type { ContextGraph, LeafActivity, Projection, ViewState, ViolationState } from './graph';
import type { DriftSignal, DriftThresholds, HistoryTurn, MapScore, ProposalChange } from './cartography';

/** The selected turn's activity, keyed by leaf id (file path or symbol id), plus plan edges. */
export type TurnActivity = {
  turn: string | null;
  leaves: Record<string, LeafActivity>;
  plannedEdges: { from: string; to: string; steps: number[]; violation: ViolationState }[]; // file → file
  addedEdges: string[]; // GraphEdge ids added this turn
  cursor: string | null; // leaf id the agent is on
};

// ---- Graph lane (src/graph/, browser-safe) ----
/** Containment tree + leaf edges from the map and per-file facts (Tier 2 merged in when its hash matches). */
export type BuildGraph = (map: DomainMap, facts: Readonly<Record<string, FileFacts>>, semantic?: Readonly<Record<string, SemanticFacts>>) => ContextGraph;
export type ActivityFor = (ui: UIState, graph: ContextGraph, turnId?: string | null) => TurnActivity;
/** Visible nodes/edges/ports for a view. With `expanded: []` it must agree with cellViews/edgeViews (parity tests). */
export type Project = (graph: ContextGraph, view: ViewState, activity: TurnActivity) => Projection;
/** DOI expansion: importance (planned, violating, cursor, edited) minus distance from focus, within `budget`. */
export type AutoExpand = (graph: ContextGraph, activity: TurnActivity, focus: string | null, budget: number) => string[];
/** Shortest call chains from `from` to sinks (vendors, tables) over calls ∪ implements ∪ handles. */
export type Trace = (graph: ContextGraph, from: string, sinks?: readonly string[]) => string[][];

// ---- Facts lane (src/facts/ for extraction is node-only; diffSymbols is browser-safe) ----
export type ExtractFacts = (path: string, source: string, resolve: (from: string, spec: string) => string | null) => FileFacts;
export type DiffSymbols = (before: readonly SymbolFact[], after: readonly SymbolFact[]) => SymbolDiff;

// ---- Cartography lane (src/cartography/, browser-safe) ----
export type ScoreMap = (
  map: DomainMap,
  facts: Readonly<Record<string, FileFacts>>,
  history: readonly HistoryTurn[],
  opts?: { current?: DomainMap; decisionPaths?: Readonly<Record<string, string[]>> },
) => MapScore;
export type DetectDrift = (
  map: DomainMap,
  facts: Readonly<Record<string, FileFacts>>,
  ui: UIState,
  history: readonly HistoryTurn[],
  thresholds: DriftThresholds,
  previous?: readonly DriftSignal[],
) => DriftSignal[];
export type DiffMaps = (current: DomainMap, next: DomainMap, files: readonly string[]) => ProposalChange[];
