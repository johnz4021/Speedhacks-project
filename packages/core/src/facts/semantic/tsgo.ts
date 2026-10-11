// SemanticResolver on TypeScript 7's `typescript/unstable/sync` API (tsgo), pinned to exactly 7.0.2 and installed under
// the alias `typescript-7` so the repo's own `tsc` stays on 5.x. The API is officially unstable until 7.1, so only the
// handful of calls below are used, typed structurally here rather than through the package's own declarations.
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isAbstract, kindTable, packageOf, qualifiedName, type DeclNode } from './names';
import type { DeclInfo, FileChanges, ResolverOptions, SemanticResolver } from './types';

type RemoteNode = DeclNode & { getSourceFile(): { fileName: string } };
type Handle = { readonly path: string; readonly index: number; resolve(project: Project): RemoteNode | undefined };
type Sym = { readonly flags: number; readonly declarations?: readonly Handle[]; readonly valueDeclaration?: Handle };
type Project = {
  readonly configFileName: string;
  readonly checker: { getSymbolAtPosition(file: string, positions: readonly number[]): (Sym | undefined)[]; getAliasedSymbol(s: Sym): Sym };
};
type Snapshot = { getProjects(): readonly Project[]; getDefaultProjectForFile(file: string): Project | undefined; dispose(): void };
type Api = { updateSnapshot(params?: Record<string, unknown>): Snapshot; close(): void };
type SyncModule = { API: new (options: { cwd: string }) => Api; SymbolFlags: Record<string, number> };
type AstModule = { SyntaxKind: Record<string, unknown> };

/** Module ids, held in variables so the TS 5 compiler of this repo doesn't type-check TS 7's declarations. */
const SYNC: string = 'typescript-7/unstable/sync';
const AST: string = 'typescript-7/unstable/ast';

const posix = (p: string) => p.split(sep).join('/');

export async function createTsgoResolver({ root, files }: ResolverOptions): Promise<SemanticResolver> {
  const sync = (await import(SYNC)) as SyncModule;
  const kindOf = kindTable(((await import(AST)) as AstModule).SyntaxKind);
  const ALIAS = sync.SymbolFlags.Alias ?? 0;
  const api = new sync.API({ cwd: root });
  const abs = (rel: string) => join(root, rel);
  const rootLower = `${root.toLowerCase()}/`;
  const tsconfig = join(root, 'tsconfig.json');

  let snap: Snapshot;
  try {
    snap = api.updateSnapshot(existsSync(tsconfig) ? { openProjects: [tsconfig] } : { openFiles: files.map(abs) });
  } catch (e) {
    api.close();
    throw e;
  }
  const decls = new Map<string, DeclInfo>(); // per snapshot: `${path}\0${index}` → info
  const opened = new Set<string>();
  const next = (params: Record<string, unknown>) => {
    const s = api.updateSnapshot(params);
    snap.dispose();
    snap = s;
    decls.clear();
  };

  /** The file's default project; files outside every tsconfig are opened once (inferred project). */
  const projectFor = (rel: string): Project | undefined => {
    const file = abs(rel);
    let p = snap.getDefaultProjectForFile(file);
    if (!p && !opened.has(rel)) {
      opened.add(rel);
      next({ openFiles: [file] });
      p = snap.getDefaultProjectForFile(file);
    }
    return p;
  };

  const classify = (h: Handle, project: Project): DeclInfo | null => {
    const lower = h.path.toLowerCase(); // tsgo canonicalizes paths (lower case on case-insensitive file systems)
    if (lower.includes('/node_modules/')) {
      const pkg = packageOf(lower);
      return pkg ? { where: 'package', pkg } : { where: 'lib' };
    }
    if (!lower.startsWith(rootLower)) return { where: 'lib' };
    const key = `${lower}\0${h.index}`;
    let info = decls.get(key);
    if (!info) {
      const node = h.resolve(project);
      if (!node) return null;
      info = { where: 'repo', file: posix(relative(root, node.getSourceFile().fileName)), name: qualifiedName(node, kindOf), abstract: isAbstract(node, kindOf) };
      decls.set(key, info);
    }
    return info;
  };

  return {
    impl: 'tsgo',
    declarationsAt(file, positions) {
      if (!positions.length) return [];
      const project = projectFor(file);
      if (!project) return positions.map(() => null);
      const syms = project.checker.getSymbolAtPosition(abs(file), positions);
      return syms.map((s0) => {
        if (!s0) return null;
        try {
          const s = s0.flags & ALIAS ? project.checker.getAliasedSymbol(s0) : s0;
          const h = s.declarations?.[0] ?? s.valueDeclaration;
          return h ? classify(h, project) : null;
        } catch {
          return null;
        }
      });
    },
    update({ changed, created, deleted }: FileChanges) {
      if (!changed.length && !created.length && !deleted.length) return;
      next({ fileChanges: { changed: changed.map(abs), created: created.map(abs), deleted: deleted.map(abs) } });
    },
    close() {
      try { snap.dispose(); } catch { /* already gone */ }
      api.close();
    },
  };
}
