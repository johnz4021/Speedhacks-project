// Parity (NAVIGATION_PLAN §3.2, N2): project() agrees with today's cellViews/edgeViews on every prefix of the log.
//
// Today's views are cell granularity (domain × layer); the projection's root children are domains. So parity is
// defined at "domains expanded one level": view.expanded = every domain id, lens.kinds = ['imports'].
// - Cells: each visible `cell:` node's rollup equals the cellView (looked, edited, added, removed, ghost steps,
//   unplanned, violation, violationFiles, newViolationFiles) and the two sets of cells are identical.
// - Edges: the visible cell→cell edges whose cells are in different domains, grouped by domain pair, equal
//   edgeViews: the same solid pairs with the same state (new/existing), violation flag and file imports, and the same
//   ghost pairs with the same violation flag, steps and planned imports (ghosts never merge with solid edges).
import { describe, expect, it } from 'vitest';
import { cellKey, cellViews, edgeViews, reduce, type HarnessEvent, type UIState } from '../src/events';
import { activityFor, graphOf, project } from '../src/graph';
import { domainId, type Projection, type ViewState } from '../src/contracts/graph';
import type { Violation } from '../src/rules';
import { demoLog } from './turn-log';

/** A second turn exercising tests, unassigned and neutral files, an unplanned file inside a planned cell, an unplanned
 *  cell, a gate block on a file that already violates another rule, and an edge added and one removed. */
function secondTurn(): HarnessEvent[] {
  let n = 0;
  const ev = (kind: HarnessEvent['kind'], data: Record<string, unknown>, extra: Partial<HarnessEvent> = {}): HarnessEvent =>
    ({ id: `t2-${n}`, t: 2000 + n++, session: 's1', turn: 't2', kind, data, ...extra });
  const block: Violation = {
    invariant: 'DR-3', kind: 'no_edge', reason: 'tools never depend on outreach', file: 'src/tools/news-summarize.ts',
    detail: '', options: ['A', 'B'], target: 'src/outreach/send.ts',
  };
  return [
    ev('turn_started', { prompt: 'memory tweaks', head: '', baseline: '' }),
    ev('looked', { tool: 'Read' }, { path: 'src/shared/db.ts' }),
    ev('planned', {
      steps: [{ n: 1, text: 'retrieve', files: ['src/memory/retrieve.ts'], imports: [{ from: 'src/memory/retrieve.ts', to: 'src/outreach/send.ts' }] }],
      cells: [{ domain: 'memory', layer: 'logic', steps: [1], files: ['src/memory/retrieve.ts'] }],
      edges: [{ from: 'memory', to: 'outreach', steps: [1], imports: [{ from: 'src/memory/retrieve.ts', to: 'src/outreach/send.ts' }] }],
      unassigned: [],
    }),
    ev('edited', { added: 4, removed: 2, created: false }, { path: 'src/memory/vector-index.ts', cell: { domain: 'memory', layer: 'logic' } }),
    ev('edited', { added: 5, removed: 0, created: false }, { path: 'test/memory/retrieve.test.ts' }),
    ev('edited', { added: 7, removed: 0, created: true }, { path: 'src/misc/foo.ts' }),
    ev('gate_blocked', { violation: block, tool: 'Edit' }, { path: block.file }),
    ev('edited', { added: 1, removed: 1, created: false }, { path: 'src/gateway/redact.ts', cell: { domain: 'gateway', layer: 'logic' } }),
    ev('edited', { added: 2, removed: 0, created: false }, { path: 'src/memory/retrieve.ts', cell: { domain: 'memory', layer: 'logic' } }),
    ev('edge_added', { edge: { from: 'src/memory/retrieve.ts', to: 'src/outreach/send.ts' }, from: 'memory', to: 'outreach' }, { path: 'src/memory/retrieve.ts' }),
    ev('edge_removed', { edge: { from: 'src/tools/company-profile.ts', to: 'src/gateway/complete.ts' }, from: 'tools', to: 'gateway' }),
    ev('turn_ended', { added: 19, removed: 3, files: [], reason: 'success' }),
  ];
}

const parityView = (ui: UIState): ViewState => ({
  expanded: ui.map!.domains.map((d) => domainId(d.id)),
  focus: null,
  lens: { kinds: ['imports'], turnOnly: false },
  budget: 50,
  follow: false,
});

const sorted = <T>(xs: T[]) => [...xs].sort();

function cellsOf(p: Projection) {
  const out: Record<string, unknown> = {};
  for (const n of p.nodes) {
    if (n.kind !== 'cell') continue;
    const r = n.rollup;
    out[`${n.domain}/${n.layer}`] = {
      looked: r.looked, edited: r.edited, added: r.added, removed: r.removed, ghost: r.ghostSteps, unplanned: r.unplanned,
      violation: r.violation, violationFiles: r.violationFiles, newViolationFiles: r.newViolationFiles,
    };
  }
  return out;
}

