// Tier 2 facts for one file: ask the resolver about every call site and implementation site, then express the answers
// in Tier 1 ids. The result replaces the file's syntactic calls in buildGraph, so it keeps what Tier 1 knew that the
// checker didn't contradict: vendor/table calls, and syntactic guesses in symbols where the checker gave up.
import type { CallFact, FileFacts, SemanticFacts } from '../../contracts/facts';
import { settleCalls } from '../extract';
import { hashText } from '../hash';
import { BULK_MIN, isMinified } from '../record';
import { scanSites } from './sites';
import type { SemanticResolver } from './types';

export type ResolveStats = { sites: number; typed: number; dispatch: number; unresolved: number; implements: number };

export const emptyStats = (): ResolveStats => ({ sites: 0, typed: 0, dispatch: 0, unresolved: 0, implements: 0 });

const byKey = (a: { from: string; to: string }, b: { from: string; to: string }) =>
  a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0;

/**
 * SemanticFacts for `facts.path` at `facts.hash`, or null when `source` isn't the text those facts describe (the file
 * moved on; a newer request follows) or is too large/minified for symbols. `symbolsOf` gives Tier 1 symbol names per
 * file, for trimming qualified names to symbols that exist (`settleCalls`).
 */
export function semanticFacts(
  resolver: SemanticResolver,
  facts: FileFacts,
  source: string,
  symbolsOf: (file: string) => ReadonlySet<string> | null,
): { facts: SemanticFacts; stats: ResolveStats } | null {
  if (hashText(source) !== facts.hash || source.length > BULK_MIN || isMinified(source)) return null;
  const path = facts.path;
  const { calls: sites, impls } = scanSites(path, source, facts.symbols);
  const decls = resolver.declarationsAt(path, [...sites.map((s) => s.at), ...impls.map((s) => s.at)]);
  const stats = emptyStats();
  stats.sites = sites.length;

  const vendors = new Set(facts.imports.filter((i) => i.to.startsWith('vendor:')).map((i) => i.to));
  const raw: CallFact[] = [];
  const gaveUp = new Set<string>(); // symbols with a call the checker couldn't resolve
  sites.forEach((site, i) => {
    const d = decls[i];
    if (!d) {
      stats.unresolved++;
      gaveUp.add(site.from);
    } else if (d.where === 'repo') {
      raw.push({ from: site.from, to: `${d.file}#${d.name}`, confidence: d.abstract ? 'dispatch' : 'typed', count: 1 });
    } else if (d.where === 'package' && vendors.has(`vendor:${d.pkg}`)) {
      raw.push({ from: site.from, to: `vendor:${d.pkg}`, confidence: 'typed', count: 1 });
    }
  });
  const typed = settleCalls(raw, symbolsOf);
  for (const c of typed) c.confidence === 'dispatch' ? stats.dispatch++ : stats.typed++;

  const seen = new Set(typed.map((c) => `${c.from}\u0000${c.to}`));
  const kept = facts.calls.filter((c) => {
    if (seen.has(`${c.from}\u0000${c.to}`)) return false;
    return c.to.startsWith('vendor:') || c.to.startsWith('table:') || gaveUp.has(c.from);
  });

  const implementsOut = new Map<string, { from: string; to: string }>();
  impls.forEach((site, i) => {
    const d = decls[sites.length + i];
    if (d?.where !== 'repo') return;
    const names = symbolsOf(d.file);
    for (const m of site.members) {
      const target = `${d.name}.${m.name}`;
      if (names?.has(target)) implementsOut.set(`${m.id}\u0000${d.file}#${target}`, { from: m.id, to: `${d.file}#${target}` });
    }
  });
  stats.implements = implementsOut.size;

  return {
    facts: { path, hash: facts.hash, calls: [...typed, ...kept].sort(byKey), implements: [...implementsOut.values()].sort(byKey) },
    stats,
  };
}
