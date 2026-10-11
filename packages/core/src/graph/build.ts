// buildGraph (NAVIGATION_PLAN §3.2): one containment tree plus leaf edges, from domains.yaml and per-file facts.
// Pure and browser-safe (the mapper only needs picomatch).
import { createMapper, matchesAny, type Placement } from '../mapper';
import type { DomainMap } from '../schema';
import type { UIState } from '../events';
import type { CallConfidence, CallFact, FileFacts, SemanticFacts } from '../contracts/facts';
import {
  NEUTRAL_ID, ROOT_ID, UNASSIGNED_ID, cellId, domainId, edgeId, fileOf, groupId, tableId, testsId,
  type ContextGraph, type EdgeKind, type GraphEdge, type GraphNode, type NodeKind,
} from '../contracts/graph';

/** Top-level container for bare packages no `external` cell claims. */
export const VENDORS_ID = 'group:vendors';
/** A container holding more files than this is split into directory groups. */
export const GROUP_THRESHOLD = 12;
/** The layer whose cells hold external services; vendor packages and trace sinks live there. */
export const EXTERNAL_LAYER = 'external';

const KIND_RANK: Partial<Record<NodeKind, number>> = { group: 0, file: 1, table: 2, vendor: 3, symbol: 4, route: 5, entry: 6 };

const emptyFacts = (path: string): FileFacts => ({ path, hash: '', imports: [], writes: [], symbols: [], calls: [], routes: [], entries: [] });
const isPseudo = (id: string) => id.startsWith('vendor:') || id.startsWith('table:');
const normalize = (p: string) => p.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.').join('/');

/**
 * Containment: repo → domain → cell → (group) → file → symbol (nested by `parent`), with routes and entries under
 * their file and tables under the cell that lists them. Test files sit in `tests:<domain>` under their domain;
 * files matching no cell in `unassigned`, shared code in `neutral` (both top-level, created when non-empty).
 * Bare packages (`vendor:<pkg>`) go into the `external` cell that claims them (a glob matching `<pkg>` or
 * `node_modules/<pkg>/…`, importing domains first), else into the top-level `group:vendors`.
 * A cell with confirmed `components` groups matching files by component; any container with more than
 * GROUP_THRESHOLD remaining files groups them by directory (recursively).
 * Leaf edges: imports (file→file), uses (file→vendor), calls, implements, handles (route→handler), writes (→table).
 * Tier 2 calls replace a file's syntactic calls when `semantic[path].hash === facts[path].hash`.
 */
