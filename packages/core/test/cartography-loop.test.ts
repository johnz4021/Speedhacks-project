// End-to-end: the server's living-map loop on a temp git copy of the fixture repo, with a FAKE proposer and labeler
// (no model calls). Lives here so `npm test` runs it; it imports the server's living-map modules directly.
import { afterAll, describe, expect, it } from 'vitest';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Bus } from '../../../apps/server/src/bus';
import { Repo } from '../../../apps/server/src/repo';
import { attachLivingMap, labelsFor, gitHistory, onboardingSkeleton, chooseCandidate, disruption, type ProposeInput, type Proposer, type Labeler } from '../../../apps/server/src/living-map';
import { reduce, type EventData, type HarnessEvent } from '../src/events';
import { parseDomainMap } from '../src/schema';
import { PROPOSAL_MARGIN } from '../src/cartography';
import { fixtureRepo, mapYaml } from './helpers';
import { BILLING, billingBlock } from './cartography-fixtures';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/** A throwaway git repo from the fixture (like scripts/sandbox.sh), with domains.yaml committed. */
function sandbox(yaml: string | null = mapYaml): string {
  const dir = realpathSync(mkdtempSync(join(process.env.HARNESS_TEST_TMP ?? tmpdir(), 'harness-lm-')));
  dirs.push(dir);
  cpSync(fixtureRepo, dir, { recursive: true });
  if (yaml) writeFileSync(join(dir, 'domains.yaml'), yaml);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@harness');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'fixture');
  return dir;
}

const FILES: Record<string, string> = {
  'src/billing/invoice.ts': 'import { db } from "../shared/db";\nimport { charge } from "./charge";\nexport function invoice(id: string, amount: number) {\n  db.insert("invoices", { id, amount });\n  return charge(id, amount);\n}\n',
  'src/billing/charge.ts': 'import { db } from "../shared/db";\nexport function charge(id: string, amount: number) {\n  db.update("invoices", id, { charged: amount });\n  return id;\n}\n',
  'src/billing/refund.ts': 'import { db } from "../shared/db";\nimport { charge } from "./charge";\nimport { invoice } from "./invoice";\nexport function refund(id: string) {\n  db.insert("invoices", { id: `${id}-refund` });\n  charge(id, 0);\n  return invoice;\n}\n',
};

/** Fake cartographer: a Billing domain, a fold into Research tools, an invalid map and a no-op. Records its inputs. */
function fakeProposer(calls: ProposeInput[]): Proposer {
  return async (input) => {
    calls.push(input);
    return {
      cost: 0,
      candidates: [
        { title: 'Fold billing into tools.', rationale: 'Smallest change.', yaml: input.yaml.replace('logic:    { paths: ["src/tools/**"] }', 'logic:    { paths: ["src/tools/**", "src/billing/**"] }') },
        { title: 'Add a Billing domain.', rationale: 'src/billing is its own product area.', yaml: input.yaml.replace('\n# Seeded by', `${billingBlock}\n# Seeded by`) },
        { title: 'Broken.', rationale: '', yaml: 'domains: [' },
        { title: 'No change.', rationale: '', yaml: input.yaml },
      ],
    };
  };
}

function setup(yaml: string | null = mapYaml, opts: { proposer?: Proposer | null; labeler?: Labeler | null } = {}) {
  const root = sandbox(yaml);
  const bus = new Bus(root, { fresh: true });
  const repo = new Repo(root, bus);
  repo.loadMapFile();
  bus.emit('map_confirmed', { map: repo.map, source: 'file' }, { turn: null });
  repo.scan();
  const calls: ProposeInput[] = [];
  const lm = attachLivingMap({ bus, repo, proposer: opts.proposer === undefined ? fakeProposer(calls) : opts.proposer, labeler: opts.labeler ?? null, gitLimit: 50 });
  /** A coding turn as the session drives it: hooks report edits, then turn_ended, then the turn closes. */
  const turn = (id: string, write: () => string[]) => {
    bus.turn = id;
    bus.emit('turn_started', { prompt: `turn ${id}`, head: '', baseline: '' });
    for (const p of write()) repo.fileChanged(p, { tool: 'Write' });
    bus.emit('turn_ended', { added: 1, removed: 0, files: [], reason: 'success' });
    bus.turn = null;
  };
  const writeBilling = () => {
    mkdirSync(join(root, 'src/billing'), { recursive: true });
    for (const [p, text] of Object.entries(FILES)) writeFileSync(join(root, p), text);
    return Object.keys(FILES);
  };
  const touchInvoice = () => { appendFileSync(join(root, 'src/billing/invoice.ts'), '\nexport const VERSION = 1;\n'); return ['src/billing/invoice.ts']; };
  const of = <K extends keyof EventData>(kind: K) => bus.events.filter((e): e is HarnessEvent & { data: EventData[K] } => e.kind === kind).map((e) => e.data as EventData[K]);
  return { root, bus, repo, lm, calls, turn, writeBilling, touchInvoice, of };
}

