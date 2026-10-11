// The deterministic domain × layer grid at every depth (NAVIGATION_PLAN §1.2, §3.3). An open column widens to fit
// its containers, the other columns compress to spines, rows grow to the tallest container. Expanded containers are
// laid out by ELK bottom-up; edges route inside containers (ELK), leave through ports, and continue through the
// gutters. Edge declutter: only edges touching the focus region, plus every violation, new and ghost edge, are drawn
// in full; the rest fade (inside containers) or merge into one faint trunk per column pair with a count.
import type { EdgeStatus, Projection, ViolationState, VisibleEdge, VisibleNode } from '@harness/core/view';
import { PAD, SIZE, portKey, type Box, type ChildSpec, type ContainerInput, type ContainerLayout, type LayoutFn, type Pt, type Side } from './containers';

export const COL_W = 236;
export const SPINE_W = 64;
export const ROW_H = 132;
export const ROW_H_SPINE = 92; // rows with no open container shrink while a column is open
export const GAP_X = 56;
export const GAP_Y = 42;
/** Open tracks grow in steps, so a container that grows a little does not move its neighbours. */
export const STEP = 24;
export const UNASSIGNED = 'unassigned';
export const UNASSIGNED_COL = '__unassigned';

export type Meta = { domains: { id: string; name: string; purpose: string }[]; layers: { id: string; name: string }[] };

export type NodeType = 'band' | 'cell' | 'spine' | 'container' | 'file' | 'group' | 'chip';
export type FrameNode = Box & { id: string; type: NodeType; z: number };
export type FrameEdge = {
  id: string;
  d: string;
  status: EdgeStatus;
  violation: ViolationState;
  count: number;
  steps: number[];
  mid: Pt;
  from: string;
  to: string;
  /** Drawn faintly: outside the focus region. A trunk merges several such edges between two columns. */
  faint: boolean;
  /** A ghost a standing decision rules out: drawn struck through, "rejected in DR-4, session 1". */
  decision: { id: string; session: number } | null;
  trunk: string[] | null;
};
export type Col = { id: string; name: string; purpose: string; x: number; w: number; spine: boolean; open: boolean; index: number };
export type Row = { id: string; name: string; y: number; h: number };
export type Frame = {
  nodes: FrameNode[];
  boxes: Record<string, FrameNode>;
  edges: FrameEdge[];
  cols: Col[];
  rows: Row[];
  bounds: Box;
  focus: Box | null;
  gutters: { x: number[]; y: number[] };
  key: string;
};

const CONTAINER_KINDS = new Set(['cell', 'group', 'unassigned']);
const isContainer = (n: VisibleNode | undefined) => !!n && n.expanded && CONTAINER_KINDS.has(n.kind);

/** Index helpers over a projection: visible nodes by id, drawn nodes, columns. */
export function indexOf(p: Projection) {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const showUnassigned = (() => {
    const u = byId.get(UNASSIGNED);
    return !!u && (u.rollup.leaves > 0 || u.expanded);
  })();
  const drawn = (id: string) => {
    const n = byId.get(id);
    if (!n) return false;
    if (n.kind === 'cell') return true;
    if (id === UNASSIGNED) return showUnassigned;
    return isContainer(byId.get(n.parent ?? ''));
  };
  /** Column id of a node: its domain, or the Unassigned column. */
  const colId = (id: string): string | null => {
    const n = byId.get(id);
    if (!n) return null;
    if (n.domain) return n.domain;
    for (let x: VisibleNode | undefined = n; x; x = byId.get(x.parent ?? '')) if (x.id === UNASSIGNED) return UNASSIGNED_COL;
    return null;
  };
  /** ELK containers above a node, innermost first. */
  const containers = (id: string): string[] => {
    const out: string[] = [];
    for (let x = byId.get(byId.get(id)?.parent ?? ''); x; x = byId.get(x.parent ?? '')) if (isContainer(x)) out.push(x.id);
    return out;
  };
  return { byId, drawn, colId, containers, showUnassigned };
}

