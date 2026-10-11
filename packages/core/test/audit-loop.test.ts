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

const DR4 = [
  '---',
  'id: DR-4',
  'title: Filings go through the gateway',
  'outcome: Route filings through the gateway, with a filings redaction mode',
  'status: made',
  'type: standing',
  'invariant: DR-1',
  'anchors:',
  '  paths:',
  '    - src/tools/filing-summarize.ts',
  'rejected: Add an exception for src/tools/filing-summarize.ts',
  '---',
  '',
  'The user chose A, in their words: "A — go through the gateway, and give redaction a filings mode so the figures survive."',
  '',
  'What triggered it: src/tools/filing-summarize.ts imports vendor/llm-openai/index.ts, which only the model gateway may call (DR-1).',
  '',
].join('\n');

/** A filings tool that calls complete() without `redaction: "filings"` (line 6). */
const DIGEST = [
  'import type { Tool } from "../shared/types";',
  'import { call as filings } from "../../vendor/sec-edgar/index";',
  'import { complete } from "../gateway/complete";',
  'export const filingsDigest: Tool = {',
  '  name: "filings-digest", tags: ["filings"],',
  '  run: async (c) => complete({ purpose: "filings", messages: [filings(c)] }),',
  '};',
  '',
].join('\n');

function sandbox(): string {
  const dir = realpathSync(mkdtempSync(join(process.env.HARNESS_TEST_TMP ?? tmpdir(), 'harness-audit-')));
  dirs.push(dir);
  cpSync(fixtureRepo, dir, { recursive: true });
  writeFileSync(join(dir, 'domains.yaml'), mapYaml.replace('allowed_from: [gateway]\n    exceptions: []', 'allowed_from: [gateway]\n    exceptions: []\n    decisions: [DR-4]'));
  mkdirSync(join(dir, 'decisions'));
  writeFileSync(join(dir, 'decisions/DR-4.md'), DR4);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@harness');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'fixture');
  return dir;
}

