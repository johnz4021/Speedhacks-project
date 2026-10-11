// Real Scout facts (fixtures/scout-real.json: Tier 1 facts, fetch sites, inferred dispatch, violations and journeys
// of scout-agent@demo-start under the reference map): provider paths (beat 1), `fetches` edges, and journeys unchanged
// by them.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FileFacts } from '../src/contracts/facts';
import type { Journey } from '../src/contracts/cartography';
import type { Violation } from '../src/rules';
import { buildGraph, trace } from '../src/graph';
import { computeJourneys, fetchEdges, providerPaths, type FetchSite, type InferredEdge } from '../src/journeys';
import { createMapper } from '../src/mapper';
import { overviewText } from '../../../apps/server/src/graph-tools';
import { loadMap } from './helpers';

type Fixture = { fileFacts: Record<string, FileFacts>; sites: FetchSite[]; inferred: InferredEdge[]; violations: Violation[]; journeys: Journey[] };
const fx = JSON.parse(readFileSync(new URL('./fixtures/scout-real.json', import.meta.url), 'utf8')) as Fixture;
const map = loadMap();

describe('providerPaths on real Scout (beat 1)', () => {
  it('classifies the three kinds of path to the model provider', () => {
    const paths = providerPaths(buildGraph(map, fx.fileFacts), map, fx.violations);
    expect(paths.map((p) => [p.class, p.invariant ?? null, p.nodes.join(' → ')])).toEqual([
      ['violation', 'DR-1', 'src/tools/news-summarize.ts → vendor/llm-anthropic/index.ts#Anthropic → vendor:@anthropic-ai/sdk'],
      ['uncosted', null, 'vendor/news/index.ts#transcriptLive → vendor:@anthropic-ai/sdk'],
      ['uncosted', null, 'vendor/search/index.ts#liveClient → vendor:@anthropic-ai/sdk'],
      ['gateway', null, 'src/gateway/embed.ts#embedMany → vendor/embeddings/index.ts#createEmbeddings'],
      ['gateway', null, 'src/gateway/providers.ts#AnthropicProvider → vendor/llm-anthropic/index.ts#Anthropic → vendor:@anthropic-ai/sdk'],
      ['gateway', null, 'src/gateway/providers.ts#OpenAIProvider → vendor/llm-openai/index.ts#OpenAI'],
    ]);
    expect(paths.every((p) => p.provider === p.nodes.at(-1))).toBe(true);
  });

  it('without a current violation the bypass reads as uncosted, and a map with no only_via rule has no provider paths', () => {
    const g = buildGraph(map, fx.fileFacts);
    expect(providerPaths(g, map, []).find((p) => p.nodes[0] === 'src/tools/news-summarize.ts')?.class).toBe('uncosted');
    expect(providerPaths(g, { ...map, invariants: map.invariants.filter((i) => i.kind !== 'only_via') }, fx.violations)).toEqual([]);
  });

  it('the overview tool states domains, edges, the violation and the provider paths', () => {
    const files = Object.keys(fx.fileFacts);
    const imports = Object.values(fx.fileFacts).flatMap((f) => f.imports.filter((i) => !i.to.startsWith('vendor:')).map((i) => ({ from: f.path, to: i.to })));
    const text = overviewText(buildGraph(map, fx.fileFacts), map, { files, imports, writes: [] }, createMapper(map), fx.violations);
    expect(text).toContain('6 domains × 5 layers (ui, entry, logic, data, external)');
    expect(text).toContain('- Model gateway (domain:gateway): Every model call, with redaction and cost logging.');
    expect(text).toContain('Rule violations now (1):\n- DR-1: src/tools/news-summarize.ts → vendor/llm-anthropic/index.ts (Model providers are only called through the model gateway)');
    expect(text).toContain('- RULE VIOLATION DR-1: src/tools/news-summarize.ts → vendor/llm-anthropic/index.ts#Anthropic → vendor:@anthropic-ai/sdk');
    expect(text).toContain('- outside the gateway, no rule broken (not redacted or cost-logged): vendor/search/index.ts#liveClient → vendor:@anthropic-ai/sdk');
    expect(text).toMatch(/- Research tools → Model gateway: \d+/);
  });
});

describe('fetches edges', () => {
  const edges = fetchEdges(fx.sites, fx.fileFacts);
  const g = buildGraph(map, fx.fileFacts, {}, edges);

  it('link UI symbols to the routes they call', () => {
    const fetches = g.edges.filter((e) => e.kind === 'fetches');
    expect(fetches.length).toBe(edges.length);
    expect(fetches.length).toBeGreaterThan(5);
    expect(fetches.every((e) => e.to.startsWith('route:') && g.nodes[e.from] && e.owner.startsWith('web/'))).toBe(true);
    expect(fetches.find((e) => e.to === 'route:POST /api/runs')).toBeTruthy();
    expect(buildGraph(map, fx.fileFacts).edges.some((e) => e.kind === 'fetches')).toBe(false);
  });

  it('trace walks them: from the UI call to the run loop', () => {
    const start = g.edges.find((e) => e.kind === 'fetches' && e.to === 'route:POST /api/runs')!.from;
    const paths = trace(g, start);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]![1]).toBe('route:POST /api/runs');
  });

  it('journeys are identical whether the graph carries the fetches edges or not (and to the recorded output)', () => {
    const withEdges = computeJourneys(g, fx.fileFacts, fx.sites, fx.inferred);
    const without = computeJourneys(buildGraph(map, fx.fileFacts), fx.fileFacts, fx.sites, fx.inferred);
    expect(withEdges).toEqual(fx.journeys);
    expect(without).toEqual(fx.journeys);
    expect(fx.journeys.length).toBe(14);
  });
});
