import { describe, expect, it } from 'vitest';
import { createMapper } from '../src/mapper';
import { loadMap } from './helpers';

describe('createMapper', () => {
  const m = createMapper(loadMap());

  it('places paths with precedence ignore → neutral → tests → cells', () => {
    expect(m.place('src/channels/routes.ts')).toEqual({ kind: 'cell', domain: 'channels', layer: 'entry' });
    expect(m.place('src/orchestrator/run-state.ts')).toEqual({ kind: 'cell', domain: 'orchestrator', layer: 'data' });
    expect(m.place('src/tools/news-summarize.ts')).toEqual({ kind: 'cell', domain: 'tools', layer: 'logic' });
    expect(m.place('vendor/sec-edgar/index.ts')).toEqual({ kind: 'cell', domain: 'tools', layer: 'external' });
    expect(m.place('vendor/llm-openai/index.ts')).toEqual({ kind: 'cell', domain: 'gateway', layer: 'external' });
    expect(m.place('test/gateway/complete.test.ts')).toEqual({ kind: 'test', domain: 'gateway' });
    expect(m.place('src/shared/db.ts')).toEqual({ kind: 'neutral' });
    expect(m.place('vendor/_calllog.ts')).toEqual({ kind: 'neutral' });
    expect(m.place('scripts/proof.ts')).toEqual({ kind: 'ignored' });
    expect(m.place('fixtures/x.json')).toEqual({ kind: 'ignored' });
    expect(m.place('.harness/events.jsonl')).toEqual({ kind: 'ignored' });
    expect(m.place('src/billing/invoice.ts')).toEqual({ kind: 'unassigned' });
    expect(m.place('package.json')).toEqual({ kind: 'ignored' });
    expect(m.place('src/package.json')).toEqual({ kind: 'unassigned' });
  });

  it('answers domainOf / isIgnored / isNeutral', () => {
    expect(m.domainOf('src/memory/retrieve.ts')).toBe('memory');
    expect(m.domainOf('test/memory/retrieve.test.ts')).toBe('memory');
    expect(m.domainOf('src/shared/db.ts')).toBeNull();
    expect(m.domainOf('scripts/proof.ts')).toBeNull();
    expect(m.domainOf('README.md')).toBeNull();
    expect(m.isIgnored('scripts/seed.ts')).toBe(true);
    expect(m.isNeutral('src/shared/types.ts')).toBe(true);
    expect(m.isNeutral('src/tools/index.ts')).toBe(false);
  });

  it('finds table owners', () => {
    expect(m.ownerOf('runs')).toEqual({ domain: 'orchestrator', layer: 'data' });
    expect(m.ownerOf('cost_log')).toEqual({ domain: 'gateway', layer: 'data' });
    expect(m.ownerOf('embeddings')).toEqual({ domain: 'memory', layer: 'data' });
    expect(m.ownerOf('outreach_log')).toEqual({ domain: 'outreach', layer: 'data' });
    expect(m.ownerOf('nope')).toBeNull();
  });
});
