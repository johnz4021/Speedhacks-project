// THROWAWAY (N0 spike): a Projection-shaped value built straight from UIState, until the Graph lane's `project()` lands.
// Domains → cells → files (ui.files), file edges from ui.facts[path].imports plus this turn's planned imports as ghosts.
// Expanding a domain expands all of its cells (System → Domain level). Ports for edges that leave an expanded cell.
import {
  cellId, cellKey, domainId, ROOT_ID,
  type Port, type Projection, type Rollup, type TurnState, type UIState, type ViolationState, type VisibleEdge, type VisibleNode, type Violation,
} from '@harness/core/view';
import type { GridSpec, Scene } from '../scene';

const sev = (v: ViolationState) => (v === 'new' ? 2 : v === 'existing' ? 1 : 0);
export const maxViolation = (a: ViolationState, b: ViolationState): ViolationState => (sev(a) >= sev(b) ? a : b);

export const emptyRollup = (): Rollup => ({
  looked: false, edited: false, added: 0, removed: 0, ghostSteps: [], unplanned: false, violation: null,
  violationFiles: [], newViolationFiles: [], cursor: false, audit: 0, proposal: null, leaves: 0,
});

/** Booleans OR, counts sum, severity MAX (never averaged). */
export function mergeRollups(list: Rollup[]): Rollup {
  const r = emptyRollup();
  for (const x of list) {
    r.looked ||= x.looked;
    r.edited ||= x.edited;
    r.added += x.added;
    r.removed += x.removed;
    r.ghostSteps = [...new Set([...r.ghostSteps, ...x.ghostSteps])].sort((a, b) => a - b);
    r.unplanned ||= x.unplanned;
    r.violation = maxViolation(r.violation, x.violation);
    r.violationFiles.push(...x.violationFiles);
    r.newViolationFiles.push(...x.newViolationFiles);
    r.cursor ||= x.cursor;
    r.audit += x.audit;
    r.leaves += x.leaves;
  }
  return r;
}

/** `vendor/news/index.ts` reads better as `news/`; a lone `src/tools/index.ts` stays `index.ts`. */
export function fileLabel(path: string) {
  const parts = path.split('/');
  const last = parts.pop() ?? path;
  return /^index\.[tj]sx?$/.test(last) && parts.length > 1 && parts[0] === 'vendor' ? `${parts.pop()}/` : last;
}

const hits = (list: readonly Violation[], from: string, to?: string) => list.some((v) => v.file === from && (!to || !v.target || v.target === to));

