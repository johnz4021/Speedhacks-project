// Tier 2 (NAVIGATION_PLAN §3.1): the SemanticResolver interface on a small TS fixture, for both implementations
// (TS 7 tsgo and TS 6 ts-morph), plus the engine's update and stale-hash logic.
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SemanticFacts } from '../src/contracts/facts';
import { SemanticEngine } from '../src/facts/semantic/engine';
import { packageOf } from '../src/facts/semantic/names';
import { semanticFacts } from '../src/facts/semantic/resolve';
import { scanSites } from '../src/facts/semantic/sites';
import type { ResolverImpl } from '../src/facts/semantic/types';
import { cleanTemps, factsFor, factsOf, semanticRepo, tempCopy, tryOpen } from './semantic-helpers';

afterAll(cleanTemps);

const show = (f: SemanticFacts) => [
  ...f.calls.map((c) => `${c.from} -> ${c.to} ${c.confidence}${c.count > 1 ? ` x${c.count}` : ''}`),
  ...f.implements.map((i) => `${i.from} => ${i.to}`),
];

/** What both resolvers must agree on (the fixture has emoji before call sites: offsets are UTF-16). */
const EXPECTED: Record<string, string[]> = {
  'src/main.ts': [
    'src/main.ts#main -> src/providers.ts#provider typed',
    'src/main.ts#main -> src/registry.ts#Registry typed',
    'src/main.ts#main -> src/registry.ts#Registry.get typed',
    'src/main.ts#main -> src/registry.ts#Registry.runAll typed',
    // `loose.whatever()` can't be resolved, so Tier 1's guesses in `main` stay (syntactic)
    'src/main.ts#main -> src/tools/echo.ts#echo.run syntactic',
    'src/main.ts#main -> src/types.ts#Provider.chat dispatch',
    'src/main.ts#main -> src/types.ts#Tool.run dispatch x2',
  ],
  'src/providers.ts': [
    'src/providers.ts#Base.hello -> src/providers.ts#Base.chat dispatch', // abstract member
    'src/providers.ts#Loud.chat -> src/util.ts#shout typed',
    'src/providers.ts#provider -> src/providers.ts#Loud typed',
    'src/providers.ts#Loud.chat => src/providers.ts#Base.chat', // extends an abstract class
    'src/providers.ts#Loud.chat => src/types.ts#Provider.chat', // implements clause, type-literal member
  ],
  'src/registry.ts': ['src/registry.ts#Registry.runAll -> src/types.ts#Tool.run dispatch'],
  'src/tools/echo.ts': ['src/tools/echo.ts#echo.run -> src/util.ts#shout typed', 'src/tools/echo.ts#echo.run => src/types.ts#Tool.run'],
  'src/tools/upper.ts': ['src/tools/upper.ts#upper.run => src/types.ts#Tool.run'], // `satisfies Tool`
  'src/tools/index.ts': [],
  'src/types.ts': [],
  'src/util.ts': [],
};