/** Expanded containers, deepest first (the bottom-up layout order). */
export function containerOrder(p: Projection): string[][] {
  const levels = new Map<number, string[]>();
  for (const n of p.nodes) if (isContainer(n)) (levels.get(n.depth) ?? levels.set(n.depth, []).get(n.depth)!).push(n.id);
  return [...levels].sort((a, b) => b[0] - a[0]).map(([, ids]) => ids);
}

/**
 * ELK input for one container: its drawn children (an open child container enters with its laid-out size and its
 * ports at fixed positions), the edges between its children, and a port for every edge that leaves or enters it.
 * A port faces the other end's column; within a column, out on the right and in on the left (ELK's flow is rightward).
 */
export function containerInput(p: Projection, id: string, done: ReadonlyMap<string, ContainerLayout>, colIndex: (col: string | null) => number): ContainerInput {
  const ix = indexOf(p);
  const children: ChildSpec[] = [];
  for (const n of p.nodes) {
    if (n.parent !== id || !ix.drawn(n.id)) continue;
    const sub = done.get(n.id);
    if (sub) {
      children.push({ id: n.id, w: sub.w, h: sub.h, ports: Object.entries(sub.ports).map(([key, q]) => ({ id: key, at: q.at, side: q.side })) });
    } else {
      const s = n.kind === 'file' ? SIZE.file : n.kind === 'group' ? SIZE.group : SIZE.chip;
      children.push({ id: n.id, w: s.w, h: s.h, ports: [] });
    }
  }
  const mine = new Set(children.map((c) => c.id));
  const here = ix.colId(id);
  /** The child of this container holding `x`, as an ELK endpoint (the child, or the child container's port). */
  const ref = (x: string, e: string): string | null => {
    if (mine.has(x)) return x;
    const chain = ix.containers(x);
    const i = chain.indexOf(id);
    if (i <= 0) return null;
    return portKey(e, chain[i - 1]!);
  };
  const edges: ContainerInput['edges'] = [];
  const ports: ContainerInput['ports'] = [];
  for (const e of drawnEdges(p)) {
    const a = ref(e.from, e.id);
    const b = ref(e.to, e.id);
    if (a && b) {
      if (a !== b) edges.push({ id: e.id, from: a, to: b });
    } else if (a || b) {
      const out = !!a;
      const peerCol = colIndex(ix.colId(out ? e.to : e.from));
      const selfCol = colIndex(here);
      const side: Side = peerCol > selfCol ? 'right' : peerCol < selfCol ? 'left' : out ? 'right' : 'left';
      ports.push({ key: portKey(e.id, id), edge: e.id, node: (a ?? b)!, side, direction: out ? 'out' : 'in' });
    }
  }
  return { id, children, edges, ports };
}

/** Edges whose two ends are drawn (tests, shared code and bare vendors are not drawn on the grid). */
export function drawnEdges(p: Projection): VisibleEdge[] {
  const ix = indexOf(p);
  return p.edges.filter((e) => ix.drawn(e.from) && ix.drawn(e.to));
}

export function columnIndex(p: Projection) {
  const order = [...p.grid.domains, UNASSIGNED_COL];
  return (col: string | null) => (col === null ? -1 : order.indexOf(col));
}

/** Lay out every expanded container bottom-up (siblings in parallel). */
export async function layoutAll(p: Projection, layout: LayoutFn): Promise<Map<string, ContainerLayout>> {
  const done = new Map<string, ContainerLayout>();
  const colIndex = columnIndex(p);
  for (const level of containerOrder(p)) {
    const ls = await Promise.all(level.map((id) => layout(containerInput(p, id, done, colIndex))));
    for (const l of ls) done.set(l.id, l);
  }
  return done;
}

const up = (n: number, step = STEP) => Math.ceil(n / step) * step;

