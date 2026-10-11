// The semantic child's state: Tier 1 facts per file, the resolver, and what it last reported per file. Runs in the
// child process (worker.ts); usable in-process for tests.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileFacts, SemanticFacts } from '../../contracts/facts';
import { emptyStats, semanticFacts, type ResolveStats } from './resolve';
import type { SemanticResolver } from './types';

/** At most this many importers are re-resolved after an edit (their typed targets may have moved). */
export const MAX_IMPORTERS = 100;

export class SemanticEngine {
  private facts = new Map<string, FileFacts>();
  private last = new Map<string, string>(); // path → hash + result signature last emitted
  readonly totals: ResolveStats = emptyStats();

  constructor(private root: string, private resolver: SemanticResolver, private emit: (facts: SemanticFacts) => void) {}

  get impl() { return this.resolver.impl; }

  /** Replace all Tier 1 facts (a full scan). Nothing is resolved until `resolveAll`. */
  setFacts(list: readonly FileFacts[]) {
    this.facts = new Map(list.map((f) => [f.path, f]));
    this.last.clear();
    Object.assign(this.totals, emptyStats());
  }

  paths() { return [...this.facts.keys()].sort(); }

  /** Resolve every file, yielding to the event loop between files; `progress(done, total)` after each one. */
  async resolveAll(progress?: (done: number, total: number) => void) {
    const paths = this.paths();
    for (let i = 0; i < paths.length; i++) {
      const s = this.resolve(paths[i]!);
      if (s) for (const k of Object.keys(s) as (keyof ResolveStats)[]) this.totals[k] += s[k];
      progress?.(i + 1, paths.length);
      if (i % 8 === 7) await new Promise((r) => setImmediate(r));
    }
  }

  /**
   * New Tier 1 facts for edited files (and deletions): update the resolver's snapshot, re-resolve those files and their
   * direct importers (a renamed export moves their typed targets). Returns the paths that were re-resolved.
   */
  update(changed: readonly FileFacts[], deleted: readonly string[] = []): string[] {
    const created = changed.filter((f) => !this.facts.has(f.path)).map((f) => f.path);
    for (const f of changed) this.facts.set(f.path, f);
    for (const p of deleted) {
      this.facts.delete(p);
      this.last.delete(p);
    }
    this.resolver.update({ changed: changed.filter((f) => !created.includes(f.path)).map((f) => f.path), created, deleted });
    const touched = new Set([...changed.map((f) => f.path), ...deleted]);
    const importers: string[] = [];
    for (const f of this.facts.values()) {
      if (!touched.has(f.path) && f.imports.some((i) => touched.has(i.to))) importers.push(f.path);
    }
    const todo = [...changed.map((f) => f.path), ...importers.sort().slice(0, MAX_IMPORTERS)];
    for (const p of todo) this.resolve(p);
    return todo;
  }

  /** Resolve one file against its current text; emits when the result differs from what was last reported. */
  resolve(path: string): ResolveStats | null {
    const facts = this.facts.get(path);
    if (!facts) return null;
    let source: string;
    try {
      source = readFileSync(join(this.root, path), 'utf8');
    } catch {
      return null;
    }
    const names = new Map<string, ReadonlySet<string> | null>();
    const symbolsOf = (file: string) => {
      if (!names.has(file)) {
        const f = this.facts.get(file);
        names.set(file, f ? new Set(f.symbols.map((s) => s.name)) : null);
      }
      return names.get(file)!;
    };
    const r = semanticFacts(this.resolver, facts, source, symbolsOf);
    if (!r) return null;
    const sig = `${r.facts.hash}|${JSON.stringify(r.facts.calls)}|${JSON.stringify(r.facts.implements)}`;
    if (this.last.get(path) !== sig) {
      this.last.set(path, sig);
      this.emit(r.facts);
    }
    return r.stats;
  }

  close() { this.resolver.close(); }
}
