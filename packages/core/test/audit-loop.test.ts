// End-to-end: the server's auditor and journeys loops on a temp git copy of the fixture repo, with a FAKE auditor and a
// FAKE namer (no model calls). Lives here so `npm test` runs it; it imports the server modules directly.
import { afterAll, describe, expect, it } from 'vitest';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Bus } from '../../../apps/server/src/bus';
import { Repo } from '../../../apps/server/src/repo';
import { baseline, numstat } from '../../../apps/server/src/git';
import { attachAuditor, type AuditInput, type Auditor } from '../../../apps/server/src/auditor';
import { attachJourneys, type Namer, type NamerInput } from '../../../apps/server/src/journeys';
import { attachLivingMap } from '../../../apps/server/src/living-map';
import { reduce, type EventData, type HarnessEvent } from '../src/events';
import { ledger } from '../src/ledger';
import { parseDomainMap } from '../src/schema';
import { fixtureRepo, mapYaml } from './helpers';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/** The demo's DR-4 (DEMO_PLAN beat 3): option A on DR-3 (no_edge tools → outreach), as `recordFork` writes it. */
const DR4 = [
  '---',
  'id: DR-4',
  'title: Research tools never read outreach data; the run loop passes outreach context in',
  'outcome: Keep research tools out of outreach data; the run loop passes outreach context in',
  'status: made',
  'type: standing',
  'invariant: DR-3',
  'anchors:',
  '  paths:',
  '    - src/tools/outreach-history.ts',
  'rejected: Add an exception for src/tools/outreach-history.ts',
  '---',
  '',
  'The user chose A, in their words: "A. Research tools never read outreach data; the run loop passes it in."',
  '',
  'Asked during: "Can we add a research tool that checks whether we\'ve already emailed this contact?"',
  '',
  'What triggered it: src/tools/outreach-history.ts imports src/outreach/outreach-log.ts, but Research tools never depend on Outreach (DR-3).',
  '',
].join('\n');

/** Beat 6: a research tool that reads `outreach_log` through neutral shared code (no import edge; reads aren't gated). Line 5 reads it. */
const HISTORY = [
  'import type { Tool } from "../shared/types";',
  'import { db } from "../shared/db";',
  'export const contactHistory: Tool = {',
  '  name: "contact-history", tags: ["outreach", "history"],',
  '  run: async (c) => JSON.stringify(db.all("outreach_log").filter((row) => JSON.stringify(row).includes(c))),',
  '};',
  '',
].join('\n');

function sandbox(): string {
  const dir = realpathSync(mkdtempSync(join(process.env.HARNESS_TEST_TMP ?? tmpdir(), 'harness-audit-')));
  dirs.push(dir);
  cpSync(fixtureRepo, dir, { recursive: true });
  writeFileSync(join(dir, 'domains.yaml'), mapYaml.replace('    to: outreach\n    exceptions: []', '    to: outreach\n    exceptions: []\n    decisions: [DR-4]'));
  mkdirSync(join(dir, 'decisions'));
  writeFileSync(join(dir, 'decisions/DR-4.md'), DR4);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@harness');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'fixture');
  return dir;
}

/** Fake auditor: flags any added line in a tools file that reads an outreach table, citing DR-4 — if DR-4 was sent. */
function fakeAuditor(calls: AuditInput[]): Auditor {
  return async (input) => {
    calls.push(input);
    if (!input.decisions.some((d) => d.decision.id === 'DR-4')) return { findings: [], cost: 0 };
    let path = '';
    const findings = [];
    for (const l of input.diff.split('\n')) {
      const header = /^### (\S+)/.exec(l);
      if (header) { path = header[1]!; continue; }
      const m = /^\s*(\d+) \+ (.*)$/.exec(l);
      if (m && path.startsWith('src/tools/') && /"(outreach_log|contacts)"/.test(m[2]!)) {
        findings.push({ decision: 'DR-4', files: [path], lines: [{ path, line: Number(m[1]) }], confidence: 'high' as const, text: `DR-4 says outreach history reaches the brief through the run loop; ${path}:${m[1]} reads outreach_log directly.` });
      }
    }
    return { findings, cost: 0.02 };
  };
}

