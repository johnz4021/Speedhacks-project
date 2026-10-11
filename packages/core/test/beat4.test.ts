// Beat 4 on the server: what a decision protects is recorded when its turn ends (DR file + commit + event), plans and
// edits that touch it emit `decision_touched`, the submit_plan result and the PostToolUse hook carry the reminder (once
// per decision per turn), and the brief lists it. Fixture repo copy; no model.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { Bus } from '../../../apps/server/src/bus';
import { Repo } from '../../../apps/server/src/repo';
import { Session, sessionModel, GRAPH_FIRST } from '../../../apps/server/src/session';
import { submitPlan, type PlanHooks } from '../../../apps/server/src/harness-tools';
import { listDecisions, recordProtects } from '../../../apps/server/src/decisions';
import type { EventData, HarnessEvent } from '../src/events';
import { linkDecision } from '../src/mapedit';
import { fixtureRepo, mapYaml } from './helpers';

const dirs: string[] = [];
const ENV = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'] as const;
beforeAll(() => { for (const k of ENV) process.env[k] = k.endsWith('EMAIL') ? 't@t' : 't'; });
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const k of ENV) delete process.env[k];
});

const DR4 = `---
id: DR-4
title: Filings go through the gateway, in a filing mode that keeps figures intact
outcome: Route it through the Model gateway (every model call, with redaction and cost logging) instead of importing vendor/llm-anthropic/index.ts directly
status: made
type: standing
invariant: DR-1
anchors:
  paths:
    - src/tools/filing-summarize.ts
rejected: Add an exception for src/tools/filing-summarize.ts and record why
session: 1
---

The user chose A.
`;

function setup() {
  const root = realpathSync(mkdtempSync(join(process.env.HARNESS_TEST_TMP ?? tmpdir(), 'harness-b4-')));
  dirs.push(root);
  cpSync(fixtureRepo, root, { recursive: true });
  writeFileSync(join(root, 'domains.yaml'), linkDecision(mapYaml, 'DR-1', 'DR-4'));
  mkdirSync(join(root, 'decisions'));
  writeFileSync(join(root, 'decisions/DR-4.md'), DR4);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  const bus = new Bus(root, { fresh: true });
  const repo = new Repo(root, bus);
  repo.loadMapFile();
  repo.scan();
  const of = <K extends keyof EventData>(kind: K) => bus.events.filter((e): e is HarnessEvent & { data: EventData[K] } => e.kind === kind).map((e) => e.data);
  return { root, bus, repo, of };
}

const hooks: PlanHooks = { onPlan: () => {}, takeNotes: () => [] };

/** Beat 3's build in the decision turn: the tool through the gateway, a filing mode in redact.ts, a gateway test. */
function beat3Turn(root: string, bus: Bus, repo: Repo) {
  bus.turn = 't1';
  bus.emit('turn_started', { prompt: 'Can we add a tool that summarizes a prospect\'s latest 10-K?', head: '', baseline: '' });
  bus.emit('decision_recorded', { id: 'DR-4', title: 'Filings go through the gateway, in a filing mode that keeps figures intact', invariant: 'DR-1', option: 'A', paths: ['src/tools/filing-summarize.ts'], alike: false });
  const edit = (path: string, text: string, append = false) => {
    if (append) appendFileSync(join(root, path), text); else writeFileSync(join(root, path), text);
    return repo.fileChanged(path, { tool: 'Edit' });
  };
  const redact = readFileSync(join(root, 'src/gateway/redact.ts'), 'utf8');
  edit('src/gateway/redact.ts', redact.replace('export function redact(text: string, _names: unknown[]): string {', 'export function redact(text: string, _names: unknown[], mode: "default" | "filing" = "default"): string {\n  if (mode === "filing") return text;'));
  edit('src/tools/filing-summarize.ts', 'import { complete } from "../gateway/complete";\nexport async function filingSummarize(text: string) { return complete({ purpose: "filing", messages: [text] }); }\n');
  edit('test/gateway/complete.test.ts', '\ndescribe("filing mode", () => it("keeps figures intact", () => expect(1).toBe(1)));\n', true);
}

