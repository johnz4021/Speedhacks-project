// Read-only graph queries for the agent (NAVIGATION_PLAN §3.4): `graph_neighbors`, `trace`, `symbols_in`. They answer
// from the same ContextGraph the user sees (Tier 1 + current Tier 2), deterministically and without a model call.
import {
  MAX_TRACE_PATHS, domainEdges, fileOf, providerPaths, trace,
  type ContextGraph, type DomainMap, type EdgeKind, type Facts, type FileFacts, type GraphEdge, type Mapper, type Violation,
} from '@harness/core';

export const MAX_LINES = 80;

type Index = { out: Map<string, GraphEdge[]>; in: Map<string, GraphEdge[]> };
const indexes = new WeakMap<ContextGraph, Index>();
function indexOf(g: ContextGraph): Index {
  let ix = indexes.get(g);
  if (ix) return ix;
  ix = { out: new Map(), in: new Map() };
  for (const e of g.edges) {
    (ix.out.get(e.from) ?? ix.out.set(e.from, []).get(e.from)!).push(e);
    (ix.in.get(e.to) ?? ix.in.set(e.to, []).get(e.to)!).push(e);
  }
  indexes.set(g, ix);
  return ix;
}

/** The node itself and everything under it. */
function subtree(g: ContextGraph, id: string): string[] {
  const out: string[] = [];
  const walk = (n: string) => { out.push(n); for (const c of g.children[n] ?? []) walk(c); };
  walk(id);
  return out;
}

/** The container that places a node on the map: its cell, or Shared / Unassigned / Vendors / a domain's tests. */
function placeOf(g: ContextGraph, id: string): string | null {
  for (let n: string | null = id; n; n = g.nodes[n]?.parent ?? null) {
    const k = g.nodes[n]?.kind;
    if (k === 'cell' || k === 'neutral' || k === 'unassigned' || k === 'tests' || (k === 'group' && g.nodes[n]!.parent === g.root)) return n;
  }
  return null;
}

function placeLabel(g: ContextGraph, map: DomainMap, id: string): string {
  const p = placeOf(g, id);
  const n = p ? g.nodes[p] : null;
  if (!n) return '';
  if (n.kind === 'cell' || n.kind === 'tests') {
    const d = map.domains.find((x) => x.id === n.domain)?.name ?? n.domain;
    return `${d} · ${n.label}`;
  }
  return n.label;
}

const describe = (e: GraphEdge) => {
  const bits: string[] = [];
  if (e.confidence) bits.push(e.confidence);
  if (e.typeOnly) bits.push('type-only');
  if (e.count > 1) bits.push(`×${e.count}`);
  return bits.length ? `${e.kind} (${bits.join(' ')})` : e.kind;
};

/**
 * A node id for user/agent input: an exact id, a repo path (`./x`, trailing `/`), `METHOD /path` for routes, a
 * package name for vendors, or a symbol name (`newsSummarize.run`, `#runAgent`) when it is unique.
 */
