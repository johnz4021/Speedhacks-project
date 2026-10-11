// Server-side Alike recording (apps/server/src/alike.ts, decisions.ts). A fake CLI only — never the real Alike.
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { anchorPath, decisionAnchors, alikeDecision, repoSlug, type DecisionInput } from '../../../apps/server/src/alike';
import { recordInAlike } from '../../../apps/server/src/decisions';
import { Bus } from '../../../apps/server/src/bus';
import type { Repo } from '../../../apps/server/src/repo';
import { loadMap } from './helpers';

const map = loadMap();
const inv = (id: string) => map.invariants.find((i) => i.id === id)!;
const dr4 = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  id: 'DR-4',
  title: 'Research tools never read outreach data; the run loop passes outreach context in',
  outcome: 'Remove the dependency from Research tools on Outreach',
  rejected: 'Add an exception for src/tools/outreach-history.ts and record why',
  option: 'A',
  invariant: inv('DR-3'),
  files: ['src/tools/outreach-history.ts'],
  answer: 'A. Research tools never read outreach data; the run loop passes it in.',
  session: 1,
  ...over,
});

describe('anchors', () => {
  it('turns cell globs into folder prefixes and refuses other wildcards', () => {
    expect(anchorPath('src/tools/**')).toBe('src/tools/');
    expect(anchorPath('src/channels/routes.ts')).toBe('src/channels/routes.ts');
    expect(anchorPath('vendor/llm-*/**')).toBeNull();
    expect(anchorPath('src/*.ts')).toBeNull();
  });

  it('anchors a no_edge decision to both domains (governs / context) plus a situation, never the unwritten file', () => {
    const a = decisionAnchors(map, dr4(), 'johnz4021/scout-agent-take3');
    const governs = a.filter((x) => x.kind === 'path' && x.label === 'governs').map((x) => (x as { path: string }).path);
    const context = a.filter((x) => x.kind === 'path' && x.label === 'context').map((x) => (x as { path: string }).path);
    expect(governs[0]).toBe('src/tools/'); // logic cell first
    expect(governs).toEqual(expect.arrayContaining(['web/src/features/tools/', 'vendor/search/']));
    expect(context).toEqual(expect.arrayContaining(['src/outreach/draft-email.ts', 'src/outreach/outreach-log.ts', 'src/outreach/schema.sql']));
    expect(governs).not.toContain('src/tools/outreach-history.ts');
    expect(a.filter((x) => x.kind === 'path').length).toBeLessThanOrEqual(20);
    expect(a.every((x) => x.kind !== 'path' || x.repository === 'johnz4021/scout-agent-take3')).toBe(true);
    expect(a.at(-1)).toEqual({ kind: 'situation', label: 'applies_when', text: 'Adding or changing code in Research tools that would depend on Outreach' });
  });

  it('expands only_via targets Alike cannot glob, anchors exceptions, and keeps only the situation without a repository', () => {
    const files = ['vendor/llm-openai/index.ts', 'vendor/llm-anthropic/index.ts', 'vendor/embeddings/index.ts'];
    const expand = (g: string) => (g === 'vendor/llm-*/**' ? ['vendor/llm-anthropic/', 'vendor/llm-openai/'] : []);
    const a = decisionAnchors(map, dr4({ invariant: inv('DR-1'), option: 'B', files: ['src/tools/news-summarize.ts'] }), 'o/r', expand);
    const paths = a.filter((x) => x.kind === 'path').map((x) => (x as { path: string }).path);
    expect(paths).toEqual(expect.arrayContaining(['vendor/llm-anthropic/', 'vendor/llm-openai/', 'vendor/embeddings/', 'src/tools/news-summarize.ts']));
    expect(files.length).toBe(3);
    expect(decisionAnchors(map, dr4(), null).map((x) => x.kind)).toEqual(['situation']);
  });

  it("beat 3's DR-1 decision anchors the asking side (src/tools/) and the gateway as folders (src/gateway/)", () => {
    const scout = JSON.parse(readFileSync(new URL('./fixtures/scout-real.json', import.meta.url), 'utf8')) as { fileFacts: Record<string, unknown> };
    const files = [...Object.keys(scout.fileFacts), 'src/gateway/schema.sql', 'src/tools/filing-summarize.ts'];
    const expand = (g: string) => (g === 'vendor/llm-*/**' ? ['vendor/llm-anthropic/', 'vendor/llm-openai/'] : []);
    const d = dr4({
      title: 'Filings go through the gateway, in a filing mode that keeps figures intact', invariant: inv('DR-1'),
      files: ['src/tools/filing-summarize.ts'], rejected: 'Add an exception for src/tools/filing-summarize.ts and record why',
    });
    const a = decisionAnchors(map, d, 'johnz4021/scout-agent-takew3c', expand, files);
    const by = (label: string) => a.filter((x) => x.kind === 'path' && x.label === label).map((x) => (x as { path: string }).path);
    expect(by('governs').slice(0, 2)).toEqual(['src/tools/', 'web/src/features/tools/']);
    expect(by('governs')).toEqual(expect.arrayContaining(['vendor/llm-anthropic/', 'vendor/llm-openai/', 'vendor/embeddings/']));
    expect(by('context')).toContain('src/gateway/');
    expect(by('context').some((p) => p.startsWith('src/gateway/') && p !== 'src/gateway/')).toBe(false);
    expect(a.filter((x) => x.kind === 'path').length).toBeLessThanOrEqual(20);
    expect(a.at(-1)).toMatchObject({ kind: 'situation' });
  });

  it('states the principle and the rejected option in the decision', () => {
    const d = alikeDecision(map, dr4(), 'o/r');
    expect(d.title).toBe('DR-4: Research tools never read outreach data; the run loop passes outreach context in');
    expect(d.rationale).toContain('Refines DR-3 (Research tools never depend on outreach).');
    expect(d.rationale).toContain('Rejected: Add an exception for src/tools/outreach-history.ts');
    expect(d.rationale).toContain('Decided in Interpretability session 1.');
    expect(d).toMatchObject({ decision_type: 'standing', status: 'made' });
  });
});

