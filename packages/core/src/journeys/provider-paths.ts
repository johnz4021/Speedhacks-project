// Beat 1 (DEMO_PLAN): the three classes of path to a model provider. Deterministic, pure and browser-safe.
import type { ContextGraph, GraphEdge } from '../contracts/graph';
import type { ProviderPath, ProviderPathClass } from '../contracts/api';
import { fileOf } from '../contracts/graph';
import { createMapper, matchesAny } from '../mapper';
import type { DomainMap } from '../schema';
import type { Violation } from '../rules';

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const RANK: Record<ProviderPathClass, number> = { violation: 0, uncosted: 1, gateway: 2 };

/**
 * Paths from code to a model provider, classified (`ProviderPaths`, contracts/api.ts):
 * - **Providers** are the files an `only_via` invariant guards (`targets`, e.g. `vendor/llm-*`), and the provider SDKs
 *   they use (bare packages, e.g. `vendor:@anthropic-ai/sdk`). The **gateway** is that invariant's `allowed_from`.
 * - A file that imports or calls into a provider file is a caller. From the gateway: `gateway`. Crossing a current
 *   violation (same file and target): `violation`, with the invariant. Test files are skipped.
 * - Any other file that uses a provider SDK directly (not a provider file, not the gateway): `uncosted`, or
 *   `violation` if a current violation names that file.
 * Each path runs from the caller (its calling symbol when a call edge says which) through the provider file (its
 * called symbol) to the SDK when the provider file uses one; `provider` is the last node. Sorted violation →
 * uncosted → gateway, then by nodes.
 */
export function providerPaths(graph: ContextGraph, map: DomainMap, violations: readonly Violation[]): ProviderPath[] {
  const mapper = createMapper(map);
  const guards = map.invariants.flatMap((i) => (i.kind === 'only_via' ? [i] : []));
  if (!guards.length) return [];
  const files = Object.keys(graph.nodes).filter((id) => graph.nodes[id]!.kind === 'file');
  const guardOf = (path: string) => guards.find((g) => matchesAny(g.targets, path));
  const targets = new Set(files.filter((f) => !!guardOf(f)));
  const edgesFrom = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    const f = fileOf(e.from) ?? e.from;
    (edgesFrom.get(f) ?? edgesFrom.set(f, []).get(f)!).push(e);
  }
  const out: ProviderPath[] = [];
  const seen = new Set<string>();
  const push = (cls: ProviderPathClass, nodes: string[], invariant?: string) => {
    const key = `${cls}\n${nodes.join('\n')}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ class: cls, nodes, provider: nodes.at(-1)!, ...(invariant ? { invariant } : {}) });
  };
  const sdksOf = (path: string) => (edgesFrom.get(path) ?? []).filter((e) => (e.kind === 'uses' || e.kind === 'calls') && e.to.startsWith('vendor:') && !e.to.startsWith('vendor:node:')).map((e) => e.to);
  const sdks = new Set([...targets].flatMap(sdksOf));
  const sdkFor = (target: string) => sdksOf(target).sort(byId)[0];
  const skip = (path: string) => { const k = mapper.place(path).kind; return k === 'test' || k === 'ignored'; };
  const violationOf = (file: string, target?: string) => violations.find((v) => v.file === file && (!target || !v.target || v.target === target));

  // Callers of provider files.
  for (const caller of files.sort(byId)) {
    if (targets.has(caller) || skip(caller)) continue;
    const es = edgesFrom.get(caller) ?? [];
    for (const target of [...new Set(es.filter((e) => targets.has(fileOf(e.to) ?? '')).map((e) => fileOf(e.to)!))].sort(byId)) {
      const call = es.filter((e) => e.kind === 'calls' && fileOf(e.to) === target).sort((a, b) => byId(a.from, b.from) || byId(a.to, b.to))[0];
      const sdk = sdkFor(target);
      const nodes = [call?.from ?? caller, call?.to ?? target, ...(sdk ? [sdk] : [])];
      const guard = guardOf(target)!;
      const domain = mapper.domainOf(caller);
      const v = violationOf(caller, target);
      if (v) push('violation', nodes, v.invariant);
      else if (domain && guard.allowed_from.includes(domain)) push('gateway', nodes);
      else push('uncosted', nodes);
    }
  }
  // Direct users of a provider SDK outside the provider files and the gateway.
  for (const user of files.sort(byId)) {
    if (targets.has(user) || skip(user)) continue;
    const domain = mapper.domainOf(user);
    if (domain && guards.some((g) => g.allowed_from.includes(domain))) continue;
    for (const sdk of [...new Set(sdksOf(user).filter((s) => sdks.has(s)))].sort(byId)) {
      const call = (edgesFrom.get(user) ?? []).filter((e) => e.kind === 'calls' && e.to === sdk).sort((a, b) => byId(a.from, b.from))[0];
      const v = violationOf(user);
      if (v) push('violation', [call?.from ?? user, sdk], v.invariant);
      else push('uncosted', [call?.from ?? user, sdk]);
    }
  }
  return out.sort((a, b) => RANK[a.class] - RANK[b.class] || byId(a.nodes.join('\n'), b.nodes.join('\n')));
}
