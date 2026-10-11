import { describe, expect, it } from 'vitest';
import {
  historyFromUI, isBulk, scoreMap, cellsLitPerUnit, modularity, describeScores, SCORE_WEIGHTS, diffMaps, changeSignature,
  summarizeChanges, instantGuess, skeletonMap, mapToYaml, layerFor, gini, median, UNASSIGNED_CELL,
} from '../src/cartography';
import { createMapper } from '../src/mapper';
import { parseDomainMap } from '../src/schema';
import { reduce } from '../src/events';
import type { HistoryTurn } from '../src/contracts/cartography';
import { demoLog } from './turn-log';
import { scoutFacts } from './scout-facts';
import { loadMap, mapYaml } from './helpers';
import { BILLING, billingFacts, billingMap, billingYaml, ev, ff } from './cartography-fixtures';

const map = loadMap();
const h = (id: string, files: string[], source: HistoryTurn['source'] = 'turn'): HistoryTurn => ({ id, source, files });

describe('historyFromUI', () => {
  it('turns become units of the files they edited (attributed or not); read-only turns are skipped', () => {
    const { events } = demoLog();
    const more = [
      ev('turn_started', { prompt: 'look only', head: '', baseline: '' }, { turn: 't2' }),
      ev('looked', { tool: 'Read' }, { turn: 't2', path: 'src/gateway/complete.ts' }),
      ev('turn_ended', { added: 0, removed: 0, files: [], reason: 'success' }, { turn: 't2' }),
      ev('turn_started', { prompt: 'bash edit', head: '', baseline: '' }, { turn: 't3' }),
      ev('edited', { added: 1, removed: 0, created: false, unattributed: true }, { turn: 't3', path: 'src/memory/retrieve.ts', cell: { domain: 'memory', layer: 'logic' } }),
      ev('turn_ended', { added: 1, removed: 0, files: [], reason: 'success' }, { turn: 't3' }),
    ];
    expect(historyFromUI(reduce([...events, ...more]))).toEqual([
      { id: 't1', source: 'turn', files: ['src/outreach/draft-email.ts', 'src/tools/filing-summary.ts', 'src/tools/index.ts'] },
      { id: 't3', source: 'turn', files: ['src/memory/retrieve.ts'] },
    ]);
  });

  it('flags bulk units (more than 10 files and 30% of known files)', () => {
    const known = new Set(Object.keys(scoutFacts()));
    expect(isBulk([...known], known)).toBe(true);
    expect(isBulk([...known].slice(0, 10), known)).toBe(false);
  });
});

