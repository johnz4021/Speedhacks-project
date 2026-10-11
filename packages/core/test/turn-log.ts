import { check } from '../src/rules';
import { createMapper } from '../src/mapper';
import { domainEdges, fileExistsIn, scanRepo, withExtra } from '../src/facts';
import { planFootprint, type PlanStep } from '../src/plan';
import type { EventData, EventKind, HarnessEvent } from '../src/events';
import { fixtureRepo, loadMap } from './helpers';

/** Builds a realistic event log for the demo turn from real core computations over the fixture repo. */
export function demoLog() {
  const map = loadMap();
  const mapper = createMapper(map);
  const facts = scanRepo(fixtureRepo, map);
  const events: HarnessEvent[] = [];
  let turn: string | null = null;
  let n = 0;
  const ev = <K extends EventKind>(kind: K, data: K extends keyof EventData ? EventData[K] : never, extra: Partial<HarnessEvent> = {}) => {
    events.push({ id: `e${n}`, t: 1000 + n++, session: 's1', turn, kind, data: data as Record<string, unknown>, ...extra });
    return events.length - 1;
  };
  const cell = (path: string) => {
    const p = mapper.place(path);
    return p.kind === 'cell' ? { domain: p.domain, layer: p.layer } : undefined;
  };
  const plan = (steps: PlanStep[]) => {
    const fp = planFootprint(map, steps, withExtra(fileExistsIn(fixtureRepo), steps.flatMap((s) => s.files)), mapper);
    ev('planned', { steps, cells: fp.cells, edges: fp.edges, unassigned: fp.unassigned });
    for (const v of fp.violations) ev('plan_violation', { violation: v }, { path: v.file });
    return fp.violations;
  };
  const tenK = (model: string): PlanStep[] => [
    { n: 1, text: 'Add the 10-K tool', files: ['src/tools/filing-summary.ts'], imports: [{ from: 'src/tools/filing-summary.ts', to: model }] },
    { n: 2, text: 'Register it', files: ['src/tools/index.ts'], imports: [] },
  ];

  ev('map_confirmed', { map, source: 'file' });
  ev('repo_scanned', { files: facts.files.map((path) => ({ path, placement: mapper.place(path) })), imports: facts.imports, writes: facts.writes, edges: domainEdges(facts, mapper) });
  ev('violation_found', { violations: check(map, facts, mapper) });

  turn = 't1';
  ev('turn_started', { prompt: "Add a tool that summarizes a prospect's latest 10-K", head: 'abc', baseline: 'abc' });
  ev('looked', { tool: 'Read' }, { path: 'src/tools/news-summarize.ts', cell: cell('src/tools/news-summarize.ts') });
  ev('looked', { tool: 'Read' }, { path: 'src/gateway/complete.ts', cell: cell('src/gateway/complete.ts') });
  const violations = plan(tenK('vendor/llm-openai/index'));
  ev('fork_asked', { violations, text: 'A or B?' });
  ev('fork_answered', { option: 'A', text: 'A, through the gateway', violations });
  ev('decision_recorded', { id: 'DR-4', title: 'Filings go through the gateway', invariant: 'DR-1', option: 'A', paths: ['src/tools/filing-summary.ts'] });
  plan(tenK('src/gateway/complete'));
  ev('approval_requested', { plan: '1. add tool 2. register' });
  ev('plan_approved', {} as never);
  ev('file_assigned', { placement: mapper.place('src/tools/filing-summary.ts') }, { path: 'src/tools/filing-summary.ts' });
  const firstEdit = ev('edited', { added: 12, removed: 0, created: true }, { path: 'src/tools/filing-summary.ts', cell: { domain: 'tools', layer: 'logic' } });
  ev('edge_added', { edge: { from: 'src/tools/filing-summary.ts', to: 'src/gateway/complete.ts' }, from: 'tools', to: 'gateway' }, { path: 'src/tools/filing-summary.ts' });
  ev('edited', { added: 2, removed: 0, created: false }, { path: 'src/tools/index.ts', cell: { domain: 'tools', layer: 'logic' } });
  ev('edited', { added: 3, removed: 1, created: false }, { path: 'src/outreach/draft-email.ts', cell: { domain: 'outreach', layer: 'logic' } });
  ev('turn_ended', { added: 17, removed: 1, files: ['src/tools/filing-summary.ts', 'src/tools/index.ts', 'src/outreach/draft-email.ts'], reason: 'success' });
  turn = null;
  return { map, events, firstEdit };
}
