// The agent's graph tools (NAVIGATION_PLAN §3.4): graph_neighbors, trace, symbols_in, answered from buildGraph over
// Tier 1 + Tier 2 facts of the small TS fixture. Imports the server module directly so `npm test` runs it.
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findNode, neighborsText, renderChain, sinksFor, symbolsText, traceText } from '../../../apps/server/src/graph-tools';
import type { SemanticFacts } from '../src/contracts/facts';
import type { ContextGraph } from '../src/contracts/graph';
import { SemanticEngine } from '../src/facts/semantic/engine';
import { buildGraph } from '../src/graph';
import { factsOf, semanticMap, semanticRepo, tryOpen } from './semantic-helpers';

let graph: ContextGraph;
let tier1: ContextGraph;
const facts = factsOf(semanticRepo);
const text = (p: string) => readFileSync(join(semanticRepo, p), 'utf8');

beforeAll(async () => {
  const resolver = (await tryOpen('tsgo', semanticRepo, Object.keys(facts))) ?? (await tryOpen('ts-morph', semanticRepo, Object.keys(facts)))!;
  const semantic: Record<string, SemanticFacts> = {};
  const engine = new SemanticEngine(semanticRepo, resolver, (f) => { semantic[f.path] = f; });
  engine.setFacts(Object.values(facts));
  await engine.resolveAll();
  engine.close();
  graph = buildGraph(semanticMap, facts, semantic);
  tier1 = buildGraph(semanticMap, facts);
});

describe('findNode', () => {
  it('accepts ids, paths, path#symbol and unique symbol names; lists ambiguous ones', () => {
    expect(findNode(graph, 'src/main.ts')).toEqual({ id: 'src/main.ts' });
    expect(findNode(graph, './src/main.ts')).toEqual({ id: 'src/main.ts' });
    expect(findNode(graph, 'runAll')).toEqual({ id: 'src/registry.ts#Registry.runAll' });
    expect(findNode(graph, '#Registry.runAll')).toEqual({ id: 'src/registry.ts#Registry.runAll' });
    const amb = findNode(graph, 'run');
    expect('error' in amb && amb.error).toMatch(/matches 3 symbols: .*echo\.run/);
    expect('error' in findNode(graph, 'nope')).toBe(true);
  });
});

describe('trace', () => {
  it('reaches implementations through the registry and labels the dispatch hop', () => {
    const out = traceText(graph, semanticMap, 'src/registry.ts#Registry.runAll', sinksFor(graph, 'src/util.ts') as string[]);
    expect(out).toContain('1 chain(s) from src/registry.ts#Registry.runAll:');
    expect(out).toContain('1. src/registry.ts#Registry.runAll  [App · Logic]');
    expect(out).toContain('   → src/types.ts#Tool.run  [Shared] (dispatch)');
    expect(out).toContain('   ⇢ via registry → src/tools/echo.ts#echo.run  [Tools · Logic]');
    expect(out).toContain('   → src/util.ts#shout  [Providers · External]');
    expect(out).toMatch(/never complete/);
    // Tier 1 alone has no implements edges: the registry is a dead end.
    expect(traceText(tier1, semanticMap, 'src/registry.ts#Registry.runAll', sinksFor(tier1, 'src/util.ts') as string[])).toMatch(/^No call chain/);
  });

  it('defaults to vendors, tables and external cells; a file traces from each of its symbols', () => {
    const out = traceText(graph, semanticMap, 'src/main.ts', undefined, { typed: 8, files: 8 });
    expect(out).toContain('src/util.ts#shout  [Providers · External]');
    expect(out).toContain('typed calls for 8/8 files');
  });

  it('collapses consecutive hops inside one cell', () => {
    const lines = renderChain(graph, semanticMap, ['src/providers.ts#provider', 'src/providers.ts#Loud', 'src/util.ts#shout'], 1);
    expect(lines[0]).toBe('1. src/providers.ts#provider → … → src/providers.ts#Loud  [Providers · Logic · 1 hop(s) in cell]');
  });
});

describe('graph_neighbors', () => {
  it('lists incoming dispatch calls and implementations of an interface member', () => {
    const out = neighborsText(graph, semanticMap, 'src/types.ts#Tool.run');
    expect(out).toContain('← calls (dispatch)  src/registry.ts#Registry.runAll  [App · Logic]');
    expect(out).toContain('← calls (dispatch ×2)  src/main.ts#main  [App · Entry]');
    expect(out).toContain('← implements  src/tools/echo.ts#echo.run  [Tools · Logic]');
    expect(out).toContain('← implements  src/tools/upper.ts#upper.run  [Tools · Logic]');
  });

  it('filters by kind and follows more hops', () => {
    const out = neighborsText(graph, semanticMap, 'src/tools/echo.ts', ['calls', 'implements'], 2);
    expect(out).toContain('→ calls (typed)  src/util.ts#shout  [Providers · External]  (from src/tools/echo.ts#echo.run)');
    expect(out).not.toContain('imports');
    expect(out).toMatch(/2 hops \(\d+\):[\s\S]*src\/registry\.ts#Registry\.runAll/);
  });
});

describe('symbols_in', () => {
  it('lists a file\'s symbols with lines, calls and implemented members', () => {
    const out = symbolsText(graph, semanticMap, new Map(Object.entries(facts)), 'src/providers.ts', text);
    expect(out).toContain('src/providers.ts  [Providers · Logic] · 6 symbols');
    expect(out).toContain('    method Base.chat :5');
    expect(out).toContain('    method Loud.chat :12 · calls 1 · implements src/providers.ts#Base.chat, src/types.ts#Provider.chat');
  });

  it('lists the files under a directory', () => {
    expect(symbolsText(graph, semanticMap, new Map(Object.entries(facts)), 'src/tools/', text)).toContain('src/tools/echo.ts  2 symbols  [Tools · Logic]');
  });
});
