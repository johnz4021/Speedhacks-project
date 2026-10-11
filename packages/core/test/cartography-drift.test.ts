import { describe, expect, it } from 'vitest';
import { detectDrift, thresholdsFor, topFolder, groupHash, cellFiles, labelHash } from '../src/cartography';
import { DEFAULT_THRESHOLDS, type DriftSignal, type DriftThresholds, type HistoryTurn, type Label } from '../src/contracts/cartography';
import { createMapper } from '../src/mapper';
import { parseDomainMap } from '../src/schema';
import { initialState, reduce, type HarnessEvent, type UIState } from '../src/events';
import { scoutFacts } from './scout-facts';
import { loadMap, mapYaml } from './helpers';
import { BILLING, billingFacts, billingMap, ev, ff } from './cartography-fixtures';

const map = loadMap();
const T = (o: Partial<DriftThresholds> = {}): DriftThresholds => ({ ...DEFAULT_THRESHOLDS, ...o });
const h = (id: string, files: string[], source: HistoryTurn['source'] = 'turn'): HistoryTurn => ({ id, source, files });
const only = (signals: DriftSignal[], kind: DriftSignal['signal']) => signals.filter((s) => s.signal === kind);
const ui0 = initialState();

describe('thresholds', () => {
  it('merges cartography.thresholds over the defaults, ignoring unknown keys', () => {
    const m = parseDomainMap(mapYaml.replace('cartography:\n', 'cartography:\n  thresholds: { wideTurnsMedian: 4, persist: 3, bogus: 1 }\n'));
    expect(thresholdsFor(m)).toEqual({ ...DEFAULT_THRESHOLDS, wideTurnsMedian: 4, persist: 3 });
    expect(thresholdsFor(null)).toEqual(DEFAULT_THRESHOLDS);
  });
  it('top-level folders', () => {
    expect(topFolder('src/billing/invoice.ts')).toBe('src/billing');
    expect(topFolder('packages/core/src/x.ts')).toBe('packages/core');
    expect(topFolder('vendor/news/index.ts')).toBe('vendor');
    expect(topFolder('index.ts')).toBeNull();
  });
});

