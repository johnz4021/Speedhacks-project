import { describe, expect, it } from 'vitest';
import { activityFor, autoExpand, buildGraph, emptyLeaf, graphOf, project, trace, VENDORS_ID } from '../src/graph';
import { cellId, domainId, edgeId, groupId, testsId, type ContextGraph, type LeafActivity, type ViewState } from '../src/contracts/graph';
import type { ActivityFor, AutoExpand, BuildGraph, Project, Trace, TurnActivity } from '../src/contracts/api';
import type { CallFact, FileFacts, SemanticFacts, SymbolFact } from '../src/contracts/facts';
import { parseDomainMap } from '../src/schema';
import { reduce } from '../src/events';
import { demoLog } from './turn-log';
import { scoutFacts } from './scout-facts';
import { loadMap } from './helpers';

// ---------------------------------------------------------------- a small map: three domains, a neutral folder

const mini = parseDomainMap(`
version: 1
layers: [{ id: entry, name: Entry }, { id: logic, name: Logic }, { id: external, name: External }]
neutral: ["src/shared/**"]
ignore: ["*.md"]
domains:
  - id: a
    name: A
    purpose: a
    cells:
      entry:    { paths: ["src/a/entry/**"] }
      logic:    { paths: ["src/a/logic/**"], tables: [ta] }
      external: { paths: ["openai", "vendor/x/**"] }
    tests: ["test/a/**"]
  - id: b
    name: B
    purpose: b
    cells:
      logic: { paths: ["src/b/**"] }
  - id: c
    name: C
    purpose: c
    cells:
      logic: { paths: ["src/c/**"], components: [{ id: core, name: Core, paths: ["src/c/core-*.ts"] }] }
`);

const sym = (file: string, name: string, parent: string | null = null): SymbolFact => ({
  id: `${file}#${name}`, file, name, kind: 'function', exported: true, parent: parent && `${file}#${parent}`, span: { start: 0, end: 0 }, sigHash: '', bodyHash: '',
});
const call = (from: string, to: string, confidence: CallFact['confidence'] = 'syntactic'): CallFact => ({ from, to, confidence, count: 1 });
const ff = (path: string, f: Partial<FileFacts> = {}): FileFacts => ({ path, hash: 'h', imports: [], writes: [], symbols: [], calls: [], routes: [], entries: [], ...f });
const imp = (...to: string[]) => to.map((t) => ({ to: t, typeOnly: false }));

function miniFacts(): Record<string, FileFacts> {
  const files = [
    ff('src/a/entry/api.ts', { imports: imp('src/a/logic/f1.ts'), routes: [{ id: 'route:GET /x', method: 'GET', path: '/x', file: 'src/a/entry/api.ts', handler: 'src/a/entry/api.ts#handler' }], symbols: [sym('src/a/entry/api.ts', 'handler')], calls: [call('src/a/entry/api.ts#handler', 'src/a/logic/f1.ts#run')] }),
    ff('src/a/logic/f1.ts', { imports: imp('src/b/g.ts', 'src/shared/util.ts', 'vendor:openai'), symbols: [sym('src/a/logic/f1.ts', 'run'), sym('src/a/logic/f1.ts', 'run.inner', 'run')], calls: [call('src/a/logic/f1.ts#run', 'src/b/g.ts#g'), call('src/a/logic/f1.ts#run', 'vendor:openai')], writes: [{ table: 'ta', symbol: 'src/a/logic/f1.ts#run', via: 'db' }] }),
    ff('src/a/logic/f2.ts', { imports: imp('src/b/h.ts', 'vendor:left-pad', 'README.md') }),
    ff('src/b/g.ts', { symbols: [sym('src/b/g.ts', 'g')], writes: [{ table: 'tz', symbol: null, via: 'db' }] }),
    ff('src/b/h.ts'),
    ff('src/c/core-1.ts', { imports: imp('src/a/logic/f1.ts') }),
    ff('src/c/other.ts'),
    ff('src/shared/util.ts', { imports: imp('src/b/g.ts') }),
    ff('test/a/f1.test.ts', { imports: imp('src/a/logic/f1.ts') }),
    ff('lib/stray.ts'),
  ];
  return Object.fromEntries(files.map((f) => [f.path, f]));
}