describe('living-map loop (fake proposer)', () => {
  it('drift persists over two turns → scored proposal → accept commits only domains.yaml and reloads the map', async () => {
    const { root, repo, lm, calls, turn, writeBilling, touchInvoice, of, bus } = setup();

    turn('t1', writeBilling);
    await lm.idle();
    const d1 = of('drift_detected').at(-1)!.signals;
    expect(d1.find((s) => s.signal === 'unassigned')).toMatchObject({ value: 3, scope: BILLING, persisted: 1 });
    expect(calls).toHaveLength(0);

    turn('t2', touchInvoice);
    await lm.idle();
    const d2 = of('drift_detected').at(-1)!.signals;
    expect(d2.find((s) => s.signal === 'unassigned')).toMatchObject({ value: 3, persisted: 2 });
    expect(d2.find((s) => s.signal === 'new_top_level')).toMatchObject({ persisted: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signals.map((s) => s.signal)).toEqual(['unassigned', 'new_top_level']);
    expect(calls[0]!.rejected).toEqual([]);
    expect(calls[0]!.turns.map((t) => t.files)).toEqual([BILLING, ['src/billing/invoice.ts']]);
    expect(calls[0]!.scope).toEqual(expect.arrayContaining([...BILLING]));

    const proposed = of('map_proposed').filter((p) => p.proposal);
    expect(proposed).toHaveLength(1);
    const { proposal, yaml, map } = proposed[0]!;
    expect(yaml).toBe(mapYaml); // the current map rides along unchanged; the reducer keeps it
    expect(map.domains.map((d) => d.id)).not.toContain('billing');
    expect(proposal!.id).toBe('MP-1');
    expect(proposal!.candidates).toHaveLength(2); // invalid and no-op candidates dropped
    expect(proposal!.changes).toContainEqual({ kind: 'add_domain', domain: 'billing', name: 'Billing' });
    expect(proposal!.changes.filter((c) => c.kind === 'place')).toHaveLength(3);
    const chosen = proposal!.candidates[proposal!.chosen]!;
    expect(chosen.score.unassigned).toBe(0);
    expect(proposal!.current.unassigned).toBe(3);
    expect(chosen.score.modularity).toBeGreaterThan(proposal!.current.modularity);
    expect(proposal!.current.total - chosen.score.total).toBeGreaterThanOrEqual(PROPOSAL_MARGIN);
    expect(Math.min(...proposal!.candidates.map((c) => c.score.total))).toBe(chosen.score.total);
    expect(proposal!.scope).toContain('domain:billing');
    expect(of('maintenance_run').at(-1)).toMatchObject({ agent: 'cartographer', trigger: 'unassigned,new_top_level', ok: true, cost: 0 });
    expect(reduce(bus.events).proposals['MP-1']!.status).toBe('pending');

    // A third turn while MP-1 is pending: drift persists, but the scope is covered, so no new run.
    turn('t3', touchInvoice);
    await lm.idle();
    expect(calls).toHaveLength(1);

    const head = git(root, 'rev-parse', 'HEAD');
    expect(lm.accept('MP-1')).toEqual({ ok: true });
    expect(git(root, 'rev-list', '--count', `${head}..HEAD`)).toBe('1');
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('domains.yaml');
    expect(git(root, 'status', '--porcelain')).toContain('?? src/billing/'); // the session's work stays uncommitted
    expect(parseDomainMap(readFileSync(join(root, 'domains.yaml'), 'utf8')).domains.at(-1)!.id).toBe('billing');
    expect(repo.place('src/billing/refund.ts')).toEqual({ kind: 'cell', domain: 'billing', layer: 'logic' });

    await lm.idle();
    const ui = reduce(bus.events);
    expect(ui.map!.domains.map((d) => d.id)).toContain('billing');
    expect(ui.files['src/billing/invoice.ts']).toEqual({ kind: 'cell', domain: 'billing', layer: 'logic' });
    expect(ui.proposals['MP-1']!.status).toBe('accepted');
    expect(ui.drift.filter((s) => s.signal === 'unassigned')).toEqual([]);
    expect(lm.accept('MP-1')).toMatchObject({ ok: false, status: 409 });
    expect(lm.accept('MP-9')).toMatchObject({ ok: false, status: 404 });
  });

  it('reject records a DR with status: rejected (only that file committed); the proposer gets it next time and it is never re-proposed', async () => {
    const { root, lm, calls, turn, writeBilling, touchInvoice, of, bus } = setup();
    turn('t1', writeBilling);
    turn('t2', touchInvoice);
    await lm.idle();
    const mp1 = of('map_proposed').find((p) => p.proposal)!.proposal!;
    expect(mp1.changes).toContainEqual({ kind: 'add_domain', domain: 'billing', name: 'Billing' });

    expect(lm.reject('MP-1', 'Billing stays unplaced until the pricing work lands')).toEqual({ ok: true, decision: 'DR-4' });
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('decisions/DR-4.md');
    const dr = readFileSync(join(root, 'decisions/DR-4.md'), 'utf8');
    expect(dr).toMatch(/^---\nid: DR-4\n/);
    expect(dr).toContain('status: rejected');
    expect(dr).toContain('proposal: MP-1');
    expect(dr).toContain('pricing work lands');
    expect(git(root, 'status', '--porcelain')).toContain('?? src/billing/');
    expect(reduce(bus.events).proposals['MP-1']).toMatchObject({ status: 'rejected', decision: 'DR-4' });
    expect(of('map_proposal_resolved').at(-1)).toEqual({ proposal: 'MP-1', outcome: 'rejected', decision: 'DR-4' });

    turn('t3', touchInvoice);
    await lm.idle();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.rejected).toEqual([expect.objectContaining({ decision: 'DR-4', proposal: 'MP-1', changes: mp1.changes })]);
    // The fake repeats Billing; the loop drops it. The other candidate (fold into tools) is new, so it may be proposed.
    const later = of('map_proposed').filter((p) => p.proposal && p.proposal.id !== 'MP-1');
    for (const p of later) expect(p.proposal!.changes).not.toContainEqual({ kind: 'add_domain', domain: 'billing', name: 'Billing' });
    expect(later.map((p) => p.proposal!.id)).toEqual(['MP-2']);
    expect(later[0]!.proposal!.changes.filter((c) => c.kind === 'place').map((c) => c.kind === 'place' && c.domain)).toEqual(['tools', 'tools', 'tools']);
  });

  it('queues a survey while a turn is open, and labels bloated cells once (cached by membership)', async () => {
    const yaml = `${mapYaml}\ncartography:\n  thresholds: { bloatedCellFiles: 4, bloatedCellShare: 1 }\n`;
    const seen: string[] = [];
    const labeler: Labeler = async ({ cell, files }) => {
      seen.push(cell);
      return { cost: 0.01, groups: [{ name: 'News', files: files.filter((f) => f.includes('news')) }, { name: 'Lookup', files: files.filter((f) => !f.includes('news')) }] };
    };
    const { root, bus, lm, of } = setup(yaml, { proposer: null, labeler });
    bus.turn = 'open';
    expect(lm.survey()).toEqual({ queued: true });
    await lm.idle();
    expect(of('drift_detected')).toHaveLength(0);
    bus.turn = null;
    lm.survey();
    await lm.idle();
    lm.survey();
    await lm.idle();
    expect(seen).toEqual(['cell:tools/logic']); // persisted 2 → one labeler call
    const labels = of('labels_updated').at(-1)!.labels;
    expect(labels.map((l) => [l.target, l.text])).toEqual([
      ['src/tools/news-digest.ts', 'News'], ['src/tools/news-summarize.ts', 'News'],
      ['src/tools/company-profile.ts', 'Lookup'], ['src/tools/index.ts', 'Lookup'], ['src/tools/web-search.ts', 'Lookup'],
    ]);
    expect(labels.every((l) => l.kind === 'group' && !l.confirmed && l.hash === labels[0]!.hash)).toBe(true);
    expect(of('maintenance_run').at(-1)).toMatchObject({ trigger: 'labels', cost: 0.01, ok: true });
    lm.survey();
    await lm.idle();
    expect(seen).toHaveLength(1); // cached under .harness/labels/<hash>.json
    expect(readFileSync(join(root, `.harness/labels/${labels[0]!.hash}.json`), 'utf8')).toContain('"News"');
    const direct = await labelsFor({ root, map: parseDomainMap(yaml), facts: {}, cells: ['cell:tools/logic'], labeler });
    expect(direct).toEqual({ labels: [], cost: 0, calls: 0 }); // no files in the cell: nothing to label
  });
});

