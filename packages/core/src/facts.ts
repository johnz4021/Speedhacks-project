import * as fs from 'node:fs';
import { normalizePath, parseImports, resolveImport } from './imports';
import { createMapper, type Mapper } from './mapper';
import type { DomainMap } from './schema';
import { scanWrites } from './writes';

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

/** File-existence check against a repo root, cached. Call `clear()` after files are created or deleted. */
export function fileExistsIn(root: string): Exists & { clear(): void } {
  const cache = new Map<string, boolean>();
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
  return Object.assign(exists, { clear: () => cache.clear() });
}

/** `exists`, plus `paths` that will exist (e.g. files a plan creates). */
export function withExtra(exists: Exists, paths: readonly string[]): Exists {
  const extra = new Set(paths.map((p) => normalizePath(p) ?? p));
  return (path) => extra.has(path) || exists(path);
}

/** Full fact scan of a repo: every non-ignored file, plus resolved imports and table writes of code files. */
export function scanRepo(root: string, map: DomainMap): Facts {
  const mapper = createMapper(map);
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
  files.sort();

  const known = new Set(files);
  const onDisk = fileExistsIn(root);
  const exists: Exists = (p) => known.has(p) || onDisk(p);
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

function counts(path: string, source: string, exists: Exists) {
  const imports = new Map<string, number>();
  for (const spec of parseImports(source)) {
    const to = resolveImport(path, spec, exists);
    if (to) imports.set(to, (imports.get(to) ?? 0) + 1);
  }
  const writes = new Map<string, number>();
  for (const table of scanWrites(source)) writes.set(table, (writes.get(table) ?? 0) + 1);
  return { imports, writes };
}

/** One file's resolved imports and table writes (each target/table once). */
export function factsForSource(path: string, source: string, exists: Exists): FactDelta {
  return deltaForEdit(path, null, source, exists);
}

/** Imports and writes that `newSource` adds over `oldSource` (multiset difference by target/table). */
export function deltaForEdit(path: string, oldSource: string | null, newSource: string, exists: Exists): FactDelta {
  const file = normalizePath(path) ?? path;
  const before = oldSource === null ? null : counts(file, oldSource, exists);
  const after = counts(file, newSource, exists);
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