export function buildGraph(
  map: DomainMap,
  facts: Readonly<Record<string, FileFacts>>,
  semantic: Readonly<Record<string, SemanticFacts>> = {},
): ContextGraph {
  const mapper = createMapper(map);
  const nodes: Record<string, GraphNode> = {};
  const children: Record<string, string[]> = {};
  const rank = new Map<string, number>();
  const add = (n: Omit<GraphNode, 'order'>, r: number): GraphNode => {
    const cur = nodes[n.id];
    if (cur) return cur;
    const node = n as GraphNode;
    node.order = 0;
    nodes[n.id] = node;
    rank.set(n.id, r);
    if (n.parent) (children[n.parent] ??= []).push(n.id);
    return node;
  };
  /** Copy a container's domain/layer onto a node (no spread: this runs per symbol). */
  const scoped = <T extends Omit<GraphNode, 'order'>>(n: T, from: GraphNode): T => {
    if (from.domain) n.domain = from.domain;
    if (from.layer) n.layer = from.layer;
    return n;
  };

  // ---- skeleton: domains in map order, cells in layer order (their order is the grid position)
  add({ id: ROOT_ID, kind: 'repo', parent: null, label: 'repo' }, 0);
  const layerIdx = new Map(map.layers.map((l, i) => [l.id, i]));
  map.domains.forEach((d, i) => {
    add({ id: domainId(d.id), kind: 'domain', parent: ROOT_ID, label: d.name, domain: d.id }, i);
    for (const l of map.layers) {
      if (l.id in d.cells) add({ id: cellId(d.id, l.id), kind: 'cell', parent: domainId(d.id), label: l.name, domain: d.id, layer: l.id }, layerIdx.get(l.id)!);
    }
  });
  const nd = map.domains.length;
  const ensureTop = (id: string) => {
    if (id === UNASSIGNED_ID) return add({ id, kind: 'unassigned', parent: ROOT_ID, label: 'Unassigned' }, nd);
    if (id === NEUTRAL_ID) return add({ id, kind: 'neutral', parent: ROOT_ID, label: 'Shared' }, nd + 1);
    return add({ id: VENDORS_ID, kind: 'group', parent: ROOT_ID, label: 'Vendors' }, nd + 2);
  };
  const ensureTests = (domain: string) =>
    add({ id: testsId(domain), kind: 'tests', parent: domainId(domain), label: 'Tests', domain }, map.layers.length);

  // ---- files: every path with facts plus every repo path they import
  const paths = new Set<string>();
  for (const [path, f] of Object.entries(facts)) {
    paths.add(path);
    for (const i of f.imports) if (!isPseudo(i.to)) paths.add(i.to);
  }
  const placement = new Map<string, Placement>();
  const byContainer = new Map<string, string[]>();
  for (const path of [...paths].sort()) {
    const p = mapper.place(path);
    if (p.kind === 'ignored') continue;
    placement.set(path, p);
    const c = p.kind === 'cell' ? cellId(p.domain, p.layer) : p.kind === 'test' ? ensureTests(p.domain).id : ensureTop(p.kind === 'neutral' ? NEUTRAL_ID : UNASSIGNED_ID).id;
    const list = byContainer.get(c) ?? [];
    list.push(path);
    byContainer.set(c, list);
  }

  const putFile = (path: string, parent: string) => {
    const p = placement.get(path)!;
    const n: Omit<GraphNode, 'order'> = { id: path, kind: 'file', parent, label: path.slice(path.lastIndexOf('/') + 1), path };
    if (p.kind === 'cell' || p.kind === 'test') n.domain = p.domain;
    if (p.kind === 'cell') n.layer = p.layer;
    add(n, KIND_RANK.file!);
  };
  /** Directory groups for a container holding too many files; recursive, files directly in the common dir stay put. */
  const groupByDir = (parent: string, files: string[], gid: (dir: string) => string, scope: Pick<GraphNode, 'domain' | 'layer'>) => {
    if (files.length <= GROUP_THRESHOLD) { for (const f of files) putFile(f, parent); return; }
    const prefix = commonDir(files);
    const dirs = new Map<string, string[]>();
    for (const f of files) {
      const rest = prefix ? f.slice(prefix.length + 1) : f;
      const i = rest.indexOf('/');
      if (i < 0) { putFile(f, parent); continue; }
      const dir = (prefix ? `${prefix}/` : '') + rest.slice(0, i);
      const list = dirs.get(dir) ?? [];
      list.push(f);
      dirs.set(dir, list);
    }
    for (const [dir, list] of dirs) {
      const id = gid(dir);
      add({ id, kind: 'group', parent, label: `${dir.slice(prefix ? prefix.length + 1 : 0)}/`, path: dir, ...scope }, KIND_RANK.group!);
      groupByDir(id, list, gid, scope);
    }
  };
  for (const [container, files] of byContainer) {
    const n = nodes[container]!;
    if (n.kind === 'cell') {
      const { domain, layer } = n as Required<Pick<GraphNode, 'domain' | 'layer'>>;
      const comps = map.domains.find((d) => d.id === domain)?.cells[layer]?.components ?? [];
      const rest: string[] = [];
      for (const f of files) {
        const comp = comps.find((c) => matchesAny(c.paths, f));
        if (!comp) { rest.push(f); continue; }
        const id = groupId(domain, layer, comp.id);
        add({ id, kind: 'group', parent: container, label: comp.name, domain, layer }, KIND_RANK.group!);
        putFile(f, id);
      }
      groupByDir(container, rest, (dir) => groupId(domain, layer, dir), { domain, layer });
    } else {
      groupByDir(container, files, (dir) => `group:${container}/${dir}`, n.domain ? { domain: n.domain } : {});
    }
  }

  // ---- symbols, routes, entries (under their file; symbols nested by parent)
  for (const path of placement.keys()) {
    const f = facts[path];
    if (!f) continue;
    const file = nodes[path]!;
    const own = f.symbols.some((s) => s.parent) ? new Set(f.symbols.map((s) => s.id)) : null;
    for (const s of f.symbols) {
      const nested = !!s.parent && !!own?.has(s.parent);
      add(scoped({
        id: s.id, kind: 'symbol', parent: nested ? s.parent : path,
        label: nested ? s.name.slice(s.name.lastIndexOf('.') + 1) : s.name, symbol: { kind: s.kind, exported: s.exported },
      }, file), KIND_RANK.symbol!);
    }
    for (const r of f.routes) add(scoped({ id: r.id, kind: 'route', parent: path, label: `${r.method} ${r.path}` }, file), KIND_RANK.route!);
    for (const e of f.entries) add(scoped({ id: e.id, kind: 'entry', parent: path, label: e.label }, file), KIND_RANK.entry!);
  }

  // ---- tables: under the cell that lists them, else unassigned
  map.domains.forEach((d) => {
    for (const [layer, cell] of Object.entries(d.cells)) {
      for (const t of cell.tables ?? []) add({ id: tableId(t), kind: 'table', parent: cellId(d.id, layer), label: t, domain: d.id, layer }, KIND_RANK.table!);
    }
  });
  const ensureTable = (id: string) => nodes[id] ?? add({ id, kind: 'table', parent: ensureTop(UNASSIGNED_ID).id, label: id.slice(6) }, KIND_RANK.table!);

  // ---- vendors: claimed by an `external` cell (importing domains first), else the top-level Vendors group
  const callsOf = (path: string, f: FileFacts): CallFact[] => {
    const s = semantic[path];
    return s && s.hash === f.hash ? s.calls : f.calls;
  };
  const importers = new Map<string, Set<string>>();
  const noteVendor = (v: string, from: string) => {
    const set = importers.get(v) ?? new Set<string>();
    const d = mapper.domainOf(fileOf(from) ?? from);
    if (d) set.add(d);
    importers.set(v, set);
  };
  for (const path of placement.keys()) {
    const f = facts[path];
    if (!f) continue;
    for (const i of f.imports) if (i.to.startsWith('vendor:')) noteVendor(i.to, path);
    for (const c of callsOf(path, f)) if (c.to.startsWith('vendor:')) noteVendor(c.to, c.from);
  }
  const externals = map.domains.flatMap((d) => (d.cells[EXTERNAL_LAYER] ? [{ domain: d.id, globs: d.cells[EXTERNAL_LAYER]!.paths ?? [] }] : []));
  for (const [v, doms] of [...importers].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const pkg = v.slice(7);
    const claims = (g: string[]) => matchesAny(g, pkg) || matchesAny(g, `node_modules/${pkg}`) || matchesAny(g, `node_modules/${pkg}/index.js`);
    const owner = externals.find((e) => doms.has(e.domain) && claims(e.globs)) ?? externals.find((e) => claims(e.globs));
    if (owner) add({ id: v, kind: 'vendor', parent: cellId(owner.domain, EXTERNAL_LAYER), label: pkg, domain: owner.domain, layer: EXTERNAL_LAYER }, KIND_RANK.vendor!);
    else add({ id: v, kind: 'vendor', parent: ensureTop(VENDORS_ID).id, label: pkg }, KIND_RANK.vendor!);
  }

  // ---- leaf edges, grouped by owner file (in path order) and sorted by id within it
  const edges: GraphEdge[] = [];
  const seen = new Map<string, Map<string, GraphEdge[]>>(); // from → to → edges (one per kind); avoids hashing new id strings
  const local: GraphEdge[] = [];
  const resolve = (id: string): string | null => {
    if (nodes[id]) return id;
    if (id.startsWith('table:')) return ensureTable(id).id;
    const f = fileOf(id);
    return f && nodes[f] ? f : null;
  };
  const edge = (kind: EdgeKind, from: string | null, to: string | null, owner: string, count: number, typeOnly?: boolean, confidence?: CallConfidence) => {
    if (!from || !to) return;
    const row = seen.get(from) ?? seen.set(from, new Map()).get(from)!;
    const same = row.get(to);
    const cur = same?.find((x) => x.kind === kind);
    if (cur) {
      cur.count += count;
      if (typeOnly === false) cur.typeOnly = false;
      return;
    }
    const e: GraphEdge = { id: edgeId(kind, from, to), kind, from, to, count, owner };
    if (typeOnly !== undefined) e.typeOnly = typeOnly;
    if (confidence) e.confidence = confidence;
    if (same) same.push(e);
    else row.set(to, [e]);
    local.push(e);
  };
  for (const path of placement.keys()) {
    const f = facts[path];
    if (!f) continue;
    for (const i of f.imports) edge(i.to.startsWith('vendor:') ? 'uses' : 'imports', path, resolve(i.to), path, 1, i.typeOnly);
    for (const c of callsOf(path, f)) edge('calls', resolve(c.from), resolve(c.to), path, c.count, undefined, c.confidence);
    const s = semantic[path];
    if (s && s.hash === f.hash) for (const im of s.implements) edge('implements', resolve(im.from), resolve(im.to), path, 1);
    for (const w of f.writes) edge('writes', w.symbol ? resolve(w.symbol) : path, ensureTable(tableId(w.table)).id, path, 1);
    for (const r of f.routes) if (r.handler) edge('handles', r.id, resolve(r.handler), path, 1);
    if (!local.length) continue;
    for (const e of local.sort((a, b) => (a.id < b.id ? -1 : 1))) edges.push(e);
    local.length = 0;
  }

  // ---- children, sorted by (rank, id); `order` is the sibling index (domains/cells: their grid index)
  for (const [parent, list] of Object.entries(children)) {
    list.sort((a, b) => rank.get(a)! - rank.get(b)! || (a < b ? -1 : a > b ? 1 : 0));
    const grid = parent === ROOT_ID || nodes[parent]!.kind === 'domain';
    for (let i = 0; i < list.length; i++) nodes[list[i]!]!.order = grid ? rank.get(list[i]!)! : i;
  }
  return { root: ROOT_ID, nodes, children, edges };
}

