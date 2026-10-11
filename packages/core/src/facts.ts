import * as fs from 'node:fs';
import type { FileFacts } from './contracts/facts';
import { attachResolver, carryResolver } from './facts/context';
import { settleCalls, extract, type ExtractContext, type PackageEntry } from './facts/extract';
import { moduleRecord, type ModuleRecord } from './facts/record';
import { createRepoResolver } from './facts/resolver';
import { packageEntries } from './facts/entries';
import { normalizePath, resolveImport, resolveSpecifier } from './imports';
import { createMapper, type Mapper } from './mapper';
import type { DomainMap } from './schema';

/** File → file import. */
export type ImportEdge = { from: string; to: string };
export type WriteFact = { file: string; table: string };
/** Cross-domain dependency (domain ids) with the file imports behind it. */
export type DomainEdge = { from: string; to: string; files: ImportEdge[] };
export type Facts = { files: string[]; imports: ImportEdge[]; writes: WriteFact[] };
export type FactDelta = { imports: ImportEdge[]; writes: WriteFact[] };

export type Exists = (path: string) => boolean;

export const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts'];

export function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/**
 * File-existence check against a repo root, cached. Call `clear()` after files are created or deleted.
 * It carries the repo's module resolver (tsconfig paths, package exports, workspaces) for `resolveImport`.
 */
export function fileExistsIn(root: string): Exists & { clear(): void } {
  const cache = new Map<string, boolean>();
  let resolver: ReturnType<typeof createRepoResolver> | null = null;
  const exists = (path: string) => {
    let hit = cache.get(path);
    if (hit === undefined) {
      try {
        hit = fs.statSync(`${root}/${path}`).isFile();
      } catch {
        hit = false;
      }
      cache.set(path, hit);
    }
    return hit;
  };
  attachResolver(exists, () => (resolver ??= createRepoResolver(root)));
  return Object.assign(exists, {
    clear: () => {
      cache.clear();
      resolver?.clear();
    },
  });
}

/** `exists`, plus `paths` that will exist (e.g. files a plan creates). Keeps `exists`'s resolver. */
export function withExtra(exists: Exists, paths: readonly string[]): Exists {
  const extra = new Set(paths.map((p) => normalizePath(p) ?? p));
  return carryResolver((path: string) => extra.has(path) || exists(path), exists);
}

/** Every non-ignored file under `root`, sorted. */
export function listRepoFiles(root: string, map: DomainMap, mapper: Mapper = createMapper(map)): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir ? `${root}/${dir}` : root, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (mapper.isIgnored(path)) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk('');
  return files.sort();
}

/** Full fact scan of a repo: every non-ignored file, plus resolved imports and table writes of code files. */
export function scanRepo(root: string, map: DomainMap): Facts {
  const files = listRepoFiles(root, map);
  const exists = scanExists(root, files);
  const imports: ImportEdge[] = [];
  const writes: WriteFact[] = [];
  for (const file of files) {
    if (!isCodeFile(file)) continue;
    const delta = factsForSource(file, fs.readFileSync(`${root}/${file}`, 'utf8'), exists);
    imports.push(...delta.imports);
    writes.push(...delta.writes);
  }
  return { files, imports, writes };
}

/** Files known from the walk, then disk; carries the repo resolver. */
function scanExists(root: string, files: readonly string[]): Exists {
  const known = new Set(files);
  const onDisk = fileExistsIn(root);
  return carryResolver((p: string) => known.has(p) || onDisk(p), onDisk);
}

/** Imports and writes of one file, with the gate's own multiset counting. */
function counts(path: string, record: ModuleRecord, exists: Exists) {
  const imports = new Map<string, number>();
  for (const s of record.specs) {
    const to = resolveImport(path, s.spec, exists);
    if (to) imports.set(to, (imports.get(to) ?? 0) + 1);
  }
  const writes = new Map<string, number>();
  for (const w of record.writes) writes.set(w.table, (writes.get(w.table) ?? 0) + 1);
  return { imports, writes };
}

/** One file's resolved imports and table writes (each target/table once). */
export function factsForSource(path: string, source: string, exists: Exists): FactDelta {
  return deltaForEdit(path, null, source, exists);
}

/**
 * Imports and writes that `newSource` adds over `oldSource` (multiset difference by target/table). This is the edit gate's
 * hot path: no AST walk, the old text's record is usually cached, and large or minified files skip parsing (< 20 ms at 1 MB).
 */
