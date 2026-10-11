// computeJourneys (NAVIGATION_PLAN §2 "Journeys", phase N10): every entry (bin, script, cli, main, route, page) traced
// through the wiring to its sinks, with UI fetch sites linked to the routes they call. Pure, deterministic, browser-safe.
// Names are placeholders here; the server's namer replaces them (inferred until the user confirms).
import type { FileFacts, RouteFact } from '../contracts/facts';
import type { ContextGraph, GraphEdge } from '../contracts/graph';
import type { Journey, JourneyStepKind } from '../contracts/cartography';
import { edgeId } from '../contracts/graph';
import { EXTERNAL_LAYER } from '../graph/build';
import { trace } from '../graph/trace';
import { fnv1a } from '../cartography/util';
import { matchRoute, type FetchSite } from './fetches';
import type { InferredEdge } from './dispatch';

type StepConfidence = Journey['steps'][number]['confidence'];
export type FetchLink = { site: FetchSite; route: RouteFact; confidence: 'syntactic' | 'inferred' };

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** `journey:<slug>` from an entry: routes use `<method> <path>`, others `<kind> <label>`; `{}` reads as `id`. */
export function journeySlug(entry: { kind: string; label: string }): string {
  const text = entry.kind === 'route' ? entry.label : `${entry.kind} ${entry.label}`;
  return text.toLowerCase().replace(/\{\}/g, 'id').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'entry';
}

/** Content hash of a journey's step list (what a name describes); the name cache is keyed by it. */
export const journeyHash = (j: Pick<Journey, 'steps'>) => fnv1a(j.steps.map((s) => s.node).join('\n'));

/** Each fetch site matched to a route (sites without a match are dropped). */
export function linkFetches(sites: readonly FetchSite[], facts: Readonly<Record<string, FileFacts>>): FetchLink[] {
  const routes = Object.values(facts).flatMap((f) => f.routes).sort((a, b) => byId(a.id, b.id));
  const serving = new Set(routes.map((r) => r.file));
  const out: FetchLink[] = [];
  for (const site of sites) {
    if (serving.has(site.file)) continue; // a server calling its own routes is not a UI flow
    const m = matchRoute(site, routes);
    if (m) out.push({ site, ...m });
  }
  return out;
}

/**
 * Sinks a flow ends at: tables, vendor packages claimed by an `external` cell, and code inside `external` cells. Bare
 * packages nobody claimed (react, node builtins) are plumbing, not destinations; they count only when the map claims
 * no external at all (then every vendor except `node:` builtins).
 */
export function journeySinks(graph: ContextGraph): string[] {
  const all = Object.values(graph.nodes);
  const claimed = all.filter((n) => n.kind === 'table' || ((n.kind === 'vendor' || n.kind === 'file' || n.kind === 'symbol') && n.layer === EXTERNAL_LAYER));
  const chosen = claimed.some((n) => n.kind !== 'table') ? claimed : all.filter((n) => n.kind === 'table' || (n.kind === 'vendor' && !n.id.startsWith('vendor:node:')));
  return chosen.map((n) => n.id).sort(byId);
}

/** Most branches kept per journey (deterministic order: by divergence point, then by steps). */
export const MAX_BRANCHES = 16;
/** Most outside-service sinks traced one by one (trace stops after MAX_TRACE_PATHS sinks; deep services need their own run). */
const MAX_DEEP_SINKS = 50;

/**
 * One journey per entry, sorted by id.
 * - Route entries start at the route; when UI code fetches it, the journey starts there instead: the UI symbol that calls
 *   the fetch site (`page`), the site (`fetch`), then the route. Only the first site (syntactic before inferred, then by id)
 *   is drawn; a route nobody fetches starts at the route.
 * - Other entries start at the entry, then its symbol (or file).
 * - Paths come from core `trace` over calls ∪ handles ∪ implements, plus the fetch → route links and `inferred` dispatch
 *   edges (see dispatch.ts), on a copy of the graph: the nearest sinks, plus each outside service traced on its own.
 * - The main path is the best one by: most domains crossed, then ending at an outside service rather than a table, then
 *   length. When the flow reaches a dispatch hub (an interface member with several implementations, e.g. a tool
 *   registry's `Tool.run`), the main path goes through the hub and its best implementation, and every other
 *   implementation's best path is a branch at the hub. Other paths are branches where they leave the main path.
 * - A route that reaches no sink still shows its handler and what it calls.
 * Step confidence is that of the edge into the step (`handles` and the first step: syntactic; dispatch: `dispatch`;
 * an inferred instance call or a fetch link: its confidence).
 */