export function fakeScene(ui: UIState, turn: TurnState | null, expanded: readonly string[]): Scene | null {
  const map = ui.map;
  if (!map) return null;
  const grid: GridSpec = {
    domains: map.domains.map((d) => ({ id: d.id, name: d.name, purpose: d.purpose })),
    layers: map.layers.map((l) => ({ id: l.id, name: l.name })),
    cells: Object.fromEntries(map.domains.map((d) => [d.id, map.layers.filter((l) => l.id in d.cells).map((l) => l.id)])),
  };
  const domIndex = new Map(map.domains.map((d, i) => [d.id, i]));
  const layerIndex = new Map(map.layers.map((l, i) => [l.id, i]));

  // Files per cell, plus planned files that don't exist yet.
  const fileCell = new Map<string, { domain: string; layer: string }>();
  for (const [path, p] of Object.entries(ui.files)) if (p.kind === 'cell') fileCell.set(path, { domain: p.domain, layer: p.layer });
  const planned: string[] = [];
  for (const pc of Object.values(turn?.planned ?? {})) {
    for (const f of pc.files) if (!fileCell.has(f)) { fileCell.set(f, pc.cell); planned.push(f); }
  }
  const cellFiles = new Map<string, string[]>();
  for (const [path, c] of fileCell) {
    const k = cellKey(c);
    cellFiles.set(k, [...(cellFiles.get(k) ?? []), path]);
  }
  for (const list of cellFiles.values()) list.sort();

  const hasPlan = !!turn && Object.keys(turn.planned).length > 0;
  const editedFiles = new Set(Object.values(turn?.edited ?? {}).flatMap((e) => e.files));
  const lookedFiles = new Set([...Object.values(turn?.looked ?? {}).flat(), ...Object.entries(turn?.paths ?? {}).filter(([, p]) => p.looked).map(([k]) => k)]);
  const plannedFiles = new Set(Object.values(turn?.planned ?? {}).flatMap((p) => p.files));
  const newList = [...(turn?.planViolations ?? []), ...(turn?.gateBlocks ?? [])];

  const leaf = (path: string): Rollup => {
    const pa = turn?.paths[path];
    const edited = editedFiles.has(path);
    const steps = turn?.steps.filter((s) => s.files.includes(path)).map((s) => s.n) ?? [];
    const isNew = hits(newList, path);
    const existing = hits(ui.violations, path);
    return {
      looked: lookedFiles.has(path), edited, added: pa?.added ?? 0, removed: pa?.removed ?? 0,
      ghostSteps: edited ? [] : steps,
      unplanned: hasPlan && edited && !plannedFiles.has(path) && !steps.length,
      violation: isNew ? 'new' : existing ? 'existing' : null,
      violationFiles: existing ? [path] : [], newViolationFiles: isNew ? [path] : [],
      cursor: ui.cursor?.path === path, audit: 0, proposal: null, leaves: 1,
    };
  };

  const isOpen = (domain: string) => expanded.includes(domainId(domain));
  const nodes: VisibleNode[] = [];
  const preview: Record<string, string[]> = {};
  const rules: Record<string, string[]> = {};
  const ruleOf = (f: string) => [...new Set([...ui.violations, ...newList].filter((v) => v.file === f).map((v) => v.invariant))];
  map.domains.forEach((d, di) => {
    const open = isOpen(d.id);
    const cellRollups: Rollup[] = [];
    const cellNodes: VisibleNode[] = [];
    const fileNodes: VisibleNode[] = [];
    map.layers.forEach((l, li) => {
      if (!(l.id in d.cells)) return;
      const files = cellFiles.get(cellKey({ domain: d.id, layer: l.id })) ?? [];
      const leaves = files.map((f) => [f, leaf(f)] as const);
      const rollup = mergeRollups(leaves.map(([, r]) => r));
      const id = cellId(d.id, l.id);
      const cellRules = [...new Set(files.flatMap(ruleOf))].sort();
      if (cellRules.length) rules[id] = cellRules;
      for (const f of files) { const r = ruleOf(f); if (r.length) rules[f] = r; }
      cellRollups.push(rollup);
      cellNodes.push({ id, kind: 'cell', parent: domainId(d.id), label: l.name, depth: 2, expanded: open && files.length > 0, expandable: files.length > 0, order: li, domain: d.id, layer: l.id, rollup });
      if (open) {
        leaves.forEach(([f, r], i) => fileNodes.push({ id: f, kind: 'file', parent: id, label: fileLabel(f), depth: 3, expanded: false, expandable: false, order: i, domain: d.id, layer: l.id, path: f, rollup: r }));
      } else {
        const rank = (r: Rollup) => (r.violation ? 0 : r.edited ? 1 : r.ghostSteps.length ? 2 : 3);
        preview[id] = [...leaves].sort((a, b) => rank(a[1]) - rank(b[1]) || a[0].localeCompare(b[0])).map(([f]) => fileLabel(f));
      }
    });
    nodes.push({ id: domainId(d.id), kind: 'domain', parent: ROOT_ID, label: d.name, depth: 1, expanded: open, expandable: true, order: di, domain: d.id, rollup: mergeRollups(cellRollups) });
    nodes.push(...cellNodes, ...fileNodes);
  });

  // Leaf edges → nearest visible endpoints.
  const visibleOf = (path: string) => {
    const c = fileCell.get(path);
    if (!c) return null;
    return isOpen(c.domain) ? path : cellId(c.domain, c.layer);
  };
  const added = new Set((turn?.edgesAdded ?? []).map((a) => `${a.edge.from}|${a.edge.to}`));
  type Leaf = { from: string; to: string; status: VisibleEdge['status']; violation: ViolationState; steps: number[] };
  const leaves: Leaf[] = [];
  const built = new Set<string>();
  for (const [path, f] of Object.entries(ui.facts)) {
    for (const imp of f.imports) {
      if (!imp.to) continue;
      built.add(`${path}|${imp.to}`);
      const isNew = added.has(`${path}|${imp.to}`);
      const violation: ViolationState = isNew && hits(turn?.gateBlocks ?? [], path, imp.to) ? 'new' : hits(ui.violations, path, imp.to) ? 'existing' : null;
      leaves.push({ from: path, to: imp.to, status: isNew ? 'new' : 'existing', violation, steps: [] });
    }
  }
  for (const pe of Object.values(turn?.plannedEdges ?? {})) {
    for (const imp of pe.imports) {
      if (built.has(`${imp.from}|${imp.to}`)) continue;
      leaves.push({ from: imp.from, to: imp.to, status: 'ghost', violation: hits(turn?.planViolations ?? [], imp.from, imp.to) ? 'new' : null, steps: pe.steps });
    }
  }
  // An import the edit gate blocked is a would-be edge: drawn as a ghost carrying the new violation.
  for (const v of turn?.gateBlocks ?? []) {
    if (!v.target || built.has(`${v.file}|${v.target}`)) continue;
    const steps = turn?.steps.filter((s) => s.files.includes(v.file)).map((s) => s.n) ?? [];
    leaves.push({ from: v.file, to: v.target, status: 'ghost', violation: 'new', steps });
  }
  const agg = new Map<string, VisibleEdge>();
  for (const l of leaves) {
    const from = visibleOf(l.from);
    const to = visibleOf(l.to);
    if (!from || !to || from === to) continue;
    const a = fileCell.get(l.from)!;
    const b = fileCell.get(l.to)!;
    if (a.domain === b.domain && !isOpen(a.domain)) continue; // inside a collapsed domain: not drawn at System level
    const id = `${l.status}|${from}|${to}`;
    const e = agg.get(id) ?? { id, from, to, kinds: ['imports'], count: 0, status: l.status, violation: null, confidence: null, steps: [], leafEdges: [] };
    e.count++;
    e.violation = maxViolation(e.violation, l.violation);
    e.steps = [...new Set([...e.steps, ...l.steps])].sort((x, y) => x - y);
    e.leafEdges.push(`imports|${l.from}|${l.to}`);
    agg.set(id, e);
  }
  const edges = [...agg.values()].sort((x, y) => x.id.localeCompare(y.id));

  // Ports: where an edge leaves (or enters) an expanded cell.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ports: Port[] = [];
  for (const e of edges) {
    for (const [self, other, direction] of [[e.from, e.to, 'out'], [e.to, e.from, 'in']] as const) {
      const s = byId.get(self);
      const o = byId.get(other);
      if (!s || !o || s.kind !== 'file' || s.parent === (o.kind === 'file' ? o.parent : o.id)) continue;
      const dd = domIndex.get(o.domain!)! - domIndex.get(s.domain!)!;
      const dl = layerIndex.get(o.layer!)! - layerIndex.get(s.layer!)!;
      const side: Port['side'] = dd > 0 ? 'right' : dd < 0 ? 'left' : dl > 0 ? 'bottom' : 'top';
      ports.push({ container: s.parent!, edge: e.id, side, direction });
    }
  }

  const projection: Projection = { nodes, edges, ports };
  const cur = ui.cursor;
  const curNode = cur ? (byId.has(cur.path) ? cur.path : (() => { const c = fileCell.get(cur.path); return c ? cellId(c.domain, c.layer) : null; })()) : null;
  return { grid, projection, cursor: cur && curNode ? { node: curNode, verb: cur.verb, path: cur.path } : null, preview, planned, rules };
}
