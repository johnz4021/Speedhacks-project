// project (NAVIGATION_PLAN §3.2): visible nodes with rolled-up activity, aggregated edges and ports for one view.
import type { TurnActivity } from '../contracts/api';
import type { CallConfidence } from '../contracts/facts';
import {
  NEUTRAL_ID, cellId, fileOf,
  type ContextGraph, type EdgeKind, type GraphEdge, type Port, type Projection, type Rollup, type ViewState, type VisibleEdge, type VisibleNode, type ViolationState,
} from '../contracts/graph';
import { strongerMark } from './activity';
import { byId, pathTo, subtreeCounts } from './util';

const SEVERITY = { new: 2, existing: 1 } as const;
/** The worse of two violation states ('new' > 'existing' > null). */
export const worse = (a: ViolationState, b: ViolationState): ViolationState => ((b ? SEVERITY[b] : 0) > (a ? SEVERITY[a] : 0) ? b : a);
const CONFIDENCE: Record<CallConfidence, number> = { dispatch: 0, syntactic: 1, typed: 2 };
/** Weakest call confidence (dispatch < syntactic < typed). */
const weaker = (a: CallConfidence | null, b: CallConfidence | undefined): CallConfidence | null =>
  !b ? a : !a || CONFIDENCE[b] < CONFIDENCE[a] ? b : a;

const emptyRollup = (leaves: number): Rollup => ({
  looked: false, edited: false, added: 0, removed: 0, ghostSteps: [], unplanned: false, violation: null,
  violationFiles: [], newViolationFiles: [], cursor: false, audit: 0, proposal: null, leaves,
});

/** True when a rollup carries activity from the turn (what the turn lens keeps). */
export const isActive = (r: Rollup) =>
  r.looked || r.edited || r.ghostSteps.length > 0 || r.unplanned || r.violation === 'new' || r.cursor || r.added > 0 || r.removed > 0;

/**
 * Visible set: the root's children, plus the children of every expanded visible node. `view.focus` does not
 * change visibility (autoExpand does). Leaf activity rolls up to the nearest visible ancestor (and on to the
 * expanded containers above it, so a container's rollup always covers its whole subtree): booleans OR,
 * counts sum, violation MAX. Ghost and unplanned keep cellViews' cell semantics at every depth: a planned unit
 * (a cell, or a leaf outside cells) is a ghost only while nothing in it under the node is edited, and an edited
 * unit is unplanned only if nothing in it under the node is planned. Leaf edges map to their nearest visible
 * endpoints and aggregate by (from, to); self-loops and edges touching neutral code or the root are dropped.
 * Ghost (planned) edges aggregate in their own lane. Ports mark where an edge leaves or enters an expanded container.
 * `lens.kinds` filters edge kinds (empty = all); `lens.turnOnly` keeps only nodes with turn activity.
 */