describe('recordProtects (decision turn end)', () => {
  it('writes protects into the DR file, commits only it, and re-emits decision_recorded with protects', () => {
    const { root, bus, repo, of } = setup();
    beat3Turn(root, bus, repo);
    bus.emit('turn_ended', { added: 0, removed: 0, files: [], reason: 'success' });
    const done = recordProtects(repo, bus, 't1');
    const protects = { paths: ['src/gateway/redact.ts', 'test/gateway/complete.test.ts'], symbols: ['src/gateway/redact.ts#redact'] };
    expect(done).toEqual([{ id: 'DR-4', protects }]);
    const text = readFileSync(join(root, 'decisions/DR-4.md'), 'utf8');
    expect(parseYaml(/^---\n([\s\S]*?)\n---/.exec(text)![1]!)).toMatchObject({ id: 'DR-4', session: 1, protects });
    expect(text).toContain('\n---\n\nThe user chose A.\n');
    expect(execFileSync('git', ['log', '-1', '--format=%s', '--name-only'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean))
      .toEqual(['docs(decisions): what DR-4 protects', 'decisions/DR-4.md']);
    expect(of('decision_recorded').at(-1)).toMatchObject({ id: 'DR-4', protects, option: 'A' });
    expect(listDecisions(root)[0]!.protects).toEqual(protects);
    // Once: a later call (e.g. a replayed turn end) leaves it alone.
    expect(recordProtects(repo, bus, 't1')).toEqual([]);
  });
});

/** A repo whose DR-4 already protects beat 3's filing mode and test (a later session). */
function protectedSetup() {
  const s = setup();
  beat3Turn(s.root, s.bus, s.repo);
  s.bus.emit('turn_ended', { added: 0, removed: 0, files: [], reason: 'success' });
  recordProtects(s.repo, s.bus, 't1');
  s.bus.turn = null;
  return s;
}

describe('plans that touch protected code (submit_plan)', () => {
  it('emits decision_touched per step and adds the reminder to the tool result; never a violation or a fork', () => {
    const { repo, bus, of } = protectedSetup();
    bus.turn = 't2';
    bus.emit('turn_started', { prompt: 'Redact every long number', head: '', baseline: '' });
    const out = submitPlan(repo, bus, hooks, {
      steps: [
        { n: 1, text: 'Widen the number pattern', files: ['./src/gateway/redact.ts'], imports: [] },
        { n: 2, text: 'Unrelated', files: ['src/orchestrator/agent.ts'], imports: [] },
        { n: 3, text: 'Extend the test', files: ['test/gateway/complete.test.ts'], imports: [], symbols: [] },
      ],
    });
    expect(of('decision_touched')).toEqual([
      { decision: 'DR-4', principle: 'Filings go through the gateway, in a filing mode that keeps figures intact', paths: ['src/gateway/redact.ts'], symbols: ['src/gateway/redact.ts#redact'], source: 'plan', step: 1 },
      { decision: 'DR-4', principle: 'Filings go through the gateway, in a filing mode that keeps figures intact', paths: ['test/gateway/complete.test.ts'], symbols: [], source: 'plan', step: 3 },
    ]);
    expect(out).toContain('No violations.\n\nThis plan touches what DR-4 protects: Filings go through the gateway, in a filing mode that keeps figures intact. Route it through the Model gateway (every model call, with redaction and cost logging) instead of importing vendor/llm-anthropic/index.ts directly. Keep it true (decided in session 1): scope the change so it still holds, and extend its test. Protected code here: src/gateway/redact.ts#redact, test/gateway/complete.test.ts.');
    expect(out).toContain('do not ask the user');
    expect(out).not.toContain('Exit plan mode when ready');
    expect(of('plan_violation')).toHaveLength(0);
  });

  it('a step naming only other symbols in the file does not touch it', () => {
    const { repo, bus, of } = protectedSetup();
    bus.turn = 't2';
    bus.emit('turn_started', { prompt: 'x', head: '', baseline: '' });
    const out = submitPlan(repo, bus, hooks, { steps: [{ n: 1, text: 'Add a helper', files: ['src/gateway/redact.ts'], imports: [], symbols: ['src/gateway/redact.ts#maskAccount'] }] });
    expect(of('decision_touched')).toHaveLength(0);
    expect(out).toContain('No violations. Exit plan mode when ready.');
    expect(of('planned').at(-1)!.steps[0]!.symbols).toEqual(['src/gateway/redact.ts#maskAccount']);
  });
});

type HookOut = { hookSpecificOutput?: { hookEventName: string; additionalContext?: string } };
type Inner = { afterEdit: (i: unknown, id: undefined, o: { signal: AbortSignal }) => Promise<HookOut> };

describe('edits that touch protected code (PostToolUse)', () => {
  it('returns additionalContext once per decision per turn, emits decision_touched for every touching edit', async () => {
    const { root, repo, bus, of } = protectedSetup();
    const session = new Session(repo, bus, () => {});
    const s = session as unknown as Inner;
    session.userMessage('We\'re seeing account numbers in briefs. Can we redact every long number?');
    const hook = (path: string) => s.afterEdit({ tool_name: 'Edit', tool_input: { file_path: join(root, path) } }, undefined, { signal: new AbortController().signal });

    // An edit that only adds a function (and a comment and an import): nothing.
    const before = readFileSync(join(root, 'src/gateway/redact.ts'), 'utf8');
    writeFileSync(join(root, 'src/gateway/redact.ts'), `import { db } from "../shared/db";\n${before}\n// Account numbers.\nexport function maskAccount(s: string) {\n  return s.replace(/\\d{8,}/g, "[ACCOUNT]");\n}\n`);
    expect(await hook('src/gateway/redact.ts')).toEqual({});
    expect(of('decision_touched')).toHaveLength(0);

    // The protected function's body changes: reminder.
    const text = readFileSync(join(root, 'src/gateway/redact.ts'), 'utf8');
    writeFileSync(join(root, 'src/gateway/redact.ts'), text.replace('if (mode === "filing") return text;', 'if (mode === "filing") return text;\n  text = maskAccount(text);'));
    const first = await hook('src/gateway/redact.ts');
    expect(first.hookSpecificOutput).toEqual({
      hookEventName: 'PostToolUse',
      additionalContext: 'This edit touches what DR-4 protects: Filings go through the gateway, in a filing mode that keeps figures intact. Route it through the Model gateway (every model call, with redaction and cost logging) instead of importing vendor/llm-anthropic/index.ts directly. Keep it true (decided in session 1): scope the change so it still holds, and extend its test. Protected code here: src/gateway/redact.ts#redact.',
    });

    // The protected test changes too: an event (marker), but no second reminder this turn.
    appendFileSync(join(root, 'test/gateway/complete.test.ts'), '\n// long numbers\n');
    expect(await hook('test/gateway/complete.test.ts')).toEqual({});
    expect(of('decision_touched').map((t) => [t.source, t.paths, t.symbols])).toEqual([
      ['edit', ['src/gateway/redact.ts'], ['src/gateway/redact.ts#redact']],
      ['edit', ['test/gateway/complete.test.ts'], []],
    ]);
    expect(of('edited').at(-1)).toMatchObject({ tool: 'Edit' });
  });

  it('a change to a module-level const (a shared pattern Tier 1 lists as no symbol) touches the protected symbols in that file', async () => {
    const { root, repo, bus, of } = protectedSetup();
    const session = new Session(repo, bus, () => {});
    const s = session as unknown as Inner;
    session.userMessage('Redact every long number');
    const path = join(root, 'src/gateway/redact.ts');
    writeFileSync(path, `const LONG = /\\d{8,}/g;\n${readFileSync(path, 'utf8')}`);
    const out = await s.afterEdit({ tool_name: 'Edit', tool_input: { file_path: path } }, undefined, { signal: new AbortController().signal });
    expect(out.hookSpecificOutput?.additionalContext).toContain('This edit touches what DR-4 protects');
    expect(of('decision_touched').at(-1)).toMatchObject({ source: 'edit', paths: ['src/gateway/redact.ts'], symbols: ['src/gateway/redact.ts#redact'] });
  });
});

describe('changedOutsideSymbols', () => {
  const sym = (name: string, start: number, end: number) => ({ id: `a.ts#${name}`, file: 'a.ts', name, kind: 'function' as const, exported: true, parent: null, span: { start, end }, sigHash: '', bodyHash: '' });
  it('flags changed lines outside every symbol span, ignoring blank lines, comments and imports', async () => {
    const { diffLines } = await import('diff');
    const { changedOutsideSymbols } = await import('../../../apps/server/src/repo');
    const a = 'const P = /a/;\nfunction f() {\n  return 1;\n}\n';
    const fSpan = (text: string) => [sym('f', text.indexOf('function'), text.indexOf('}') + 1)];
    const inBody = a.replace('return 1', 'return 2');
    expect(changedOutsideSymbols(diffLines(a, inBody), fSpan(a), fSpan(inBody))).toBe(false);
    const constChanged = a.replace('/a/', '/b/');
    expect(changedOutsideSymbols(diffLines(a, constChanged), fSpan(a), fSpan(constChanged))).toBe(true);
    const inert = `import x from "y";\n// note\n\n${a}`;
    expect(changedOutsideSymbols(diffLines(a, inert), fSpan(a), fSpan(inert))).toBe(false);
  });
});

describe('the brief and the session model', () => {
  it('lists each standing decision with what it protects, and tells Claude to answer questions from the graph', () => {
    const { repo, bus } = protectedSetup();
    const brief = new Session(repo, bus, () => {}).brief();
    expect(brief).toContain('- DR-4: Filings go through the gateway, in a filing mode that keeps figures intact\n');
    expect(brief).toContain('  Protects: src/gateway/redact.ts#redact; test/gateway/complete.test.ts (keep it true when changing this code)');
    expect(brief).toContain(GRAPH_FIRST);
    expect(brief).toContain('a question needs no plan and no ExitPlanMode');
  });

  it('pins the model (HARNESS_MODEL, default Opus 5.5) and passes a valid HARNESS_EFFORT', () => {
    expect(sessionModel({})).toEqual({ model: 'claude-opus-5-5' });
    expect(sessionModel({ HARNESS_MODEL: 'claude-sonnet-5', HARNESS_EFFORT: 'high' })).toEqual({ model: 'claude-sonnet-5', effort: 'high' });
    expect(sessionModel({ HARNESS_EFFORT: 'turbo' })).toEqual({ model: 'claude-opus-5-5' });
  });
});