/** Fake auditor: flags any changed line that calls complete( without `redaction: "filings"`, citing DR-4 — if DR-4 was sent. */
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
      if (m && m[2]!.includes('complete(') && !m[2]!.includes('redaction')) {
        findings.push({ decision: 'DR-4', files: [path], lines: [{ path, line: Number(m[1]) }], confidence: 'high' as const, text: `DR-4 says filings go through the gateway with redaction: "filings" so the figures survive; ${path}:${m[1]} calls complete() without it.` });
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

describe('auditor loop (fake auditor)', () => {
  it('a filings tool calling complete() without redaction: "filings" while DR-4 stands → a finding citing DR-4 and the line; dismiss is remembered; the ledger is untouched', async () => {
    const { root, bus, auditor, calls, turn, put, of, idle } = setup();
    await idle();

    turn('t1', put('src/tools/filings-digest.ts', DIGEST));
    await idle();
    expect(calls).toHaveLength(1);
    const input = calls[0]!;
    expect(input.decisions.map((d) => d.decision.id)).toEqual(['DR-4']);
    expect(input.decisions[0]!.reasons.map((r) => r.kind)).toEqual(['invariant', 'mention']);
    expect(input.surface).toMatchObject({ turn: 't1', source: 'turn', files: ['src/tools/filings-digest.ts'], created: ['src/tools/filings-digest.ts'] });
    expect(input.surface.delta.calls).toContainEqual({ from: expect.stringMatching(/^src\/tools\/filings-digest\.ts#/), to: 'src/gateway/complete.ts#complete' });
    expect(input.diff).toContain('### src/tools/filings-digest.ts (new file)');
    expect(input.diff).toContain('   6 +   run: async (c) => complete({ purpose: "filings", messages: [filings(c)] }),');
    expect(input.invariants.map((i) => i.id)).toEqual(['DR-1', 'DR-2', 'DR-3']);

    const found = bus.events.filter((e) => e.kind === 'audit_finding');
    expect(found).toHaveLength(1);
    expect(found[0]!).toMatchObject({ turn: 't1', path: 'src/tools/filings-digest.ts' });
    expect((found[0]!.data as EventData['audit_finding']).finding).toEqual({
      id: 'AF-1', decision: 'DR-4', files: ['src/tools/filings-digest.ts'], lines: [{ path: 'src/tools/filings-digest.ts', line: 6 }], confidence: 'high',
      text: 'DR-4 says filings go through the gateway with redaction: "filings" so the figures survive; src/tools/filings-digest.ts:6 calls complete() without it.',
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
    expect(memory.dismissed).toEqual([expect.objectContaining({ id: 'AF-1', decision: 'DR-4', files: ['src/tools/filings-digest.ts'] })]);

    // Next turn edits the same file: the auditor runs again, raises the same finding (now at line 7), and it stays dismissed.
    turn('t2', () => { writeFileSync(join(root, 'src/tools/filings-digest.ts'), `// Filings digest\n${DIGEST}`); return ['src/tools/filings-digest.ts']; });
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

  it('promote turns a finding into a living-map proposal amending DR-1 (accept commits domains.yaml); reinforcement proposes once', async () => {
    const { root, bus, repo, auditor, turn, put, of, idle } = setup();
    const lm = attachLivingMap({ bus, repo, proposer: null, labeler: null, gitLimit: 20 });
    turn('t1', put('src/tools/filings-risk.ts', DIGEST.replace('filingsDigest', 'filingsRisk')));
    await idle();
    await lm.idle();
    expect(reduce(bus.events).findings['AF-1']).toMatchObject({ decision: 'DR-4', status: 'open' });

    expect(auditor.promote('AF-1')).toEqual({ ok: true, proposal: 'MP-1', manual: false });
    expect(auditor.promote('AF-1')).toMatchObject({ ok: false, status: 409 });
    const p = of('map_proposed').find((x) => x.proposal)!.proposal!;
    const rule = 'Model providers are only called through the model gateway; DR-4: Filings go through the gateway';
    expect(p).toMatchObject({ id: 'MP-1', trigger: [], scope: ['rule:DR-1', 'src/tools/filings-risk.ts'], changes: [{ kind: 'change_rule', invariant: 'DR-1', rule }] });
    expect(p.rationale).toMatch(/^Promoted from AF-1: /);
    expect(of('audit_resolved')).toEqual([{ id: 'AF-1', outcome: 'promoted' }]);
    expect(reduce(bus.events).proposals['MP-1']!.status).toBe('pending');

    // The living map's accept path works unchanged on an auditor proposal: only domains.yaml is committed.
    expect(lm.accept('MP-1')).toEqual({ ok: true });
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('domains.yaml');
    expect(parseDomainMap(readFileSync(join(root, 'domains.yaml'), 'utf8')).invariants[0]!.rule).toBe(rule);
    expect(git(root, 'status', '--porcelain')).toContain('?? src/tools/filings-risk.ts');
    await lm.idle();

    // Rule reinforcement: three option-A decisions on DR-1 for Research tools → one proposal, not repeated.
    const decide = () => { for (const id of ['DR-5', 'DR-6', 'DR-7']) bus.emit('decision_recorded', { id, title: `${id} comply`, invariant: 'DR-1', option: 'A', paths: [`src/tools/${id}.ts`], alike: false }); };
    turn('t2', () => [], decide);
    await idle();
    const reinforced = of('map_proposed').filter((x) => x.proposal?.trigger.some((s) => s.signal === 'rule_reinforcement'));
    expect(reinforced).toHaveLength(1);
    expect(reinforced[0]!.proposal).toMatchObject({
      id: 'MP-2',
      changes: [{ kind: 'change_rule', invariant: 'DR-1', rule: `${rule} (confirmed 3× for Research tools: DR-5, DR-6, DR-7)` }],
      scope: ['domain:tools', 'rule:DR-1', 'src/tools/DR-5.ts', 'src/tools/DR-6.ts', 'src/tools/DR-7.ts'],
    });
    turn('t3', () => []);
    await idle();
    expect(of('map_proposed').filter((x) => x.proposal?.trigger.some((s) => s.signal === 'rule_reinforcement'))).toHaveLength(1);
    lm.detach();
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