function domainEdgesOf(p: Projection) {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const out = new Map<string, { from: string; to: string; state: string; violation: boolean; steps: number[]; files: string[] }>();
  for (const e of p.edges) {
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    if (a.kind !== 'cell' || b.kind !== 'cell' || a.domain === b.domain) continue;
    const ghost = e.status === 'ghost';
    const k = `${ghost ? 'ghost' : 'solid'}:${a.domain}->${b.domain}`;
    const cur = out.get(k) ?? { from: a.domain!, to: b.domain!, state: ghost ? 'ghost' : 'existing', violation: false, steps: [], files: [] };
    if (e.status === 'new') cur.state = 'new';
    cur.violation ||= e.violation !== null;
    cur.steps = sorted([...new Set([...cur.steps, ...e.steps])]);
    cur.files.push(...e.leafEdges.map((id) => id.split('|').slice(1).join(' -> ')));
    out.set(k, cur);
  }
  return [...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => ({ ...v, files: sorted(v.files) }));
}

function expectParity(ui: UIState, turnId?: string | null) {
  const graph = graphOf(ui)!;
  const p = project(graph, parityView(ui), activityFor(ui, graph, turnId));

  const cv = cellViews(ui, turnId);
  const want: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cv)) {
    want[k] = {
      looked: v.looked, edited: v.edited, added: v.added, removed: v.removed, ghost: v.ghost ?? [], unplanned: v.unplanned,
      violation: v.violation, violationFiles: sorted(v.violationFiles), newViolationFiles: sorted(v.newViolationFiles),
    };
  }
  expect(cellsOf(p)).toEqual(want);

  const ev = edgeViews(ui, turnId)
    .map((e) => ({
      key: `${e.state === 'ghost' ? 'ghost' : 'solid'}:${e.from}->${e.to}`,
      v: { from: e.from, to: e.to, state: e.state, violation: e.violation, steps: sorted(e.steps), files: sorted(e.files.map((f) => `${f.from} -> ${f.to}`)) },
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((x) => x.v);
  expect(domainEdgesOf(p)).toEqual(ev);
}

describe('parity: project() at domains-expanded == cellViews/edgeViews', () => {
  const { events } = demoLog();
  const full = [...events, ...secondTurn()];

  it('holds on every prefix of the demo log', () => {
    let checked = 0;
    for (let i = 0; i <= events.length; i++) {
      const ui = reduce(events, i);
      if (!ui.map) continue;
      expectParity(ui);
      checked++;
    }
    expect(checked).toBe(events.length);
  });

  it('holds on every prefix of the demo log plus a second turn, for each selected turn', () => {
    for (let i = 1; i <= full.length; i++) {
      const ui = reduce(full, i);
      if (!ui.map) continue;
      expectParity(ui);
      for (const t of ui.turns) expectParity(ui, t.id);
      expectParity(ui, null);
    }
  });

  it('is not vacuous: the demo states show up in the projection', () => {
    const forkAsked = events.findIndex((e) => e.kind === 'fork_asked');
    const mid = reduce(events, forkAsked + 1);
    const g = graphOf(mid)!;
    const p = project(g, parityView(mid), activityFor(mid, g));
    const tools = p.nodes.find((n) => n.id === 'cell:tools/logic')!.rollup;
    expect(tools).toMatchObject({ ghostSteps: [1, 2], violation: 'new', newViolationFiles: ['src/tools/filing-summary.ts'], violationFiles: ['src/tools/news-summarize.ts'] });
    expect(p.edges.filter((e) => e.status === 'ghost').map((e) => [e.from, e.to, e.violation])).toEqual([['cell:tools/logic', 'cell:gateway/external', 'new']]);

    const end = reduce(full);
    const g2 = graphOf(end)!;
    const p2 = project(g2, parityView(end), activityFor(end, g2));
    const cells = cellsOf(p2) as Record<string, { unplanned: boolean; edited: boolean; violation: string | null; newViolationFiles: string[]; violationFiles: string[] }>;
    expect(cells['memory/logic']).toMatchObject({ edited: true, unplanned: false });
    expect(cells['gateway/logic']).toMatchObject({ edited: true, unplanned: true });
    expect(cells['tools/logic']).toMatchObject({ violation: 'new', violationFiles: ['src/tools/news-summarize.ts'], newViolationFiles: ['src/tools/news-summarize.ts'] });
    expect(p2.edges.some((e) => e.from === 'cell:memory/logic' && e.to === 'cell:outreach/logic' && e.status === 'new')).toBe(true);
    // Outside cells: the test edit sits on tests:memory, the unassigned file on `unassigned`, nothing on neutral.
    const byId = new Map(p2.nodes.map((n) => [n.id, n.rollup]));
    expect(byId.get('tests:memory')).toMatchObject({ edited: true, added: 5 });
    expect(byId.get('unassigned')).toMatchObject({ edited: true, added: 7, unplanned: true });
    expect(byId.get('neutral')).toMatchObject({ looked: true, edited: false });
    expect(cellKey({ domain: 'memory', layer: 'logic' })).toBe('memory/logic');
  });
});
