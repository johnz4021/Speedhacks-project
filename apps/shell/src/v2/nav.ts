// Navigation over the containment tree (NAVIGATION_PLAN §3.3): dive, go up, jump, spatial neighbours. Pure: every
// function maps (graph, open, focus) to the next place; the store applies it and keeps history.
import { fileOf, type ContextGraph } from '@harness/core/view';
import type { Frame } from './layout/frame';
import type { Place } from './store';

const OPENABLE = new Set(['domain', 'cell', 'group', 'unassigned']);

export function ancestors(graph: ContextGraph, id: string): string[] {
  const out: string[] = [];
  for (let n: string | null = id; n && n !== graph.root; n = graph.nodes[n]?.parent ?? null) out.push(n);
  return out.reverse(); // top-down, including id
}

/** Is `id` drawn inside an open container (or is it one)? Domains open all of their cells. */
export function isOpen(graph: ContextGraph, open: readonly string[], id: string): boolean {
  if (open.includes(id)) return true;
  const n = graph.nodes[id];
  return n?.kind === 'cell' && !!n.domain && open.includes(`domain:${n.domain}`);
}

/** Remove a container (and anything opened inside it). Closing one cell of an open domain keeps its other cells open. */
export function close(graph: ContextGraph, open: readonly string[], id: string): string[] {
  const n = graph.nodes[id];
  let next = open.filter((o) => o !== id && !ancestors(graph, o).includes(id));
  if (n?.kind === 'cell' && n.domain && next.includes(`domain:${n.domain}`)) {
    const siblings = (graph.children[`domain:${n.domain}`] ?? []).filter((c) => c !== id && graph.nodes[c]!.kind === 'cell');
    next = [...next.filter((o) => o !== `domain:${n.domain}`), ...siblings];
  }
  return next;
}

/** Dive into a node: open it if it is a container (a domain replaces its cells), else just focus it. */
export function dive(graph: ContextGraph, place: Place, id: string): Place {
  const n = graph.nodes[id];
  if (!n || !OPENABLE.has(n.kind) || !(graph.children[id]?.length)) return { ...place, focus: id };
  if (isOpen(graph, place.open, id)) return { open: close(graph, place.open, id), focus: id };
  let open = [...place.open];
  if (n.kind === 'domain') open = open.filter((o) => graph.nodes[o]?.domain !== n.domain || o === id);
  return { open: [...open, id], focus: id };
}

/** Esc: close the deepest open container holding the focus and focus it; at the top, close the last opened. */
export function up(graph: ContextGraph, place: Place): Place {
  const { open, focus } = place;
  if (focus) {
    const path = ancestors(graph, focus);
    for (let i = path.length - 1; i >= 0; i--) {
      const a = path[i]!;
      if (!isOpen(graph, open, a)) continue;
      return { open: close(graph, open, a), focus: a };
    }
    if (graph.nodes[focus]?.kind !== 'domain') {
      const dom = path.find((p) => graph.nodes[p]?.kind === 'domain' || p === 'unassigned');
      if (dom && dom !== focus) return { open, focus: dom };
    }
    return { open, focus: null };
  }
  if (open.length) return { open: open.slice(0, -1), focus: null };
  return place;
}

/** ⌘K jump: open the containers on the way to a node (symbols and routes land on their file) and focus it. */
export function jump(graph: ContextGraph, place: Place, id: string): Place {
  let target = id;
  const n = graph.nodes[id];
  if (n && (n.kind === 'symbol' || n.kind === 'route' || n.kind === 'entry')) target = fileOf(id) ?? n.parent ?? id;
  const t = graph.nodes[target];
  if (!t) return place;
  if (t.kind === 'domain') return isOpen(graph, place.open, target) ? { ...place, focus: target } : dive(graph, place, target);
  const path = ancestors(graph, target);
  // the innermost container to open: the node itself when it is a cell or group, else its parent container
  const own = OPENABLE.has(t.kind) ? target : null;
  const inner = own ?? [...path].reverse().find((p) => p !== target && OPENABLE.has(graph.nodes[p]?.kind ?? '') && graph.nodes[p]!.kind !== 'domain');
  const open = [...place.open];
  if (inner && !isOpen(graph, open, inner)) open.push(inner);
  return { open, focus: target };
}

export type Dir = 'left' | 'right' | 'up' | 'down';
const FOCUSABLE = new Set(['cell', 'spine', 'container', 'file', 'group', 'chip']);

/** The nearest drawn node in a direction (cost: distance along it plus twice the sideways offset). */
export function neighbour(frame: Frame, from: string | null, dir: Dir): string | null {
  const nodes = frame.nodes.filter((n) => FOCUSABLE.has(n.type));
  const cur = from ? frame.boxes[from] : undefined;
  if (!cur) return nodes[0]?.id ?? null;
  const cx = cur.x + cur.w / 2;
  const cy = cur.y + cur.h / 2;
  const [dx, dy] = dir === 'left' ? [-1, 0] : dir === 'right' ? [1, 0] : dir === 'up' ? [0, -1] : [0, 1];
  let best: string | null = null;
  let cost = Infinity;
  for (const n of nodes) {
    if (n.id === from) continue;
    const nx = n.x + n.w / 2;
    const ny = n.y + n.h / 2;
    const ahead = dx ? (dx > 0 ? n.x - (cur.x + cur.w) : cur.x - (n.x + n.w)) : dy > 0 ? n.y - (cur.y + cur.h) : cur.y - (n.y + n.h);
    if (ahead < -1) continue;
    const side = dx ? Math.abs(ny - cy) : Math.abs(nx - cx);
    const c = Math.max(0, ahead) + 2 * side;
    if (c < cost) { cost = c; best = n.id; }
  }
  return best;
}
