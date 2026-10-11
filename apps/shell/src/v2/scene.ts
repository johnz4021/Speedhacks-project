// The pipeline's pure half (NAVIGATION_PLAN §3): graph = graphOf(ui) memoized on its inputs, the view for what is
// open, activity and projection. No React and no stores, so the layout tests run it in node.
import {
  activityFor, buildGraph, graphFacts, project,
  type ContextGraph, type FileFacts, type LeafActivity, type Projection, type TurnActivity, type UIState, type ViewState,
} from '@harness/core/view';

const sameImports = (a: FileFacts['imports'], b: FileFacts['imports']) =>
  a === b || (a.length === b.length && a.every((x, i) => x.to === b[i]!.to && x.typeOnly === b[i]!.typeOnly));

/** Same graph inputs: facts by content hash (stubs and edge-adjusted files compare their imports), map and Tier 2 by hash. */
export function sameInputs(a: Record<string, FileFacts>, b: Record<string, FileFacts>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = a[k]!;
    const y = b[k];
    if (!y) return false;
    if (x === y) continue;
    if (x.hash !== y.hash || !sameImports(x.imports, y.imports) || x.writes.length !== y.writes.length) return false;
  }
  return true;
}

const semKey = (ui: UIState) => Object.values(ui.semantic).map((s) => `${s.path}@${s.hash}`).sort().join('|');

/**
 * graphOf(ui), rebuilt only when what it is built from changes. Replay re-reduces the log, so UIState objects are
 * new on every event; the facts inside them are the events' own objects, so most comparisons are by reference.
 */
export function graphMemo() {
  let last: { map: unknown; mapJson: string; facts: Record<string, FileFacts>; sem: string; graph: ContextGraph } | null = null;
  return (ui: UIState): ContextGraph | null => {
    if (!ui.map) return (last = null);
    const facts = graphFacts(ui);
    const sem = semKey(ui);
    const mapJson = last && last.map === ui.map ? last.mapJson : JSON.stringify(ui.map);
    if (last && last.mapJson === mapJson && last.sem === sem && sameInputs(last.facts, facts)) {
      last.map = ui.map;
      return last.graph;
    }
    const graph = buildGraph(ui.map, facts, ui.semantic);
    last = { map: ui.map, mapJson, facts, sem, graph };
    return graph;
  };
}

/** Opened ids that still exist, each with the containers above it (a group needs its cell open). */
export function normalizeOpen(graph: ContextGraph, open: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of open) {
    const n = graph.nodes[id];
    if (!n || !(graph.children[id]?.length)) continue;
    if (n.kind !== 'domain' && n.kind !== 'cell' && n.kind !== 'group' && n.kind !== 'unassigned') continue;
    out.add(id);
  }
  return [...out];
}

/**
 * The projection's view for what is open. System level is "every domain expanded one level" (cells visible, the
 * parity view). Opening a domain opens all its cells; opening a cell or group opens it and the containers above it.
 */
export function viewFor(graph: ContextGraph, open: readonly string[]): ViewState {
  const expanded = new Set<string>();
  for (const id of graph.children[graph.root] ?? []) if (graph.nodes[id]!.kind === 'domain') expanded.add(id);
  for (const id of normalizeOpen(graph, open)) {
    const n = graph.nodes[id]!;
    if (n.kind === 'domain') for (const c of graph.children[id] ?? []) if (graph.nodes[c]!.kind === 'cell') expanded.add(c);
    for (let p: string | null = id; p && p !== graph.root; p = graph.nodes[p]?.parent ?? null) expanded.add(p);
  }
  return { expanded: [...expanded], focus: null, lens: { kinds: [], turnOnly: false }, budget: 50, follow: false };
}

const heat = (l: LeafActivity | undefined) =>
  !l ? 9 : l.violation === 'new' ? 0 : l.violation ? 1 : l.cursor ? 2 : l.edited ? 3 : l.ghostSteps.length ? 4 : l.looked ? 5 : 9;

/** Collapsed cells list their children with the ones that matter this turn first (as v1 did), then by order. */
export function hotLabels(graph: ContextGraph, activity: TurnActivity, p: Projection, max = 8): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const n of p.nodes) {
    if (n.expanded || (n.kind !== 'cell' && n.kind !== 'unassigned')) continue;
    const kids = graph.children[n.id] ?? [];
    const ranked = kids.map((k, i) => ({ k, i, h: heat(activity.leaves[k]) })).sort((a, b) => a.h - b.h || a.i - b.i);
    out[n.id] = ranked.slice(0, max).map((x) => graph.nodes[x.k]!.label);
  }
  return out;
}

export type Scene = {
  ui: UIState;
  graph: ContextGraph;
  activity: TurnActivity;
  projection: Projection;
  open: string[];
  /** Layout key: what is open (positions depend on nothing else but content). */
  key: string;
};

export function sceneOf(ui: UIState, graph: ContextGraph, turn: string | null, open: readonly string[]): Scene {
  const activity = activityFor(ui, graph, turn);
  const opened = normalizeOpen(graph, open);
  const projection = project(graph, viewFor(graph, opened), activity);
  return { ui, graph, activity, projection, open: opened, key: opened.join(',') };
}