function setup() {
  const root = sandbox();
  const bus = new Bus(root, { fresh: true });
  const repo = new Repo(root, bus);
  repo.loadMapFile();
  bus.emit('map_confirmed', { map: repo.map, source: 'file' }, { turn: null });
  const calls: AuditInput[] = [];
  const named: NamerInput[] = [];
  const namer: Namer = async (input) => { named.push(input); return { names: input.journeys.map((j) => ({ id: j.id, name: 'Run research from the CLI' })), cost: 0.001 }; };
  const auditor = attachAuditor({ bus, repo, auditor: fakeAuditor(calls), plans: false });
  const journeys = attachJourneys({ bus, repo, namer });
  repo.scan();
  /** A coding turn as the session drives it: baseline, hook-reported edits, numstat at turn_ended, then the turn closes. */
  const turn = (id: string, write: () => string[], during?: () => void) => {
    const base = baseline(root);
    bus.turn = id;
    bus.emit('turn_started', { prompt: `turn ${id}`, head: base.head, baseline: base.snapshot });
    for (const p of write()) repo.fileChanged(p, { tool: 'Write' });
    during?.();
    bus.emit('turn_ended', { ...numstat(root, base), reason: 'success' });
    bus.turn = null;
  };
  const put = (p: string, text: string) => () => { writeFileSync(join(root, p), text); return [p]; };
  const of = <K extends keyof EventData>(kind: K) => bus.events.filter((e): e is HarnessEvent & { data: EventData[K] } => e.kind === kind).map((e) => e.data as EventData[K]);
  const idle = async () => { await auditor.idle(); await journeys.idle(); };
  return { root, bus, repo, auditor, journeys, calls, named, turn, put, of, idle };
}

const READER = 'src/tools/contact-history.ts';