export function computeJourneys(graph: ContextGraph, facts: Readonly<Record<string, FileFacts>>, sites: readonly FetchSite[] = [], inferred: readonly InferredEdge[] = []): Journey[] {
  const links = linkFetches(sites, facts).filter((l) => graph.nodes[l.site.from] && graph.nodes[l.route.id]);
  const known = (e: { from: string; to: string }) => !!graph.nodes[e.from] && !!graph.nodes[e.to];
  // Fetch links ride along as `handles` edges so `trace` walks them; inferred dispatch as calls/implements. Never shown.
  const extra: GraphEdge[] = [
    ...links.map((l): GraphEdge => ({ id: edgeId('fetches', l.site.from, l.route.id), kind: 'handles', from: l.site.from, to: l.route.id, count: 1, owner: l.site.file })),
    ...inferred.filter(known).map((e): GraphEdge => ({ id: edgeId(e.kind, e.from, e.to), kind: e.kind, from: e.from, to: e.to, count: 1, owner: '', confidence: 'dispatch' })),
  ];
  const g: ContextGraph = extra.length ? { ...graph, edges: [...graph.edges, ...extra] } : graph;
  const sinks = journeySinks(graph);
  const deep = sinks.filter((s) => !s.startsWith('table:')).slice(0, MAX_DEEP_SINKS);

  const conf = new Map<string, StepConfidence>();
  const key = (a: string, b: string) => `${a}\u0000${b}`;
  const callers = new Map<string, string[]>();
  const callees = new Map<string, string[]>();
  const impls = new Map<string, string[]>(); // interface member → implementations
  for (const e of g.edges) {
    if (e.kind === 'calls') {
      if (!conf.has(key(e.from, e.to))) conf.set(key(e.from, e.to), e.confidence ?? 'syntactic');
      (callers.get(e.to) ?? callers.set(e.to, []).get(e.to)!).push(e.from);
      (callees.get(e.from) ?? callees.set(e.from, []).get(e.from)!).push(e.to);
    } else if (e.kind === 'handles') conf.set(key(e.from, e.to), 'syntactic');
    else if (e.kind === 'implements') {
      conf.set(key(e.to, e.from), 'dispatch');
      (impls.get(e.to) ?? impls.set(e.to, []).get(e.to)!).push(e.from);
    }
  }
  for (const e of inferred) if (e.kind === 'calls' && known(e)) conf.set(key(e.from, e.to), e.confidence);
  for (const l of links) conf.set(key(l.site.from, l.route.id), l.confidence);
  const siteIds = new Set(links.map((l) => l.site.from));
  const hubs = [...impls].filter(([, list]) => list.length >= 2).map(([h]) => h).sort(byId);

  /** Paths from `from` to sinks: the nearest few, plus one per outside service. Deduplicated, in a stable order. */
  const sinkSet = new Set(sinks);
  const reach = (from: string): string[][] => {
    // A single-sink trace walks through other sinks; such a path really ends at the first sink it meets (kept elsewhere).
    const all = [...trace(g, from, sinks), ...deep.flatMap((s) => trace(g, from, [s])).filter((p) => !p.slice(1, -1).some((id) => sinkSet.has(id)))];
    return [...new Map(all.map((p) => [p.join('\n'), p])).values()];
  };
  const domains = (p: string[]) => new Set(p.map((id) => graph.nodes[id]?.domain).filter(Boolean)).size;
  const better = (a: string[], b: string[]) => {
    const d = domains(a) - domains(b);
    if (d) return d > 0;
    const v = (a.at(-1)!.startsWith('table:') ? 0 : 1) - (b.at(-1)!.startsWith('table:') ? 0 : 1);
    if (v) return v > 0;
    if (a.length !== b.length) return a.length > b.length;
    return a.join('\n') < b.join('\n');
  };
  const best = (ps: string[][]) => ps.reduce<string[] | null>((m, p) => (!m || better(p, m) ? p : m), null);

  const routes = new Map(Object.values(facts).flatMap((f) => f.routes).map((r) => [`entry:route:${r.method} ${r.path}`, r]));
  const entries = [...new Map(Object.values(facts).flatMap((f) => f.entries).map((e) => [e.id, e])).values()].sort((a, b) => byId(a.id, b.id));
  const used = new Map<string, number>();
  const out: Journey[] = [];

  for (const entry of entries) {
    const prefix: { node: string; kind: JourneyStepKind }[] = [];
    let start: string;
    const route = entry.kind === 'route' ? routes.get(entry.id) : undefined;
    if (route && graph.nodes[route.id]) {
      start = route.id;
      const hits = links.filter((l) => l.route.id === route.id)
        .sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === 'syntactic' ? -1 : 1) || byId(a.site.from, b.site.from));
      const first = hits[0];
      if (first) {
        const page = pageFor(graph, callers, first.site.from);
        if (page) prefix.push({ node: page, kind: 'page' });
        prefix.push({ node: first.site.from, kind: 'fetch' });
      }
    } else {
      start = entry.symbol && graph.nodes[entry.symbol] ? entry.symbol : entry.file;
      prefix.push({ node: entry.id, kind: 'entry' });
    }

    // Where the flow starts: the start itself, or (an entry file with no top-level calls, e.g. a page whose component
    // isn't the default export) its first exported symbol that reaches anything, components first.
    let head = [start];
    let paths = graph.nodes[start] ? reach(start) : [];
    if (!paths.length && graph.nodes[start]?.kind === 'file') {
      const own = (graph.children[start] ?? []).filter((id) => graph.nodes[id]!.kind === 'symbol' && graph.nodes[id]!.symbol?.exported)
        .sort((a, b) => (graph.nodes[a]!.symbol!.kind === 'component' ? 0 : 1) - (graph.nodes[b]!.symbol!.kind === 'component' ? 0 : 1) || graph.nodes[a]!.order - graph.nodes[b]!.order);
      for (const id of own) {
        const found = reach(id);
        if (found.length) { paths = found; head = [start, id]; break; }
      }
    }
    const from = head.at(-1)!;

    // Through a dispatch hub: the hub's best implementation is the main path; the other implementations are branches.
    const alternatives: string[][] = [...paths];
    let main = best(paths);
    const toHub = hubs.length && graph.nodes[from] ? trace(g, from, hubs)[0] : undefined;
    if (toHub) {
      const viaImpl = (impls.get(toHub.at(-1)!) ?? []).slice().sort(byId)
        .map((i) => best(reach(i)))
        .filter((p): p is string[] => !!p)
        .map((p) => [...toHub, ...p]);
      const hubMain = best(viaImpl);
      if (hubMain && (!main || domains(hubMain) >= domains(main))) main = hubMain;
      alternatives.push(...viaImpl);
    }
    // No sink reached (reads aren't walked): a route still shows its handler and what it calls.
    main ??= route?.handler && graph.nodes[route.handler] && start === route.id ? [start, ...followCalls(graph, callees, route.handler)] : [from];

    const nodes = [...prefix.map((p) => p.node), ...head.slice(0, -1), ...main];
    const offset = nodes.length - main.length;
    const steps: Journey['steps'] = nodes.map((node, i) => {
      const pre = prefix[i];
      const isPage = entry.kind === 'page' && (i === prefix.length || (i === prefix.length + 1 && graph.nodes[node]?.symbol?.kind === 'component'));
      const kind: JourneyStepKind = pre?.kind ?? stepKind(graph, node, siteIds, isPage);
      const into = i === 0 ? 'syntactic' : (conf.get(key(nodes[i - 1]!, node)) ?? 'syntactic');
      return { node, kind, confidence: into };
    });
    const branches = new Map<string, Journey['branches'][number]>();
    for (const p of alternatives) {
      let i = 0;
      while (i < p.length && i < main.length && p[i] === main[i]) i++;
      if (i === 0 || i >= p.length) continue;
      const b = { from: offset + i - 1, steps: p.slice(i) };
      branches.set(`${b.from}\n${b.steps.join('\n')}`, b);
    }

    const slug = journeySlug(entry);
    const n = (used.get(slug) ?? 0) + 1;
    used.set(slug, n);
    out.push({
      id: `journey:${n > 1 ? `${slug}-${n}` : slug}`,
      name: route ? `${route.method} ${route.path}` : `${entry.kind} ${entry.label}`,
      inferred: true,
      entry: entry.id,
      steps,
      branches: [...branches.values()].sort((a, b) => a.from - b.from || byId(a.steps.join('\n'), b.steps.join('\n'))).slice(0, MAX_BRANCHES),
    });
  }
  return out.sort((a, b) => byId(a.id, b.id));
}
/**
 * `from`, then up to `hops` calls onward, each the first callee (by id) in another file — the handler's real work,
 * when no sink is reachable (e.g. a GET that only reads). Stops at a cycle or when nothing is called outside the file.
 */