describe('metric helpers', () => {
  it('gini and median', () => {
    expect(gini([1, 1, 1, 1])).toBe(0);
    expect(gini([0, 0, 0, 4])).toBeCloseTo(0.75);
    expect(gini([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it('modularity: Newman Q by domain, with unassigned files as singletons', () => {
    const two = parseDomainMap(`version: 1
layers: [{ id: logic, name: Logic }]
domains:
  - { id: a, name: A, purpose: a, cells: { logic: { paths: ["src/a/**"] } } }
  - { id: b, name: B, purpose: b, cells: { logic: { paths: ["src/b/**"] } } }
`);
    const facts = {
      'src/a/1.ts': ff('src/a/1.ts', ['src/a/2.ts', 'src/b/1.ts', 'vendor:zod']),
      'src/a/2.ts': ff('src/a/2.ts'),
      'src/b/1.ts': ff('src/b/1.ts', ['src/b/2.ts']),
      'src/b/2.ts': ff('src/b/2.ts', ['src/b/1.ts']), // the reverse import is the same undirected edge
    };
    // m = 3; each domain: 1 intra edge, degree 3 → Q = 2 · (1/3 − (3/6)²) = 1/6
    expect(modularity(createMapper(two), facts)).toBeCloseTo(1 / 6);
    // Without b on the map: a = 1/3 − 1/4; ?b1 (deg 2) = −1/9; ?b2 (deg 1) = −1/36
    const onlyA = parseDomainMap(`version: 1
layers: [{ id: logic, name: Logic }]
domains: [{ id: a, name: A, purpose: a, cells: { logic: { paths: ["src/a/**"] } } }]
`);
    expect(modularity(createMapper(onlyA), facts)).toBeCloseTo(1 / 3 - 1 / 4 - 1 / 9 - 1 / 36);
    expect(modularity(createMapper(two), {})).toBe(0);
  });
});

describe('scoreMap', () => {
  const facts = billingFacts();
  const history = [
    h('c1', ['src/tools/news-summarize.ts', 'src/gateway/complete.ts', 'README.md'], 'commit'), // 2 cells; README is not code
    h('c2', ['src/memory/retrieve.ts', 'src/memory/vector-index.ts', 'src/shared/db.ts'], 'commit'), // 1 cell; neutral skipped
    h('c3', Object.keys(facts), 'commit'), // bulk: skipped
    h('c4', ['docs/x.md'], 'commit'), // no code: skipped
    h('t1', BILLING),
    h('t2', ['src/billing/invoice.ts', 'src/tools/index.ts']),
  ];

  it('counts cells lit per unit (unassigned files share one cell)', () => {
    expect(cellsLitPerUnit(map, facts, history)).toEqual([2, 1, 1, 2]);
    expect(cellsLitPerUnit(billingMap(), facts, history)).toEqual([2, 1, 1, 2]);
    expect(UNASSIGNED_CELL).toBe('(unassigned)');
  });

  it('scores the current map and a candidate that adds Billing', () => {
    const current = scoreMap(map, facts, history, { current: map });
    const next = scoreMap(billingMap(), facts, history, { current: map });
    expect(current).toMatchObject({ cellsLitMean: 1.5, cellsLitMedian: 1.5, unassigned: 3, decisionsBroken: 0, churnFiles: 0, churnIds: 0 });
    expect(next).toMatchObject({ cellsLitMean: 1.5, unassigned: 0, decisionsBroken: 0, churnFiles: 0, churnIds: 0 });
    expect(next.modularity).toBeGreaterThan(current.modularity);
    expect(next.total).toBeLessThan(current.total - 1);
    const w = SCORE_WEIGHTS;
    const total = (s: typeof next) => w.cellsLitMean * s.cellsLitMean + w.cellsLitMedian * s.cellsLitMedian + w.modularity * s.modularity +
      w.unassigned * s.unassigned + w.cellSizeGini * s.cellSizeGini + w.decisionsBroken * s.decisionsBroken + w.churnFiles * s.churnFiles + w.churnIds * s.churnIds;
    expect(next.total).toBeCloseTo(total(next), 2);
    expect(describeScores(current, next)).toContain('3 files placed');
  });

  it('is deterministic regardless of fact and history key order', () => {
    const shuffled = Object.fromEntries(Object.entries(facts).reverse());
    const a = scoreMap(billingMap(), facts, history, { current: map });
    expect(scoreMap(billingMap(), shuffled, history, { current: map })).toEqual(a);
    expect(scoreMap(billingMap(), facts, history, { current: map })).toEqual(a);
  });

  it('counts churn: moved files and removed ids, not newly placed files', () => {
    const moved = {
      ...map,
      domains: map.domains.filter((d) => d.id !== 'outreach').map((d) => (d.id === 'tools' ? { ...d, cells: { ...d.cells, entry: { paths: ['src/tools/index.ts'] } } } : d)),
      invariants: map.invariants.filter((i) => i.id === 'DR-1'), // DR-2 and DR-3 reference outreach
    };
    const s = scoreMap(moved, facts, [], { current: map });
    // index.ts moves to tools/entry (entry precedes logic); outreach's 4 src files + 2 vendor files and its test leave their homes
    expect(s.churnFiles).toBe(1 + 6 + 0);
    expect(s.churnIds).toBe(1 /* domain:outreach */ + 2 /* rule:DR-2, rule:DR-3 */);
  });

  it('counts decisions broken: anchored paths changing domain, and decision-backed invariants disappearing', () => {
    const news = parseDomainMap(mapYaml.replace('\n# Seeded by', `
  - id: news
    name: News
    purpose: News tools
    cells:
      logic: { paths: ["src/tools/news-summarize.ts"] }
\n# Seeded by`).replace('logic:    { paths: ["src/tools/**"] }', 'logic:    { paths: ["src/tools/web-search.ts", "src/tools/news-digest.ts", "src/tools/index.ts", "src/tools/company-profile.ts"] }'));
    expect(scoreMap(news, facts, [], { current: map, decisionPaths: { 'DR-4': ['src/tools/news-summarize.ts'], 'DR-5': ['src/tools/index.ts'] } }).decisionsBroken).toBe(1);
    const linked = parseDomainMap(mapYaml.replace('allowed_from: [gateway]', 'allowed_from: [gateway]\n    decisions: [DR-4]'));
    const retired = { ...linked, invariants: linked.invariants.filter((i) => i.id !== 'DR-1') };
    expect(scoreMap(retired, facts, [], { current: linked }).decisionsBroken).toBe(1);
    expect(scoreMap(retired, facts, []).decisionsBroken).toBe(0); // no current map: nothing to break
  });
});

describe('diffMaps', () => {
  const files = Object.keys(billingFacts());

  it('reports a new domain, its cells and the files it places', () => {
    const changes = diffMaps(map, billingMap(), files);
    expect(changes).toEqual([
      { kind: 'add_domain', domain: 'billing', name: 'Billing' },
      { kind: 'purpose', domain: 'billing', purpose: 'Invoices, charges and refunds' },
      { kind: 'add_cell', domain: 'billing', layer: 'logic' },
      ...BILLING.map((path) => ({ kind: 'place', path, domain: 'billing', layer: 'logic' })),
    ]);
    expect(summarizeChanges(changes)).toBe('add domain Billing (billing); place 3 files');
    expect(diffMaps(map, map, files)).toEqual([]);
  });

  it('reports renames, purposes, cell and file moves, removals and rule changes', () => {
    const next = parseDomainMap(mapYaml
      .replace('name: Agent loop', 'name: Run loop')
      .replace('purpose: Store and retrieve notes about each company', 'purpose: Company memory')
      .replace('logic: { paths: ["src/memory/retrieve.ts", "src/memory/vector-index.ts"] }', 'logic: { paths: ["src/memory/retrieve.ts"] }\n      data:  { paths: ["src/memory/notes-store.ts", "src/memory/vector-index.ts"], tables: ["notes", "embeddings"] }\n      external: { paths: [] }')
      .replace(/      data:  \{ paths: \["src\/memory\/notes-store.ts", "src\/memory\/schema.sql"\], tables: \["notes", "embeddings"\] \}\n/, '')
      .replace('rule: Research tools never depend on outreach', 'rule: Research tools never import outreach')
      .replace(/  - id: DR-2[\s\S]*?source: cartographer\n\n/, ''));
    const changes = diffMaps(map, next, files);
    expect(changes).toEqual([
      { kind: 'rename_domain', domain: 'orchestrator', from: 'Agent loop', to: 'Run loop' },
      { kind: 'purpose', domain: 'memory', purpose: 'Company memory' },
      { kind: 'add_cell', domain: 'memory', layer: 'external' },
      { kind: 'move', path: 'src/memory/vector-index.ts', from: { domain: 'memory', layer: 'logic' }, to: { domain: 'memory', layer: 'data' } },
      { kind: 'change_rule', invariant: 'DR-3', rule: 'Research tools never import outreach' },
      { kind: 'retire_rule', invariant: 'DR-2' },
    ]);
    // rule text change is a change_rule; linking a decision or adding an exception is not
    const reworded = parseDomainMap(mapYaml.replace('rule: Research tools never depend on outreach', 'rule: Tools never import outreach').replace('allowed_from: [gateway]', 'allowed_from: [gateway]\n    decisions: [DR-4]'));
    expect(diffMaps(map, reworded, files)).toEqual([{ kind: 'change_rule', invariant: 'DR-3', rule: 'Tools never import outreach' }]);
    const removed = { ...map, domains: map.domains.filter((d) => d.id !== 'memory') };
    expect(diffMaps(map, removed, files)).toContainEqual({ kind: 'remove_domain', domain: 'memory' });
  });

  it('detects nested rule edits (a new table owner) as change_rule', () => {
    const owned = parseDomainMap(billingYaml.replace('outreach_log: outreach }', 'outreach_log: outreach, invoices: billing }'));
    expect(diffMaps(billingMap(), owned, files)).toEqual([{ kind: 'change_rule', invariant: 'DR-2', rule: 'Each table is written only by the domain that owns it' }]);
  });

  it('change signatures ignore order but see nested fields', () => {
    const c = diffMaps(map, billingMap(), files);
    expect(changeSignature([...c].reverse())).toBe(changeSignature(c));
    expect(changeSignature(c)).not.toBe(changeSignature(c.slice(1)));
    const move = (layer: string) => ({ kind: 'move' as const, path: 'a.ts', from: { domain: 'x', layer: 'logic' }, to: { domain: 'x', layer } });
    expect(changeSignature([move('data')])).not.toBe(changeSignature([move('entry')]));
  });
});

describe('instantGuess', () => {
  const facts = {
    ...billingFacts(),
    'src/memory/summarize.ts': ff('src/memory/summarize.ts', ['src/memory/retrieve.ts']),
    'src/glue/wire.ts': ff('src/glue/wire.ts', ['src/gateway/complete.ts', 'src/gateway/redact.ts', 'src/tools/index.ts']),
  };

  it('returns the existing cell for a placed file', () => {
    expect(instantGuess(map, facts, 'src/tools/news-summarize.ts')).toEqual({ domain: 'tools', layer: 'logic', basis: 'cell' });
  });
  it('uses the majority cell of folder siblings', () => {
    expect(instantGuess(map, facts, 'src/memory/summarize.ts')).toEqual({ domain: 'memory', layer: 'logic', basis: 'siblings' });
  });
  it('falls back to the majority domain of its import neighbours', () => {
    expect(instantGuess(map, facts, 'src/glue/wire.ts')).toEqual({ domain: 'gateway', layer: 'logic', basis: 'imports' });
  });
  it('names a new domain after a folder the map knows nothing about', () => {
    expect(instantGuess(map, facts, 'src/billing/invoice.ts')).toEqual({ domain: 'billing', layer: 'data', basis: 'folder' });
    expect(instantGuess(map, facts, 'src/billing/charge.ts')).toEqual({ domain: 'billing', layer: 'logic', basis: 'folder' });
  });
  it('returns null for neutral files', () => {
    expect(instantGuess(map, facts, 'src/shared/db.ts')).toBeNull();
  });
});

describe('skeletonMap', () => {
  const facts = scoutFacts();
  const files = [...Object.keys(facts), 'README.md', 'package.json'];

  it('builds one domain per top-level source folder with heuristic layers, owned tables and vendor cells', () => {
    const sk = skeletonMap(files, facts);
    expect(sk.domains.map((d) => d.id)).toEqual(['channels', 'gateway', 'memory', 'orchestrator', 'outreach', 'tools']);
    expect(sk.layers.map((l) => l.id)).toEqual(['entry', 'logic', 'data', 'external']);
    const m = createMapper(sk);
    // Same cells as the hand-made reference map for every placed source file.
    const ref = createMapper(map);
    for (const path of Object.keys(facts)) expect([path, m.place(path)]).toEqual([path, ref.place(path)]);
    expect(m.ownerOf('cost_log')).toEqual({ domain: 'gateway', layer: 'data' });
    expect(sk.domains.find((d) => d.id === 'tools')!.cells.logic!.paths).toEqual(['src/tools/**']);
    expect(sk.invariants).toEqual([]);
  });

  it('round-trips through domains.yaml text and is deterministic', () => {
    const sk = skeletonMap(files, facts);
    expect(parseDomainMap(mapToYaml(sk))).toEqual(sk);
    expect(skeletonMap([...files].reverse(), facts)).toEqual(sk);
  });

  it('puts a new folder in its own domain', () => {
    const bf = billingFacts();
    const sk = skeletonMap(Object.keys(bf), bf);
    const billing = sk.domains.find((d) => d.id === 'billing')!;
    expect(billing.cells.logic!.paths).toEqual(['src/billing/charge.ts']);
    expect(billing.cells.data).toEqual({ paths: ['src/billing/invoice.ts', 'src/billing/refund.ts'], tables: ['invoices'] });
  });

  it('layer heuristics', () => {
    expect(layerFor('src/api/routes.ts')).toBe('entry');
    expect(layerFor('src/x/user-store.ts')).toBe('data');
    expect(layerFor('vendor/stripe/index.ts')).toBe('external');
    expect(layerFor('src/x/stripe-client.ts')).toBe('external');
    expect(layerFor('src/x/catalog.ts')).toBe('logic');
  });
});

describe('billing yaml fixture', () => {
  it('parses', () => expect(parseDomainMap(billingYaml).domains.at(-1)!.id).toBe('billing'));
});