describe('chooseCandidate', () => {
  const score = (total: number) => ({ cellsLitMean: 1, cellsLitMedian: 1, modularity: 0, unassigned: 0, cellSizeGini: 0, decisionsBroken: 0, churnFiles: 0, churnIds: 0, total });
  const place = (domain: string) => BILLING.map((path) => ({ kind: 'place' as const, path, domain, layer: 'data' }));
  // Shapes from the real cartographer run: a new Billing domain vs. renaming an existing domain to absorb it.
  const newDomain = [{ kind: 'add_domain' as const, domain: 'billing', name: 'Billing' }, { kind: 'purpose' as const, domain: 'billing', purpose: 'x' }, { kind: 'add_cell' as const, domain: 'billing', layer: 'data' }, ...place('billing'), { kind: 'change_rule' as const, invariant: 'DR-2', rule: 'r' }];
  const absorb = [{ kind: 'rename_domain' as const, domain: 'gateway', from: 'Model gateway', to: 'Gateway & billing' }, { kind: 'purpose' as const, domain: 'gateway', purpose: 'y' }, ...place('gateway')];

  it('extending the map is less disruptive than rewriting an existing domain', () => {
    expect(disruption(newDomain)).toBe(1);
    expect(disruption(absorb)).toBe(2);
    expect(chooseCandidate(score(2.418), [{ changes: absorb, score: score(0.832) }, { changes: newDomain, score: score(0.764) }])).toBe(1);
    // within SIMILAR, the less disruptive one wins even if it scores slightly worse
    expect(chooseCandidate(score(2.418), [{ changes: absorb, score: score(0.76) }, { changes: newDomain, score: score(0.79) }])).toBe(1);
    expect(chooseCandidate(score(1), [{ changes: newDomain, score: score(0.8) }])).toBeNull(); // below the margin
    expect(chooseCandidate(score(1), [])).toBeNull();
  });
});

describe('living-map node helpers', () => {
  it('gitHistory lists commits oldest first without Harness files', () => {
    const root = sandbox();
    mkdirSync(join(root, 'decisions'));
    writeFileSync(join(root, 'decisions/DR-9.md'), 'x');
    appendFileSync(join(root, 'src/tools/index.ts'), '\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'second');
    const h = gitHistory(root);
    expect(h).toHaveLength(2);
    expect(h[1]).toMatchObject({ source: 'commit', files: ['src/tools/index.ts'] });
    expect(h[0]!.files).toContain('src/gateway/complete.ts');
    expect(h[0]!.files).not.toContain('domains.yaml');
    expect(gitHistory(join(root, 'src'))).toHaveLength(2); // inside the repo still works
  });

  it('onboardingSkeleton gives a valid instant map for a repo without domains.yaml', () => {
    const root = sandbox(null);
    const text = onboardingSkeleton(root);
    const map = parseDomainMap(text);
    expect(map.domains.map((d) => d.id)).toEqual(['channels', 'gateway', 'memory', 'orchestrator', 'outreach', 'tools']);
  });
});
