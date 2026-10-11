// Browser-safe entry for the shell: the reducer, derived views and ledger, with no node builtins.
export * from './events';
export * from './ledger';
export type { DomainMap, Layer, Domain, Invariant } from './schema';
export type { Placement } from './mapper';
export type { ImportEdge, WriteFact, DomainEdge } from './facts';
export type { Violation } from './rules';
export type { PlanStep } from './plan';
