// Browser-safe entry for the shell: the reducer, derived views and ledger, with no node builtins.
export * from './events';
export * from './ledger';
export type { DomainMap, Layer, Domain, Invariant } from './schema';
export type { Placement } from './mapper';
export type { ImportEdge, WriteFact, DomainEdge } from './facts';
export type { Violation } from './rules';
export type { PlanStep } from './plan';
// NAVIGATION_PLAN contracts (types and id helpers; browser-safe).
export * from './contracts/facts';
export * from './contracts/graph';
export * from './contracts/cartography';
export type * from './contracts/api';
// Living map engine (Cartography lane; pure, browser-safe).
export * from './cartography';
// Graph lane: ContextGraph, activity, projection, autoExpand, trace (browser-safe).
export * from './graph';
// Facts lane: which symbols an edit changed.
export { diffSymbols } from './facts/diff';
// Journeys (N10): computation and fetch → route matching.
export * from './journeys';
// Auditor (N9): finding signatures and dismissal matching.
export { findingSignature, normalizeFindingText, isDismissed, textSimilarity, type RawFinding, type DismissedFinding } from './audit/findings';
// Beat 4: what a decision protects, and whether a step or edit touches it.
export * from './protects';