describe('detectDrift', () => {
  it('is quiet on the confirmed Scout map', () => {
    expect(detectDrift(map, scoutFacts(), ui0, [], T())).toEqual([]);
  });

  it('unplaced code and new top-level folders, persisted across surveys while the scope overlaps', () => {
    const facts = billingFacts();
    const first = detectDrift(map, facts, ui0, [], T());
    expect(only(first, 'unassigned')).toEqual([{ signal: 'unassigned', metric: 'files in Unassigned under src/billing/', value: 3, threshold: 0, scope: BILLING, persisted: 1 }]);
    expect(only(first, 'new_top_level')).toEqual([{ signal: 'new_top_level', metric: 'new top-level folder src/billing/ (no file on the map)', value: 3, threshold: 0, scope: BILLING, persisted: 1 }]);
    const second = detectDrift(map, facts, ui0, [], T(), first);
    expect(only(second, 'unassigned')[0]!.persisted).toBe(2);
    // one more file in the folder: the scope overlaps, so the count carries on
    const third = detectDrift(map, { ...facts, 'src/billing/tax.ts': ff('src/billing/tax.ts') }, ui0, [], T(), second);
    expect(only(third, 'unassigned')[0]).toMatchObject({ value: 4, persisted: 3 });
    // a different folder starts at 1
    const other = detectDrift(map, { ...scoutFacts(), 'src/search/x.ts': ff('src/search/x.ts') }, ui0, [], T(), third);
    expect(only(other, 'unassigned')[0]).toMatchObject({ scope: ['src/search/x.ts'], persisted: 1 });
    // placed by the map: gone
    expect(detectDrift(billingMap(), facts, ui0, [], T(), third)).toEqual([]);
  });

  it('turns too wide: median cells lit over the last N turns, needing 3 turns', () => {
    const wide = ['src/channels/routes.ts', 'src/orchestrator/agent.ts', 'src/tools/index.ts', 'src/gateway/complete.ts']; // 4 cells
    const facts = scoutFacts();
    expect(only(detectDrift(map, facts, ui0, [h('t1', wide), h('t2', wide)], T()), 'wide_turns')).toEqual([]);
    const hist = [h('c1', ['src/tools/index.ts'], 'commit'), h('t1', wide), h('t2', wide), h('t3', ['src/tools/index.ts']), h('t4', wide)];
    expect(only(detectDrift(map, facts, ui0, hist, T()), 'wide_turns')).toEqual([{
      signal: 'wide_turns', metric: 'median cells lit per turn (last 10)', value: 4, threshold: 3, persisted: 1,
      scope: ['domain:channels', 'domain:gateway', 'domain:orchestrator', 'domain:tools'],
    }]);
    // window of 2: the last two turns are 1 and 4 → median 2.5
    expect(only(detectDrift(map, facts, ui0, hist, T({ wideTurnsWindow: 2 })), 'wide_turns')).toEqual([]);
  });

  it('co-change across a boundary: pairs in different domains together in >= 3 of the last 20 units', () => {
    const pair = ['src/tools/news-summarize.ts', 'src/gateway/complete.ts'];
    const same = ['src/tools/news-summarize.ts', 'src/tools/index.ts']; // same domain: never a signal
    const hist = [h('c1', pair, 'commit'), h('t1', [...pair, 'README.md']), h('c2', same, 'commit'), h('c3', same, 'commit'), h('c4', same, 'commit')];
    expect(only(detectDrift(map, scoutFacts(), ui0, hist, T()), 'co_change')).toEqual([]);
    const sigs = only(detectDrift(map, scoutFacts(), ui0, [...hist, h('t2', pair)], T()), 'co_change');
    expect(sigs).toEqual([{
      signal: 'co_change', metric: 'src/gateway/complete.ts and src/tools/news-summarize.ts changed together (last 20 turns or commits)',
      value: 3, threshold: 3, scope: ['src/gateway/complete.ts', 'src/tools/news-summarize.ts'], persisted: 1,
    }]);
    // outside the window
    expect(only(detectDrift(map, scoutFacts(), ui0, [...hist, h('t2', pair)], T({ coChangeWindow: 3 })), 'co_change')).toEqual([]);
  });

  it('coupling growth: importing files per domain pair added by turns since the map was confirmed', () => {
    const facts = { ...scoutFacts(), 'src/tools/filing-summary.ts': ff('src/tools/filing-summary.ts', ['src/gateway/complete.ts']) };
    const edge = { from: 'src/tools/filing-summary.ts', to: 'src/gateway/complete.ts' };
    const ui = reduce([
      ev('turn_started', { prompt: 'p', head: '', baseline: '' }, { turn: 't1' }),
      ev('edge_added', { edge, from: 'tools', to: 'gateway' }, { turn: 't1' }),
      ev('turn_ended', { added: 1, removed: 0, files: [], reason: 'success' }, { turn: 't1' }),
    ]);
    const mapper = createMapper(map);
    const before = Object.values(facts).filter((f) => mapper.domainOf(f.path) === 'tools' && f.imports.some((i) => mapper.domainOf(i.to) === 'gateway')).length - 1;
    expect(only(detectDrift(map, facts, ui, [], T({ couplingGrowthFiles: 1 })), 'coupling_growth')).toEqual([{
      signal: 'coupling_growth', metric: 'files importing tools → gateway added since the map was confirmed', value: 1, threshold: 1,
      scope: ['domain:tools', 'domain:gateway'], persisted: 1,
    }]);
    expect(only(detectDrift(map, facts, ui, [], T({ couplingGrowthRatio: 1 / before })), 'coupling_growth')[0]).toMatchObject({ value: Math.round((1 / before) * 1000) / 1000 });
    expect(only(detectDrift(map, facts, ui, [], T({ couplingGrowthRatio: 1 / before + 0.01 })), 'coupling_growth')).toEqual([]);
    // the edge was removed again: no growth
    expect(only(detectDrift(map, scoutFacts(), ui, [], T({ couplingGrowthFiles: 1 })), 'coupling_growth')).toEqual([]);
  });

  it('rule erosion (exceptions or B answers) and reinforcement (A answers in one domain)', () => {
    const eroded = parseDomainMap(mapYaml.replace(/(kind: only_via[\s\S]*?)exceptions: \[\]/, '$1exceptions: ["src/a.ts", "src/b.ts", "src/c.ts"]'));
    expect(only(detectDrift(eroded, scoutFacts(), ui0, [], T()), 'rule_erosion')).toEqual([
      { signal: 'rule_erosion', metric: 'exceptions to DR-1', value: 3, threshold: 3, scope: ['rule:DR-1'], persisted: 1 },
    ]);
    const decide = (id: string, option: 'A' | 'B', paths: string[], invariant = 'DR-1'): HarnessEvent =>
      ev('decision_recorded', { id, title: id, invariant, option, paths });
    const ui = reduce([
      decide('DR-4', 'B', ['src/tools/a.ts']), decide('DR-5', 'B', ['src/tools/b.ts']), decide('DR-5', 'B', ['src/tools/b.ts']), // re-emitted: counted once
      decide('DR-6', 'A', ['src/tools/c.ts'], 'DR-3'), decide('DR-7', 'A', ['src/tools/d.ts'], 'DR-3'), decide('DR-8', 'A', ['src/memory/retrieve.ts'], 'DR-3'),
    ]);
    const sigs = detectDrift(map, scoutFacts(), ui, [], T());
    expect(only(sigs, 'rule_erosion')).toEqual([{ signal: 'rule_erosion', metric: 'option B (exception) chosen for DR-1', value: 2, threshold: 2, scope: ['rule:DR-1'], persisted: 1 }]);
    expect(only(sigs, 'rule_reinforcement')).toEqual([]); // 2 in tools, 1 in memory
    const ui2 = reduce([...[6, 7, 9].map((n) => decide(`DR-${n}`, 'A', [`src/tools/x${n}.ts`], 'DR-3'))]);
    expect(only(detectDrift(map, scoutFacts(), ui2, [], T()), 'rule_reinforcement')).toEqual([
      { signal: 'rule_reinforcement', metric: 'option A chosen for DR-3 in tools', value: 3, threshold: 3, scope: ['rule:DR-3', 'domain:tools'], persisted: 1 },
    ]);
  });

  it('bloated cells: over N files, or over a share of the domain above N/2 files', () => {
    expect(only(detectDrift(map, scoutFacts(), ui0, [], T({ bloatedCellFiles: 4, bloatedCellShare: 1 })), 'bloated_cell')).toEqual([
      { signal: 'bloated_cell', metric: 'files in tools/logic', value: 5, threshold: 4, scope: ['cell:tools/logic'], persisted: 1 },
    ]);
    expect(only(detectDrift(map, scoutFacts(), ui0, [], T()), 'bloated_cell')).toEqual([]); // defaults: 25 files / 40% above 13
    // share rule: tools/logic is 5 of 9 tools files (56% > 40%) and above 8/2 = 4 files
    expect(only(detectDrift(map, scoutFacts(), ui0, [], T({ bloatedCellFiles: 8 })), 'bloated_cell')).toEqual([
      { signal: 'bloated_cell', metric: "share of tools's files in logic", value: 0.556, threshold: 0.4, scope: ['cell:tools/logic'], persisted: 1 },
    ]);
  });

  it('stale labels: a summary whose symbol body changed, a group whose cell membership changed', () => {
    const facts = scoutFacts();
    const mapper = createMapper(map);
    const tools = cellFiles(mapper, facts, 'tools', 'logic');
    const labels: Label[] = [
      { target: 'src/gateway/complete.ts#complete', kind: 'summary', text: 'Calls a model', hash: 'body:src/gateway/complete.ts#complete', confirmed: false },
      { target: 'src/gateway/redact.ts#redact', kind: 'summary', text: 'Redacts', hash: 'old', confirmed: false },
      { target: 'src/tools/index.ts', kind: 'group', text: 'Registry', hash: groupHash(tools), confirmed: false },
    ];
    const ui: UIState = reduce([ev('labels_updated', { labels })]);
    expect(labelHash(mapper, facts, labels[0]!)).toBe(labels[0]!.hash);
    expect(only(detectDrift(map, facts, ui, [], T()), 'stale_label')).toEqual([
      { signal: 'stale_label', metric: 'labels whose target changed', value: 1, threshold: 0, scope: ['src/gateway/redact.ts#redact'], persisted: 1 },
    ]);
    // a new file joins tools/logic: the group label goes stale too
    const more = { ...facts, 'src/tools/filing.ts': ff('src/tools/filing.ts') };
    expect(only(detectDrift(map, more, ui, [], T()), 'stale_label')[0]!.scope).toEqual(['src/gateway/redact.ts#redact', 'src/tools/index.ts']);
  });

  it('is deterministic and ordered by kind, then scope', () => {
    const facts = billingFacts();
    const hist = [h('t1', [...BILLING, 'src/tools/index.ts', 'src/gateway/complete.ts', 'src/memory/retrieve.ts']), h('t2', [...BILLING, 'src/tools/index.ts', 'src/gateway/complete.ts', 'src/memory/retrieve.ts']), h('t3', [...BILLING, 'src/tools/index.ts', 'src/gateway/complete.ts', 'src/memory/retrieve.ts'])];
    const a = detectDrift(map, facts, ui0, hist, T());
    expect(a.map((s) => s.signal)).toEqual(['unassigned', 'new_top_level', 'wide_turns', 'co_change', 'co_change', 'co_change']);
    expect(detectDrift(map, Object.fromEntries(Object.entries(facts).reverse()), ui0, hist, T())).toEqual(a);
  });
});
