export * from './schema';
export * from './mapper';
export * from './imports';
export * from './writes';
export * from './facts';
export * from './rules';
export * from './plan';
export * from './mapedit';
export * from './events';
export * from './ledger';
export * from './contracts/facts';
export * from './contracts/graph';
export * from './contracts/cartography';
export type * from './contracts/api';
export * from './cartography';
export * from './graph';
// Facts lane (NAVIGATION_PLAN §3.1): Tier 1 extraction is node-only; diffSymbols is browser-safe.
export { extractFacts, settleCalls, type ExtractContext, type PackageEntry } from './facts/extract';
export { diffSymbols } from './facts/diff';
export { createRepoResolver, packageName, workspaceDirs } from './facts/resolver';
export { packageEntries } from './facts/entries';
export { normalizeRoutePath } from './facts/routes';
export { hashText } from './facts/hash';
// Tier 2 semantic facts (NAVIGATION_PLAN §3.1): node-only. The resolvers (tsgo, ts-morph) run in a child process
// started by `startSemantic`; their heavy modules load only there.
export { startSemantic, SEMANTIC_DEBOUNCE_MS, type SemanticClient, type SemanticClientOptions, type SemanticStatus } from './facts/semantic/client';
export { KeyedDebounce } from './facts/semantic/debounce';
export { SemanticEngine } from './facts/semantic/engine';
export { openResolver, type ResolverChoice } from './facts/semantic/open';
export { semanticFacts, type ResolveStats } from './facts/semantic/resolve';
export type { DeclInfo, ResolverImpl, SemanticResolver } from './facts/semantic/types';
export { moduleRecord, type ModuleRecord } from './facts/record';
export { findReads, parseSqlTables, sqlFacts } from './facts/tables';
// Auditor (N9) and journeys (N10): pure helpers; the model calls live in the server.
export * from './audit';
export * from './journeys';
// Beat 4: decisions protect the code that implements them (pure).
export * from './protects';
// Event-log snapshots (N11): reduceFrom(snapshot, events) equals reduce(events) (pure).
export * from './snapshots';
// Tier 1 for Python and Go (N11): web-tree-sitter, loaded once with initTreeSitter (node-only).
export { initTreeSitter, treeSitterReady, treeSitterLang, extractTreeSitter, diskLangContext, type LangContext, type TreeSitterLang } from './facts/treesitter';
