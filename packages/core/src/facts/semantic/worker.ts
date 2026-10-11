// The semantic child process (NAVIGATION_PLAN §3.1 Tier 2). Forked by client.ts with a heap cap; talks over IPC.
// Messages are handled one at a time, so an edit that arrives during the initial load waits for it to finish.
import { SemanticEngine } from './engine';
import { openResolver } from './open';
import type { FromWorker, ToWorker } from './protocol';

let engine: SemanticEngine | null = null;
const send = (m: FromWorker) => process.send?.(m);
const memory = () => {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed };
};

async function handle(msg: ToWorker) {
  if (msg.type === 'close') {
    engine?.close();
    process.exit(0);
  }
  if (msg.type === 'load') {
    engine?.close(); // a rescan may follow a tsconfig/package.json change: reopen the project
    engine = null;
    const t0 = performance.now();
    const { resolver, fallback } = await openResolver({ root: msg.root, files: msg.facts.map((f) => f.path) }, msg.prefer);
    engine = new SemanticEngine(msg.root, resolver, (facts) => send({ type: 'resolved', facts }));
    engine.setFacts(msg.facts);
    send({ type: 'ready', impl: resolver.impl, fallback, openMs: Math.round(performance.now() - t0), files: msg.facts.length });
    const t1 = performance.now();
    let lastProgress = 0;
    await engine.resolveAll((done, total) => {
      const now = performance.now();
      if (done === total || now - lastProgress > 250) {
        lastProgress = now;
        send({ type: 'progress', done, total });
      }
    });
    send({ type: 'loaded', ms: Math.round(performance.now() - t1), files: msg.facts.length, stats: engine.totals, memory: memory() });
    return;
  }
  const t0 = performance.now();
  const paths = engine ? engine.update(msg.facts, msg.deleted) : [];
  send({ type: 'updated', ms: Math.round((performance.now() - t0) * 10) / 10, paths });
}

let chain = Promise.resolve();
process.on('message', (msg: ToWorker) => {
  chain = chain.then(() => handle(msg)).catch((e: Error) => { send({ type: 'error', message: e.stack ?? e.message }); });
});
process.on('disconnect', () => {
  engine?.close();
  process.exit(0);
});