/** Longest common directory of sorted paths (the common prefix of the first and last, cut at a `/`). */
function commonDir(sorted: string[]): string {
  const a = sorted[0]!;
  const b = sorted[sorted.length - 1]!;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(0, Math.max(0, a.lastIndexOf('/', i - 1)));
}

/**
 * The facts the graph is built from: `ui.facts`, plus empty stubs for every file the log knows about but has no
 * facts for (placed files, files a turn touched or planned, planned import endpoints), so ghosts and fresh files
 * have a leaf. Cross-domain cell→cell imports follow `ui.edges` (the reducer's record of edge_added/removed), so
 * logs without `facts_changed` still project the same edges as `edgeViews`. A no-op when facts are current.
 */
export function graphFacts(ui: UIState): Record<string, FileFacts> {
  const out: Record<string, FileFacts> = { ...ui.facts };
  const stub = (path: string) => { if (!out[path] && !isPseudo(path)) out[path] = emptyFacts(path); };
  for (const [path, p] of Object.entries(ui.files)) if (p.kind !== 'ignored') stub(path);
  for (const t of ui.turns) {
    for (const p of Object.keys(t.paths)) stub(p);
    for (const c of Object.values(t.planned)) c.files.forEach(stub);
    t.unassigned.forEach(stub);
    for (const files of Object.values(t.tests)) files.forEach(stub);
    for (const s of t.steps) for (const f of [...s.files, ...s.imports.map((i) => i.from)]) stub(normalize(fileOf(f) ?? f));
    for (const e of Object.values(t.plannedEdges)) for (const i of e.imports) { stub(i.from); stub(i.to); }
    for (const e of t.edgesAdded) { stub(e.edge.from); stub(e.edge.to); }
  }
  if (!ui.map) return out;
  const mapper = createMapper(ui.map);
  const want = new Map<string, Set<string>>();
  for (const e of Object.values(ui.edges)) for (const f of e.files) { stub(f.from); stub(f.to); (want.get(f.from) ?? want.set(f.from, new Set()).get(f.from)!).add(f.to); }
  const cross = (a: string, b: string) => {
    const pa = mapper.place(a);
    const pb = mapper.place(b);
    return pa.kind === 'cell' && pb.kind === 'cell' && pa.domain !== pb.domain;
  };
  for (const [path, f] of Object.entries(out)) {
    const w = want.get(path);
    const keep = f.imports.filter((i) => isPseudo(i.to) || !cross(path, i.to) || !!w?.has(i.to));
    const extra = [...(w ?? [])].filter((to) => !f.imports.some((i) => i.to === to)).sort();
    if (keep.length !== f.imports.length || extra.length) out[path] = { ...f, imports: [...keep, ...extra.map((to) => ({ to, typeOnly: false }))] };
  }
  return out;
}

/** The context graph for a UI state (null before a map exists). */
export function graphOf(ui: UIState): ContextGraph | null {
  return ui.map ? buildGraph(ui.map, graphFacts(ui), ui.semantic) : null;
}