export type FrameInput = {
  projection: Projection;
  meta: Meta;
  layouts: ReadonlyMap<string, ContainerLayout>;
  /** Roots of the focus region (edges touching them are drawn in full); null = everything. */
  region: readonly string[] | null;
  key: string;
};

export function buildFrame({ projection: p, meta, layouts, region, key }: FrameInput): Frame {
  const ix = indexOf(p);
  const cells = p.nodes.filter((n) => n.kind === 'cell');
  const openCol = new Set(cells.filter((n) => n.expanded).map((n) => n.domain!));
  const unassigned = ix.byId.get(UNASSIGNED);
  if (ix.showUnassigned && unassigned?.expanded) openCol.add(UNASSIGNED_COL);
  const any = openCol.size > 0;
  const dmeta = new Map(meta.domains.map((d) => [d.id, d]));
  const lmeta = new Map(meta.layers.map((l) => [l.id, l]));

  // ---- tracks
  const colIds = [...p.grid.domains, ...(ix.showUnassigned ? [UNASSIGNED_COL] : [])];
  const cols: Col[] = [];
  let x = 0;
  colIds.forEach((id, i) => {
    const open = openCol.has(id);
    let w = open ? COL_W : any ? SPINE_W : COL_W;
    if (open) {
      for (const c of cells) if (c.domain === id && c.expanded) w = Math.max(w, layouts.get(c.id)?.w ?? 0);
      if (id === UNASSIGNED_COL) w = Math.max(w, layouts.get(UNASSIGNED)?.w ?? 0);
      w = up(w);
    }
    const d = dmeta.get(id);
    cols.push({ id, name: d?.name ?? (id === UNASSIGNED_COL ? 'Unassigned' : id), purpose: d?.purpose ?? 'Files that match no cell in domains.yaml', x, w, spine: any && !open, open, index: i });
    x += w + GAP_X;
  });
  const rows: Row[] = [];
  let y = 0;
  for (const l of p.grid.layers) {
    let h = any ? ROW_H_SPINE : ROW_H;
    for (const c of cells) if (c.layer === l && c.expanded) h = Math.max(h, up(layouts.get(c.id)?.h ?? 0));
    rows.push({ id: l, name: lmeta.get(l)?.name ?? l, y, h });
    y += h + GAP_Y;
  }
  const width = Math.max(0, x - GAP_X);
  const height = Math.max(0, y - GAP_Y);
  const colOf = new Map(cols.map((c) => [c.id, c]));
  const rowOf = new Map(rows.map((r, j) => [r.id, { ...r, index: j }]));

  // ---- boxes: bands and grid cells, then container children (parents before children: projection pre-order)
  const nodes: FrameNode[] = [];
  const boxes: Record<string, FrameNode> = {};
  const add = (n: FrameNode) => { nodes.push(n); boxes[n.id] = n; };
  let focus: Box | null = null;
  for (const c of cols) {
    if (!c.open) continue;
    const id = c.id === UNASSIGNED_COL ? `band:${UNASSIGNED}` : `domain:${c.id}`;
    const b = { x: c.x - 14, y: -14, w: c.w + 28, h: height + 28 };
    add({ id, type: 'band', z: 0, ...b });
    focus = focus ? union(focus, b) : b;
  }
  for (const n of p.nodes) {
    if (n.kind === 'cell') {
      const c = colOf.get(n.domain!)!;
      const r = rowOf.get(n.layer!)!;
      add({ id: n.id, type: n.expanded ? 'container' : c.spine ? 'spine' : 'cell', z: 1, x: c.x, y: r.y, w: c.w, h: r.h });
    } else if (n.id === UNASSIGNED && ix.showUnassigned) {
      const c = colOf.get(UNASSIGNED_COL)!;
      const h = n.expanded ? Math.max(height, layouts.get(UNASSIGNED)?.h ?? 0) : height;
      add({ id: n.id, type: n.expanded ? 'container' : c.spine ? 'spine' : 'cell', z: 1, x: c.x, y: 0, w: c.w, h });
    } else if (ix.drawn(n.id)) {
      const parent = boxes[n.parent!];
      const b = layouts.get(n.parent!)?.nodes[n.id];
      if (!parent || !b) continue;
      const type: NodeType = isContainer(n) ? 'container' : n.kind === 'file' ? 'file' : n.kind === 'group' ? 'group' : 'chip';
      add({ id: n.id, type, z: n.depth, x: parent.x + b.x, y: parent.y + b.y, w: b.w, h: b.h });
    }
  }

  // ---- gutters and lanes
  const colGutter = (g: number) => (g <= 0 ? -GAP_X / 2 : cols[g - 1]!.x + cols[g - 1]!.w + GAP_X / 2);
  const rowGutter = (g: number) => (g <= 0 ? -GAP_Y / 2 : rows[g - 1]!.y + rows[g - 1]!.h + GAP_Y / 2);
  const used = new Map<string, number>();
  const take = (k: string) => { const n = used.get(k) ?? 0; used.set(k, n + 1); return n; };
  const lane = (i: number, s: number) => (i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * s);
  const colAt = (px: number) => { let i = 0; while (i < cols.length - 1 && px > cols[i]!.x + cols[i]!.w + GAP_X / 2) i++; return i; };
  const rowAt = (py: number) => { let j = 0; while (j < rows.length - 1 && py > rows[j]!.y + rows[j]!.h + GAP_Y / 2) j++; return j; };

  type Anchor = { p: Pt; side: Side; col: number; row: number };
  const abs = (c: string, q: Pt): Pt => ({ x: boxes[c]!.x + q.x, y: boxes[c]!.y + q.y });
  const boxAnchor = (self: string, other: Pt): Anchor | null => {
    const b = boxes[self];
    if (!b) return null;
    const col = colAt(b.x + b.w / 2);
    const row = rowAt(b.y + Math.min(b.h / 2, 60));
    const oc = colAt(other.x);
    const or = rowAt(other.y);
    const side: Side = oc > col ? 'right' : oc < col ? 'left' : or > row ? 'bottom' : 'top';
    const k = take(`port:${self}:${side}`);
    const p = side === 'right' || side === 'left'
      ? { x: side === 'right' ? b.x + b.w : b.x, y: b.y + Math.min(b.h / 2, 60) + lane(k, 10) }
      : { x: b.x + b.w / 2 + lane(k, 10), y: side === 'bottom' ? b.y + b.h : b.y };
    return { p, side, col, row };
  };
  const center = (id: string): Pt => { const b = boxes[id]!; return { x: b.x + b.w / 2, y: b.y + Math.min(b.h / 2, 60) }; };

  // Edges between the same two containers (same status) share one lane in every gutter: a trunk that fans out only
  // at the ports. Rule-crossing edges get their own trunk and stay distinct.
  const bundled = new Map<string, number>();
  const laneFor = (k: string, bundle: string) => {
    const kk = `${k}|${bundle}`;
    let i = bundled.get(kk);
    if (i === undefined) bundled.set(kk, (i = take(k)));
    return i;
  };
  const route = (A: Anchor, B: Anchor, bundle: string): Pt[] => {
    const hA = A.side === 'left' || A.side === 'right';
    const hB = B.side === 'left' || B.side === 'right';
    const gxOf = (a: Anchor) => (a.side === 'right' ? a.col + 1 : a.col);
    const gyOf = (a: Anchor) => (a.side === 'bottom' ? a.row + 1 : a.row);
    const gx = (g: number) => colGutter(g) + lane(laneFor(`col:${g}`, bundle), 7);
    const gy = (g: number) => rowGutter(g) + lane(laneFor(`row:${g}`, bundle), 6);
    if (hA && hB) {
      const g1 = gxOf(A);
      const g2 = gxOf(B);
      if (g1 === g2) {
        if (Math.abs(A.p.y - B.p.y) < 1) return [A.p, B.p];
        const x1 = gx(g1);
        return [A.p, { x: x1, y: A.p.y }, { x: x1, y: B.p.y }, B.p];
      }
      const rg = B.row > A.row ? B.row : B.row < A.row ? B.row + 1 : A.row + 1; // run across next to the target
      const x1 = gx(g1);
      const yy = gy(rg);
      const x2 = gx(g2);
      return [A.p, { x: x1, y: A.p.y }, { x: x1, y: yy }, { x: x2, y: yy }, { x: x2, y: B.p.y }, B.p];
    }
    if (!hA && !hB) {
      const g1 = gyOf(A);
      const g2 = gyOf(B);
      if (g1 === g2) {
        const y1 = gy(g1);
        return [A.p, { x: A.p.x, y: y1 }, { x: B.p.x, y: y1 }, B.p];
      }
      const y1 = gy(g1);
      const xx = gx(A.col + 1);
      const y2 = gy(g2);
      return [A.p, { x: A.p.x, y: y1 }, { x: xx, y: y1 }, { x: xx, y: y2 }, { x: B.p.x, y: y2 }, B.p];
    }
    if (hA) {
      const x1 = gx(gxOf(A));
      const y2 = gy(gyOf(B));
      return [A.p, { x: x1, y: A.p.y }, { x: x1, y: y2 }, { x: B.p.x, y: y2 }, B.p];
    }
    const y1 = gy(gyOf(A));
    const x2 = gx(gxOf(B));
    return [A.p, { x: A.p.x, y: y1 }, { x: x2, y: y1 }, { x: x2, y: B.p.y }, B.p];
  };

  // ---- declutter
  const roots = region ? new Set(region) : null;
  const inRegion = (id: string) => {
    if (!roots) return true;
    for (let n = ix.byId.get(id); n; n = ix.byId.get(n.parent ?? '')) if (roots.has(n.id)) return true;
    return false;
  };
  const loud = (e: VisibleEdge) => e.status !== 'existing' || e.violation !== null || !!e.decision;
  const drawn = drawnEdges(p).filter((e) => boxes[e.from] && boxes[e.to]);
  const full: VisibleEdge[] = [];
  const faintInside: VisibleEdge[] = [];
  const trunks = new Map<string, VisibleEdge[]>();
  for (const e of drawn) {
    if (loud(e) || inRegion(e.from) || inRegion(e.to)) full.push(e);
    else if (ix.containers(e.from).length || ix.containers(e.to).length) faintInside.push(e);
    else {
      const k = `trunk:${ix.colId(e.from)}>${ix.colId(e.to)}`;
      (trunks.get(k) ?? trunks.set(k, []).get(k)!).push(e);
    }
  }

  const pathOf = (e: VisibleEdge, bundle: string): Pt[] | null => {
    const ca = ix.containers(e.from);
    const cb = ix.containers(e.to);
    const shared = ca.find((c) => cb.includes(c)) ?? null;
    const ownA = shared ? ca.slice(0, ca.indexOf(shared)) : ca;
    const ownB = shared ? cb.slice(0, cb.indexOf(shared)) : cb;
    const seg = (c: string) => (layouts.get(c)?.edges[e.id] ?? []).map((q) => abs(c, q));
    const segA = ownA.flatMap(seg);
    const segB = [...ownB].reverse().flatMap(seg);
    if (shared) return [...segA, ...seg(shared), ...segB];
    const outer = (chain: string[], self: string, other: Pt): Anchor | null => {
      const c = chain.at(-1);
      if (!c) return boxAnchor(self, other);
      const q = layouts.get(c)?.ports[portKey(e.id, c)];
      if (!q) return null;
      const pt = abs(c, q.at);
      return { p: pt, side: q.side, col: colAt(pt.x), row: rowAt(pt.y) };
    };
    const A = outer(ownA, e.from, center(e.to));
    const B = outer(ownB, e.to, center(e.from));
    if (!A || !B) return null;
    return [...segA, ...route(A, B, bundle), ...segB];
  };
  const bundleOf = (e: VisibleEdge) => {
    const top = (id: string) => ix.containers(id).at(-1) ?? id;
    return `${top(e.from)}>${top(e.to)}|${e.status}|${e.violation ?? ''}`;
  };

  const edges: FrameEdge[] = [];
  const push = (e: VisibleEdge, pts: Pt[] | null, faint: boolean, trunk: string[] | null, id = e.id, count = e.count) => {
    if (!pts || pts.length < 2) return;
    pts = dedupe(pts);
    edges.push({ id, d: roundedPath(pts, 8), status: e.status, violation: e.violation, count, steps: e.steps, mid: midpoint(pts), from: e.from, to: e.to, faint, trunk, decision: e.decision ?? null });
  };
  // Lanes are taken in a fixed order (existing, new, ghost; then faint) so they stay put as a turn adds edges.
  const rank = { existing: 0, new: 1, ghost: 2 } as const;
  for (const e of [...full].sort((a, b) => rank[a.status] - rank[b.status] || a.id.localeCompare(b.id))) push(e, pathOf(e, bundleOf(e)), false, null);
  for (const e of faintInside.sort((a, b) => a.id.localeCompare(b.id))) push(e, pathOf(e, bundleOf(e)), true, null);
  for (const [k, list] of [...trunks].sort(([a], [b]) => a.localeCompare(b))) {
    const rep = [...list].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))[0]!;
    push(rep, pathOf(rep, k), true, list.map((e) => e.id), k, list.reduce((s, e) => s + e.count, 0));
  }

  if (roots && !focus) for (const r of roots) if (boxes[r]) focus = focus ? union(focus, boxes[r]!) : boxes[r]!;
  return {
    nodes, boxes, edges, cols, rows, key,
    bounds: { x: -GAP_X / 2, y: -GAP_Y / 2, w: width + GAP_X, h: Math.max(height, ...nodes.map((n) => n.y + n.h)) + GAP_Y },
    focus,
    gutters: { x: cols.map((_, g) => colGutter(g)).concat(colGutter(cols.length)), y: rows.map((_, g) => rowGutter(g)).concat(rowGutter(rows.length)) },
  };
}

