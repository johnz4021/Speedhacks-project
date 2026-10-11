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

/**
 * One journey per entry, sorted by id.
 * - Route entries start at the route; when UI code fetches it, the journey starts there instead: the UI symbol that calls
 *   the fetch site (`page`), the site (`fetch`), then the route. Only the first site (syntactic before inferred, then by id)
 *   is drawn; a route nobody fetches starts at the route.
 * - Other entries start at the entry, then its symbol (or file).
 * - From the start, `trace` (calls ∪ handles ∪ implements, plus the fetch → route links) finds the shortest chains to
 *   each sink. The longest chain (ties: an outside service over a table) is the main path; the others are branches that
 *   leave it where they diverge. A route
 *   that reaches no sink still shows its handler.
 * Step confidence is that of the edge into the step (`handles` and the first step: syntactic; `implements`: dispatch;
 * a fetch link: its match confidence).
 */
export function computeJourneys(graph: ContextGraph, facts: Readonly<Record<string, FileFacts>>, sites: readonly FetchSite[] = []): Journey[] {
  const links = linkFetches(sites, facts).filter((l) => graph.nodes[l.site.from] && graph.nodes[l.route.id]);
  // Fetch links ride along as `handles` edges so `trace` walks them (trace walks calls/handles forward); never shown.
  const extra: GraphEdge[] = links.map((l) => ({ id: edgeId('fetches', l.site.from, l.route.id), kind: 'handles', from: l.site.from, to: l.route.id, count: 1, owner: l.site.file }));
  const g: ContextGraph = extra.length ? { ...graph, edges: [...graph.edges, ...extra] } : graph;
  const sinks = journeySinks(graph);

  const conf = new Map<string, StepConfidence>();
  const key = (a: string, b: string) => `${a}\u0000${b}`;
  const callers = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.kind === 'calls') {
      if (!conf.has(key(e.from, e.to))) conf.set(key(e.from, e.to), e.confidence ?? 'syntactic');
      (callers.get(e.to) ?? callers.set(e.to, []).get(e.to)!).push(e.from);
    } else if (e.kind === 'handles') conf.set(key(e.from, e.to), 'syntactic');
    else if (e.kind === 'implements') conf.set(key(e.to, e.from), 'dispatch');
  }
  for (const l of links) conf.set(key(l.site.from, l.route.id), l.confidence);
  const siteIds = new Set(links.map((l) => l.site.from));

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

    let paths = graph.nodes[start] ? trace(g, start, sinks) : [];
    if (!paths.length && graph.nodes[start]?.kind === 'file') {
      // An entry file with no top-level calls (e.g. a page whose component isn't the default export): its exported
      // symbols, components first, are where the flow starts.
      const own = (graph.children[start] ?? []).filter((id) => graph.nodes[id]!.kind === 'symbol' && graph.nodes[id]!.symbol?.exported)
        .sort((a, b) => (graph.nodes[a]!.symbol!.kind === 'component' ? 0 : 1) - (graph.nodes[b]!.symbol!.kind === 'component' ? 0 : 1) || graph.nodes[a]!.order - graph.nodes[b]!.order);
      for (const id of own) {
        const found = trace(g, id, sinks);
        if (found.length) { paths = found.map((p) => [start, ...p]); break; }
      }
    }
    // No sink reached (reads aren't walked; dynamic dispatch): a route still shows its handler.
    let main = paths[0] ?? (route?.handler && graph.nodes[route.handler] && start === route.id ? [start, route.handler] : [start]);
    // Longest chain; on a tie, one that ends at an outside service beats one that ends at a table.
    const rank = (p: string[]) => p.length * 2 + (p.at(-1)!.startsWith('table:') ? 0 : 1);
    for (const p of paths) if (rank(p) > rank(main)) main = p;
    const nodes = [...prefix.map((p) => p.node), ...main];
    const steps: Journey['steps'] = nodes.map((node, i) => {
      const pre = prefix[i];
      const isPage = entry.kind === 'page' && (i === prefix.length || (i === prefix.length + 1 && graph.nodes[node]?.symbol?.kind === 'component'));
      const kind: JourneyStepKind = pre?.kind ?? stepKind(graph, node, siteIds, isPage);
      const into = i === 0 ? 'syntactic' : (conf.get(key(nodes[i - 1]!, node)) ?? 'syntactic');
      return { node, kind, confidence: into };
    });
    const branches: Journey['branches'] = [];
    for (const p of paths) {
      if (p === main) continue;
      let i = 0;
      while (i < p.length && i < main.length && p[i] === main[i]) i++;
      if (i === 0 || i >= p.length) continue;
      branches.push({ from: prefix.length + i - 1, steps: p.slice(i) });
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
      branches,
    });
  }
  return out.sort((a, b) => byId(a.id, b.id));
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