describe('auditor loop (fake auditor)', () => {
  it('a research tool reading outreach_log through shared code while DR-4 stands → a finding citing DR-4 and the line; the gate stays quiet; dismiss is remembered; the ledger is untouched', async () => {
    const { root, bus, auditor, calls, turn, put, of, idle } = setup();
    await idle();

    turn('t1', put(READER, HISTORY));
    await idle();
    const ui = reduce(bus.events);
    expect(ui.turns[0]!.violationsSeen).toEqual([]); // no import edge crossed: the checker has nothing to say
    expect(ui.violations.filter((v) => v.file === READER)).toEqual([]);
    expect(calls).toHaveLength(1);
    const input = calls[0]!;
    expect(input.decisions.map((d) => d.decision.id)).toEqual(['DR-4']);
    expect(input.decisions[0]!.reasons[0]).toEqual({ kind: 'invariant', detail: 'the turn changed files in tools, an end of DR-3 (tools → outreach)' });
    expect(input.surface).toMatchObject({ turn: 't1', source: 'turn', files: [READER], created: [READER], violations: [] });
    expect(input.surface.delta.imports).toContainEqual({ from: READER, to: 'src/shared/db.ts' });
    expect(input.diff).toContain(`### ${READER} (new file)`);
    expect(input.diff).toContain('   5 +   run: async (c) => JSON.stringify(db.all("outreach_log")');
    expect(input.invariants.map((i) => i.id)).toEqual(['DR-1', 'DR-2', 'DR-3']);

    const found = bus.events.filter((e) => e.kind === 'audit_finding');
    expect(found).toHaveLength(1);
    expect(found[0]!).toMatchObject({ turn: 't1', path: READER });
    expect((found[0]!.data as EventData['audit_finding']).finding).toEqual({
      id: 'AF-1', decision: 'DR-4', files: [READER], lines: [{ path: READER, line: 5 }], confidence: 'high',
      text: `DR-4 says outreach history reaches the brief through the run loop; ${READER}:5 reads outreach_log directly.`,
    });
    expect(of('maintenance_run').filter((m) => m.agent === 'auditor')).toEqual([expect.objectContaining({ trigger: 'turn', cost: 0.02, ok: true })]);
    expect(reduce(bus.events).findings['AF-1']).toMatchObject({ status: 'open', turn: 't1' });

    // Ledger counters are exactly what they would be without the auditor.
    const without = bus.events.filter((e) => !['audit_finding', 'audit_resolved', 'maintenance_run'].includes(e.kind));
    expect(ledger(reduce(bus.events))).toEqual(ledger(reduce(without)));

    // Dismiss: recorded in the log and in .harness/audit/dismissed.json.
    expect(auditor.dismiss('AF-1')).toEqual({ ok: true });
    expect(auditor.dismiss('AF-1')).toMatchObject({ ok: false, status: 409 });
    expect(auditor.dismiss('AF-9')).toMatchObject({ ok: false, status: 404 });
    expect(of('audit_resolved')).toEqual([{ id: 'AF-1', outcome: 'dismissed' }]);
    expect(reduce(bus.events).findings['AF-1']!.status).toBe('dismissed');
    const memory = JSON.parse(readFileSync(join(root, '.harness/audit/dismissed.json'), 'utf8')) as { dismissed: { decision: string; files: string[] }[] };
    expect(memory.dismissed).toEqual([expect.objectContaining({ id: 'AF-1', decision: 'DR-4', files: [READER] })]);

    // Next turn edits the same file: the auditor runs again, raises the same finding (now at line 6), and it stays dismissed.
    turn('t2', () => { writeFileSync(join(root, READER), `// Contact history\n${HISTORY}`); return [READER]; });
    await idle();
    expect(calls).toHaveLength(2);
    expect(bus.events.filter((e) => e.kind === 'audit_finding')).toHaveLength(1);

    // A turn that touches nothing any decision bears on: the model is never called.
    turn('t3', () => { appendFileSync(join(root, 'src/channels/validate.ts'), '\nexport const LIMIT = 3;\n'); return ['src/channels/validate.ts']; });
    await idle();
    expect(calls).toHaveLength(2);
    expect(of('maintenance_run').filter((m) => m.agent === 'auditor')).toHaveLength(2);
    expect(ledger(reduce(bus.events))).toEqual(ledger(reduce(bus.events.filter((e) => !['audit_finding', 'audit_resolved', 'maintenance_run'].includes(e.kind)))));
  });

  it('promote turns a finding into a living-map proposal amending DR-3 (accept commits domains.yaml); reinforcement proposes once', async () => {
    const { root, bus, repo, auditor, turn, put, of, idle } = setup();
    const lm = attachLivingMap({ bus, repo, proposer: null, labeler: null, gitLimit: 20 });
    turn('t1', put('src/tools/emailed-before.ts', HISTORY.replace('contactHistory', 'emailedBefore')));
    await idle();
    await lm.idle();
    expect(reduce(bus.events).findings['AF-1']).toMatchObject({ decision: 'DR-4', status: 'open' });

    expect(auditor.promote('AF-1')).toEqual({ ok: true, proposal: 'MP-1', manual: false });
    expect(auditor.promote('AF-1')).toMatchObject({ ok: false, status: 409 });
    const p = of('map_proposed').find((x) => x.proposal)!.proposal!;
    const rule = 'Research tools never depend on outreach; DR-4: Research tools never read outreach data; the run loop passes outreach context in';
    expect(p).toMatchObject({ id: 'MP-1', trigger: [], scope: ['rule:DR-3', 'src/tools/emailed-before.ts'], changes: [{ kind: 'change_rule', invariant: 'DR-3', rule }] });
    expect(p.rationale).toMatch(/^Promoted from AF-1: /);
    expect(of('audit_resolved')).toEqual([{ id: 'AF-1', outcome: 'promoted' }]);
    expect(reduce(bus.events).proposals['MP-1']!.status).toBe('pending');

    // The living map's accept path works unchanged on an auditor proposal: only domains.yaml is committed.
    expect(lm.accept('MP-1')).toEqual({ ok: true });
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('domains.yaml');
    expect(parseDomainMap(readFileSync(join(root, 'domains.yaml'), 'utf8')).invariants[2]!.rule).toBe(rule);
    expect(git(root, 'status', '--porcelain')).toContain('?? src/tools/emailed-before.ts');
    await lm.idle();

    // Rule reinforcement: three option-A decisions on DR-3 for Research tools → one proposal, not repeated.
    const decide = () => { for (const id of ['DR-5', 'DR-6', 'DR-7']) bus.emit('decision_recorded', { id, title: `${id} comply`, invariant: 'DR-3', option: 'A', paths: [`src/tools/${id}.ts`], alike: false }); };
    turn('t2', () => [], decide);
    await idle();
    const reinforced = of('map_proposed').filter((x) => x.proposal?.trigger.some((s) => s.signal === 'rule_reinforcement'));
    expect(reinforced).toHaveLength(1);
    expect(reinforced[0]!.proposal).toMatchObject({
      id: 'MP-2',
      changes: [{ kind: 'change_rule', invariant: 'DR-3', rule: `${rule} (confirmed 3× for Research tools: DR-5, DR-6, DR-7)` }],
      scope: ['domain:tools', 'rule:DR-3', 'src/tools/DR-5.ts', 'src/tools/DR-6.ts', 'src/tools/DR-7.ts'],
    });
    turn('t3', () => []);
    await idle();
    expect(of('map_proposed').filter((x) => x.proposal?.trigger.some((s) => s.signal === 'rule_reinforcement'))).toHaveLength(1);
    lm.detach();
  });
});