// The lane's exports implement the contract signatures (compile-time check).
export const contract: [BuildGraph, ActivityFor, Project, AutoExpand, Trace] = [buildGraph, activityFor, project, autoExpand, trace];

const view = (expanded: string[] = [], lens: Partial<ViewState['lens']> = {}): ViewState => ({ expanded, focus: null, lens: { kinds: [], turnOnly: false, ...lens }, budget: 50, follow: false });
const act = (leaves: Record<string, Partial<LeafActivity>>, extra: Partial<TurnActivity> = {}): TurnActivity => ({
  turn: 't', leaves: Object.fromEntries(Object.entries(leaves).map(([k, v]) => [k, { ...emptyLeaf(), ...v }])),
  plannedEdges: [], addedEdges: [], cursor: null, violations: { files: [], edges: [] }, ...extra,
});
const kidsOf = (g: ContextGraph, id: string) => g.children[id] ?? [];

describe('buildGraph', () => {
  const g = buildGraph(mini, miniFacts());

  it('builds one containment tree: domains in map order, cells in layer order, pseudo-domains last', () => {
    expect(kidsOf(g, 'repo')).toEqual(['domain:a', 'domain:b', 'domain:c', 'unassigned', 'neutral', VENDORS_ID]);
    expect(kidsOf(g, 'domain:a')).toEqual(['cell:a/entry', 'cell:a/logic', 'cell:a/external', testsId('a')]);
    expect(kidsOf(g, 'cell:a/logic')).toEqual(['src/a/logic/f1.ts', 'src/a/logic/f2.ts', 'table:ta']);
    expect(kidsOf(g, 'src/a/logic/f1.ts')).toEqual(['src/a/logic/f1.ts#run']);
    expect(kidsOf(g, 'src/a/logic/f1.ts#run')).toEqual(['src/a/logic/f1.ts#run.inner']);
    expect(g.nodes['src/a/logic/f1.ts#run.inner']).toMatchObject({ label: 'inner', domain: 'a', layer: 'logic' });
    expect(kidsOf(g, 'src/a/entry/api.ts')).toEqual(['src/a/entry/api.ts#handler', 'route:GET /x']);
    expect(kidsOf(g, testsId('a'))).toEqual(['test/a/f1.test.ts']);
    expect(kidsOf(g, 'neutral')).toEqual(['src/shared/util.ts']);
    expect(kidsOf(g, 'unassigned')).toEqual(['lib/stray.ts', 'table:tz']);
    expect(g.nodes['README.md']).toBeUndefined(); // ignored
    expect(g.nodes['cell:a/logic']!.order).toBe(1);
  });

  it('puts claimed vendors in the external cell, others under Vendors; groups confirmed components', () => {
    expect(g.nodes['vendor:openai']).toMatchObject({ parent: 'cell:a/external', kind: 'vendor' });
    expect(g.nodes['vendor:left-pad']).toMatchObject({ parent: VENDORS_ID });
    expect(kidsOf(g, 'cell:c/logic')).toEqual([groupId('c', 'logic', 'core'), 'src/c/other.ts']);
    expect(g.nodes[groupId('c', 'logic', 'core')]).toMatchObject({ label: 'Core', kind: 'group' });
  });

  it('builds leaf edges of every kind with stable ids', () => {
    const ids = g.edges.map((e) => e.id);
    // grouped by owner file in path order, sorted by id within an owner
    const owners = g.edges.map((e) => e.owner);
    expect(owners).toEqual([...owners].sort());
    for (const o of new Set(owners)) {
      const mine = g.edges.filter((e) => e.owner === o).map((e) => e.id);
      expect(mine).toEqual([...mine].sort());
    }
    for (const id of [
      edgeId('imports', 'src/a/logic/f1.ts', 'src/b/g.ts'),
      edgeId('uses', 'src/a/logic/f1.ts', 'vendor:openai'),
      edgeId('calls', 'src/a/logic/f1.ts#run', 'src/b/g.ts#g'),
      edgeId('calls', 'src/a/logic/f1.ts#run', 'vendor:openai'),
      edgeId('calls', 'src/a/entry/api.ts#handler', 'src/a/logic/f1.ts#run'),
      edgeId('handles', 'route:GET /x', 'src/a/entry/api.ts#handler'),
      edgeId('writes', 'src/a/logic/f1.ts#run', 'table:ta'),
      edgeId('writes', 'src/b/g.ts', 'table:tz'),
    ]) expect(ids).toContain(id);
    expect(ids.some((id) => id.includes('README'))).toBe(false);
    expect(buildGraph(mini, miniFacts())).toEqual(g); // deterministic
  });

  it('groups a crowded cell by directory, recursively', () => {
    const facts: Record<string, FileFacts> = {};
    for (let i = 0; i < 10; i++) facts[`src/b/one/f${i}.ts`] = ff(`src/b/one/f${i}.ts`);
    for (let i = 0; i < 3; i++) facts[`src/b/two/f${i}.ts`] = ff(`src/b/two/f${i}.ts`);
    facts['src/b/top.ts'] = ff('src/b/top.ts');
    const big = buildGraph(mini, facts);
    expect(kidsOf(big, 'cell:b/logic')).toEqual([groupId('b', 'logic', 'src/b/one'), groupId('b', 'logic', 'src/b/two'), 'src/b/top.ts']);
    expect(big.nodes[groupId('b', 'logic', 'src/b/one')]).toMatchObject({ label: 'one/', path: 'src/b/one', domain: 'b', layer: 'logic' });
    expect(kidsOf(big, groupId('b', 'logic', 'src/b/one'))).toHaveLength(10);
  });

  it('replaces syntactic calls with Tier 2 calls only when the hash matches', () => {
    const sem: SemanticFacts = { path: 'src/a/logic/f1.ts', hash: 'h', calls: [call('src/a/logic/f1.ts#run', 'src/b/g.ts#g', 'typed')], implements: [{ from: 'src/b/g.ts#g', to: 'src/a/logic/f1.ts#run' }] };
    const typed = buildGraph(mini, miniFacts(), { [sem.path]: sem });
    const calls = typed.edges.filter((e) => e.kind === 'calls' && e.owner === 'src/a/logic/f1.ts');
    expect(calls.map((e) => [e.to, e.confidence])).toEqual([['src/b/g.ts#g', 'typed']]);
    expect(typed.edges.some((e) => e.kind === 'implements')).toBe(true);
    const stale = buildGraph(mini, miniFacts(), { [sem.path]: { ...sem, hash: 'old' } });
    expect(stale.edges.filter((e) => e.kind === 'calls' && e.owner === 'src/a/logic/f1.ts').map((e) => e.confidence)).toEqual(['syntactic', 'syntactic']);
    expect(stale.edges.some((e) => e.kind === 'implements')).toBe(false);
  });

  it('graphOf adds leaves for planned and freshly created files the facts do not know yet', () => {
    const { events } = demoLog();
    const forkAsked = events.findIndex((e) => e.kind === 'fork_asked');
    const g2 = graphOf(reduce(events, forkAsked))!;
    expect(g2.nodes['src/tools/filing-summary.ts']).toMatchObject({ parent: 'cell:tools/logic' });
  });
});

