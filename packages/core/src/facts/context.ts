// A repo resolver rides along on an `Exists` function, so `resolveImport(from, spec, exists)` and every caller of
// it (gate, plan, load scan) gain tsconfig paths, package exports and workspaces without a signature change.

/** Module resolution against one repo on disk (see `createRepoResolver`). */
export type RepoResolverLike = {
  /** Repo path, `vendor:<pkg>` (package or node builtin), or null. Files on disk only. */
  resolve(fromFile: string, spec: string): string | null;
  /**
   * Repo-relative candidate bases for a non-relative spec from tsconfig `paths`/`baseUrl` (for files that don't exist
   * yet); `alias` is true when a `paths` pattern matched, i.e. the spec is not a package name.
   */
  candidates(fromFile: string, spec: string): { bases: string[]; alias: boolean };
  clear(): void;
};

const KEY = Symbol.for('harness.repoResolver');

type Carrier = { [KEY]?: () => RepoResolverLike };

/** The resolver attached to `fn`, if any. */
export function resolverOf(fn: object): RepoResolverLike | null {
  return (fn as Carrier)[KEY]?.() ?? null;
}

/** Attach a (lazily created) resolver to `fn`. Returns `fn`. */
export function attachResolver<T extends object>(fn: T, get: () => RepoResolverLike): T {
  Object.defineProperty(fn, KEY, { value: get, enumerable: false, configurable: true });
  return fn;
}

/** Give `fn` the resolver (and repo root) `from` carries, if any. Returns `fn`. */
export function carryResolver<T extends object>(fn: T, from: object): T {
  const get = (from as Carrier)[KEY];
  const root = rootOf(from);
  if (root !== null) attachRoot(fn, root);
  return get ? attachResolver(fn, get) : fn;
}

const ROOT = Symbol.for('harness.repoRoot');

/** Attach the repo root an `Exists` checks against (Python and Go extraction list and read package files). */
export function attachRoot<T extends object>(fn: T, root: string): T {
  Object.defineProperty(fn, ROOT, { value: root, enumerable: false, configurable: true });
  return fn;
}

/** The repo root `fn` carries, or null. */
export const rootOf = (fn: object): string | null => (fn as { [ROOT]?: string })[ROOT] ?? null;
