import { cellKey, type DomainMap, type EdgeView, type ImportEdge, type TurnState, type UIState, type Violation } from '@harness/core/view';

export type Rect = { x: number; y: number; w: number; h: number };

export type GridLayout = {
  width: number;
  height: number;
  labelW: number;
  headerH: number;
  gapX: number;
  gapY: number;
  colW: number;
  rowH: number;
  cols: { id: string; name: string; purpose: string; x: number; index: number }[];
  rows: { id: string; name: string; y: number; index: number }[];
  cells: Record<string, Rect & { col: number; row: number }>;
  unassigned: Rect | null;
};

/** Fixed grid: a gutter on both sides of every column and row, so edges can route around cells. */
export function gridLayout(map: DomainMap, size: { w: number; h: number }, withUnassigned: boolean): GridLayout {
  const labelW = 64;
  const headerH = 46;
  const n = map.domains.length + (withUnassigned ? 1 : 0);
  const r = map.layers.length;
  const gapX = Math.max(28, Math.min(44, size.w * 0.032));
  const gapY = 26;
  const colW = Math.max(96, (size.w - labelW - gapX * (n + 1)) / n);
  const rowH = Math.max(72, Math.min(150, (size.h - headerH - gapY * (r + 1)) / r));
  const colX = (i: number) => labelW + gapX + i * (colW + gapX);
  const rowY = (j: number) => headerH + gapY + j * (rowH + gapY);
  const cols = map.domains.map((d, i) => ({ id: d.id, name: d.name, purpose: d.purpose, x: colX(i), index: i }));
  const rows = map.layers.map((l, j) => ({ id: l.id, name: l.name, y: rowY(j), index: j }));
  const cells: GridLayout['cells'] = {};
  map.domains.forEach((d, i) => {
    map.layers.forEach((l, j) => {
      if (l.id in d.cells) cells[cellKey({ domain: d.id, layer: l.id })] = { x: colX(i), y: rowY(j), w: colW, h: rowH, col: i, row: j };
    });
  });
  const unassigned = withUnassigned ? { x: colX(n - 1), y: rowY(0), w: colW, h: rowY(r - 1) + rowH - rowY(0) } : null;
  if (withUnassigned) cols.push({ id: '__unassigned', name: 'Unassigned', purpose: 'Files that match no cell in domains.yaml', x: colX(n - 1), index: n - 1 });
  return {
    width: labelW + gapX * (n + 1) + colW * n,
    height: headerH + gapY * (r + 1) + rowH * r,
    labelW, headerH, gapX, gapY, colW, rowH, cols, rows, cells, unassigned,
  };
}

// ---------------------------------------------------------------- edges

export type EdgeSegment = {
  key: string; // stable React key
  edgeKey: string; // `${from}->${to}`
  pair: string; // `${srcCell}=>${dstCell}`
  from: string;
  to: string;
  src: string; // cellKey
  dst: string; // cellKey
  state: EdgeView['state'];
  violation: boolean;
  steps: number[];
  files: ImportEdge[];
};

/** Which cell a file sits in: its placement, else the cell a plan put it in. */
function cellForFile(s: UIState, turn: TurnState | null, file: string): string | null {
  const p = s.files[file];
  if (p?.kind === 'cell') return cellKey(p);
  const planned = turn && Object.values(turn.planned).find((c) => c.files.includes(file));
  return planned ? cellKey(planned.cell) : null;
}

function fallbackCell(map: DomainMap, domain: string): string | null {
  const d = map.domains.find((x) => x.id === domain);
  const layer = d && map.layers.find((l) => l.id in d.cells);
  return d && layer ? cellKey({ domain, layer: layer.id }) : null;
}

/**
 * Splits each domain edge from `edgeViews` into one segment per (source cell, target cell) pair, so a gateway
 * bypass to the provider (tools·logic → gateway·external) is drawn apart from calls to complete() (→ gateway·logic).
 * The edge's `violation` flag is kept only on the segments whose files are the violating imports.
 */
export function edgeSegments(s: UIState, turn: TurnState | null, edges: EdgeView[]): EdgeSegment[] {
  const map = s.map;
  if (!map) return [];
  const out: EdgeSegment[] = [];
  for (const e of edges) {
    const groups = new Map<string, { src: string; dst: string; files: ImportEdge[] }>();
    for (const f of e.files.length ? e.files : [{ from: '', to: '' }]) {
      const src = (f.from && cellForFile(s, turn, f.from)) || fallbackCell(map, e.from);
      const dst = (f.to && cellForFile(s, turn, f.to)) || fallbackCell(map, e.to);
      if (!src || !dst) continue;
      const k = `${src}=>${dst}`;
      const g = groups.get(k) ?? { src, dst, files: [] };
      if (f.from) g.files.push(f);
      groups.set(k, g);
    }
    const list: Violation[] = e.state === 'ghost' ? turn?.planViolations ?? [] : s.violations;
    const added = turn?.edgesAdded ?? [];
    for (const [pair, g] of groups) {
      const violation = e.violation && (groups.size === 1 || g.files.some((f) => list.some((v) => v.file === f.from && (!v.target || v.target === f.to))));
      const edgeKey = `${e.from}->${e.to}`;
      // `new` is per domain pair in edgeViews; only the cell pairs whose imports were added this turn draw in as new.
      const state = e.state === 'new' && !g.files.some((f) => added.some((a) => a.edge.from === f.from && a.edge.to === f.to)) ? 'existing' : e.state;
      out.push({ key: `${state}:${pair}`, edgeKey, pair, from: e.from, to: e.to, src: g.src, dst: g.dst, state, violation, steps: e.steps, files: g.files });
    }
  }
  // Existing edges first, then new, then ghosts: lanes are assigned in this order and stay stable as a turn adds edges.
  const rank = { existing: 0, new: 1, ghost: 2 } as const;
  return out.sort((a, b) => rank[a.state] - rank[b.state] || a.key.localeCompare(b.key));
}