describe('recordInAlike', () => {
  const dirs: string[] = [];
  afterEach(() => { delete process.env.HARNESS_REPO_SLUG; });

  function repoWithDecision() {
    const root = mkdtempSync(join(process.env.HARNESS_TEST_TMP ?? tmpdir(), 'alike-'));
    dirs.push(root);
    mkdirSync(join(root, 'decisions'));
    writeFileSync(join(root, 'decisions/DR-4.md'), '---\nid: DR-4\ntitle: x\nstatus: made\n---\n\nwhy\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: root });
    const bus = new Bus(root, { fresh: true });
    bus.emit('decision_recorded', { id: 'DR-4', title: 'x', invariant: 'DR-3', option: 'A', paths: [], alike: false });
    return { root, bus, repo: { root } as Repo };
  }

  it('records once through the CLI, writes the URN into the DR file, commits it alone, and emits alike: true', async () => {
    const { root, bus, repo } = repoWithDecision();
    const calls: string[][] = [];
    const urn = 'urn:alike:decision:' + 'ab'.repeat(32);
    const exec = async (_f: string, args: string[]) => { calls.push(args); return { stdout: JSON.stringify({ outcome: 'created', id: 'u1', urn }) }; };
    const items = [{ id: 'DR-4', decision: alikeDecision(map, dr4(), 'o/r') }];
    expect(await recordInAlike(repo, bus, items, exec)).toEqual([]);
    expect(calls[0]![0]).toBe('it');
    expect(calls[0]![1]).toBe('DR-4: Research tools never read outreach data; the run loop passes outreach context in');
    expect(JSON.parse(calls[0]![3]!).anchors.length).toBeGreaterThan(1);
    expect(readFileSync(join(root, 'decisions/DR-4.md'), 'utf8')).toContain(`alike_urn: ${urn}`);
    expect(execFileSync('git', ['log', '-1', '--format=%s', '--name-only'], { cwd: root, encoding: 'utf8' })).toContain('decisions/DR-4.md');
    expect(bus.events.at(-1)!.data).toMatchObject({ id: 'DR-4', alike: true, urn });
    await recordInAlike(repo, bus, items, exec); // dedupe: the URN is already there
    expect(calls).toHaveLength(1);
  });

  it('falls back to an MCP instruction when the CLI fails', async () => {
    const { bus, repo } = repoWithDecision();
    const exec = async () => { throw new Error('alike: not paired'); };
    const notes = await recordInAlike(repo, bus, [{ id: 'DR-4', decision: alikeDecision(map, dr4(), 'o/r') }], exec);
    expect(notes[0]).toContain('mcp__alike__record_decision');
    expect(bus.events.some((e) => e.kind === 'error' && String((e.data as { message: string }).message).includes('not paired'))).toBe(true);
  });

  it('takes the repository from HARNESS_REPO_SLUG, lowercased, else from origin', () => {
    const { root } = repoWithDecision();
    expect(repoSlug(root)).toBeNull();
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:JohnZ4021/Scout-Agent.git'], { cwd: root });
    expect(repoSlug(root)).toBe('johnz4021/scout-agent');
    process.env.HARNESS_REPO_SLUG = 'JohnZ4021/scout-agent-take3';
    expect(repoSlug(root)).toBe('johnz4021/scout-agent-take3');
  });
});
