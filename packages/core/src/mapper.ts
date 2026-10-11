import picomatch from 'picomatch';
import type { DomainMap } from './schema';

export type Placement =
  | { kind: 'cell'; domain: string; layer: string }
  | { kind: 'test'; domain: string }
  | { kind: 'neutral' }
  | { kind: 'ignored' }
  | { kind: 'unassigned' };

export type Mapper = ReturnType<typeof createMapper>;

const globCache = new Map<string, (path: string) => boolean>();

/** Compiled, cached picomatch matcher for a single glob (exact paths match themselves). */
export function globMatcher(glob: string): (path: string) => boolean {
  let m = globCache.get(glob);
  if (!m) {
    m = picomatch(glob, { dot: true });
    globCache.set(glob, m);
  }
  return m;
}

/** True if `path` matches any of `globs`. */
export function matchesAny(globs: readonly string[] | undefined, path: string): boolean {
  return !!globs && globs.some((g) => globMatcher(g)(path));
}

/** Path → placement on the domain × layer grid, and table → owning cell. */
export function createMapper(map: DomainMap) {
  const ignore = map.ignore ?? [];
  const neutral = map.neutral ?? [];
  const layerOrder = map.layers.map((l) => l.id);
  const tests = map.domains.map((d) => ({ domain: d.id, globs: d.tests ?? [] }));
  const cells = map.domains.flatMap((d) =>
    layerOrder.flatMap((layer) => {
      const cell = d.cells[layer];
      return cell ? [{ domain: d.id, layer, globs: cell.paths ?? [], tables: cell.tables ?? [] }] : [];
    }),
  );
  const cache = new Map<string, Placement>();

  function place(path: string): Placement {
    let p = cache.get(path);
    if (p) return p;
    if (matchesAny(ignore, path)) p = { kind: 'ignored' };
    else if (matchesAny(neutral, path)) p = { kind: 'neutral' };
    else {
      const t = tests.find((t) => matchesAny(t.globs, path));
      const c = t ? undefined : cells.find((c) => matchesAny(c.globs, path));
      p = t
        ? { kind: 'test', domain: t.domain }
        : c
          ? { kind: 'cell', domain: c.domain, layer: c.layer }
          : { kind: 'unassigned' };
    }
    cache.set(path, p);
    return p;
  }

  return {
    place,
    /** Domain of a cell or test file; null for neutral, ignored and unassigned files. */
    domainOf(path: string): string | null {
      const p = place(path);
      return p.kind === 'cell' || p.kind === 'test' ? p.domain : null;
    },
    /** The cell that lists `table`, if any. */
    ownerOf(table: string): { domain: string; layer: string } | null {
      const c = cells.find((c) => c.tables.includes(table));
      return c ? { domain: c.domain, layer: c.layer } : null;
    },
    isIgnored: (path: string) => place(path).kind === 'ignored',
    isNeutral: (path: string) => place(path).kind === 'neutral',
  };
}
