// Messages between the server (client.ts) and the semantic child (worker.ts). Types only.
import type { FileFacts, SemanticFacts } from '../../contracts/facts';
import type { ResolveStats } from './resolve';
import type { ResolverChoice } from './open';
import type { ResolverImpl } from './types';

export type ToWorker =
  /** Full (re)load after a scan: (re)open the project and resolve every file. */
  | { type: 'load'; root: string; prefer: ResolverChoice; facts: FileFacts[] }
  /** Debounced edits: new Tier 1 facts for changed files, and deleted paths. */
  | { type: 'update'; facts: FileFacts[]; deleted: string[] }
  | { type: 'close' };

export type Memory = { rss: number; heapUsed: number };

export type FromWorker =
  | { type: 'ready'; impl: ResolverImpl; fallback: string | null; openMs: number; files: number }
  | { type: 'resolved'; facts: SemanticFacts }
  | { type: 'progress'; done: number; total: number }
  | { type: 'loaded'; ms: number; files: number; stats: ResolveStats; memory: Memory }
  | { type: 'updated'; ms: number; paths: string[] }
  /** Terminal for the load/update that failed (each load/update ends in exactly one of loaded, updated, error). */
  | { type: 'error'; message: string };
