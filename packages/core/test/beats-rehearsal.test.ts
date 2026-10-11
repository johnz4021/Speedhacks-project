// A recorded live run of beats 3 → 4 → 4b (wave 3; real Claude Opus 5.5, fresh Scout copy, Alike off), one server
// session per beat: packages/core/test/fixtures/beats-3-4-4b.events.json (Tier 2 `facts_resolved` events dropped).
// Beat 3 built the 10-K tool through the gateway without forking (Opus never took the shortcut in 3 tries), so DR-4
// was recorded on that real turn by the server's own recordFork + recordProtects (option A, the scripted answer).
// Beat 4's plan and edits touched what DR-4 protects and kept filing mode; beat 4b avoided the direct call per DR-4.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { reduce, type HarnessEvent, type TurnState } from '../src/events';
import { ledger } from '../src/ledger';
import { activityFor, graphOf, project } from '../src/graph';

const events = JSON.parse(readFileSync(new URL('./fixtures/beats-3-4-4b.events.json', import.meta.url), 'utf8')) as HarnessEvent[];
const ui = reduce(events);
const [beat3, beat4, beat4b] = ui.turns;

describe('recorded beats 3 → 4 → 4b', () => {
  it('three sessions, one turn each; DR-4 made in session 1 protects the filing mode and its tests', () => {
    expect(ui.sessions).toHaveLength(3);
    expect(ui.turns.map((t) => t.prompt.slice(0, 32))).toEqual(['Can we add a tool that summarize', "We're seeing account numbers in ", 'Can we add a tool that summarize']);
    expect(ui.decisions).toHaveLength(1);
    expect(ui.decisions[0]).toMatchObject({
      id: 'DR-4', invariant: 'DR-1', option: 'A', turn: beat3!.id, paths: ['src/tools/filing-summarize.ts'],
      protects: { paths: ['src/gateway/redact.ts', 'test/gateway/redact.test.ts', 'test/tools/tools.test.ts'], symbols: ['src/gateway/redact.ts#Redactor', 'src/gateway/redact.ts#Redactor.redact'] },
    });
    expect(ui.sessions.indexOf(ui.decisions[0]!.session)).toBe(0);
  });

  it('beat 4: the plan touched DR-4 (redact.ts, then the tests) and so did the edits; no violation, no fork', () => {
    const key = (t: TurnState['touched'][number]) => [t.decision, t.source, t.step ?? null, t.paths.join(','), t.symbols.length];
    expect(beat4!.touched.map(key)).toEqual([
      ['DR-4', 'plan', 1, 'src/gateway/redact.ts', 2],
      ['DR-4', 'plan', 4, 'test/gateway/redact.test.ts,test/tools/tools.test.ts', 0],
      ['DR-4', 'edit', null, 'src/gateway/redact.ts', 2],
      ['DR-4', 'edit', null, 'test/gateway/redact.test.ts', 0],
      ['DR-4', 'edit', null, 'test/tools/tools.test.ts', 0],
    ]);
    expect(beat4!.violationsSeen).toHaveLength(0);
    expect(beat4!.forks).toHaveLength(0);
    // The build kept filing mode: the 10-K tool now asks the gateway for it.
    expect(Object.keys(beat4!.paths).filter((p) => beat4!.paths[p]!.edits)).toEqual(expect.arrayContaining(['src/gateway/redact.ts', 'src/gateway/complete.ts', 'src/tools/filing-summarize.ts']));
  });

  it('beat 4b: the plan avoids the direct provider call per DR-4, drawn as a rejected edge (session 1); nothing calls the provider', () => {
    expect(beat4b!.avoided).toEqual([expect.objectContaining({ from: 'src/tools/earnings-summarize.ts', to: 'vendor/llm-anthropic/index.ts', decision: 'DR-4' })]);
    expect(beat4b!.edgesAdded.map((e) => `${e.edge.from}→${e.edge.to}`)).toEqual(['src/tools/earnings-summarize.ts→src/gateway/complete.ts']);
    const g = graphOf(ui)!;
    const p = project(g, { expanded: [], focus: null, lens: { kinds: [], turnOnly: false }, budget: 25, follow: false }, activityFor(ui, g, beat4b!.id));
    expect(p.edges.filter((e) => e.decision).map((e) => [e.from, e.to, e.status, e.decision!.id, e.decision!.session])).toEqual([['domain:tools', 'domain:gateway', 'ghost', 'DR-4', 1]]);
  });

  it('ledger: exact counts per turn and for the session', () => {
    const l = ledger(ui);
    expect(l.turns.map((t) => [t.linesChanged, t.cellsToReview, t.forksCaughtBeforeCode, t.rejectedOptionsBlocked])).toEqual([[72, 1, 0, 0], [77, 0, 0, 0], [67, 1, 0, 1]]);
    expect(l.session).toEqual({ linesChanged: 216, cellsToReview: 2, forksCaughtBeforeCode: 0, rejectedOptionsBlocked: 1 });
  });
});