function followCalls(graph: ContextGraph, callees: Map<string, string[]>, from: string, hops = 2): string[] {
  const out = [from];
  for (let cur = from; out.length <= hops;) {
    const here = cur.split('#')[0];
    const next = [...new Set(callees.get(cur) ?? [])].sort(byId).find((id) => graph.nodes[id] && id.split('#')[0] !== here && !out.includes(id));
    if (!next) break;
    out.push(next);
    cur = next;
  }
  return out;
}

/** The UI symbol behind a fetch site: a caller of it (components first, then by id), or null when nothing calls it. */
function pageFor(graph: ContextGraph, callers: Map<string, string[]>, site: string): string | null {
  const list = [...new Set(callers.get(site) ?? [])].filter((c) => c !== site && graph.nodes[c]);
  list.sort((a, b) => {
    const ca = graph.nodes[a]!.symbol?.kind === 'component' ? 0 : 1;
    const cb = graph.nodes[b]!.symbol?.kind === 'component' ? 0 : 1;
    return ca - cb || byId(a, b);
  });
  return list[0] ?? null;
}

function stepKind(graph: ContextGraph, id: string, sites: ReadonlySet<string>, page: boolean): JourneyStepKind {
  if (id.startsWith('entry:')) return 'entry';
  if (id.startsWith('route:')) return 'route';
  if (id.startsWith('table:')) return 'table';
  const n = graph.nodes[id];
  if (id.startsWith('vendor:') || n?.layer === EXTERNAL_LAYER) return 'vendor';
  if (sites.has(id)) return 'fetch';
  return page ? 'page' : 'symbol';
}
