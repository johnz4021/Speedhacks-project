import { describe, expect, it } from 'vitest';
import { reduce, type HarnessEvent } from '../src/events';
import { fileOf, cellId, domainId, edgeId, symbolId } from '../src/contracts/graph';
import type { MapProposal } from '../src/contracts/cartography';
import { parseDomainMap } from '../src/schema';
import { demoLog } from './turn-log';
import { scoutFacts } from './scout-facts';
import { mapYaml } from './helpers';

const ev = (i: number, kind: HarnessEvent['kind'], data: Record<string, unknown>, extra: Partial<HarnessEvent> = {}): HarnessEvent =>
  ({ id: `c${i}`, t: 5000 + i, session: 's1', turn: null, kind, data, ...extra });

describe('contract ids', () => {
  it('build and invert stable ids', () => {
    expect(domainId('tools')).toBe('domain:tools');
    expect(cellId('tools', 'logic')).toBe('cell:tools/logic');
    expect(symbolId('src/a.ts', 'f.g')).toBe('src/a.ts#f.g');
    expect(edgeId('calls', 'src/a.ts#f', 'src/b.ts#g')).toBe('calls|src/a.ts#f|src/b.ts#g');
    expect(fileOf('src/a.ts#f.g')).toBe('src/a.ts');
    expect(fileOf('src/a.ts')).toBe('src/a.ts');
    expect(fileOf('cell:tools/logic')).toBeNull();
    expect(fileOf('table:runs')).toBeNull();
  });
});

describe('schema extensions', () => {
  it('accepts components and cartography settings', () => {
    const yaml = mapYaml.replace(
      'logic:    { paths: ["src/tools/**"] }',
      'logic:    { paths: ["src/tools/**"], components: [{ id: news, name: News, paths: ["src/tools/news-*.ts"] }] }',
    ) + '\ncartography:\n  thresholds: { wideTurnsMedian: 4 }\n';
    const map = parseDomainMap(yaml);
    expect(map.domains.find((d) => d.id === 'tools')!.cells.logic!.components![0]!.name).toBe('News');
    expect(map.cartography?.thresholds?.wideTurnsMedian).toBe(4);
  });
});