type Pt = [number, number];

/** Alternating lane offsets around a gutter's center: 0, +s, −s, +2s, … */
const lane = (i: number, s: number) => (i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * s);

export type RoutedSegment = EdgeSegment & { d: string; length: number };

/** Orthogonal routes through the gutters, with a separate lane per segment in every gutter it uses. */
export function routeEdges(L: GridLayout, segs: EdgeSegment[]): RoutedSegment[] {
  const used = new Map<string, number>();
  const take = (k: string) => {
    const n = used.get(k) ?? 0;
    used.set(k, n + 1);
    return n;
  };
  const colGutterX = (g: number) => L.labelW + g * (L.colW + L.gapX) + L.gapX / 2;
  const rowGutterY = (g: number) => L.headerH + g * (L.rowH + L.gapY) + L.gapY / 2;
  const laneX = Math.min(7, L.gapX / 6);
  const laneY = Math.min(6, L.gapY / 5);
  const out: RoutedSegment[] = [];

  for (const seg of segs) {
    const S = L.cells[seg.src];
    const T = L.cells[seg.dst];
    if (!S || !T || S === T) continue;
    const dir = T.col > S.col ? 1 : T.col < S.col ? -1 : 0;
    let pts: Pt[];
    const sideY = (c: typeof S, port: string) => c.y + c.h / 2 + lane(take(`port:${port}`), 9);
    if (dir === 0) {
      // Same column (only possible for odd placements): loop out through the right gutter.
      const gx = colGutterX(S.col + 1) + lane(take(`col:${S.col + 1}`), laneX);
      const ey = sideY(S, `${seg.src}:r`);
      const ty = sideY(T, `${seg.dst}:r`);
      pts = [[S.x + S.w, ey], [gx, ey], [gx, ty], [T.x + T.w, ty]];
    } else {
      const sx = dir > 0 ? S.x + S.w : S.x;
      const tx = dir > 0 ? T.x : T.x + T.w;
      const gS = dir > 0 ? S.col + 1 : S.col;
      const gT = dir > 0 ? T.col : T.col + 1;
      const ey = sideY(S, `${seg.src}:${dir > 0 ? 'r' : 'l'}`);
      const ty = sideY(T, `${seg.dst}:${dir > 0 ? 'l' : 'r'}`);
      if (gS === gT) {
        if (S.row === T.row) {
          const y = (ey + ty) / 2;
          pts = [[sx, y], [tx, y]];
        } else {
          const gx = colGutterX(gS) + lane(take(`col:${gS}`), laneX);
          pts = [[sx, ey], [gx, ey], [gx, ty], [tx, ty]];
        }
      } else {
        let rg: number;
        if (T.row > S.row) rg = S.row + 1;
        else if (T.row < S.row) rg = S.row;
        else rg = (used.get(`row:${S.row + 1}`) ?? 0) <= (used.get(`row:${S.row}`) ?? 0) ? S.row + 1 : S.row;
        const gy = rowGutterY(rg) + lane(take(`row:${rg}`), laneY);
        const gx1 = colGutterX(gS) + lane(take(`col:${gS}`), laneX);
        const gx2 = colGutterX(gT) + lane(take(`col:${gT}`), laneX);
        pts = [[sx, ey], [gx1, ey], [gx1, gy], [gx2, gy], [gx2, ty], [tx, ty]];
      }
    }
    const { d, length } = roundedPath(pts, 7);
    out.push({ ...seg, d, length });
  }
  return out;
}

function roundedPath(pts: Pt[], r: number) {
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  let d = `M${pts[0]![0].toFixed(1)},${pts[0]![1].toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1]!;
    const [cx, cy] = pts[i]!;
    const [nx, ny] = pts[i + 1]!;
    const d1 = Math.hypot(cx - px, cy - py);
    const d2 = Math.hypot(nx - cx, ny - cy);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    if (rr < 0.5) {
      d += `L${cx.toFixed(1)},${cy.toFixed(1)}`;
      continue;
    }
    const ax = cx - ((cx - px) / d1) * rr;
    const ay = cy - ((cy - py) / d1) * rr;
    const bx = cx + ((nx - cx) / d2) * rr;
    const by = cy + ((ny - cy) / d2) * rr;
    d += `L${ax.toFixed(1)},${ay.toFixed(1)}Q${cx.toFixed(1)},${cy.toFixed(1)} ${bx.toFixed(1)},${by.toFixed(1)}`;
  }
  const last = pts[pts.length - 1]!;
  d += `L${last[0].toFixed(1)},${last[1].toFixed(1)}`;
  return { d, length };
}

// ---------------------------------------------------------------- invariants

/** Glob → RegExp for the subset domains.yaml uses (`**`, `*`, `?`). */
export function globRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i++; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Invariants that involve a domain (and, for `only_via`, files of a given cell). */
export function invariantsFor(map: DomainMap, domain: string, files: string[]) {
  return map.invariants.filter((inv) => {
    if (inv.kind === 'only_via') return inv.allowed_from.includes(domain) || files.some((f) => inv.targets.some((t) => globRe(t).test(f)));
    if (inv.kind === 'owns_writes') return Object.values(inv.owners).includes(domain);
    return inv.from === domain || inv.to === domain;
  });
}
