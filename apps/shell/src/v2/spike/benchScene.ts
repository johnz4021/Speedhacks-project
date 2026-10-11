// THROWAWAY (N0 spike): a synthetic large Projection for performance measurement (`?map=v2&bench=500`).
// 6 domains × 4 layers; `n` files spread over the cells of the first three domains, ~1.5n import edges
// (mostly inside a cell, some across cells and domains), deterministic.
import { cellId, domainId, ROOT_ID, type Port, type VisibleEdge, type VisibleNode } from '@harness/core/view';
import type { GridSpec, Scene } from '../scene';
import { emptyRollup, mergeRollups } from './fakeProjection';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

const DOMAINS = ['Channels', 'Agent loop', 'Research tools', 'Model gateway', 'Memory', 'Outreach'];
const LAYERS = ['Entry', 'Logic', 'Data', 'External'];

export function benchScene(n: number, expanded: readonly string[]): Scene {
  const grid: GridSpec = {
    domains: DOMAINS.map((name, i) => ({ id: `d${i}`, name, purpose: 'Synthetic' })),
    layers: LAYERS.map((name, i) => ({ id: `l${i}`, name })),
    cells: Object.fromEntries(DOMAINS.map((_, i) => [`d${i}`, LAYERS.map((__, j) => `l${j}`)])),
  };
  const r = rng(7);
  const files: { id: string; d: number; l: number }[] = [];
  for (let i = 0; i < n; i++) {
    const d = i % 3;
    const l = Math.floor(r() * 4);
    files.push({ id: `src/d${d}/l${l}/file-${String(i).padStart(4, '0')}.ts`, d, l });
  }
  // a few files in the other domains, so collapsed cells have counts
  for (let i = 0; i < 60; i++) files.push({ id: `src/d${3 + (i % 3)}/l${i % 4}/other-${i}.ts`, d: 3 + (i % 3), l: i % 4 });
  files.sort((a, b) => a.id.localeCompare(b.id));
  const open = (d: number) => expanded.includes(domainId(`d${d}`));

  const leafRollup = (i: number) => {
    const x = emptyRollup();
    x.leaves = 1;
    if (i % 11 === 0) { x.edited = true; x.added = 3 + (i % 17); x.removed = i % 5; }
    if (i % 13 === 0) x.looked = true;
    if (i % 29 === 0) x.ghostSteps = [1 + (i % 4)];
    if (i % 41 === 0) { x.violation = 'existing'; x.violationFiles = ['x']; }
    return x;
  };

  const nodes: VisibleNode[] = [];
  const byCell = new Map<string, { id: string; i: number }[]>();
  files.forEach((f, i) => {
    const k = cellId(`d${f.d}`, `l${f.l}`);
    byCell.set(k, [...(byCell.get(k) ?? []), { id: f.id, i }]);
  });
  const preview: Record<string, string[]> = {};
  grid.domains.forEach((dom, d) => {
    const cells: VisibleNode[] = [];
    const kids: VisibleNode[] = [];
    grid.layers.forEach((lay, l) => {
      const k = cellId(dom.id, lay.id);
      const list = byCell.get(k) ?? [];
      const rollups = list.map(({ i }) => leafRollup(i));
      cells.push({ id: k, kind: 'cell', parent: domainId(dom.id), label: lay.name, depth: 2, expanded: open(d) && list.length > 0, expandable: list.length > 0, order: l, domain: dom.id, layer: lay.id, rollup: mergeRollups(rollups) });
      if (open(d)) list.forEach(({ id }, j) => kids.push({ id, kind: 'file', parent: k, label: id.split('/').pop()!, depth: 3, expanded: false, expandable: false, order: j, domain: dom.id, layer: lay.id, path: id, rollup: rollups[j]! }));
      else preview[k] = list.slice(0, 6).map(({ id }) => id.split('/').pop()!);
    });
    nodes.push({ id: domainId(dom.id), kind: 'domain', parent: ROOT_ID, label: dom.name, depth: 1, expanded: open(d), expandable: true, order: d, domain: dom.id, rollup: mergeRollups(cells.map((c) => c.rollup)) }, ...cells, ...kids);
  });

  const where = new Map(files.map((f) => [f.id, f]));
  const vis = (id: string) => {
    const f = where.get(id)!;
    return open(f.d) ? id : cellId(`d${f.d}`, `l${f.l}`);
  };
  const agg = new Map<string, VisibleEdge>();
  const er = rng(11);
  const domainFiles = (d: number) => files.filter((f) => f.d === d);
  for (let k = 0; k < Math.round(n * 1.5); k++) {
    const a = files[Math.floor(er() * n * 0.98)]!;
    let b: (typeof files)[number];
    const roll = er();
    if (roll < 0.8) {
      const same = files.filter((f) => f.d === a.d && f.l === a.l); // inside the cell
      b = same[Math.floor(er() * same.length)]!;
    } else if (roll < 0.93) {
      const same = domainFiles(a.d);
      b = same[Math.floor(er() * same.length)]!;
    } else b = files[Math.floor(er() * files.length)]!;
    if (a.id === b.id || a.id > b.id) continue; // acyclic-ish: imports point "down" the sort order
    const from = vis(a.id);
    const to = vis(b.id);
    if (from === to) continue;
    if (a.d === b.d && !open(a.d)) continue;
    const id = `existing|${from}|${to}`;
    const e = agg.get(id) ?? { id, from, to, kinds: ['imports'], count: 0, status: 'existing', violation: null, confidence: null, steps: [], leafEdges: [] };
    e.count++;
    agg.set(id, e);
  }
  const edges = [...agg.values()].sort((x, y) => x.id.localeCompare(y.id));
  const byId = new Map(nodes.map((x) => [x.id, x]));
  const ports: Port[] = [];
  const di = (id: string) => Number(id.slice(1));
  for (const e of edges) {
    for (const [self, other, direction] of [[e.from, e.to, 'out'], [e.to, e.from, 'in']] as const) {
      const s = byId.get(self)!;
      const o = byId.get(other)!;
      if (s.kind !== 'file' || s.parent === (o.kind === 'file' ? o.parent : o.id)) continue;
      const dd = di(o.domain!) - di(s.domain!);
      const dl = Number(o.layer!.slice(1)) - Number(s.layer!.slice(1));
      ports.push({ container: s.parent!, edge: e.id, side: dd > 0 ? 'right' : dd < 0 ? 'left' : dl > 0 ? 'bottom' : 'top', direction });
    }
  }
  return { grid, projection: { nodes, edges, ports }, cursor: null, preview, planned: [], rules: {} };
}

/** One container of `n` files with ~1.5n internal edges, for timing ELK on a big cell. */
export function bigCell(n: number) {
  const r = rng(3);
  const children = Array.from({ length: n }, (_, i) => `f${String(i).padStart(4, '0')}`);
  const edges: { id: string; from: string; to: string }[] = [];
  for (let k = 0; k < Math.round(n * 1.5); k++) {
    const a = Math.floor(r() * n);
    const b = Math.floor(r() * n);
    if (a < b) edges.push({ id: `e${k}`, from: children[a]!, to: children[b]! });
  }
  return { id: `cell:big/${n}`, children, edges, ports: [] };
}
