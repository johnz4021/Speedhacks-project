// The deterministic domain × layer grid at every depth: an expanded domain's column widens to fit its containers,
// the other columns compress to spines, rows grow to the tallest container. Edges route through the gutters;
// edges that leave a container start at its ELK port and continue through the gutters to the other endpoint.
import type { EdgeStatus, ViolationState, VisibleEdge, VisibleNode } from '@harness/core/view';
import type { Scene } from '../scene';
import { portKey, portSide, type Box, type ContainerInput, type ContainerLayout, type Pt } from './containers';

/** One ELK input per expanded cell: its files, the edges inside it, and the ports where edges leave it. */
export function containerInputs(scene: Scene): ContainerInput[] {
  const { nodes, edges, ports } = scene.projection;
  const out = new Map<string, ContainerInput>();
  for (const n of nodes) if (n.kind === 'cell' && n.expanded) out.set(n.id, { id: n.id, children: [], edges: [], ports: [] });
  const parent = new Map<string, string>();
  for (const n of [...nodes].sort((a, b) => a.order - b.order)) {
    if (n.kind === 'file' && n.parent && out.has(n.parent)) { out.get(n.parent)!.children.push(n.id); parent.set(n.id, n.parent); }
  }
  const byEdge = new Map(edges.map((e) => [e.id, e]));
  for (const e of edges) {
    const c = parent.get(e.from);
    if (c && c === parent.get(e.to)) out.get(c)!.edges.push({ id: e.id, from: e.from, to: e.to });
  }
  for (const p of ports) {
    const e = byEdge.get(p.edge);
    const c = out.get(p.container);
    if (!e || !c) continue;
    c.ports.push({ ...p, node: p.direction === 'out' ? e.from : e.to });
  }
  return [...out.values()];
}

export const COL_W = 236;
export const SPINE_W = 64;
export const ROW_H = 132;
export const ROW_H_SPINE = 92; // rows with no open container shrink while a domain is open
export const GAP_X = 56;
export const GAP_Y = 42;

export type NodeType = 'band' | 'cell' | 'spine' | 'container' | 'file';
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
};
export type Col = { id: string; name: string; purpose: string; x: number; w: number; spine: boolean; expanded: boolean; index: number };
export type Row = { id: string; name: string; y: number; h: number };
export type Frame = {
  nodes: FrameNode[];
  boxes: Record<string, FrameNode>;
  edges: FrameEdge[];
  cols: Col[];
  rows: Row[];
  bounds: Box;
  focus: Box | null;
  gutters: { x: number[]; y: number[] }; // gutter centre lines, for registration marks
  key: string; // expanded set the frame was laid out for
  scene: Scene; // what the nodes show; published to the store in the same commit as the positions
};

