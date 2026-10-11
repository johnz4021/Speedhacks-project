// trace (NAVIGATION_PLAN §2 "Wiring trace"): shortest call chains from a symbol, route or file to its sinks.
import type { ContextGraph } from '../contracts/graph';
import { EXTERNAL_LAYER } from './build';
import { byId } from './util';

export const MAX_TRACE_PATHS = 5;

const adjacency = new WeakMap<ContextGraph, Map<string, { to: string; sinkOnly: boolean }[]>>();

/** calls, handles and fetches (UI → route) forward, implements from the interface member to each implementation, writes into tables. */
function adjacencyOf(g: ContextGraph) {
  let adj = adjacency.get(g);
  if (adj) return adj;
  adj = new Map();
  const link = (a: string, b: string, sinkOnly: boolean) => {
    const list = adj!.get(a) ?? adj!.set(a, []).get(a)!;
    if (!list.some((x) => x.to === b)) list.push({ to: b, sinkOnly });
  };
  for (const e of g.edges) {
    if (e.kind === 'calls' || e.kind === 'handles' || e.kind === 'fetches') link(e.from, e.to, false);
    else if (e.kind === 'implements') link(e.to, e.from, false);
    else if (e.kind === 'writes') link(e.from, e.to, true);
  }
  for (const list of adj.values()) list.sort((x, y) => byId(x.to, y.to));
  adjacency.set(g, adj);
  return adj;
}

/**
 * BFS over calls ∪ implements ∪ handles ∪ fetches (plus writes into a table sink). Default sinks: vendor and table nodes,
 * and anything inside an `external` cell. Sinks end a chain. Returns at most MAX_TRACE_PATHS shortest chains
 * (one per sink, nearest first, ties by sink id), each starting at `from`. Dispatch through a registry shows up
 * as an interface member followed by an implementation (`implements` walked backwards).
 */
export function trace(graph: ContextGraph, from: string, sinks?: readonly string[]): string[][] {
  if (!graph.nodes[from]) return [];
  const adj = adjacencyOf(graph);
  const given = sinks ? new Set(sinks) : null;
  const isSink = (id: string) => {
    if (given) return given.has(id);
    const n = graph.nodes[id];
    return id.startsWith('vendor:') || id.startsWith('table:') || n?.layer === EXTERNAL_LAYER;
  };
  const parent = new Map<string, string | null>([[from, null]]);
  const found: string[] = [];
  let frontier = [from];
  while (frontier.length && found.length < MAX_TRACE_PATHS) {
    const next: string[] = [];
    const reached: string[] = [];
    for (const id of frontier) {
      for (const { to, sinkOnly } of adj.get(id) ?? []) {
        if (parent.has(to) || (sinkOnly && !isSink(to))) continue;
        parent.set(to, id);
        if (isSink(to)) reached.push(to);
        else next.push(to);
      }
    }
    found.push(...reached.sort(byId));
    frontier = next;
  }
  return found.slice(0, MAX_TRACE_PATHS).map((sink) => {
    const path: string[] = [];
    for (let n: string | null = sink; n !== null; n = parent.get(n) ?? null) path.push(n);
    return path.reverse();
  });
}