describe('project', () => {
  const g = buildGraph(mini, miniFacts());

  it('shows the root children, plus children of expanded visible nodes only', () => {
    expect(project(g, view(), act({})).nodes.map((n) => n.id)).toEqual(kidsOf(g, 'repo'));
    const p = project(g, view(['domain:a', 'cell:a/logic', 'src/b/g.ts']), act({}));
    expect(p.nodes.map((n) => n.id)).toEqual([
      'domain:a', 'cell:a/entry', 'cell:a/logic', 'src/a/logic/f1.ts', 'src/a/logic/f2.ts', 'table:ta', 'cell:a/external', testsId('a'),
      'domain:b', 'domain:c', 'unassigned', 'neutral', VENDORS_ID,
    ]);
    const f1 = p.nodes.find((n) => n.id === 'src/a/logic/f1.ts')!;
    expect(f1).toMatchObject({ parent: 'cell:a/logic', depth: 2, expanded: false, expandable: true });
    expect(p.nodes.find((n) => n.id === 'domain:a')!.rollup.leaves).toBe(4);
  });

  it('rolls up: booleans OR, counts sum, severity MAX, files listed', () => {
    const a = act(
      {
        'src/a/logic/f1.ts': { violation: 'existing', added: 3, removed: 1, looked: true, audit: 1 },
        'src/a/logic/f2.ts': { violation: 'new', added: 2, cursor: true, proposal: 'move_out' },
        'src/a/entry/api.ts#handler': { edited: true },
        'src/b/g.ts': { violation: 'existing' },
      },
      { violations: { files: ['src/a/logic/f1.ts', 'src/b/g.ts'], edges: [] } },
    );
    const p = project(g, view(), a);
    const ra = p.nodes.find((n) => n.id === 'domain:a')!.rollup;
    expect(ra).toMatchObject({ looked: true, edited: true, added: 5, removed: 1, violation: 'new', cursor: true, audit: 1, proposal: 'move_out', violationFiles: ['src/a/logic/f1.ts'], newViolationFiles: ['src/a/logic/f2.ts'] });
    expect(p.nodes.find((n) => n.id === 'domain:b')!.rollup).toMatchObject({ violation: 'existing', violationFiles: ['src/b/g.ts'], edited: false });
    const open = project(g, view(['domain:a']), a);
    expect(open.nodes.find((n) => n.id === 'cell:a/logic')!.rollup.violation).toBe('new');
    expect(open.nodes.find((n) => n.id === 'cell:a/entry')!.rollup).toMatchObject({ edited: true, violation: null, cursor: false });
  });

  it('keeps ghost and unplanned at cell semantics at every depth', () => {
    const a = act({
      'src/a/logic/f1.ts': { planned: true, ghostSteps: [1] },
      'src/a/logic/f2.ts': { edited: true, unplanned: true },
      'src/a/entry/api.ts': { planned: true, ghostSteps: [2] },
      'src/b/g.ts': { edited: true, unplanned: true },
    });
    const top = project(g, view(), a);
    // a/logic has an edit, so its ghost is solid; a/entry is still a ghost; a/logic is planned, so f2 isn't amber here
    expect(top.nodes.find((n) => n.id === 'domain:a')!.rollup).toMatchObject({ ghostSteps: [2], unplanned: false });
    expect(top.nodes.find((n) => n.id === 'domain:b')!.rollup).toMatchObject({ unplanned: true });
    const deep = project(g, view(['domain:a', 'cell:a/logic']), a);
    const at = (id: string) => deep.nodes.find((n) => n.id === id)!.rollup;
    expect(at('cell:a/logic')).toMatchObject({ ghostSteps: [], unplanned: false, edited: true });
    expect(at('src/a/logic/f1.ts')).toMatchObject({ ghostSteps: [1] });
    expect(at('src/a/logic/f2.ts')).toMatchObject({ unplanned: true });
  });

  it('aggregates leaf edges by visible endpoints with kinds, counts, weakest confidence, status and violation', () => {
    const typed = buildGraph(mini, miniFacts(), { 'src/a/logic/f1.ts': { path: 'src/a/logic/f1.ts', hash: 'h', calls: [call('src/a/logic/f1.ts#run', 'src/b/g.ts#g', 'typed')], implements: [] } });
    const a = act({}, { addedEdges: [edgeId('imports', 'src/a/logic/f2.ts', 'src/b/h.ts')], violations: { files: [], edges: [edgeId('imports', 'src/a/logic/f1.ts', 'src/b/g.ts')] } });
    const ab = (p: ReturnType<typeof project>) => p.edges.find((e) => e.from === 'domain:a' && e.to === 'domain:b')!;
    const e = ab(project(typed, view(), a));
    expect(e).toMatchObject({ id: 'domain:a->domain:b', kinds: ['calls', 'imports'], count: 3, status: 'new', violation: 'existing', confidence: 'typed' });
    expect(e.leafEdges).toEqual([edgeId('calls', 'src/a/logic/f1.ts#run', 'src/b/g.ts#g'), edgeId('imports', 'src/a/logic/f1.ts', 'src/b/g.ts'), edgeId('imports', 'src/a/logic/f2.ts', 'src/b/h.ts')]);
    expect(ab(project(g, view(), act({}))).confidence).toBe('syntactic');
    // inside the same visible node: self-loop dropped; neutral never draws edges, even when expanded
    const p = project(g, view(['neutral']), act({}));
    expect(p.edges.some((x) => x.from === x.to)).toBe(false);
    expect(p.edges.some((x) => x.from === 'neutral' || x.to === 'neutral' || x.from === 'src/shared/util.ts' || x.to === 'src/shared/util.ts')).toBe(false);
    expect(p.edges.map((x) => x.id)).toEqual([...p.edges.map((x) => x.id)].sort());
  });

  it('keeps ghost edges in their own lane', () => {
    const a = act({}, { plannedEdges: [{ from: 'src/a/logic/f1.ts', to: 'src/b/h.ts', steps: [2], violation: 'new' }, { from: 'src/a/logic/f2.ts', to: 'src/b/g.ts', steps: [1], violation: null }] });
    const p = project(g, view(), a);
    const ab = p.edges.filter((e) => e.from === 'domain:a' && e.to === 'domain:b');
    expect(ab.map((e) => e.status).sort()).toEqual(['existing', 'ghost']);
    expect(ab.find((e) => e.status === 'ghost')).toMatchObject({ id: 'ghost:domain:a->domain:b', count: 2, steps: [1, 2], violation: 'new', kinds: ['imports'] });
    expect(project(g, view([], { kinds: ['calls'] }), a).edges.some((e) => e.status === 'ghost')).toBe(false);
  });

  it('filters edge kinds with the lens', () => {
    const p = project(g, view([], { kinds: ['calls'] }), act({}));
    expect(p.edges.every((e) => e.kinds.length === 1 && e.kinds[0] === 'calls')).toBe(true);
    // handler → run and run → vendor:openai stay inside domain a: self-loops at this depth
    expect(p.edges.map((e) => e.id)).toEqual(['domain:a->domain:b']);
    // f1#run → table:ta surfaces as f1 → ta once the cell is open; g.ts writes an unowned table (in Unassigned)
    const writes = project(g, view(['domain:a', 'cell:a/logic'], { kinds: ['writes'] }), act({}));
    expect(writes.edges.map((e) => e.id)).toEqual(['domain:b->unassigned', 'src/a/logic/f1.ts->table:ta']);
  });

  it('turn lens keeps only active nodes and their containers', () => {
    const a = act({ 'src/a/logic/f1.ts': { edited: true, added: 1 }, 'src/b/g.ts': { violation: 'existing' } });
    const p = project(g, view(['domain:a', 'domain:b'], { turnOnly: true }), a);
    expect(p.nodes.map((n) => n.id)).toEqual(['domain:a', 'cell:a/logic']);
    expect(p.edges).toEqual([]);
  });

  it('adds ports on every expanded container an edge crosses, with grid sides', () => {
    const p1 = project(g, view(['domain:a']), act({}));
    const e1 = p1.edges.find((e) => e.from === 'cell:a/logic' && e.to === 'domain:b')!;
    expect(p1.ports.filter((x) => x.edge === e1.id)).toEqual([{ container: 'domain:a', edge: e1.id, side: 'right', direction: 'out' }]);
    const back = p1.edges.find((e) => e.from === 'domain:c' && e.to === 'cell:a/logic')!;
    expect(p1.ports.filter((x) => x.edge === back.id)).toEqual([{ container: 'domain:a', edge: back.id, side: 'right', direction: 'in' }]);

    const p2 = project(g, view(['domain:a', 'domain:b', 'cell:a/logic', 'cell:b/logic']), act({}));
    const e2 = p2.edges.find((e) => e.from === 'src/a/logic/f1.ts' && e.to === 'src/b/g.ts')!;
    expect(p2.ports.filter((x) => x.edge === e2.id)).toEqual([
      { container: 'cell:a/logic', edge: e2.id, side: 'right', direction: 'out' },
      { container: 'domain:a', edge: e2.id, side: 'right', direction: 'out' },
      { container: 'cell:b/logic', edge: e2.id, side: 'left', direction: 'in' },
      { container: 'domain:b', edge: e2.id, side: 'left', direction: 'in' },
    ]);
    // within a column: rows → top/bottom (entry above logic; tests below every layer)
    const p3 = project(g, view(['domain:a', 'cell:a/entry', 'cell:a/logic']), act({}));
    const down = p3.edges.find((e) => e.from === 'src/a/entry/api.ts' && e.to === 'src/a/logic/f1.ts')!;
    expect(p3.ports.filter((x) => x.edge === down.id)).toEqual([
      { container: 'cell:a/entry', edge: down.id, side: 'bottom', direction: 'out' },
      { container: 'cell:a/logic', edge: down.id, side: 'top', direction: 'in' },
    ]);
    const up = p3.edges.find((e) => e.from === testsId('a') && e.to === 'src/a/logic/f1.ts')!;
    expect(p3.ports.filter((x) => x.edge === up.id)).toEqual([{ container: 'cell:a/logic', edge: up.id, side: 'bottom', direction: 'in' }]);
    // no ports when both endpoints are top-level
    expect(project(g, view(), act({})).ports).toEqual([]);
  });
});

