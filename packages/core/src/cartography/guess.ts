// The instant, faint placement guess for an unassigned file (NAVIGATION_PLAN §4.3). Deterministic; never a model.
import { createMapper } from '../mapper';
import type { DomainMap } from '../schema';
import type { FileFacts } from '../contracts/facts';
import { topFolder } from './drift';
import { layerFor } from './skeleton';
import { dirOf, majority, repoImports } from './util';

/** `basis` says why: already placed, folder siblings, import neighbours, or a new top-level folder (`domain` may not exist yet). */
export type PlacementGuess = { domain: string; layer: string; basis: 'cell' | 'siblings' | 'imports' | 'folder' };

/**
 * Guess a cell for `path`: its placement if it already has one; else the majority cell of files in the same folder
 * (then the parent folder); else the majority domain of what it imports and what imports it; else, for a folder
 * the map knows nothing about, a new domain named after it. Null for neutral, ignored and test files.
 */
export function instantGuess(map: DomainMap, facts: Readonly<Record<string, FileFacts>>, path: string): PlacementGuess | null {
  const mapper = createMapper(map);
  const own = mapper.place(path);
  if (own.kind === 'cell') return { domain: own.domain, layer: own.layer, basis: 'cell' };
  if (own.kind !== 'unassigned') return null;

  const paths = Object.keys(facts).filter((p) => p !== path).sort();
  const cellOf = (p: string) => { const pl = mapper.place(p); return pl.kind === 'cell' ? pl : null; };
  const layers = map.layers.map((l) => l.id);
  const fitLayer = (domain: string | null, fallback: string[]) => {
    const want = layerFor(path, facts[path]);
    const cells = domain ? Object.keys(map.domains.find((d) => d.id === domain)?.cells ?? {}) : layers;
    if (cells.includes(want)) return want;
    return majority(fallback.filter((l) => cells.includes(l))) ?? (cells.includes('logic') ? 'logic' : cells[0] ?? layers[0]!);
  };

  for (const dir of [dirOf(path), dirOf(dirOf(path))]) {
    if (!dir) continue;
    const sibs = paths.filter((p) => dirOf(p) === dir).map(cellOf).filter((c) => !!c);
    const best = majority(sibs.map((c) => `${c.domain}\u0000${c.layer}`));
    if (best) { const [domain, layer] = best.split('\u0000') as [string, string]; return { domain, layer, basis: 'siblings' }; }
  }

  const imports = facts[path] ? repoImports(facts[path]!) : [];
  const importers = paths.filter((p) => repoImports(facts[p]!).includes(path));
  const neighbours = [...imports, ...importers].map(cellOf).filter((c) => !!c);
  const domain = majority(neighbours.map((c) => c.domain));
  if (domain) return { domain, layer: fitLayer(domain, neighbours.filter((c) => c.domain === domain).map((c) => c.layer)), basis: 'imports' };

  const top = topFolder(path);
  if (top && !paths.some((p) => p.startsWith(`${top}/`) && cellOf(p))) {
    const slug = top.split('/').at(-1)!;
    return { domain: slug, layer: fitLayer(null, []), basis: 'folder' };
  }
  return null;
}
