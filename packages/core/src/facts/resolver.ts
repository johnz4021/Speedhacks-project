// Node-only module resolution for one repo: oxc-resolver for files on disk (tsconfig `paths`/`baseUrl` with
// `extends`, package `exports`/`imports`, workspaces, `.js`→`.ts`, directory index), get-tsconfig for planned files.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createPathsMatcher, getTsconfig } from 'get-tsconfig';
import { ResolverFactory } from 'oxc-resolver';
import picomatch from 'picomatch';
import YAML from 'yaml';
import type { RepoResolverLike } from './context';

/** Package name for a bare specifier (`react-dom/client` → `react-dom`), `node:x` as is; null for aliases like `@/x`, `~/x`, `#x`. */
export function packageName(spec: string): string | null {
  if (spec.startsWith('node:')) return spec;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : '') : parts[0]!;
  return /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name) ? name : null;
}

const toPosix = (p: string) => p.split(path.sep).join('/');

export type RepoResolver = RepoResolverLike & { root: string };

/**
 * Resolver for the repo at `root`. If a workspace package isn't linked under `node_modules` (no install yet), it is
 * symlinked under `<root>/.harness/ws-modules` so `exports` maps still apply (Interpretability may write only under `.harness/`).
 */
export function createRepoResolver(rootIn: string): RepoResolver {
  const root = fs.realpathSync(rootIn);
  const modules = ['node_modules'];
  const shim = linkWorkspaces(root);
  if (shim) modules.push(shim);
  const factory = new ResolverFactory({
    tsconfig: 'auto',
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.d.ts'],
    extensionAlias: { '.js': ['.ts', '.tsx', '.js', '.jsx'], '.jsx': ['.tsx', '.jsx'], '.mjs': ['.mts', '.mjs'], '.cjs': ['.cts', '.cjs'] },
    conditionNames: ['source', 'types', 'import', 'require', 'module', 'node', 'default'],
    mainFields: ['types', 'module', 'main'],
    builtinModules: true,
    nodePath: false,
    modules,
  });

  type Matcher = { match: (spec: string) => string[]; patterns: string[] };
  const matchers = new Map<string, Matcher | null>();
  const tsconfigCache = new Map<string, unknown>();
  const matcherFor = (dir: string) => {
    let m = matchers.get(dir);
    if (m === undefined) {
      const ts = getTsconfig(dir, 'tsconfig.json', tsconfigCache as never);
      const match = ts && ts.path.startsWith(root + path.sep) ? createPathsMatcher(ts) : null;
      m = match ? { match, patterns: Object.keys(ts?.config.compilerOptions?.paths ?? {}) } : null;
      matchers.set(dir, m);
    }
    return m;
  };
  const matchesPattern = (pattern: string, spec: string) => {
    const star = pattern.indexOf('*');
    return star === -1 ? pattern === spec : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1));
  };

  const inRepo = (abs: string): string | null => {
    const rel = toPosix(path.relative(root, abs));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel;
  };

  return {
    root,
    resolve(fromFile, spec) {
      let r;
      try {
        r = factory.resolveFileSync(path.join(root, fromFile), spec);
      } catch {
        return null;
      }
      if (r.builtin) return `vendor:${r.builtin.resolved}`;
      if (!r.path) return null;
      const rel = inRepo(r.path);
      if (rel && !/(^|\/)node_modules\//.test(rel)) return rel;
      const pkg = packageName(spec);
      return pkg ? `vendor:${pkg}` : null;
    },
    candidates(fromFile, spec) {
      const m = matcherFor(path.dirname(path.join(root, fromFile)));
      if (!m) return { bases: [], alias: false };
      return { bases: m.match(spec).flatMap((abs) => inRepo(abs) ?? []), alias: m.patterns.some((p) => matchesPattern(p, spec)) };
    },
    clear() {
      factory.clearCache();
      matchers.clear();
      tsconfigCache.clear();
    },
  };
}

/** Workspace package dirs (repo-relative) from package.json `workspaces` and pnpm-workspace.yaml. */
export function workspaceDirs(root: string): string[] {
  const globs: string[] = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { workspaces?: string[] | { packages?: string[] } };
    globs.push(...(Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? [])));
  } catch { /* no package.json */ }
  try {
    const pnpm = YAML.parse(fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8')) as { packages?: string[] } | null;
    globs.push(...(pnpm?.packages ?? []));
  } catch { /* not pnpm */ }
  const include = globs.filter((g) => !g.startsWith('!')).map((g) => g.replace(/^\.\//, '').replace(/\/$/, ''));
  if (include.length === 0) return [];
  const match = picomatch(include, { ignore: globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1).replace(/^\.\//, '')) });
  const depth = Math.max(...include.map((g) => (g.includes('**') ? 4 : g.split('/').length)));
  const out: string[] = [];
  const walk = (dir: string, d: number) => {
    if (d > depth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (match(rel) && fs.existsSync(path.join(root, rel, 'package.json'))) out.push(rel);
      walk(rel, d + 1);
    }
  };
  walk('', 1);
  return out.sort();
}

/** Symlink workspace packages missing from `node_modules` under `.harness/ws-modules`; returns that dir, or null if none were needed. */
function linkWorkspaces(root: string): string | null {
  const missing: { name: string; dir: string }[] = [];
  for (const dir of workspaceDirs(root)) {
    let name: string | undefined;
    try {
      name = (JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8')) as { name?: string }).name;
    } catch { /* unreadable */ }
    if (name && !fs.existsSync(path.join(root, 'node_modules', name))) missing.push({ name, dir });
  }
  if (missing.length === 0) return null;
  const shim = path.join(root, '.harness', 'ws-modules');
  for (const { name, dir } of missing) {
    const link = path.join(shim, name);
    const target = path.join(root, dir);
    try {
      if (fs.realpathSync(link) === target) continue;
    } catch { /* missing or dangling */ }
    fs.rmSync(link, { force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, 'dir');
  }
  return shim;
}