export function project(graph: ContextGraph, view: ViewState, activity: TurnActivity): Projection {
  const counts = subtreeCounts(graph);
  const expanded = new Set(view.expanded);

  // ---- visible tree (pre-order, siblings by order)
  const visible = new Map<string, VisibleNode>();
  const order: string[] = [];
  const walk = (parent: string, vparent: string | null, depth: number) => {
    for (const id of graph.children[parent] ?? []) {
      const n = graph.nodes[id]!;
      const expandable = (graph.children[id]?.length ?? 0) > 0;
      const isOpen = expandable && expanded.has(id);
      visible.set(id, {
        id, kind: n.kind, parent: vparent, label: n.label, depth, expanded: isOpen, expandable, order: n.order,
        ...(n.domain ? { domain: n.domain } : {}), ...(n.layer ? { layer: n.layer } : {}), ...(n.path ? { path: n.path } : {}),
        rollup: emptyRollup(n.kind === 'file' ? counts(id).symbols : n.kind === 'symbol' ? counts(id).symbols + 1 : counts(id).files),
      });
      order.push(id);
      if (isOpen) walk(id, id, depth + 1);
    }
  };
  walk(graph.root, null, 0);

  const repMemo = new Map<string, string | null>();
  /** Nearest visible ancestor-or-self (null for the root and unknown ids). */
  const rep = (id: string): string | null => {
    let r = repMemo.get(id);
    if (r !== undefined) return r;
    const n = graph.nodes[id];
    r = !n || id === graph.root ? null : visible.has(id) ? id : n.parent ? rep(n.parent) : null;
    repMemo.set(id, r);
    return r;
  };
  const endMemo = new Map<string, string | null>();
  /** Edge endpoint: the nearest visible ancestor-or-self, or null inside neutral code (which never draws edges). */
  const end = (id: string): string | null => {
    let r = endMemo.get(id);
    if (r !== undefined) return r;
    const n = graph.nodes[id];
    if (!n || id === graph.root || id === NEUTRAL_ID || !n.parent) r = null;
    else if (n.parent === graph.root) r = id;
    else {
      const up = end(n.parent);
      r = up === null ? null : visible.has(id) ? id : up;
    }
    endMemo.set(id, r);
    return r;
  };
  /** Cell semantics unit: a leaf's cell, or the leaf's file outside cells. */
  const unit = (id: string) => {
    const n = graph.nodes[id]!;
    return n.domain && n.layer ? cellId(n.domain, n.layer) : fileOf(id) ?? id;
  };

  // ---- rollups
  type Unit = { ghost: Set<number>; edited: boolean; planned: boolean; unplanned: boolean };
  const units = new Map<string, Map<string, Unit>>();
  for (const [id, l] of Object.entries(activity.leaves)) {
    const k = unit(id);
    // the nearest visible ancestor, and every visible (hence expanded) container above it
    for (let r = rep(id); r; r = visible.get(r)!.parent) {
      const ro = visible.get(r)!.rollup;
      ro.looked ||= l.looked;
      ro.edited ||= l.edited;
      ro.added += l.added;
      ro.removed += l.removed;
      ro.violation = worse(ro.violation, l.violation);
      if (l.violation === 'new') ro.newViolationFiles.push(fileOf(id) ?? id);
      ro.cursor ||= l.cursor;
      ro.audit += l.audit;
      ro.proposal = strongerMark(ro.proposal, l.proposal);
      const byUnit = units.get(r) ?? units.set(r, new Map()).get(r)!;
      const u = byUnit.get(k) ?? byUnit.set(k, { ghost: new Set(), edited: false, planned: false, unplanned: false }).get(k)!;
      for (const s of l.ghostSteps) u.ghost.add(s);
      u.edited ||= l.edited;
      u.planned ||= l.planned;
      u.unplanned ||= l.unplanned;
    }
  }
  for (const [r, byUnit] of units) {
    const ro = visible.get(r)!.rollup;
    const ghost = new Set<number>();
    for (const u of byUnit.values()) {
      if (!u.edited) for (const s of u.ghost) ghost.add(s);
      if (u.unplanned && !u.planned) ro.unplanned = true;
    }
    ro.ghostSteps = [...ghost].sort((a, b) => a - b);
  }
  for (const f of activity.violations.files) {
    for (let r = rep(f); r; r = visible.get(r)!.parent) visible.get(r)!.rollup.violationFiles.push(f);
  }
  for (const v of visible.values()) {
    v.rollup.violationFiles = [...new Set(v.rollup.violationFiles)].sort(byId);
    v.rollup.newViolationFiles = [...new Set(v.rollup.newViolationFiles)].sort(byId);
  }

  const shown = view.lens.turnOnly ? new Set(order.filter((id) => isActive(visible.get(id)!.rollup))) : null;
  const nodes = order.filter((id) => !shown || shown.has(id)).map((id) => visible.get(id)!);

  // ---- edges
  const kinds = view.lens.kinds.length ? new Set<EdgeKind>(view.lens.kinds) : null;
  // index the few listed ids by their `from`, so the loop below only hashes ids of edges leaving those leaves
  const byFrom = (ids: readonly string[]) => {
    const m = new Map<string, Set<string>>();
    for (const id of ids) {
      const from = id.slice(id.indexOf('|') + 1, id.lastIndexOf('|'));
      (m.get(from) ?? m.set(from, new Set()).get(from)!).add(id);
    }
    return { has: (e: GraphEdge) => !!m.get(e.from)?.has(e.id) };
  };
  const added = byFrom(activity.addedEdges);
  const existing = byFrom(activity.violations.edges);
  const endpoints = (from: string, to: string): [string, string] | null => {
    const a = end(from);
    if (!a) return null;
    const b = end(to);
    if (!b || a === b) return null;
    if (shown && (!shown.has(a) || !shown.has(b))) return null;
    return [a, b];
  };
  type Solid = VisibleEdge & { kindSet: Set<EdgeKind> };
  const solid: Solid[] = [];
  const byPair = new Map<string, Map<string, Solid>>();
  for (const e of graph.edges) {
    if (kinds && !kinds.has(e.kind)) continue;
    const ends = endpoints(e.from, e.to);
    if (!ends) continue;
    const row = byPair.get(ends[0]) ?? byPair.set(ends[0], new Map()).get(ends[0])!;
    let v = row.get(ends[1]);
    if (!v) {
      v = { id: `${ends[0]}->${ends[1]}`, from: ends[0], to: ends[1], kinds: [], kindSet: new Set(), count: 0, status: 'existing', violation: null, confidence: null, steps: [], leafEdges: [] };
      row.set(ends[1], v);
      solid.push(v);
    }
    v.kindSet.add(e.kind);
    v.count += 1;
    v.leafEdges.push(e.id);
    if (added.has(e)) v.status = 'new';
    if (existing.has(e)) v.violation = worse(v.violation, 'existing');
    if (e.kind === 'calls') v.confidence = weaker(v.confidence, e.confidence);
  }
  const ghosts = new Map<string, VisibleEdge & { stepSet: Set<number> }>();
  if (!kinds || kinds.has('imports')) {
    for (const pe of activity.plannedEdges) {
      const ends = endpoints(pe.from, pe.to);
      if (!ends) continue;
      const id = `ghost:${ends[0]}->${ends[1]}`;
      let v = ghosts.get(id);
      if (!v) ghosts.set(id, (v = { id, from: ends[0], to: ends[1], kinds: ['imports'], count: 0, status: 'ghost', violation: null, confidence: null, steps: [], stepSet: new Set(), leafEdges: [] }));
      v.count += 1;
      v.leafEdges.push(`plan|${pe.from}|${pe.to}`);
      v.violation = worse(v.violation, pe.violation);
      for (const s of pe.steps) v.stepSet.add(s);
    }
  }
  const edges: VisibleEdge[] = [
    ...solid.map(({ kindSet, ...v }) => ({ ...v, kinds: [...kindSet].sort(byId) })),
    ...[...ghosts.values()].map(({ stepSet, ...v }) => ({ ...v, steps: [...stepSet].sort((a, b) => a - b) })),
  ].sort((a, b) => byId(a.id, b.id));

  // ---- ports: every expanded container an edge leaves (out) or enters (in)
  const ports: Port[] = [];
  const ancestors = (id: string) => {
    const out: string[] = [];
    for (let p = visible.get(id)!.parent; p; p = visible.get(p)!.parent) out.push(p);
    return out;
  };
  for (const e of edges) {
    const fa = ancestors(e.from);
    const ta = ancestors(e.to);
    const ts = new Set(ta);
    const fs = new Set(fa);
    for (const c of fa) if (!ts.has(c)) ports.push({ container: c, edge: e.id, side: side(graph, c, e.to), direction: 'out' });
    for (const c of ta) if (!fs.has(c)) ports.push({ container: c, edge: e.id, side: side(graph, c, e.from), direction: 'in' });
  }
  return { nodes, edges, ports };
}

/**
 * Which side of container `c` faces node `x`, from grid position: where their ancestor chains diverge, siblings
 * under a domain are rows (cells in layer order, tests last) → top/bottom; anywhere else (domain columns in map
 * order, or children inside a cell) → left/right by sibling order.
 */
export function side(graph: ContextGraph, c: string, x: string): Port['side'] {
  const pc = pathTo(graph, c);
  const px = pathTo(graph, x);
  let i = 0;
  while (i < pc.length && i < px.length && pc[i] === px[i]) i++;
  const a = pc[i];
  const b = px[i];
  if (!a || !b) return 'right'; // one contains the other: not a crossing
  const after = graph.nodes[b]!.order > graph.nodes[a]!.order;
  return graph.nodes[pc[i - 1]!]!.kind === 'domain' ? (after ? 'bottom' : 'top') : after ? 'right' : 'left';
}