export const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

function dedupe(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(q.x - p.x) < 0.5 && Math.abs(q.y - p.y) < 0.5) continue;
    out.push(p);
  }
  return out;
}

function midpoint(pts: Pt[]): Pt {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  let half = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (half <= d && d > 0) return { x: a.x + ((b.x - a.x) * half) / d, y: a.y + ((b.y - a.y) * half) / d };
    half -= d;
  }
  return pts[0]!;
}

export function roundedPath(pts: Pt[], r: number): string {
  const f = (n: number) => n.toFixed(1);
  let d = `M${f(pts[0]!.x)},${f(pts[0]!.y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1]!;
    const c = pts[i]!;
    const n = pts[i + 1]!;
    const d1 = Math.hypot(c.x - p.x, c.y - p.y);
    const d2 = Math.hypot(n.x - c.x, n.y - c.y);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    if (rr < 0.5) { d += `L${f(c.x)},${f(c.y)}`; continue; }
    const ax = c.x - ((c.x - p.x) / d1) * rr;
    const ay = c.y - ((c.y - p.y) / d1) * rr;
    const bx = c.x + ((n.x - c.x) / d2) * rr;
    const by = c.y + ((n.y - c.y) / d2) * rr;
    d += `L${f(ax)},${f(ay)}Q${f(c.x)},${f(c.y)} ${f(bx)},${f(by)}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d}L${f(last.x)},${f(last.y)}`;
}

/** Stroke width by count (aggregated edges read heavier). */
export const strokeFor = (count: number) => 1.5 + Math.min(3, Math.log2(Math.max(1, count))) * 0.75;

export { PAD };
