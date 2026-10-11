import { describe, expect, it } from 'vitest';
import { apply, cellViews, edgeViews, initialState, provenance, reduce } from '../src/events';
import { demoLog } from './turn-log';

describe('reduce', () => {
  const { events, firstEdit } = demoLog();
  const s = reduce(events);

  it('is a pure fold: incremental apply equals reduce', () => {
    const inc = initialState();
    events.forEach((e, i) => apply(inc, e, i));
    expect(JSON.parse(JSON.stringify(inc))).toEqual(JSON.parse(JSON.stringify(reduce(events))));
  });

  it('carries the load-time violation as existing and the map edges', () => {
    expect(s.violations).toHaveLength(1);
    expect(s.violations[0]!.file).toBe('src/tools/news-summarize.ts');
    expect(s.edges['tools->gateway']).toBeDefined();
  });

  it('replays: before the fork answer the plan ghost is red and new, after the turn it is solid', () => {
    const forkAsked = events.findIndex((e) => e.kind === 'fork_asked');
    const mid = reduce(events, forkAsked + 1);
    expect(mid.pendingFork?.violations[0]?.invariant).toBe('DR-1');
    const tools = cellViews(mid)['tools/logic']!;
    expect(tools.ghost).toEqual([1, 2]);
    expect(tools.violation).toBe('new'); // differs from the map before the turn even though the cell was already red
    expect(tools.newViolationFiles).toEqual(['src/tools/filing-summary.ts']);
    const ghost = edgeViews(mid).find((e) => e.state === 'ghost');
    expect(ghost).toMatchObject({ from: 'tools', to: 'gateway', violation: true });
    expect(edgeViews(mid).some((e) => e.state === 'existing' && e.from === 'tools' && e.to === 'gateway')).toBe(true);

    const end = cellViews(s);
    expect(end['tools/logic']).toMatchObject({ edited: true, ghost: null, added: 14 });
    expect(end['outreach/logic']).toMatchObject({ unplanned: true });
    expect(end['gateway/logic']).toMatchObject({ looked: true, edited: false });
    expect(reduce(events, firstEdit).turns[0]!.approved).toBe(true);
  });

  it('records the decision and provenance', () => {
    expect(s.decisions.map((d) => d.id)).toEqual(['DR-4']);
    const p = provenance(s, { edge: 'tools->gateway' });
    expect(p.turns.map((t) => t.index)).toEqual([1]);
    expect(p.decisions.map((d) => d.id)).toEqual(['DR-4']);
  });
});