describe('reducer: facts and living-map events', () => {
  const { events } = demoLog();

  it('derives per-file facts from an older scan and tracks per-path activity', () => {
    const s = reduce(events);
    expect(s.facts['src/tools/news-summarize.ts']!.imports.map((i) => i.to)).toContain('vendor/llm-openai/index.ts');
    expect(s.facts['src/gateway/cost-ledger.ts']!.writes.map((w) => w.table)).toEqual(['cost_log']);
    const t = s.turns[0]!;
    expect(t.paths['src/tools/news-summarize.ts']!.looked).toBe(true);
    expect(t.paths['src/tools/filing-summary.ts']).toMatchObject({ created: true, added: 12, edits: 1 });
  });

  it('replaces facts on facts_changed, drops stale Tier 2 results, merges symbol diffs', () => {
    const facts = scoutFacts();
    const f = { ...facts['src/tools/news-summarize.ts']!, hash: 'h2' };
    const extra: HarnessEvent[] = [
      ev(1, 'turn_started', { prompt: 'x', head: '', baseline: '' }, { turn: 't9' }),
      ev(2, 'facts_changed', { facts: f }, { turn: 't9', path: f.path }),
      ev(3, 'facts_resolved', { facts: { path: f.path, hash: 'old', calls: [], implements: [] } }),
      ev(4, 'facts_resolved', { facts: { path: f.path, hash: 'h2', calls: [{ from: 'a', to: 'b', confidence: 'typed', count: 1 }], implements: [] } }),
      ev(5, 'edited', { added: 1, removed: 0, created: false, symbols: { added: ['a'], removed: [], sig: [], body: ['b'], renamed: [] } }, { turn: 't9', path: f.path, cell: { domain: 'tools', layer: 'logic' } }),
      ev(6, 'edited', { added: 2, removed: 1, created: false, symbols: { added: [], removed: [], sig: ['c'], body: ['b'], renamed: [] } }, { turn: 't9', path: f.path, cell: { domain: 'tools', layer: 'logic' } }),
      ev(7, 'call_added', { from: 'a', to: 'b', confidence: 'syntactic' }, { turn: 't9' }),
      ev(8, 'facts_changed', { facts: null }, { turn: 't9', path: 'src/tools/web-search.ts' }),
    ];
    const s = reduce([...events, ...extra]);
    expect(s.facts[f.path]!.hash).toBe('h2');
    expect(s.semantic[f.path]!.calls).toHaveLength(1);
    expect(s.facts['src/tools/web-search.ts']).toBeUndefined();
    const pa = s.turns.at(-1)!.paths[f.path]!;
    expect(pa).toMatchObject({ added: 3, removed: 1, edits: 2 });
    expect(pa.symbols).toEqual({ added: ['a'], removed: [], sig: ['c'], body: ['b'], renamed: [] });
    expect(s.turns.at(-1)!.callsAdded).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('keeps living-map proposals out of the map until accepted, and tracks labels, findings, drift', () => {
    const before = reduce(events);
    const proposal: MapProposal = {
      id: 'MP-1', trigger: [], scope: ['domain:billing'], candidates: [], chosen: 0,
      current: { cellsLitMean: 0, cellsLitMedian: 0, modularity: 0, unassigned: 0, cellSizeGini: 0, decisionsBroken: 0, churnFiles: 0, churnIds: 0, total: 0 },
      changes: [{ kind: 'add_domain', domain: 'billing', name: 'Billing' }], rationale: 'new folder',
    };
    const extra: HarnessEvent[] = [
      ev(1, 'drift_detected', { signals: [{ signal: 'unassigned', metric: 'files in Unassigned', value: 3, threshold: 0, scope: ['unassigned'], persisted: 2 }] }),
      ev(2, 'map_proposed', { map: { ...before.map!, domains: [] }, yaml: '', proposal }),
      ev(3, 'labels_updated', { labels: [{ target: 'group:tools/logic/news', kind: 'group', text: 'News', hash: 'h', confirmed: false }] }),
      ev(4, 'audit_finding', { finding: { id: 'AF-1', decision: 'DR-4', files: ['src/a.ts'], lines: [{ path: 'src/a.ts', line: 3 }], text: 'x', confidence: 'high' } }),
      ev(5, 'map_proposal_resolved', { proposal: 'MP-1', outcome: 'rejected', decision: 'DR-9' }),
      ev(6, 'audit_resolved', { id: 'AF-1', outcome: 'dismissed' }),
      ev(7, 'maintenance_run', { agent: 'cartographer', trigger: 'unassigned', ms: 1200, cost: 0.4, ok: true }),
    ];
    const s = reduce([...events, ...extra]);
    expect(s.map!.domains.length).toBe(before.map!.domains.length); // not replaced by the candidate
    expect(s.proposals['MP-1']).toMatchObject({ status: 'rejected', decision: 'DR-9' });
    expect(s.drift[0]!.signal).toBe('unassigned');
    expect(s.labels['group:group:tools/logic/news']!.text).toBe('News');
    expect(s.findings['AF-1']!.status).toBe('dismissed');
    expect(s.maintenance).toHaveLength(1);
  });
});

describe('scout facts fixture', () => {
  it('covers every code file with the DR-1 bypass visible at symbol level', () => {
    const f = scoutFacts();
    expect(Object.keys(f).length).toBeGreaterThan(30);
    expect(f['src/tools/news-summarize.ts']!.calls.map((c) => c.to)).toContain('vendor/llm-openai/index.ts#chat');
    expect(f['src/gateway/cost-ledger.ts']!.writes[0]!.table).toBe('cost_log');
  });
});