export function findNode(g: ContextGraph, input: string, rel: (p: string) => string | null = (p) => p): { id: string } | { error: string } {
  const raw = input.trim();
  const tries = [raw, raw.replace(/^\.\//, '').replace(/\/$/, ''), rel(raw) ?? '', `route:${raw}`, `vendor:${raw}`, `table:${raw}`];
  for (const t of tries) if (t && g.nodes[t]) return { id: t };
  const hash = raw.indexOf('#');
  if (hash > 0) {
    const file = rel(raw.slice(0, hash)) ?? raw.slice(0, hash);
    if (g.nodes[`${file}#${raw.slice(hash + 1)}`]) return { id: `${file}#${raw.slice(hash + 1)}` };
  }
  const name = raw.replace(/^#/, '');
  const hits = Object.keys(g.nodes).filter((id) => g.nodes[id]!.kind === 'symbol' && (id.endsWith(`#${name}`) || id.endsWith(`.${name}`)));
  if (hits.length === 1) return { id: hits[0]! };
  if (hits.length > 1) return { error: `"${input}" matches ${hits.length} symbols: ${hits.slice(0, 8).join(', ')}${hits.length > 8 ? ', …' : ''}. Use a full id (path#name).` };
  // A directory: its group node, if the map has one.
  const dir = raw.replace(/^\.\//, '').replace(/\/$/, '');
  const group = Object.keys(g.nodes).find((id) => g.nodes[id]!.kind === 'group' && g.nodes[id]!.path === dir);
  if (group) return { id: group };
  return { error: `No node "${input}". Use a repo path, path#symbol, a route like "POST /api/runs", vendor:<pkg>, domain:<id> or cell:<domain>/<layer>.` };
}

/** Leaf edges around a node (and everything under it), up to `hops` away, optionally only some edge kinds. */
export function neighborsText(g: ContextGraph, map: DomainMap, id: string, kinds?: readonly EdgeKind[], hops = 1): string {
  const ix = indexOf(g);
  const start = new Set(subtree(g, id));
  const ok = (e: GraphEdge) => !kinds?.length || kinds.includes(e.kind);
  const lines: string[] = [];
  const label = (n: string) => `${n}${placeLabel(g, map, n) ? `  [${placeLabel(g, map, n)}]` : ''}`;
  const out: string[] = [];
  const inc: string[] = [];
  for (const n of start) {
    for (const e of ix.out.get(n) ?? []) if (ok(e) && !start.has(e.to)) out.push(`  → ${describe(e)}  ${label(e.to)}${n === id ? '' : `  (from ${n})`}`);
    for (const e of ix.in.get(n) ?? []) if (ok(e) && !start.has(e.from)) inc.push(`  ← ${describe(e)}  ${label(e.from)}${n === id ? '' : `  (to ${n})`}`);
  }
  lines.push(`${label(id)}`);
  lines.push(`Outgoing (${out.length}):`, ...out.sort(), `Incoming (${inc.length}):`, ...inc.sort());

  if (hops > 1) {
    const seen = new Set(start);
    let frontier = [...start];
    for (let h = 1; h <= Math.min(hops, 3); h++) {
      const next: string[] = [];
      for (const n of frontier) {
        for (const e of [...(ix.out.get(n) ?? []), ...(ix.in.get(n) ?? [])]) {
          if (!ok(e)) continue;
          const other = e.from === n ? e.to : e.from;
          if (seen.has(other)) continue;
          seen.add(other);
          next.push(other);
        }
      }
      if (h > 1 && next.length) lines.push(`${h} hops (${next.length}):`, ...next.sort().map((n) => `  ${label(n)}`));
      frontier = next;
    }
  }
  return cap(lines);
}

const cap = (lines: string[]) => (lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more lines`] : lines).join('\n');

/** Sinks for `to`: a node and everything under it, or every node under a path prefix (`vendor/llm-openai`). */
export function sinksFor(g: ContextGraph, to: string, rel: (p: string) => string | null = (p) => p): string[] | { error: string } {
  const prefix = (rel(to) ?? to).replace(/^\.\//, '').replace(/\/$/, '');
  const under = Object.keys(g.nodes).filter((id) => {
    const f = fileOf(id);
    return f !== null && (f === prefix || f.startsWith(`${prefix}/`));
  });
  if (under.length) return under;
  const hit = findNode(g, to, rel);
  return 'error' in hit ? hit : subtree(g, hit.id);
}

/**
 * Shortest call chains from `from` (a symbol, route or file: a file traces from each of its symbols and routes) to
 * `to` (default: vendors, tables and anything in an `external` cell). Consecutive hops inside one cell are collapsed;
 * a hop from an interface member to an implementation is labelled "via registry".
 */
export function traceText(g: ContextGraph, map: DomainMap, from: string, sinks?: readonly string[], coverage?: { typed: number; files: number }): string {
  const starts = g.nodes[from]?.kind === 'file' ? subtree(g, from).filter((n) => n === from || ['symbol', 'route', 'entry'].includes(g.nodes[n]!.kind)) : [from];
  const best = new Map<string, string[]>();
  for (const s of starts) {
    for (const p of trace(g, s, sinks)) {
      const sink = p[p.length - 1]!;
      const cur = best.get(sink);
      if (!cur || p.length < cur.length) best.set(sink, p);
    }
  }
  const paths = [...best.values()].sort((a, b) => a.length - b.length || (a.at(-1)! < b.at(-1)! ? -1 : 1)).slice(0, MAX_TRACE_PATHS);
  const tier = coverage ? (coverage.typed ? `typed calls for ${coverage.typed}/${coverage.files} files` : 'syntactic calls only (typed calls not ready yet)') : '';
  const note = `Follows calls, route handlers and interface dispatch${tier ? ` (${tier})` : ''}. Dispatch the checker can't see (dynamic keys, DI) is missing, so a trace is never complete.`;
  if (!paths.length) return `No call chain from ${from}${sinks ? ' to the given target' : ' to a vendor, table or external cell'}.\n${note}`;
  return [`${paths.length} chain(s) from ${from}:`, ...paths.flatMap((p, i) => renderChain(g, map, p, i + 1)), '', note].join('\n');
}

type Hop = 'calls' | 'handles' | 'writes' | 'dispatch';
function hopKind(g: ContextGraph, a: string, b: string): { kind: Hop; edge?: GraphEdge } {
  const ix = indexOf(g);
  const fwd = (ix.out.get(a) ?? []).find((e) => e.to === b && (e.kind === 'calls' || e.kind === 'handles' || e.kind === 'writes'));
  if (fwd) return { kind: fwd.kind as Hop, edge: fwd };
  return { kind: 'dispatch' }; // implements walked backwards: interface member → implementation
}

export function renderChain(g: ContextGraph, map: DomainMap, path: readonly string[], n: number): string[] {
  type Group = { nodes: string[]; via: Hop | null; edge?: GraphEdge };
  const groups: Group[] = [];
  path.forEach((id, i) => {
    const h = i ? hopKind(g, path[i - 1]!, id) : null;
    const last = groups[groups.length - 1];
    if (last && h?.kind !== 'dispatch' && placeOf(g, last.nodes[0]!) === placeOf(g, id)) last.nodes.push(id);
    else groups.push({ nodes: [id], via: h?.kind ?? null, edge: h?.edge });
  });
  return groups.map((grp, i) => {
    const where = placeLabel(g, map, grp.nodes[0]!);
    const body = grp.nodes.length === 1 ? grp.nodes[0]! : `${grp.nodes[0]} → … → ${grp.nodes[grp.nodes.length - 1]}`;
    const inCell = grp.nodes.length > 1 ? ` · ${grp.nodes.length - 1} hop(s) in cell` : '';
    const how = grp.via === 'dispatch' ? '⇢ via registry → ' : '→ ';
    const conf = grp.edge?.confidence && grp.edge.confidence !== 'typed' ? ` (${grp.edge.confidence})` : '';
    return i === 0 ? `${n}. ${body}  [${where}${inCell}]` : `   ${how}${body}  [${where}${inCell}]${conf}`;
  });
}

/** Symbols, routes and entries of a file (with line numbers), or the files under a directory with their symbol counts. */
export function symbolsText(g: ContextGraph, map: DomainMap, facts: ReadonlyMap<string, FileFacts>, path: string, text: (p: string) => string | null): string {
  const p = path.replace(/^\.\//, '').replace(/\/$/, '');
  const f = facts.get(p);
  if (!f) {
    const files = [...facts.keys()].filter((x) => x.startsWith(`${p}/`)).sort();
    if (!files.length) return `No code file or directory "${path}" with facts.`;
    return cap([`${p}/ · ${files.length} file(s):`, ...files.map((x) => `  ${x}  ${facts.get(x)!.symbols.length} symbols  [${placeLabel(g, map, x)}]`)]);
  }
  const src = text(p);
  const lineOf = (at: number) => (src ? src.slice(0, at).split('\n').length : 0);
  const ix = indexOf(g);
  const depth = (s: { parent: string | null }) => { let d = 0; for (let q = s.parent; q; q = f.symbols.find((x) => x.id === q)?.parent ?? null) d++; return d; };
  const lines = [`${p}  [${placeLabel(g, map, p)}] · ${f.symbols.length} symbols`];
  for (const s of f.symbols) {
    const out = (ix.out.get(s.id) ?? []).filter((e) => e.kind === 'calls');
    const impl = (ix.out.get(s.id) ?? []).filter((e) => e.kind === 'implements').map((e) => e.to);
    const calls = out.length ? ` · calls ${out.length}` : '';
    lines.push(`${'  '.repeat(depth(s) + 1)}${s.kind} ${s.name}${s.exported ? ' (exported)' : ''} :${lineOf(s.span.start)}${calls}${impl.length ? ` · implements ${impl.join(', ')}` : ''}`);
  }
  for (const r of f.routes) lines.push(`  route ${r.method} ${r.path}${r.handler ? ` → ${r.handler}` : ''}`);
  for (const e of f.entries) lines.push(`  entry ${e.kind}: ${e.label}`);
  return cap(lines);
}

/**
 * Beat 1: the system at a glance, deterministic. Domains (purpose, files per layer, tables), cross-domain import edges
 * with counts, current rule violations, and every path to a model provider classified as through the gateway, a rule
 * violation, or uncosted (`providerPaths` in core). Paths are repo paths, so the user can click them.
 */
export function overviewText(g: ContextGraph, map: DomainMap, facts: Facts, mapper: Mapper, violations: readonly Violation[]): string {
  const name = (id: string) => map.domains.find((d) => d.id === id)?.name ?? id;
  const lines: string[] = [`${map.domains.length} domains × ${map.layers.length} layers (${map.layers.map((l) => l.id).join(', ')}); ${facts.files.length} files.`, '', 'Domains:'];
  for (const d of map.domains) {
    const byLayer = new Map<string, number>();
    for (const f of facts.files) {
      const p = mapper.place(f);
      if (p.kind === 'cell' && p.domain === d.id) byLayer.set(p.layer, (byLayer.get(p.layer) ?? 0) + 1);
    }
    const n = [...byLayer.values()].reduce((a, b) => a + b, 0);
    const layers = map.layers.filter((l) => byLayer.has(l.id)).map((l) => `${l.id} ${byLayer.get(l.id)}`).join(', ');
    const tables = Object.values(d.cells).flatMap((c) => c.tables ?? []);
    lines.push(`- ${d.name} (domain:${d.id}): ${d.purpose}. ${n} files (${layers})${tables.length ? `; tables ${tables.join(', ')}` : ''}`);
  }
  const outside = new Map<string, number>();
  for (const f of facts.files) {
    const p = mapper.place(f);
    if (p.kind !== 'cell' && p.kind !== 'test' && p.kind !== 'ignored') outside.set(p.kind, (outside.get(p.kind) ?? 0) + 1);
  }
  if (outside.size) lines.push(`  (outside domains: ${[...outside].map(([k, n]) => `${k} ${n}`).join(', ')})`);
  const edges = domainEdges(facts, mapper);
  lines.push('', `Cross-domain dependencies (${edges.length}, imports):`, ...edges.map((e) => `- ${name(e.from)} → ${name(e.to)}: ${e.files.length}`));
  lines.push('', `Rule violations now (${violations.length}):`, ...violations.map((v) => `- ${v.invariant}: ${v.detail} (${map.invariants.find((i) => i.id === v.invariant)?.rule ?? ''})`));
  const paths = providerPaths(g, map, violations);
  if (paths.length) {
    const label = { gateway: 'through the gateway (redacted, cost-logged)', violation: 'RULE VIOLATION', uncosted: 'outside the gateway, no rule broken (not redacted or cost-logged)' } as const;
    lines.push('', `Paths to a model provider (${paths.length}):`);
    for (const p of paths) lines.push(`- ${label[p.class]}${p.invariant ? ` ${p.invariant}` : ''}: ${p.nodes.join(' → ')}`);
  }
  lines.push('', 'Next: trace <symbol|route> for call chains, graph_neighbors <path> for what touches a file, domain <id> for its cells and rules.');
  return cap(lines);
}
