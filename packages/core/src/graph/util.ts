// Lazy per-graph indexes, cached by identity (graphs are treated as immutable once built).
import type { ContextGraph, GraphEdge } from '../contracts/graph';

const memo = <T>(build: (g: ContextGraph) => T) => {
  const cache = new WeakMap<ContextGraph, T>();
  return (g: ContextGraph): T => {
    let v = cache.get(g);
    if (v === undefined) cache.set(g, (v = build(g)));
    return v;
  };
};

/** from → leaf edges, in graph order. */
export const outEdges = memo((g) => {
  const out = new Map<string, GraphEdge[]>();
  for (const e of g.edges) {
    const list = out.get(e.from);
    if (list) list.push(e);
    else out.set(e.from, [e]);
  }
  return out;
});

export const edgeIds = memo((g) => new Set(g.edges.map((e) => e.id)));

/** Files in a subtree (a file counts itself) and symbols strictly below a node; memoized for containers only. */
export const subtreeCounts = memo((g) => {
  const cache = new Map<string, { files: number; symbols: number }>();
  const count = (id: string): { files: number; symbols: number } => {
    const kids = g.children[id];
    const self = g.nodes[id]!.kind === 'file' ? 1 : 0;
    if (!kids?.length) return { files: self, symbols: 0 };
    let c = cache.get(id);
    if (c) return c;
    c = { files: self, symbols: 0 };
    for (const k of kids) {
      const s = count(k);
      c.files += s.files;
      c.symbols += s.symbols + (g.nodes[k]!.kind === 'symbol' ? 1 : 0);
    }
    cache.set(id, c);
    return c;
  };
  return count;
});

/** Ancestors of `id` from the root down, including `id`. */
export function pathTo(g: ContextGraph, id: string): string[] {
  const out: string[] = [];
  for (let n: string | null = id; n; n = g.nodes[n]?.parent ?? null) out.push(n);
  return out.reverse();
}

export const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