export function deltaForEdit(path: string, oldSource: string | null, newSource: string, exists: Exists): FactDelta {
  const file = normalizePath(path) ?? path;
  const before = oldSource === null ? null : counts(file, moduleRecord(file, oldSource), exists);
  const after = counts(file, moduleRecord(file, newSource), exists);
  const added = (key: string, n: number, old: Map<string, number> | undefined) => n > (old?.get(key) ?? 0);
  return {
    imports: [...after.imports].filter(([to, n]) => added(to, n, before?.imports)).map(([to]) => ({ from: file, to })),
    writes: [...after.writes].filter(([t, n]) => added(t, n, before?.writes)).map(([table]) => ({ file, table })),
  };
}

/** Apply a Claude Code `Edit` to file text. Throws if `oldString` is not found. */
export function applyEdit(current: string, oldString: string, newString: string, replaceAll = false): string {
  if (!current.includes(oldString)) throw new Error('old_string not found in file');
  return replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, () => newString);
}

/** Cross-domain edges between cell files. Neutral, ignored, unassigned and test files, and same-domain imports, draw none. */
export function domainEdges(facts: Facts | FactDelta, mapper: Mapper): DomainEdge[] {
  const edges = new Map<string, DomainEdge>();
  for (const imp of facts.imports) {
    const a = mapper.place(imp.from);
    const b = mapper.place(imp.to);
    if (a.kind !== 'cell' || b.kind !== 'cell' || a.domain === b.domain) continue;
    const key = `${a.domain}\u0000${b.domain}`;
    let edge = edges.get(key);
    if (!edge) edges.set(key, (edge = { from: a.domain, to: b.domain, files: [] }));
    edge.files.push(imp);
  }
  return [...edges.values()].sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to));
}

// ---- Tier 1 facts (NAVIGATION_PLAN §3.1)

/**
 * Per-repo extraction state: resolves through `exists`'s resolver, reads other files for barrel linking, and knows
 * package.json entries and `cartography.routes`. `read(path)` returns current text (or null), e.g. the server's cache.
 */
export function createFactsIndex(root: string, map: DomainMap, exists: Exists, read: (path: string) => string | null) {
  const resolve = (from: string, spec: string) => resolveSpecifier(from, spec, exists);
  let entries: Map<string, PackageEntry[]> | null = null;
  const routes = map.cartography?.routes ?? [];
  const ctx = (path: string): ExtractContext => ({
    recordOf: (file) => {
      if (!isCodeFile(file)) return null;
      const text = read(file);
      return text === null ? null : moduleRecord(file, text);
    },
    entries: (entries ??= packageEntries(root, exists)).get(path) ?? [],
    routes,
  });
  return {
    resolve,
    /** Facts for one file, calls not yet settled (see `settleCalls`). `parsed` is false for source with syntax errors. */
    extract: (path: string, source: string) => extract(path, source, resolve, ctx(path)),
  };
}

/** Symbol names per file, for `settleCalls` (memoized). */
export function symbolNames(facts: Readonly<Record<string, FileFacts>>): (file: string) => ReadonlySet<string> | null {
  const sets = new Map<string, ReadonlySet<string> | null>();
  return (file) => {
    if (!sets.has(file)) sets.set(file, facts[file] ? new Set(facts[file]!.symbols.map((s) => s.name)) : null);
    return sets.get(file)!;
  };
}

/** `scanRepo` plus Tier 1 `FileFacts` for every code and `.sql` file, calls settled against the whole repo. */
export function scanRepoFacts(root: string, map: DomainMap): Facts & { fileFacts: Record<string, FileFacts> } {
  const files = listRepoFiles(root, map);
  const exists = scanExists(root, files);
  const texts = new Map<string, string>();
  const read = (p: string) => {
    let t = texts.get(p);
    if (t === undefined) {
      try {
        t = fs.readFileSync(`${root}/${p}`, 'utf8');
      } catch {
        return null;
      }
      texts.set(p, t);
    }
    return t;
  };
  const index = createFactsIndex(root, map, exists, read);
  const imports: ImportEdge[] = [];
  const writes: WriteFact[] = [];
  const fileFacts: Record<string, FileFacts> = {};
  for (const file of files) {
    if (file.endsWith('.sql')) {
      fileFacts[file] = index.extract(file, read(file)!).facts; // schema tables, no imports
      continue;
    }
    if (!isCodeFile(file)) continue;
    const source = read(file)!;
    fileFacts[file] = index.extract(file, source).facts; // first: it leaves the record cached for the gate facts
    const delta = factsForSource(file, source, exists);
    imports.push(...delta.imports);
    writes.push(...delta.writes);
  }
  const names = symbolNames(fileFacts);
  for (const f of Object.values(fileFacts)) f.calls = settleCalls(f.calls, names);
  return { files, imports, writes, fileFacts };
}
