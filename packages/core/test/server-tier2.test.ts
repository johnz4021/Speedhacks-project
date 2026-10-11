// Server wiring for Tier 2 and the N5 leftovers, on temp git copies of the fixture repo (no model calls: fake
// proposers only): facts_resolved from the semantic child, the SemanticStore behind the graph tools and the living
// map, config-file rescans (Interpretability's own domains.yaml writes don't rescan), barrel relinks, and onboarding.
import { afterAll, describe, expect, it } from 'vitest';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Bus } from '../../../apps/server/src/bus';
import { Repo } from '../../../apps/server/src/repo';
import { attachSemantic, semanticStore } from '../../../apps/server/src/semantic';
import { attachLivingMap, buildPrompt, onboardingSkeleton, proposeOnboarding, type ProposeInput, type Proposer } from '../../../apps/server/src/living-map';
import { reduce, type EventData, type HarnessEvent } from '../src/events';
import { parseDomainMap } from '../src/schema';
import { fixtureRepo, mapYaml } from './helpers';

const dirs: string[] = [];
const closers: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sandbox(yaml: string | null = mapYaml, extra: Record<string, string> = {}): string {
  const dir = realpathSync(mkdtempSync(join(process.env.HARNESS_TEST_TMP ?? tmpdir(), 'harness-t2-')));
  dirs.push(dir);
  cpSync(fixtureRepo, dir, { recursive: true });
  if (yaml) writeFileSync(join(dir, 'domains.yaml'), yaml);
  for (const [p, text] of Object.entries(extra)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@harness');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'fixture');
  return dir;
}

function setup(extra: Record<string, string> = {}) {
  const root = sandbox(mapYaml, extra);
  const bus = new Bus(root, { fresh: true });
  const repo = new Repo(root, bus);
  repo.loadMapFile();
  bus.emit('map_confirmed', { map: repo.map, source: 'file' }, { turn: null });
  closers.push(() => repo.close());
  const of = <K extends keyof EventData>(kind: K) => bus.events.filter((e): e is HarnessEvent & { data: EventData[K] } => e.kind === kind);
  return { root, bus, repo, of };
}

describe('Tier 2 on the server', () => {
  it('emits facts_resolved per file after a scan, re-resolves edits, and the graph store follows the current hashes', async () => {
    const { root, bus, repo, of } = setup();
    const semantic = attachSemantic(bus, repo)!;
    closers.push(() => semantic.close());
    repo.scan();
    await semantic.idle();
    const resolved = of('facts_resolved');
    expect(resolved.length).toBe(repo.fileFacts.size);
    expect(new Set(resolved.map((e) => e.path)).size).toBe(repo.fileFacts.size);
    const ui = reduce(bus.events);
    expect(Object.keys(ui.semantic).length).toBe(repo.fileFacts.size); // every hash matched in the reducer too
    const ns = ui.semantic['src/tools/news-summarize.ts']!;
    expect(ns.implements).toEqual([{ from: 'src/tools/news-summarize.ts#newsSummarize.run', to: 'src/shared/types.ts#Tool.run' }]);
    expect(ns.calls.map((c) => `${c.to} ${c.confidence}`)).toEqual(['vendor/llm-openai/index.ts#chat typed', 'vendor/news/index.ts#call typed']);

    const store = semanticStore(repo, bus);
    expect(store.coverage()).toEqual({ typed: repo.fileFacts.size, files: repo.fileFacts.size });
    const g1 = store.graph();
    expect(store.graph()).toBe(g1); // cached until something changes
    expect(g1.edges.some((e) => e.kind === 'implements' && e.to === 'src/shared/types.ts#Tool.run')).toBe(true);

    // An edit: the stale entry drops at once; the new one arrives after the debounce, for the new hash.
    const path = 'src/tools/news-summarize.ts';
    appendFileSync(join(root, path), '\nexport function extra() { return 1; }\n');
    const t0 = performance.now();
    repo.fileChanged(path, { tool: 'Edit' });
    expect(store.facts[path]).toBeUndefined();
    expect(store.graph()).not.toBe(g1);
    await semantic.idle();
    const ms = performance.now() - t0;
    const last = of('facts_resolved').at(-1)!;
    expect(last.path).toBe(path);
    expect(last.data.facts.hash).toBe(repo.fileFacts.get(path)!.hash);
    expect(store.facts[path]?.hash).toBe(repo.fileFacts.get(path)!.hash);
    expect(ms).toBeLessThan(1500); // 150 ms debounce + one snapshot update + re-resolve
    expect(semantic.status().state).toBe('ready');
  });

  it('is off with HARNESS_SEMANTIC=0', () => {
    const { bus, repo } = setup();
    process.env.HARNESS_SEMANTIC = '0';
    try { expect(attachSemantic(bus, repo)).toBeNull(); } finally { delete process.env.HARNESS_SEMANTIC; }
  });
});

describe('config-file rescans', () => {
  it('rescans on package.json / tsconfig changes and user edits of domains.yaml, never on Interpretability\'s own writes', () => {
    const { root, repo, of } = setup();
    repo.scan();
    const scans = () => of('repo_scanned').length;
    expect(scans()).toBe(1);

    // Interpretability writes domains.yaml the way decisions/accept do: file, then setMap with the same text.
    const own = `${mapYaml}\n# exception recorded by Interpretability\n`;
    writeFileSync(repo.mapPath, own);
    repo.setMap(own);
    expect(repo.applyConfigChanges(['domains.yaml'])).toBe(false);
    expect(scans()).toBe(1);

    // The user edits it by hand: reload the map and rescan once.
    writeFileSync(repo.mapPath, `${own}# edited by hand\n`);
    expect(repo.applyConfigChanges(['domains.yaml'])).toBe(true);
    expect(scans()).toBe(2);
    expect(of('map_confirmed').at(-1)!.data.source).toBe('file');

    // An invalid hand edit keeps the old map and doesn't rescan.
    writeFileSync(repo.mapPath, 'domains: [');
    expect(repo.applyConfigChanges(['domains.yaml'])).toBe(false);
    expect(of('error').at(-1)!.data.message).toMatch(/keeping the previous map/);
    writeFileSync(repo.mapPath, repo.mapText);

    // package.json gains a bin: entries come from a fresh index after the rescan.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(root, 'package.json'), JSON.stringify({ ...pkg, bin: { scoutctl: 'src/channels/cli.ts' } }));
    expect(repo.applyConfigChanges(['package.json'])).toBe(true);
    expect(scans()).toBe(3);
    expect(repo.fileFacts.get('src/channels/cli.ts')!.entries.map((e) => e.id)).toContain('entry:bin:scoutctl');
  });

  it('the watcher triggers them (tsconfig.json), and ignores Interpretability\'s own domains.yaml write', async () => {
    const { root, repo, of } = setup();
    repo.scan();
    repo.startWatcher();
    await sleep(300); // chokidar's initial crawl
    const scans = () => of('repo_scanned').length;
    writeFileSync(join(root, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }\n');
    for (let i = 0; i < 40 && scans() < 2; i++) await sleep(100);
    expect(scans()).toBe(2);

    const own = `${repo.mapText}\n# written by Interpretability\n`;
    writeFileSync(repo.mapPath, own);
    repo.setMap(own);
    await sleep(900);
    expect(scans()).toBe(2);
  });
});

describe('barrel relink', () => {
  const LIB = {
    'src/lib/a.ts': 'export function alpha() {\n  return 1;\n}\n',
    'src/lib/b.ts': 'export function beta() {\n  return 2;\n}\n',
    'src/lib/index.ts': "export { alpha } from './a';\n",
    'src/use.ts': "import { alpha } from './lib';\nexport function run() {\n  return alpha();\n}\n",
  };
  const callsOf = (repo: Repo, p: string) => repo.fileFacts.get(p)!.calls.map((c) => `${c.from} -> ${c.to}`);

  it('re-links importers when a barrel re-points an export, and through barrels when a symbol disappears', () => {
    const { root, repo, of } = setup(LIB);
    repo.scan();
    expect(callsOf(repo, 'src/use.ts')).toEqual(['src/use.ts#run -> src/lib/a.ts#alpha']);

    writeFileSync(join(root, 'src/lib/index.ts'), "export { beta as alpha } from './b';\n");
    repo.fileChanged('src/lib/index.ts', { tool: 'Write' });
    expect(callsOf(repo, 'src/use.ts')).toEqual(['src/use.ts#run -> src/lib/b.ts#beta']);
    const changed = of('facts_changed').filter((e) => e.path === 'src/use.ts');
    expect(changed).toHaveLength(1);
    expect(of('call_added').filter((e) => e.path === 'src/use.ts').map((e) => e.data.to)).toEqual(['src/lib/b.ts#beta']);
    expect(of('call_removed').filter((e) => e.path === 'src/use.ts').map((e) => e.data.to)).toEqual(['src/lib/a.ts#alpha']);

    // Back to `export *`, then a.ts renames alpha: use.ts (behind the barrel) no longer reaches a.ts.
    writeFileSync(join(root, 'src/lib/index.ts'), "export * from './a';\n");
    repo.fileChanged('src/lib/index.ts', { tool: 'Write' });
    expect(callsOf(repo, 'src/use.ts')).toEqual(['src/use.ts#run -> src/lib/a.ts#alpha']);
    writeFileSync(join(root, 'src/lib/a.ts'), 'export function alpha2() {\n  return 1;\n}\n');
    repo.fileChanged('src/lib/a.ts', { tool: 'Write' });
    expect(callsOf(repo, 'src/use.ts')).toEqual(['src/use.ts#run -> src/lib/index.ts']);

    // A body-only edit relinks nothing.
    const before = of('facts_changed').length;
    writeFileSync(join(root, 'src/lib/a.ts'), 'export function alpha2() {\n  return 42;\n}\n');
    repo.fileChanged('src/lib/a.ts', { tool: 'Write' });
    expect(of('facts_changed').length).toBe(before + 1); // a.ts itself only
  });
});

describe('onboarding (no domains.yaml)', () => {
  it('scores the cartographer\'s K candidates and returns the best; invalid ones are dropped', async () => {
    const root = sandbox(null);
    const bus = new Bus(root, { fresh: true });
    const inputs: ProposeInput[] = [];
    const weak = mapYaml.replace(/paths: \[[^\]]*\]/g, 'paths: ["nowhere/**"]');
    const proposer: Proposer = async (input) => {
      inputs.push(input);
      return { cost: 0, candidates: [
        { title: 'Broken.', rationale: '', yaml: 'domains: [' },
        { title: 'Nothing placed.', rationale: '', yaml: weak },
        { title: 'Scout map.', rationale: 'Product domains.', yaml: mapYaml },
      ] };
    };
    const best = await proposeOnboarding({ root, bus, proposer, k: 4, gitLimit: 20 });
    expect(best).not.toBeNull();
    expect(best!.candidate.title).toBe('Scout map.');
    expect(best!.scored).toBe(2);
    expect(best!.score.unassigned).toBeLessThan(best!.skeleton.unassigned + 1);
    expect(parseDomainMap(best!.yaml).domains.map((d) => d.id)).toEqual(parseDomainMap(mapYaml).domains.map((d) => d.id));

    const input = inputs[0]!;
    expect(input).toMatchObject({ mode: 'onboard', k: 4, signals: [], turns: [] });
    expect(input.yaml).toBe(onboardingSkeleton(root).replace(/^#.*\n\n/, ''));
    expect(input.facts['src/tools/news-summarize.ts']!.symbols.length).toBeGreaterThan(0); // real Tier 1 facts
    const prompt = buildPrompt(input);
    expect(prompt).toContain('There is no confirmed map yet');
    expect(prompt).not.toContain('## Signals');
    const runs = bus.events.filter((e) => e.kind === 'maintenance_run').map((e) => e.data);
    expect(runs).toEqual([expect.objectContaining({ agent: 'cartographer', trigger: 'onboarding', ok: true, cost: 0 })]);
  });

  it('returns null when no candidate is valid', async () => {
    const root = sandbox(null);
    const bus = new Bus(root, { fresh: true });
    const proposer: Proposer = async () => ({ cost: null, candidates: [{ title: 'x', rationale: '', yaml: 'nope: [' }] });
    expect(await proposeOnboarding({ root, bus, proposer, k: 4 })).toBeNull();
  });
});

describe('living map facts', () => {
  it('hands the cartographer real Tier 1 facts (symbols, calls, hashes), with Tier 2 calls where current', async () => {
    const { root, bus, repo } = setup();
    repo.scan();
    const store = semanticStore(repo, bus);
    // Pretend Tier 2 resolved one file: its calls replace Tier 1's in what the living map sees.
    const f = repo.fileFacts.get('src/orchestrator/agent.ts')!;
    bus.emit('facts_resolved', { facts: { path: f.path, hash: f.hash, calls: [{ from: `${f.path}#runAgent`, to: 'src/memory/retrieve.ts#retrieve', confidence: 'typed', count: 1 }], implements: [] } }, { path: f.path, turn: null });
    bus.emit('facts_resolved', { facts: { path: 'src/tools/web-search.ts', hash: 'stale', calls: [], implements: [] } }, { turn: null });
    expect(Object.keys(store.facts)).toEqual(['src/orchestrator/agent.ts']);

    const inputs: ProposeInput[] = [];
    const lm = attachLivingMap({ bus, repo, proposer: async (i) => { inputs.push(i); return { cost: 0, candidates: [] }; }, labeler: null, gitLimit: 20 });
    const turn = (id: string, files: Record<string, string>) => {
      bus.turn = id;
      bus.emit('turn_started', { prompt: id, head: '', baseline: '' });
      for (const [p, text] of Object.entries(files)) {
        mkdirSync(join(root, p, '..'), { recursive: true });
        writeFileSync(join(root, p), text);
        repo.fileChanged(p, { tool: 'Write' });
      }
      bus.emit('turn_ended', { added: 1, removed: 0, files: [], reason: 'success' });
      bus.turn = null;
    };
    turn('t1', { 'src/billing/invoice.ts': 'export function invoice() {\n  return 1;\n}\n' });
    await lm.idle();
    turn('t2', { 'src/billing/invoice.ts': 'export function invoice() {\n  return 2;\n}\n' });
    await lm.idle();
    lm.detach();
    expect(inputs).toHaveLength(1);
    const facts = inputs[0]!.facts;
    expect(facts['src/tools/news-summarize.ts']!.symbols.map((s) => s.id)).toContain('src/tools/news-summarize.ts#newsSummarize.run');
    expect(facts['src/tools/news-summarize.ts']!.hash).not.toBe('');
    expect(facts['src/billing/invoice.ts']!.symbols.map((s) => s.name)).toEqual(['invoice']);
    expect(facts['src/orchestrator/agent.ts']!.calls).toEqual([{ from: 'src/orchestrator/agent.ts#runAgent', to: 'src/memory/retrieve.ts#retrieve', confidence: 'typed', count: 1 }]);
  });
});