describe('autoExpand', () => {
  const g = buildGraph(mini, miniFacts());
  const visibleCount = (expanded: string[]) => project(g, view(expanded), act({})).nodes.length;

  it('expands toward the cursor first, within the budget, deterministically', () => {
    const a = act({ 'src/a/logic/f1.ts': { cursor: true, looked: true }, 'src/b/h.ts': { edited: true } }, { cursor: 'src/a/logic/f1.ts' });
    const full = autoExpand(g, a, null, 50);
    expect(full.slice(0, 3)).toEqual(['domain:a', 'cell:a/logic', 'src/a/logic/f1.ts']);
    expect(full).toContain('domain:b');
    expect(full.some((id) => g.nodes[id]!.kind === 'symbol')).toBe(false);
    expect(autoExpand(g, a, null, 50)).toEqual(full);
    for (const budget of [6, 10, 12, 14, 20]) {
      const ex = autoExpand(g, a, null, budget);
      expect(visibleCount(ex)).toBeLessThanOrEqual(budget);
    }
    expect(autoExpand(g, a, null, 10)).toEqual(['domain:a']);
    expect(autoExpand(g, a, null, 5)).toEqual([]); // the root's children alone exceed it
  });

  it('opens the focus path even without activity, and prefers interest near the focus', () => {
    // the focus and its ancestors open; its children (the Core group) stay collapsed without interest of their own
    expect(autoExpand(g, act({}), 'cell:c/logic', 50)).toEqual(['domain:c', 'cell:c/logic']);
    const a = act({ 'src/a/logic/f2.ts': { looked: true }, 'src/b/h.ts': { looked: true } });
    expect(autoExpand(g, a, 'domain:b', 50)[0]).toBe('domain:b');
    expect(autoExpand(g, a, 'domain:a', 50)[0]).toBe('domain:a');
  });
});