export function buildFrame(scene: Scene, layouts: ReadonlyMap<string, ContainerLayout>, key: string): Frame {
  const { grid, projection } = scene;
  const byId = new Map(projection.nodes.map((n) => [n.id, n]));
  const open = new Set(projection.nodes.filter((n) => n.kind === 'domain' && n.expanded).map((n) => n.domain!));
  const any = open.size > 0;

  // Track sizes.
  const colW = grid.domains.map((d) => {
    if (!open.has(d.id)) return any ? SPINE_W : COL_W;
    let w = COL_W;
    for (const l of grid.cells[d.id] ?? []) w = Math.max(w, layouts.get(`cell:${d.id}/${l}`)?.w ?? 0);
    return w;
  });
  const rowH = grid.layers.map((l) => {
    let h = any ? ROW_H_SPINE : ROW_H;
    for (const d of open) h = Math.max(h, layouts.get(`cell:${d}/${l.id}`)?.h ?? 0);
    return h;
  });
  const cols: Col[] = [];
  let x = 0;
  grid.domains.forEach((d, i) => {
    cols.push({ id: d.id, name: d.name, purpose: d.purpose, x, w: colW[i]!, spine: any && !open.has(d.id), expanded: open.has(d.id), index: i });
    x += colW[i]! + GAP_X;
  });
  const rows: Row[] = [];
  let y = 0;
  grid.layers.forEach((l, j) => {
    rows.push({ id: l.id, name: l.name, y, h: rowH[j]! });
    y += rowH[j]! + GAP_Y;
  });
  const width = x - GAP_X;
  const height = y - GAP_Y;
  const colOf = new Map(cols.map((c) => [c.id, c]));
  const rowOf = new Map(rows.map((r, j) => [r.id, { ...r, index: j }]));

  // Node boxes.
  const nodes: FrameNode[] = [];
  const boxes: Record<string, FrameNode> = {};
  const add = (n: FrameNode) => { nodes.push(n); boxes[n.id] = n; };
  let focus: Box | null = null;
  for (const n of projection.nodes) {
    if (n.kind === 'domain' && n.expanded) {
      const c = colOf.get(n.domain!)!;
      const b = { x: c.x - 14, y: -14, w: c.w + 28, h: height + 28 };
      add({ id: n.id, type: 'band', z: 0, ...b });
      focus = focus ? union(focus, b) : b;
    } else if (n.kind === 'cell') {
      const c = colOf.get(n.domain!)!;
      const r = rowOf.get(n.layer!)!;
      add({ id: n.id, type: n.expanded ? 'container' : c.spine ? 'spine' : 'cell', z: 1, x: c.x, y: r.y, w: c.w, h: r.h });
    }
  }
  for (const n of projection.nodes) {
    if (n.kind !== 'file' || !n.parent) continue;
    const parent = boxes[n.parent];
    const b = layouts.get(n.parent)?.nodes[n.id];
    if (!parent || !b) continue;
    add({ id: n.id, type: 'file', z: 2, x: parent.x + b.x, y: parent.y + b.y, w: b.w, h: b.h });
  }

  // Gutters and lanes.
  const colGutter = (g: number) => (g <= 0 ? -GAP_X / 2 : cols[g - 1]!.x + cols[g - 1]!.w + GAP_X / 2);
  const rowGutter = (g: number) => (g <= 0 ? -GAP_Y / 2 : rows[g - 1]!.y + rows[g - 1]!.h + GAP_Y / 2);
  const used = new Map<string, number>();
  const take = (k: string) => { const n = used.get(k) ?? 0; used.set(k, n + 1); return n; };
  const lane = (i: number, s: number) => (i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * s);

  type Side = 'top' | 'right' | 'bottom' | 'left';
  const portOf = new Map(projection.ports.map((p) => [portKey(p.edge, p.container), p]));
  type Anchor = { p: Pt; side: Side; col: number; row: number; pre: Pt[] };
  const cellIndex = (n: VisibleNode) => ({ col: colOf.get(n.domain!)!.index, row: rowOf.get(n.layer!)!.index });

  const anchor = (self: VisibleNode, other: VisibleNode, e: VisibleEdge, out: boolean): Anchor | null => {
    const { col, row } = cellIndex(self);
    if (self.kind === 'file') {
      const container = boxes[self.parent!];
      const port = layouts.get(self.parent!)?.ports[portKey(e.id, self.parent!)];
      if (!container || !port) return null;
      const lp = portOf.get(portKey(e.id, self.parent!));
      const side: Side = lp ? portSide(lp) : out ? 'right' : 'left';
      const abs = port.route.map((q) => ({ x: container.x + q.x, y: container.y + q.y }));
      const at = { x: container.x + port.at.x, y: container.y + port.at.y };
      if (side === 'right') at.x = container.x + container.w;
      if (side === 'left') at.x = container.x;
      // ELK routes run child → port for outgoing edges and port → child for incoming ones.
      const pre = out ? abs : [...abs].reverse();
      return { p: at, side, col, row, pre };
    }
    const b = boxes[self.id];
    if (!b) return null;
    const o = cellIndex(other);
    const side: Side = o.col > col ? 'right' : o.col < col ? 'left' : o.row > row ? 'bottom' : 'top';
    const k = take(`port:${self.id}:${side}`);
    const p = side === 'right' || side === 'left'
      ? { x: side === 'right' ? b.x + b.w : b.x, y: b.y + b.h / 2 + lane(k, 10) }
      : { x: b.x + b.w / 2 + lane(k, 10), y: side === 'bottom' ? b.y + b.h : b.y };
    return { p, side, col, row, pre: [] };
  };

  // Bundling: edges between the same two containers (same status) share one lane in every gutter, so they read as a
  // trunk that fans out only at the ports. Rule-crossing edges get their own trunk and stay distinct.
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

  // Existing edges first, then new, then ghosts: lanes are assigned in this order and stay stable as a turn adds edges.
  const rank = { existing: 0, new: 1, ghost: 2 } as const;
  const ordered = [...projection.edges].sort((a, b) => rank[a.status] - rank[b.status] || a.id.localeCompare(b.id));
  const edges: FrameEdge[] = [];
  for (const e of ordered) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    let pts: Pt[] | null = null;
    if (a.kind === 'file' && b.kind === 'file' && a.parent === b.parent) {
      const c = boxes[a.parent!];
      const inner = layouts.get(a.parent!)?.edges[e.id];
      if (c && inner?.length) pts = inner.map((q) => ({ x: c.x + q.x, y: c.y + q.y }));
    } else {
      const A = anchor(a, b, e, true);
      const B = anchor(b, a, e, false);
      const box = (n: VisibleNode) => (n.kind === 'file' ? n.parent : n.id);
      if (A && B) pts = [...A.pre, ...route(A, B, `${box(a)}>${box(b)}|${e.status}|${e.violation ?? ''}`), ...B.pre];
    }
    if (!pts || pts.length < 2) continue;
    pts = dedupe(pts);
    edges.push({ id: e.id, d: roundedPath(pts, 8), status: e.status, violation: e.violation, count: e.count, steps: e.steps, mid: midpoint(pts), from: e.from, to: e.to });
  }

  return { nodes, boxes, edges, cols, rows, bounds: { x: -GAP_X / 2, y: -GAP_Y / 2, w: width + GAP_X, h: height + GAP_Y }, focus, key, scene, gutters: { x: cols.map((_, g) => colGutter(g)).concat(colGutter(cols.length)), y: rows.map((_, g) => rowGutter(g)).concat(rowGutter(rows.length)) } };
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
