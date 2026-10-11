// Tier 2 on the server (NAVIGATION_PLAN §3.1, N8): the semantic child process is fed from the bus (`repo_scanned` →
// full load, `facts_changed` → debounced per-file update) and its results come back as `facts_resolved` events, keyed
// by the file's content hash. Nothing here runs a model or blocks a hook. HARNESS_SEMANTIC=0 turns it off.
import {
  buildGraph, startSemantic,
  type ContextGraph, type DomainMap, type EventData, type FileFacts, type HarnessEvent, type SemanticFacts, type SemanticStatus,
} from '@harness/core';
import type { Bus } from './bus';
import type { Repo } from './repo';

/**
 * Current Tier 2 facts per file (only those whose hash matches the file's current Tier 1 facts), kept in step with
 * the bus. One per repo: the graph tools and the living map read the same store.
 */
export class SemanticStore {
  readonly facts: Record<string, SemanticFacts> = {};
  /** Bumped on every event that changes the facts the graph is built from. */
  version = 0;
  private graphCache: { version: number; map: DomainMap; graph: ContextGraph } | null = null;

  constructor(private repo: Repo, bus: Bus) {
    // Seed from the log since the last scan, so a store created mid-session agrees with the shell's reducer.
    const from = bus.events.findLastIndex((e) => e.kind === 'repo_scanned');
    for (const e of bus.events.slice(Math.max(0, from))) this.apply(e);
    bus.on((e) => this.apply(e));
  }

  private apply(e: HarnessEvent) {
    switch (e.kind) {
      case 'repo_scanned':
        for (const k of Object.keys(this.facts)) delete this.facts[k];
        break;
      case 'facts_changed': {
        const f = (e.data as EventData['facts_changed']).facts;
        const path = f?.path ?? e.path;
        if (path && this.facts[path] && this.facts[path]!.hash !== f?.hash) delete this.facts[path];
        break;
      }
      case 'facts_resolved': {
        const f = (e.data as EventData['facts_resolved']).facts;
        if (this.repo.fileFacts.get(f.path)?.hash !== f.hash) return;
        this.facts[f.path] = f;
        break;
      }
      case 'map_confirmed':
        break;
      default:
        return;
    }
    this.version++;
  }

  /** Tier 1 facts with Tier 2 calls swapped in where current (what buildGraph does), for consumers of FileFacts. */
  merged(): Record<string, FileFacts> {
    const out: Record<string, FileFacts> = {};
    for (const [path, f] of this.repo.fileFacts) {
      const s = this.facts[path];
      out[path] = s && s.hash === f.hash ? { ...f, calls: s.calls } : f;
    }
    return out;
  }

  /** The same graph the shell projects (`buildGraph(map, facts, semantic)`), rebuilt only after a change. */
  graph(): ContextGraph {
    const c = this.graphCache;
    if (c && c.version === this.version && c.map === this.repo.map) return c.graph;
    const graph = buildGraph(this.repo.map, Object.fromEntries(this.repo.fileFacts), this.facts);
    this.graphCache = { version: this.version, map: this.repo.map, graph };
    return graph;
  }

  /** Files with current Tier 2 facts, of all files with Tier 1 facts. */
  coverage() {
    let typed = 0;
    for (const [path, f] of this.repo.fileFacts) if (this.facts[path]?.hash === f.hash) typed++;
    return { typed, files: this.repo.fileFacts.size };
  }
}

const stores = new WeakMap<Repo, SemanticStore>();
export function semanticStore(repo: Repo, bus: Bus): SemanticStore {
  let s = stores.get(repo);
  if (!s) stores.set(repo, (s = new SemanticStore(repo, bus)));
  return s;
}

export type Semantic = { status(): SemanticStatus; idle(): Promise<void>; close(): Promise<void> };

/** Start Tier 2 for this repo (null when HARNESS_SEMANTIC=0). Attach before the first scan. */
export function attachSemantic(bus: Bus, repo: Repo, opts: { onStatus?: (s: SemanticStatus) => void; log?: (line: string) => void } = {}): Semantic | null {
  if (process.env.HARNESS_SEMANTIC === '0') return null;
  semanticStore(repo, bus);
  let lastState: SemanticStatus['state'] | null = null;
  const client = startSemantic({
    root: repo.root,
    onResolved(facts) {
      if (repo.fileFacts.get(facts.path)?.hash !== facts.hash) return; // stale: a newer edit is on its way
      bus.emit('facts_resolved', { facts }, { path: facts.path, turn: null });
    },
    onStatus(s) {
      opts.onStatus?.(s);
      if (s.state === lastState) return;
      lastState = s.state;
      if (s.state === 'ready' && s.stats) {
        opts.log?.(`Tier 2 (${s.impl}): ${s.total} files, ${s.stats.typed} typed + ${s.stats.dispatch} dispatch call edges, ${s.stats.implements} implements · open ${s.openMs} ms, resolve ${s.loadMs} ms`);
      } else if (s.state === 'failed') {
        opts.log?.(`Tier 2 failed: ${s.error}`);
      } else if (s.fallback && s.state === 'resolving') opts.log?.(s.fallback);
    },
  });
  const off = bus.on((e) => {
    if (e.kind === 'repo_scanned') client.load([...repo.fileFacts.values()]);
    else if (e.kind === 'facts_changed') {
      const f = (e.data as EventData['facts_changed']).facts;
      const path = f?.path ?? e.path;
      if (path) client.changed(path, f);
    }
  });
  return {
    status: () => client.status(),
    idle: () => client.idle(),
    async close() {
      off();
      await client.close();
    },
  };
}