describe.each<ResolverImpl>(['tsgo', 'ts-morph'])('SemanticResolver (%s)', (impl) => {
  const facts = factsOf(semanticRepo);

  it('resolves typed calls, dispatch through interface members, and implements edges in Tier 1 ids', async (ctx) => {
    const resolver = await tryOpen(impl, semanticRepo, Object.keys(facts));
    if (!resolver) return ctx.skip(); // TS 7 has no native binary for this platform
    expect(resolver.impl).toBe(impl);
    const out: SemanticFacts[] = [];
    const engine = new SemanticEngine(semanticRepo, resolver, (f) => out.push(f));
    engine.setFacts(Object.values(facts));
    await engine.resolveAll();
    engine.close();
    const got = Object.fromEntries(out.map((f) => [f.path, show(f)]));
    expect(got).toEqual(EXPECTED);
    for (const f of out) expect(f.hash).toBe(facts[f.path]!.hash);
    expect(engine.totals).toMatchObject({ unresolved: 1, implements: 4 });
  });

  it('re-resolves an edited file and its importers after update(), and reports only what changed', async (ctx) => {
    const root = tempCopy();
    const all = factsOf(root);
    const resolver = await tryOpen(impl, root, Object.keys(all));
    if (!resolver) return ctx.skip();
    const out: SemanticFacts[] = [];
    const engine = new SemanticEngine(root, resolver, (f) => out.push(f));
    engine.setFacts(Object.values(all));
    await engine.resolveAll();
    out.length = 0;

    // util.ts gains `whisper`; echo.ts switches to it.
    const util = `${readFileSync(join(root, 'src/util.ts'), 'utf8')}\nexport function whisper(s: string): string {\n  return s.toLowerCase();\n}\n`;
    writeFileSync(join(root, 'src/util.ts'), util);
    all['src/util.ts'] = factsFor(root, 'src/util.ts', util, all);
    const echo = readFileSync(join(root, 'src/tools/echo.ts'), 'utf8').replace(/shout/g, 'whisper');
    writeFileSync(join(root, 'src/tools/echo.ts'), echo);
    all['src/tools/echo.ts'] = factsFor(root, 'src/tools/echo.ts', echo, all);

    const t = performance.now();
    const paths = engine.update([all['src/util.ts']!, all['src/tools/echo.ts']!]);
    const ms = performance.now() - t;
    engine.close();
    // The edited files first, then importers (re-resolved, emitted only if their result moved).
    expect(paths.slice(0, 2)).toEqual(['src/util.ts', 'src/tools/echo.ts']);
    expect(paths).toEqual(expect.arrayContaining(['src/providers.ts', 'src/tools/index.ts']));
    const echoOut = out.find((f) => f.path === 'src/tools/echo.ts')!;
    expect(echoOut.hash).toBe(all['src/tools/echo.ts']!.hash);
    expect(show(echoOut)).toContain('src/tools/echo.ts#echo.run -> src/util.ts#whisper typed');
    expect(out.map((f) => f.path).sort()).toEqual(['src/tools/echo.ts', 'src/util.ts']); // providers.ts unchanged: not re-emitted
    expect(ms).toBeLessThan(impl === 'tsgo' ? 500 : 2000);
  });
});

describe('Tier 2 helpers', () => {
  it('drops a result when the text on disk is not the text the Tier 1 facts describe (stale hash)', async () => {
    const facts = factsOf(semanticRepo);
    const f = facts['src/main.ts']!;
    const never = { impl: 'ts-morph' as const, declarationsAt: () => { throw new Error('not called'); }, update() {}, close() {} };
    expect(semanticFacts(never, f, `${readFileSync(join(semanticRepo, 'src/main.ts'), 'utf8')}\n// edited`, () => null)).toBeNull();
  });

  it('finds call sites at the callee name and attributes them to the innermost Tier 1 symbol', () => {
    const facts = factsOf(semanticRepo);
    const src = readFileSync(join(semanticRepo, 'src/main.ts'), 'utf8');
    const { calls } = scanSites('src/main.ts', src, facts['src/main.ts']!.symbols);
    expect(calls.map((c) => `${src.slice(c.at, c.at + 8)}@${c.from}`)).toEqual([
      'Registry@src/main.ts#main', 'runAll(\'@src/main.ts#main', 'run(\'y\')@src/main.ts#main', 'get(name@src/main.ts#main',
      'run(\'z\')@src/main.ts#main', 'chat(\'he@src/main.ts#main', 'provider@src/main.ts#main', 'whatever@src/main.ts#main',
    ]);
  });

  it('names packages from declaration paths (@types/x → x)', () => {
    expect(packageOf('/r/node_modules/@anthropic-ai/sdk/client.d.mts')).toBe('@anthropic-ai/sdk');
    expect(packageOf('/r/node_modules/a/node_modules/yaml/dist/index.d.ts')).toBe('yaml');
    expect(packageOf('/r/node_modules/@types/node/fs.d.ts')).toBe('node');
    expect(packageOf('/r/node_modules/@types/babel__core/index.d.ts')).toBe('@babel/core');
    expect(packageOf('/r/src/a.ts')).toBeNull();
  });
});
