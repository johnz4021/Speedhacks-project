// Tier 2 from the server's side: the per-file debounce, the child process (startSemantic) with its hash checks, and
// the edit gate staying within budget while the child is busy resolving.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SemanticFacts } from '../src/contracts/facts';
import { deltaForEdit, fileExistsIn, scanRepoFacts } from '../src/facts';
import { startSemantic, type SemanticClient } from '../src/facts/semantic/client';
import { KeyedDebounce } from '../src/facts/semantic/debounce';
import { parseDomainMap } from '../src/schema';
import { cleanTemps, factsFor, factsOf, tempCopy } from './semantic-helpers';
import { fixtureRepo } from './helpers';

afterAll(cleanTemps);

describe('KeyedDebounce', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('waits 150 ms after the last change per key, keeps the latest value, and flushes keys due together as one batch', () => {
    vi.useFakeTimers();
    const batches: [string, number][][] = [];
    const d = new KeyedDebounce<number>(150, (b) => batches.push([...b]));
    d.push('a', 1);
    vi.advanceTimersByTime(100);
    d.push('a', 2); // restarts a's wait
    d.push('b', 1);
    vi.advanceTimersByTime(140);
    expect(batches).toEqual([]);
    expect(d.pending).toBe(2);
    vi.advanceTimersByTime(20); // a and b both came due
    expect(batches).toEqual([[['a', 2], ['b', 1]]]);
    d.push('c', 1);
    vi.advanceTimersByTime(151);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual([['c', 1]]);
    expect(d.pending).toBe(0);
  });

  it('clear() drops everything queued', () => {
    vi.useFakeTimers();
    const batches: unknown[] = [];
    const d = new KeyedDebounce<number>(150, (b) => batches.push(b));
    d.push('a', 1);
    d.clear();
    vi.advanceTimersByTime(500);
    expect(batches).toEqual([]);
  });
});

describe('startSemantic (child process)', () => {
  const clients: SemanticClient[] = [];
  afterAll(async () => { await Promise.all(clients.map((c) => c.close())); });

  it('loads in the background, then debounces edits and only hands back results for the current hash', async () => {
    const root = tempCopy();
    const all = factsOf(root);
    const got: SemanticFacts[] = [];
    const client = startSemantic({ root, onResolved: (f) => got.push(f) });
    clients.push(client);
    client.load(Object.values(all));
    expect(client.status().state).toBe('opening'); // returns at once
    await client.idle();
    const st = client.status();
    expect(st).toMatchObject({ state: 'ready', total: 8, done: 8 });
    expect(st.impl === 'tsgo' || st.impl === 'ts-morph').toBe(true);
    expect(st.stats).toMatchObject({ unresolved: 1, implements: 4 });
    expect(got.map((f) => f.path).sort()).toEqual(Object.keys(all).sort());
    got.length = 0;

    // Two quick edits of echo.ts: one update after the debounce, for the second text only.
    const path = 'src/tools/echo.ts';
    const base = readFileSync(join(root, path), 'utf8');
    const v1 = base.replace('return shout(input);', 'return shout(input) + shout(input);');
    writeFileSync(join(root, path), v1);
    client.changed(path, factsFor(root, path, v1, all));
    const v2 = base.replace('return shout(input);', 'return input;');
    writeFileSync(join(root, path), v2);
    const f2 = factsFor(root, path, v2, all);
    client.changed(path, f2);
    await client.idle();
    const mine = got.filter((f) => f.path === path);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.hash).toBe(f2.hash);
    expect(mine[0]!.calls).toEqual([]); // echo.run no longer calls shout
    expect(mine[0]!.implements).toEqual([{ from: 'src/tools/echo.ts#echo.run', to: 'src/types.ts#Tool.run' }]);
    expect(client.status().lastUpdateMs).not.toBeNull();

    // A result computed for an older hash is dropped: tell the client a newer text exists before the child answers.
    got.length = 0;
    const v3 = `${v2}\n// v3\n`;
    client.load(Object.values({ ...all, [path]: f2 })); // the child will resolve echo.ts against f2…
    writeFileSync(join(root, path), v3);
    client.changed(path, factsFor(root, path, v3, all)); // …but v3 is current now
    await client.idle();
    const hashes = got.filter((f) => f.path === path).map((f) => f.hash);
    expect(hashes).not.toContain(f2.hash);
  });

  it('keeps the edit gate under budget while the child is busy resolving', async () => {
    // Keep the child busy on a real project (this package's own sources) while the gate runs in this process.
    const root = fileURLToPath(new URL('..', import.meta.url));
    const map = parseDomainMap('version: 1\nlayers: [{ id: logic, name: Logic }]\nignore: ["node_modules/**", "test/**", "*.json"]\ndomains:\n  - { id: core, name: Core, purpose: x, cells: { logic: { paths: ["src/**"] } } }\n');
    const facts = Object.values(scanRepoFacts(root, map).fileFacts);
    const client = startSemantic({ root, onResolved: () => {} });
    clients.push(client);
    client.load(facts);

    const BUDGET = process.env.HARNESS_PERF_STRICT === '1' ? 20 : 60;
    const exists = fileExistsIn(fixtureRepo);
    const forbidden = 'import { chat } from "../../vendor/llm-openai/index";\n';
    let text = 'import { complete } from "../gateway/complete";\n';
    for (let i = 0; text.length < 1_000_000; i++) text += `export function f${i}(x: number): number {\n  const y = complete({ purpose: "p${i}", messages: [] });\n  return [1, 2].map((q) => q * x).length + Number(y);\n}\n`;
    const runs: number[] = [];
    let busy = 0;
    for (let i = 0; i <= 5; i++) {
      const old = text + '\n'.repeat(i);
      deltaForEdit('src/tools/generated.ts', null, old, exists); // the previous write's extraction leaves the old record cached
      if (client.status().state !== 'ready') busy++;
      const t = performance.now();
      const delta = deltaForEdit('src/tools/generated.ts', old, forbidden + old, exists);
      if (i > 0) runs.push(performance.now() - t);
      expect(delta.imports).toEqual([{ from: 'src/tools/generated.ts', to: 'vendor/llm-openai/index.ts' }]);
    }
    console.log(`gate while Tier 2 is busy (ms): ${runs.map((r) => r.toFixed(1)).join(', ')} · child ${client.status().state}`);
    expect(busy).toBeGreaterThan(0); // measured while the child was opening/resolving
    expect(Math.min(...runs)).toBeLessThan(BUDGET);
    await client.idle();
    expect(client.status().state).toBe('ready');
  });
});