describe('plan review (HARNESS_AUDIT_PLANS=1)', () => {
  it('reviews each submitted plan mid-turn without a diff; off by default', async () => {
    const { bus, repo, calls, idle } = setup(); // plans: false
    const planCalls: AuditInput[] = [];
    const reviewer = attachAuditor({ bus, repo, auditor: async (input) => { planCalls.push(input); return { findings: [{ decision: 'DR-4', files: [READER], lines: [], text: 'Step 1 has a research tool read outreach_log itself; DR-4 says the run loop passes outreach context in.', confidence: 'medium' }], cost: 0.01 }; }, plans: true });
    bus.turn = 'tp';
    bus.emit('turn_started', { prompt: 'add a contact history tool', head: '', baseline: '' });
    bus.emit('planned', { steps: [{ n: 1, text: `Add ${READER} reading outreach_log through src/shared/db`, files: [READER], imports: [{ from: READER, to: 'src/shared/db.ts' }] }], cells: [], edges: [], unassigned: [] });
    await reviewer.idle();
    await idle();
    expect(calls).toHaveLength(0); // the default loop doesn't review plans
    expect(planCalls).toHaveLength(1);
    expect(planCalls[0]!.surface).toMatchObject({ source: 'plan', files: [READER], baseline: null });
    expect(planCalls[0]!.diff).toBe('');
    expect(planCalls[0]!.decisions.map((d) => d.decision.id)).toEqual(['DR-4']);
    const f = bus.events.find((e) => e.kind === 'audit_finding')!;
    expect(f).toMatchObject({ turn: 'tp', data: { finding: { id: 'AF-1', decision: 'DR-4', confidence: 'medium' } } });
    expect(bus.events.filter((e) => e.kind === 'maintenance_run' && (e.data as EventData['maintenance_run']).trigger === 'plan')).toHaveLength(1);
    reviewer.detach();
  });
});

describe('journeys loop (fake namer)', () => {
  it('publishes journeys after the scan, names them once (cached by step hash), and confirm/rename clears inferred', async () => {
    const { root, bus, journeys, named, turn, put, of, idle } = setup();
    await idle();
    const updates = of('journeys_updated');
    expect(updates).toHaveLength(2); // placeholders, then names
    expect(updates[0]!.journeys.map((j) => [j.id, j.name, j.inferred])).toEqual([['journey:cli-scout', 'cli scout', true]]);
    expect(updates[1]!.journeys.map((j) => [j.id, j.name, j.inferred])).toEqual([['journey:cli-scout', 'Run research from the CLI', true]]);
    expect(named).toHaveLength(1);
    expect(named[0]!.journeys[0]!.steps[0]).toBe('entry: scout (entry:cli:scout)');
    expect(readdirSync(join(root, '.harness/journeys')).filter((f) => f !== 'confirmed.json')).toHaveLength(1);
    expect(of('maintenance_run').find((m) => m.trigger === 'journeys')).toMatchObject({ agent: 'cartographer', ok: true, cost: 0.001 });

    // A turn that doesn't change entries/routes/calls: nothing new is published or named.
    turn('t1', () => { appendFileSync(join(root, 'src/channels/validate.ts'), '\n// note\n'); return ['src/channels/validate.ts']; });
    await idle();
    expect(of('journeys_updated')).toHaveLength(2);

    // Confirm with a rename: inferred false, persisted, and it survives a refresh.
    expect(journeys.confirm('journey:cli-scout', 'Start research from the terminal')).toMatchObject({ ok: true, journey: { name: 'Start research from the terminal', inferred: false } });
    expect(journeys.confirm('journey:nope')).toMatchObject({ ok: false, status: 404 });
    expect(reduce(bus.events).journeys[0]).toMatchObject({ name: 'Start research from the terminal', inferred: false });
    expect(existsSync(join(root, '.harness/journeys/confirmed.json'))).toBe(true);
    journeys.refresh();
    await idle();
    expect(reduce(bus.events).journeys[0]).toMatchObject({ name: 'Start research from the terminal', inferred: false });
    expect(named).toHaveLength(1);

    // A turn that adds a CLI-reachable call changes the journey: recomputed and published, the new step list named.
    turn('t2', put('src/channels/cli.ts', 'import { runAgent } from "../orchestrator/agent.js";\nimport { complete } from "../gateway/complete";\nconst url = "https://example.com/runs";\nrunAgent(process.argv.slice(2).join(" "), url);\ncomplete({ purpose: "cli", messages: [] });\n'));
    await idle();
    expect(of('journeys_updated').length).toBeGreaterThan(3);
    expect(reduce(bus.events).journeys[0]).toMatchObject({ id: 'journey:cli-scout', name: 'Start research from the terminal', inferred: false });
  });
});