describe('trace (Scout fixture)', () => {
  const map = loadMap();
  const facts = scoutFacts();
  facts['src/shared/types.ts'] = { ...facts['src/shared/types.ts']!, symbols: [
    { ...sym('src/shared/types.ts', 'Tool'), kind: 'type' },
    { ...sym('src/shared/types.ts', 'Tool.run', 'Tool'), kind: 'property' },
  ] };
  const typed = (path: string, calls: CallFact[], impl: { from: string; to: string }[] = []): SemanticFacts => ({ path, hash: 'fixture', calls, implements: impl });
  const asTyped = (path: string) => facts[path]!.calls.map((c) => ({ ...c, confidence: 'typed' as const }));
  // Tier 2: the agent dispatches through the registry's Tool.run; tools implement it; the provider picks a model.
  const semantic: Record<string, SemanticFacts> = {
    'src/orchestrator/agent.ts': typed('src/orchestrator/agent.ts', [call('src/orchestrator/agent.ts#runAgent', 'src/shared/types.ts#Tool.run', 'dispatch')]),
    'src/tools/news-summarize.ts': typed('src/tools/news-summarize.ts', asTyped('src/tools/news-summarize.ts'), [{ from: 'src/tools/news-summarize.ts#newsSummarize.run', to: 'src/shared/types.ts#Tool.run' }]),
    'src/tools/company-profile.ts': typed('src/tools/company-profile.ts', asTyped('src/tools/company-profile.ts'), [{ from: 'src/tools/company-profile.ts#companyProfile.run', to: 'src/shared/types.ts#Tool.run' }]),
    'src/gateway/providers.ts': typed('src/gateway/providers.ts', [
      call('src/gateway/providers.ts#provider', 'vendor/llm-openai/index.ts#call', 'typed'),
      call('src/gateway/providers.ts#provider', 'vendor/llm-anthropic/index.ts#call', 'typed'),
    ]),
  };
  const g = buildGraph(map, facts, semantic);
  const CHAT = 'vendor/llm-openai/index.ts#chat';

  it('reaches the OpenAI chat from the HTTP server only via news-summarize (through the tool registry)', () => {
    const paths = trace(g, 'src/channels/routes.ts#server', [CHAT]);
    expect(paths).toEqual([[
      'src/channels/routes.ts#server', 'src/orchestrator/agent.ts#runAgent', 'src/shared/types.ts#Tool.run',
      'src/tools/news-summarize.ts#newsSummarize.run', CHAT,
    ]]);
    expect(trace(g, 'route:POST /runs', [CHAT])[0]!.slice(0, 2)).toEqual(['route:POST /runs', 'src/channels/routes.ts#server']);
    // Tier 1 alone can't see through the registry
    expect(trace(buildGraph(map, facts), 'src/channels/routes.ts#server', [CHAT])).toEqual([]);
  });

  it('through complete() reaches the providers via providers.ts, and the cost table', () => {
    const paths = trace(g, 'src/gateway/complete.ts#complete');
    expect(paths).toContainEqual(['src/gateway/complete.ts#complete', 'src/gateway/providers.ts#provider', 'vendor/llm-openai/index.ts']);
    expect(paths).toContainEqual(['src/gateway/complete.ts#complete', 'src/gateway/providers.ts#provider', 'vendor/llm-anthropic/index.ts']);
    expect(paths.every((p) => !p.includes('src/tools/news-summarize.ts#newsSummarize.run'))).toBe(true);
    const viaProfile = trace(g, 'src/tools/company-profile.ts#companyProfile.run');
    expect(viaProfile.filter((p) => p.at(-1)!.startsWith('vendor/llm-')).every((p) => p.includes('src/gateway/providers.ts#provider'))).toBe(true);
  });

  it('is deterministic, shortest first, and capped at five paths', () => {
    const all = trace(g, 'src/channels/routes.ts#server');
    expect(all.length).toBeLessThanOrEqual(5);
    expect(all.map((p) => p.length)).toEqual([...all.map((p) => p.length)].sort((a, b) => a - b));
    expect(trace(g, 'src/channels/routes.ts#server')).toEqual(all);
    expect(trace(g, 'nope')).toEqual([]);
  });
});

