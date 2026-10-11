import { describe, expect, it } from 'vitest';
import { reduce, type HarnessEvent } from '../src/events';
import { ledger, turnFindings } from '../src/ledger';
import type { Violation } from '../src/rules';
import { demoLog } from './turn-log';

describe('ledger (SPEC §9)', () => {
  it('counts the demo turn exactly', () => {
    const { events } = demoLog();
    const l = ledger(reduce(events));
    expect(l.turns).toHaveLength(1);
    expect(l.turns[0]).toMatchObject({ linesChanged: 18, forksCaughtBeforeCode: 1, rejectedOptionsBlocked: 0 });
    // invariant hit (tools/logic) · unplanned edit (outreach/logic); the tools→gateway edge already existed
    // at domain level but is new this turn, and lands in tools/logic too.
    expect(l.turns[0]!.cellsToReview).toBe(2);
    expect(l.session).toEqual({ linesChanged: 18, cellsToReview: 2, forksCaughtBeforeCode: 1, rejectedOptionsBlocked: 0 });
  });

  it('ranks findings loudest first', () => {
    const { events } = demoLog();
    const s = reduce(events);
    const f = turnFindings(s, s.turns[0]!);
    expect(f.map((x) => x.severity)).toEqual([...f.map((x) => x.severity)].sort());
    expect(f[0]).toMatchObject({ severity: 1, kind: 'invariant', invariant: 'DR-1' });
    expect(f.some((x) => x.kind === 'unplanned' && x.cell?.domain === 'outreach')).toBe(true);
  });

  it('lines changed is null until the turn ends', () => {
    const { events } = demoLog();
    const l = ledger(reduce(events, events.length - 1));
    expect(l.turns[0]!.linesChanged).toBeNull();
    expect(l.session.linesChanged).toBe(0);
  });

  it('does not count a fork answered after code was written', () => {
    const { events, firstEdit } = demoLog();
    // Move the fork question and answer after the first edit.
    const fork = events.filter((e) => e.kind === 'fork_asked' || e.kind === 'fork_answered');
    const rest = events.filter((e) => !fork.includes(e));
    const at = rest.findIndex((e) => e === events[firstEdit]) + 1;
    const reordered: HarnessEvent[] = [...rest.slice(0, at), ...fork, ...rest.slice(at)];
    expect(ledger(reduce(reordered)).turns[0]!.forksCaughtBeforeCode).toBe(0);
  });

  it('counts violations that cite an existing decision as rejected options blocked', () => {
    const { events } = demoLog();
    const v: Violation = { invariant: 'DR-1', kind: 'only_via', reason: 'You decided this in DR-4. …', file: 'src/tools/earnings.ts', detail: '', options: ['A', 'B'], target: 'vendor/llm-openai/index.ts', decision: 'DR-4' };
    const t2: HarnessEvent[] = [
      { id: 'x1', t: 1, session: 's1', turn: 't2', kind: 'turn_started', data: { prompt: 'earnings calls', head: '', baseline: '' } },
      { id: 'x2', t: 2, session: 's1', turn: 't2', kind: 'gate_blocked', path: v.file, data: { violation: v, tool: 'Write' } },
      { id: 'x3', t: 3, session: 's1', turn: 't2', kind: 'gate_blocked', path: v.file, data: { violation: v, tool: 'Write' } },
      { id: 'x4', t: 4, session: 's1', turn: 't2', kind: 'turn_ended', data: { added: 0, removed: 0, files: [], reason: 'success' } },
    ];
    const l = ledger(reduce([...events, ...t2]));
    expect(l.turns[1]).toMatchObject({ rejectedOptionsBlocked: 1, linesChanged: 0, forksCaughtBeforeCode: 0 });
    expect(l.session.rejectedOptionsBlocked).toBe(1);
  });
});

describe('ledger: avoided approaches', () => {
  it('counts a plan that avoids a decided-against approach as a rejected option blocked', () => {
    const { events } = demoLog();
    const t3: HarnessEvent[] = [
      { id: 'y1', t: 1, session: 's2', turn: 't3', kind: 'turn_started', data: { prompt: 'opener from past emails', head: '', baseline: '' } },
      { id: 'y2', t: 2, session: 's2', turn: 't3', kind: 'planned', data: { steps: [], cells: [], edges: [], unassigned: [],
        avoided: [{ from: 'domain:tools', to: 'domain:outreach', decision: 'DR-4', reason: 'research tools never read outreach data' }] } },
      { id: 'y3', t: 3, session: 's2', turn: 't3', kind: 'turn_ended', data: { added: 0, removed: 0, files: [], reason: 'success' } },
    ];
    const l = ledger(reduce([...events, ...t3]));
    expect(l.turns.at(-1)!.rejectedOptionsBlocked).toBe(1);
  });
});

describe('ledger: a recorded live run of the earlier outreach storyline (beats 3 and 4; real Claude, fresh Scout copy)', () => {
  // packages/core/test/fixtures/beats-3-4.events.json: beat 3 forks on DR-3 and records DR-4; beat 4, in a new session,
  // plans the decided way and lists the research tool as avoided per DR-4.
  it('counts one fork caught before code and one rejected option blocked, and draws the rejected edge', async () => {
    const { readFileSync } = await import('node:fs');
    const { graphOf, activityFor, project } = await import('../src/graph');
    const events = JSON.parse(readFileSync(new URL('./fixtures/beats-3-4.events.json', import.meta.url), 'utf8')) as HarnessEvent[];
    const ui = reduce(events);
    const l = ledger(ui);
    expect(ui.sessions).toHaveLength(2);
    expect(l.turns.map((t) => [t.forksCaughtBeforeCode, t.rejectedOptionsBlocked])).toEqual([[1, 0], [0, 1]]);
    expect(l.session).toMatchObject({ forksCaughtBeforeCode: 1, rejectedOptionsBlocked: 1 });
    const g = graphOf(ui)!;
    const p = project(g, { expanded: [], focus: null, lens: { kinds: [], turnOnly: false }, budget: 25, follow: false }, activityFor(ui, g, ui.turns.at(-1)!.id));
    expect(p.edges.filter((e) => e.decision).map((e) => [e.from, e.to, e.decision!.id, e.decision!.session])).toEqual([['domain:tools', 'domain:outreach', 'DR-4', 1]]);
  });
});
