// Server side of Tier 2: forks the semantic child (heap-capped), feeds it Tier 1 facts, debounces edits per file
// (~150 ms) and hands back results whose hash is still current. Never blocks the caller: every call returns at once.
import { fork, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FileFacts, SemanticFacts } from '../../contracts/facts';
import { KeyedDebounce } from './debounce';
import type { ResolverChoice } from './open';
import type { FromWorker, Memory, ToWorker } from './protocol';
import type { ResolveStats } from './resolve';
import type { ResolverImpl } from './types';

export const SEMANTIC_DEBOUNCE_MS = 150;

export type SemanticStatus = {
  state: 'idle' | 'opening' | 'resolving' | 'ready' | 'failed';
  impl: ResolverImpl | null;
  fallback: string | null;
  done: number;
  total: number;
  openMs: number | null;
  loadMs: number | null;
  lastUpdateMs: number | null;
  stats: ResolveStats | null;
  memory: Memory | null;
  error: string | null;
};

export type SemanticClientOptions = {
  root: string;
  /** `HARNESS_SEMANTIC_IMPL` (tsgo | ts-morph | auto) by default. */
  prefer?: ResolverChoice;
  /** Child heap cap in MB (`HARNESS_SEMANTIC_HEAP`, default 1536). tsgo's own Go process is not under it. */
  heapMb?: number;
  debounceMs?: number;
  onResolved(facts: SemanticFacts): void;
  onStatus?(status: SemanticStatus): void;
};

const WORKER = fileURLToPath(new URL('./worker.ts', import.meta.url));
/** The child runs TypeScript sources through tsx, like the server itself. */
const loader = () => pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

export function startSemantic(opts: SemanticClientOptions) {
  const prefer = opts.prefer ?? ((process.env.HARNESS_SEMANTIC_IMPL as ResolverChoice | undefined) || 'auto');
  const heap = opts.heapMb ?? Number(process.env.HARNESS_SEMANTIC_HEAP ?? 1536);
  const latest = new Map<string, string | null>(); // path → current Tier 1 hash (null: deleted)
  const status: SemanticStatus = { state: 'idle', impl: null, fallback: null, done: 0, total: 0, openMs: null, loadMs: null, lastUpdateMs: null, stats: null, memory: null, error: null };
  let child: ChildProcess | null = null;
  let inflight = 0;
  let closing = false;
  const waiters: (() => void)[] = [];
  const settle = () => {
    if (inflight > 0 || debounce.pending > 0) return;
    for (const w of waiters.splice(0)) w();
  };
  const report = () => opts.onStatus?.({ ...status });

  const send = (m: ToWorker) => {
    if (!child?.connected) return false;
    child.send(m);
    return true;
  };

  const debounce = new KeyedDebounce<FileFacts | null>(opts.debounceMs ?? SEMANTIC_DEBOUNCE_MS, (batch) => {
    const facts: FileFacts[] = [];
    const deleted: string[] = [];
    for (const [path, f] of batch) (f ? facts.push(f) : deleted.push(path));
    if (send({ type: 'update', facts, deleted })) inflight++;
    settle();
  });

  function spawn(): ChildProcess {
    const c = fork(WORKER, [], { execArgv: ['--import', loader(), `--max-old-space-size=${heap}`], stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced' });
    c.on('message', (m: FromWorker) => {
      switch (m.type) {
        case 'resolved':
          if (latest.get(m.facts.path) === m.facts.hash) opts.onResolved(m.facts);
          return;
        case 'ready':
          Object.assign(status, { state: 'resolving', impl: m.impl, fallback: m.fallback, openMs: m.openMs, total: m.files, done: 0 });
          break;
        case 'progress':
          Object.assign(status, { done: m.done, total: m.total });
          break;
        case 'loaded':
          Object.assign(status, { state: 'ready', loadMs: m.ms, stats: m.stats, memory: m.memory });
          inflight--;
          break;
        case 'updated':
          status.lastUpdateMs = m.ms;
          inflight--;
          break;
        case 'error': // terminal for the load/update that failed
          status.error = m.message.split('\n')[0] ?? m.message;
          if (status.state === 'opening' || status.state === 'resolving') status.state = 'failed';
          inflight = Math.max(0, inflight - 1);
          break;
      }
      report();
      settle();
    });
    c.on('exit', (code, signal) => {
      if (child === c) child = null;
      inflight = 0;
      if (!closing) {
        Object.assign(status, { state: 'failed', error: status.error ?? `semantic process exited (${signal ?? code})` });
        report();
      }
      settle();
    });
    return c;
  }

  return {
    /** Full (re)load after a scan: (re)opens the project and resolves every file in the background. */
    load(facts: readonly FileFacts[], root = opts.root) {
      debounce.clear();
      latest.clear();
      for (const f of facts) latest.set(f.path, f.hash);
      child ??= spawn();
      Object.assign(status, { state: 'opening', done: 0, total: facts.length, error: null });
      if (send({ type: 'load', root, prefer, facts: [...facts] })) inflight++;
      report();
    },
    /** A file's Tier 1 facts changed (null: deleted). Resolved ~150 ms after its last change. */
    changed(path: string, facts: FileFacts | null) {
      latest.set(path, facts?.hash ?? null);
      if (child) debounce.push(path, facts);
    },
    status: (): SemanticStatus => ({ ...status }),
    /** Resolves when nothing is queued or in flight (tests, acceptance runs). */
    idle(): Promise<void> {
      return new Promise((resolve) => {
        waiters.push(resolve);
        settle();
      });
    },
    async close() {
      closing = true;
      debounce.clear();
      const c = child;
      child = null;
      if (!c) return;
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { c.kill('SIGKILL'); resolve(); }, 2000);
        c.once('exit', () => { clearTimeout(t); resolve(); });
        if (c.connected) c.send({ type: 'close' } satisfies ToWorker);
        else c.kill();
      });
      settle();
    },
  };
}

export type SemanticClient = ReturnType<typeof startSemantic>;