describe('activityFor', () => {
  it('derives per-leaf activity from the demo turn', () => {
    const { events } = demoLog();
    const ui = reduce(events);
    const g = graphOf(ui)!;
    const a = activityFor(ui, g);
    expect(a.turn).toBe('t1');
    expect(a.leaves['src/tools/filing-summary.ts']).toMatchObject({ edited: true, created: true, added: 12, planned: true, ghostSteps: [], unplanned: false });
    expect(a.leaves['src/outreach/draft-email.ts']).toMatchObject({ edited: true, unplanned: true });
    expect(a.leaves['src/tools/news-summarize.ts']).toMatchObject({ looked: true, violation: 'existing' });
    expect(a.addedEdges).toEqual([edgeId('imports', 'src/tools/filing-summary.ts', 'src/gateway/complete.ts')]);
    expect(a.violations).toEqual({ files: ['src/tools/news-summarize.ts'], edges: [edgeId('imports', 'src/tools/news-summarize.ts', 'vendor/llm-openai/index.ts')] });
    expect(a.cursor).toBeNull(); // the turn ended

    const mid = reduce(events, events.findIndex((e) => e.kind === 'fork_asked') + 1);
    const am = activityFor(mid, graphOf(mid)!);
    expect(am.leaves['src/tools/filing-summary.ts']).toMatchObject({ ghostSteps: [1], planned: true, violation: 'new' });
    expect(am.leaves['src/tools/index.ts']).toMatchObject({ ghostSteps: [2] });
    expect(am.plannedEdges).toEqual([{ from: 'src/tools/filing-summary.ts', to: 'vendor/llm-openai/index.ts', steps: [1], violation: 'new' }]);
    expect(am.cursor).toBe('src/gateway/complete.ts');
    expect(am.leaves['src/gateway/complete.ts']!.cursor).toBe(true);
  });

  it('marks symbols from the edit diff, open findings and pending proposals', () => {
    const { events } = demoLog();
    const facts = scoutFacts();
    const extra = [
      { id: 'x1', t: 1, session: 's1', turn: 't2', kind: 'turn_started', data: { prompt: 'x', head: '', baseline: '' } },
      { id: 'x2', t: 2, session: 's1', turn: 't2', kind: 'facts_changed', path: 'src/gateway/complete.ts', data: { facts: facts['src/gateway/complete.ts'] } },
      { id: 'x3', t: 3, session: 's1', turn: 't2', kind: 'edited', path: 'src/gateway/complete.ts', cell: { domain: 'gateway', layer: 'logic' }, data: { added: 1, removed: 0, created: false, symbols: { added: [], removed: [], sig: [], body: ['src/gateway/complete.ts#complete'], renamed: [] } } },
      { id: 'x4', t: 4, session: 's1', turn: 't2', kind: 'audit_finding', data: { finding: { id: 'AF-1', decision: 'DR-4', files: ['src/gateway/complete.ts'], lines: [], text: 'x', confidence: 'high' } } },
      { id: 'x5', t: 5, session: 's1', turn: null, kind: 'map_proposed', data: { map: {}, yaml: '', proposal: { id: 'MP-1', trigger: [], scope: [], candidates: [], chosen: 0, current: {}, changes: [{ kind: 'move', path: 'src/gateway/redact.ts', from: { domain: 'gateway', layer: 'logic' }, to: { domain: 'memory', layer: 'logic' } }, { kind: 'remove_domain', domain: 'outreach' }], rationale: '' } } },
    ] as unknown as typeof events;
    const ui = reduce([...events, ...extra]);
    const g = graphOf(ui)!;
    const a = activityFor(ui, g);
    expect(a.leaves['src/gateway/complete.ts#complete']).toMatchObject({ edited: true, created: false, added: 0 });
    expect(a.leaves['src/gateway/complete.ts']).toMatchObject({ audit: 1, edited: true, added: 1 });
    expect(a.leaves['src/gateway/redact.ts']!.proposal).toBe('move_out');
    expect(a.leaves['src/outreach/send.ts']!.proposal).toBe('remove');
    const p = project(g, view(), a);
    expect(p.nodes.find((n) => n.id === domainId('gateway'))!.rollup).toMatchObject({ added: 1, audit: 1, proposal: 'move_out', edited: true });
    expect(p.nodes.find((n) => n.id === cellId('outreach', 'logic'))).toBeUndefined();
  });
});
