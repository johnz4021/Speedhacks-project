// Tier 2 (NAVIGATION_PLAN §3.1): the semantic resolver interface. Two implementations sit behind it: TypeScript 7's
// `typescript/unstable/sync` (tsgo, pinned to 7.0.2) and the TS 6 LanguageService via ts-morph (fallback). Node-only;
// runs in the semantic child process, never in the server's main thread.

/** What a call site's callee (or a heritage/annotation type name) resolves to. */
export type DeclInfo =
  /** A declaration in a repo source file. `name` is qualified like Tier 1 symbol names (`Tool.run`, `Anthropic.messages.create`). */
  | { where: 'repo'; file: string; name: string; abstract: boolean }
  /** A declaration inside an installed package (`@types/x` is reported as `x`). */
  | { where: 'package'; pkg: string }
  /** The default library (`Array.prototype.map`, `Promise`, …) or anything else outside the repo. */
  | { where: 'lib' };

export type ResolverImpl = 'tsgo' | 'ts-morph';

export interface SemanticResolver {
  readonly impl: ResolverImpl;
  /**
   * For each UTF-16 offset in `file`'s text on disk, the declaration the identifier there resolves to (aliases followed),
   * or null when the checker can't resolve it (e.g. a member of an `any` value).
   */
  declarationsAt(file: string, positions: readonly number[]): (DeclInfo | null)[];
  /** Files changed, created or deleted on disk (repo-relative). The next `declarationsAt` sees the new program. */
  update(changes: FileChanges): void;
  close(): void;
}

export type FileChanges = { changed: readonly string[]; created: readonly string[]; deleted: readonly string[] };

export type ResolverOptions = {
  root: string; // absolute, real path
  /** Repo-relative code files to analyse (used when the repo has no root tsconfig.json). */
  files: readonly string[];
};
