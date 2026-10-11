import { resolverOf } from './facts/context';
import { moduleRecord } from './facts/record';
import { packageName } from './facts/resolver';

export { stripComments } from './facts/regex';

/** Module specifiers imported, re-exported or required by `source`, in source order. Comments are ignored. */
export function parseImports(source: string, path = 'source.ts'): string[] {
  return moduleRecord(path, source).specs.map((s) => s.spec);
}

/** Normalize a repo-relative path: POSIX separators, no `./`, `.`/`..` resolved. Null if it escapes the root. */
export function normalizePath(path: string): string | null {
  const parts: string[] = [];
  for (const seg of path.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Directory part of a repo-relative path ('' for root files). */
export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

const EXT_SWAPS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'] };

/** First existing file for a repo path written the way an import would be: as is, swapped JS extension, `.ts`, `.tsx`, `/index.ts`, `/index.tsx`. */
export function resolvePath(path: string, exists: (path: string) => boolean): string | null {
  const base = normalizePath(path);
  if (!base) return null;
  const candidates = [base];
  const ext = base.match(/\.(?:js|jsx|mjs)$/)?.[0];
  if (ext) for (const swap of EXT_SWAPS[ext]!) candidates.push(base.slice(0, -ext.length) + swap);
  candidates.push(`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`);
  return candidates.find((c) => exists(c)) ?? null;
}

/**
 * Resolve a specifier imported by `fromFile` to a repo path, `vendor:<pkg>` (a package or `vendor:node:<x>` builtin), or null.
 * If `exists` carries a repo resolver (`fileExistsIn`, `withExtra`), files on disk resolve through oxc-resolver (tsconfig
 * paths, package exports/imports, workspaces), and files that `exists` knows but disk doesn't (a plan's new files) through
 * relative paths and tsconfig `paths`. Without one, only relative specifiers resolve.
 */
export function resolveSpecifier(fromFile: string, specifier: string, exists: (path: string) => boolean): string | null {
  const from = normalizePath(fromFile) ?? fromFile;
  const repo = resolverOf(exists);
  if (isRelative(specifier)) {
    const hit = repo?.resolve(from, specifier);
    if (hit && !hit.startsWith('vendor:')) return hit;
    const dir = dirname(from);
    return resolvePath(dir ? `${dir}/${specifier}` : specifier, exists);
  }
  if (!repo) return null;
  const hit = repo.resolve(from, specifier);
  if (hit && !hit.startsWith('vendor:')) return hit;
  const { bases, alias } = repo.candidates(from, specifier);
  for (const base of bases) {
    const p = resolvePath(base, exists);
    if (p) return p;
  }
  if (hit) return hit;
  if (alias || specifier.startsWith('#')) return null; // an alias or package import, not a package
  const pkg = packageName(specifier);
  return pkg ? `vendor:${pkg}` : null;
}

/** Resolve a specifier imported by `fromFile` to an existing (or planned) repo file. Packages, builtins and misses give null. */
export function resolveImport(fromFile: string, specifier: string, exists: (path: string) => boolean): string | null {
  const to = resolveSpecifier(fromFile, specifier, exists);
  return to && !to.startsWith('vendor:') ? to : null;
}

export function isRelative(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}
