// Contract (NAVIGATION_PLAN §3.1): per-file facts shared by the facts tiers, the reducer, the graph and the
// cartographer. Ids never contain line numbers, so they stay stable across edits that shift code.
// Browser-safe: types only.

export type SymbolKind = 'function' | 'class' | 'method' | 'const' | 'type' | 'property' | 'component';

/** A definition in a file. `id` = `<path>#<qualified name>` (e.g. `src/tools/news-summarize.ts#newsSummarize.run`). */
export type SymbolFact = {
  id: string;
  file: string;
  name: string; // qualified within the file: `newsSummarize.run`; duplicates get `~2`, anonymous callbacks `<cb1>`
  kind: SymbolKind;
  exported: boolean;
  parent: string | null; // enclosing symbol id, or null at top level
  span: { start: number; end: number }; // JS string (UTF-16) offsets in the current text; never part of the id
  sigHash: string; // normalized params, types, modifiers, export flag
  bodyHash: string; // whitespace-normalized body text
};

export type CallConfidence = 'syntactic' | 'typed' | 'dispatch';

/**
 * A call (or `new`) from code in one file. `from` is a symbol id, or the file path for top-level code.
 * `to` is a symbol id, a file path (unresolved member), `vendor:<x>` or `table:<x>`.
 */
export type CallFact = { from: string; to: string; confidence: CallConfidence; count: number };

/** `id` = `route:<METHOD> <path>` with params normalized to `{}` (e.g. `route:POST /api/runs/{}`). */
export type RouteFact = { id: string; method: string; path: string; file: string; handler: string | null };

export type EntryKind = 'bin' | 'script' | 'route' | 'page' | 'cli' | 'main';
/** `id` = `entry:<kind>:<label>` (e.g. `entry:bin:scout`, `entry:page:/runs/{}`). */
export type EntryFact = { id: string; kind: EntryKind; file: string; symbol: string | null; label: string };

/** A table write found by a write adapter (Scout `db.insert`, Prisma, Drizzle, Knex, raw SQL, …). */
export type WriteSite = { table: string; symbol: string | null; via: string };

/** Everything Tier 1 knows about one file. Replaced wholesale when the file changes. */
export type FileFacts = {
  path: string;
  hash: string; // content hash; Tier 2 results for an older hash are ignored
  imports: { to: string; typeOnly: boolean }[]; // resolved repo paths, or `vendor:<pkg>` for bare imports
  writes: WriteSite[];
  /** Table reads (`db.get/where("t")`, SQL `FROM/JOIN t`, ORM finds). Optional for older logs. */
  reads?: WriteSite[];
  /** Tables a schema file defines (`CREATE TABLE`), with their columns. Optional; only for `.sql` files. */
  tables?: { name: string; columns: string[] }[];
  symbols: SymbolFact[];
  calls: CallFact[];
  routes: RouteFact[];
  entries: EntryFact[];
};

/** Tier 2 (typed) facts for one file at one content hash. */
export type SemanticFacts = {
  path: string;
  hash: string;
  calls: CallFact[]; // confidence 'typed' or 'dispatch'
  implements: { from: string; to: string }[]; // implementation symbol → interface/type member symbol
};

/** Which symbols an edit changed (sigHash/bodyHash comparison). */
export type SymbolDiff = {
  added: string[];
  removed: string[];
  sig: string[]; // signature changed (callers are affected)
  body: string[]; // body changed only
  renamed: [string, string][]; // [old id, new id], same bodyHash
};

export const emptySymbolDiff = (): SymbolDiff => ({ added: [], removed: [], sig: [], body: [], renamed: [] });
