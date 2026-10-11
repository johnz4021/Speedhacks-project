// Beat 4 (DEMO_PLAN): a violation of an invariant that already has a decision is not a fork. submit_plan and the
// edit gate tell Claude what was decided; the session never asks the user again. Plus submit_plan's `avoided`.
import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Bus } from '../../../apps/server/src/bus';
import { Repo } from '../../../apps/server/src/repo';
import { Session } from '../../../apps/server/src/session';
import { submitPlan, type PlanHooks } from '../../../apps/server/src/harness-tools';
import type { EventData, HarnessEvent } from '../src/events';
import { linkDecision } from '../src/mapedit';
import type { Violation } from '../src/rules';
import { fixtureRepo, mapYaml } from './helpers';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const DR4 = `---
id: DR-4
title: Research tools never read outreach data; the run loop passes it in
outcome: Keep research tools out of outreach data, and have the run loop pass outreach context in
status: made
type: standing
invariant: DR-3
anchors:
  paths:
    - src/tools/outreach-history.ts
rejected: Add an exception for this tool
---

The user chose A.
`;

function setup() {
  const root = realpathSync(mkdtempSync(join(process.env.HARNESS_TEST_TMP ?? tmpdir(), 'harness-dr-')));
  dirs.push(root);
  cpSync(fixtureRepo, root, { recursive: true });
  writeFileSync(join(root, 'domains.yaml'), linkDecision(mapYaml, 'DR-3', 'DR-4'));
  mkdirSync(join(root, 'decisions'));
  writeFileSync(join(root, 'decisions/DR-4.md'), DR4);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const bus = new Bus(root, { fresh: true });
  const repo = new Repo(root, bus);
  repo.loadMapFile();
  repo.scan();
  const planned: { violations: Violation[] }[] = [];
  const hooks: PlanHooks = { onPlan: (_s, violations) => planned.push({ violations }), takeNotes: () => [] };
  const of = <K extends keyof EventData>(kind: K) => bus.events.filter((e): e is HarnessEvent & { data: EventData[K] } => e.kind === kind).map((e) => e.data);
  return { root, bus, repo, hooks, planned, of };
}

// A new research tool importing outreach: DR-3 (tools never depend on outreach), already decided in DR-4.
const TOOL_PLAN = {
  steps: [{ n: 1, text: 'Add the tool', files: ['src/tools/outreach-history.ts'], imports: [{ from: 'src/tools/outreach-history.ts', to: 'src/outreach/outreach-log.ts' }] }],
};

describe('decision-backed violations (beat 4)', () => {
  it('submit_plan says it is already decided and not to ask; undecided ones still ask A or B', () => {
    const { repo, bus, hooks, planned } = setup();
    const out = submitPlan(repo, bus, hooks, TOOL_PLAN);
    expect(planned[0]!.violations.map((v) => `${v.invariant} ${v.decision}`)).toEqual(['DR-3 DR-4']);
    expect(out).toContain('ALREADY DECIDED (1):');
    expect(out).toContain('Already decided in DR-4 (Research tools never read outreach data; the run loop passes it in): Keep research tools out of outreach data, and have the run loop pass outreach context in. Plan it the decided way and resubmit; do not ask the user.');
    expect(out).not.toContain('Stop and ask the user');

    const undecided = submitPlan(repo, bus, hooks, {
      steps: [{ n: 1, text: 'x', files: ['src/tools/x.ts'], imports: [{ from: 'src/tools/x.ts', to: 'vendor/llm-openai/index.ts' }] }],
    });
    expect(undecided).toContain('VIOLATIONS (1):');
    expect(undecided).toContain('Stop and ask the user');
    expect(undecided).not.toContain('ALREADY DECIDED');
  });

  it('the session never opens a fork for them, and the gate\'s deny reason cites the decision', async () => {
    const { root, repo, bus, of } = setup();
    const session = new Session(repo, bus, () => {});
    type Inner = { turn: { planViolations: Violation[]; gateBlocks: Violation[] } | null; onResult(s: string): void; gate: (i: unknown, id: undefined, o: { signal: AbortSignal }) => Promise<{ hookSpecificOutput?: { permissionDecisionReason?: string } }> };
    const s = session as unknown as Inner;
    session.userMessage('Can we build a research tool that reads our past emails?');

    const res = await s.gate({ tool_name: 'Write', tool_input: { file_path: join(root, 'src/tools/opener.ts'), content: 'import { recentOutreach } from "../outreach/outreach-log";\nexport const x = recentOutreach;\n' } }, undefined, { signal: new AbortController().signal });
    const reason = res.hookSpecificOutput!.permissionDecisionReason!;
    expect(reason).toContain('You decided this in DR-4.');
    expect(reason).toContain('Already decided in DR-4');
    expect(reason).not.toContain('Stop and ask the user');
    expect(of('gate_blocked')).toHaveLength(1);

    s.onResult('success');
    expect(of('fork_asked')).toHaveLength(0);
    expect(of('turn_ended')).toHaveLength(1);
  });

  it('an undecided violation still forks', () => {
    const { repo, bus, of } = setup();
    const session = new Session(repo, bus, () => {});
    const s = session as unknown as { turn: { planViolations: Violation[] } | null; onResult(s: string): void };
    session.userMessage('Call OpenAI from a tool');
    s.turn!.planViolations = [{ invariant: 'DR-1', kind: 'only_via', reason: 'r', file: 'src/tools/x.ts', detail: 'd', options: ['a', 'b'] }];
    s.onResult('success');
    expect(of('fork_asked')).toHaveLength(1);
  });
});

describe('submit_plan avoided', () => {
  it('records avoided approaches that cite a known decision, and drops unknown ones with a note', () => {
    const { repo, bus, hooks, of } = setup();
    const out = submitPlan(repo, bus, hooks, {
      steps: [{ n: 1, text: 'Pass past emails into the draft', files: ['src/orchestrator/agent.ts', 'src/outreach/draft-email.ts'], imports: [] }],
      avoided: [
        { from: './src/tools/opener.ts', to: 'domain:outreach', decision: 'DR-4', reason: 'Research tools never read outreach data' },
        { from: 'domain:tools', to: 'domain:outreach', decision: 'DR-9', reason: 'made up' },
      ],
    });
    expect(of('planned').at(-1)!.avoided).toEqual([{ from: 'src/tools/opener.ts', to: 'domain:outreach', decision: 'DR-4', reason: 'Research tools never read outreach data' }]);
    expect(out).toContain('Avoided (per standing decisions): src/tools/opener.ts → domain:outreach (DR-4).');
    expect(out).toContain('Not recorded as avoided (no such decision in decisions/): domain:tools → domain:outreach (DR-9).');
    expect(out).toContain('No violations.');
  });
});
