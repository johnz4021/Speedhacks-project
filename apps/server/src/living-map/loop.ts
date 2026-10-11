// The living-map loop (NAVIGATION_PLAN §4.1, §4.3): at every turn end, measure drift deterministically; when a signal
// has persisted and no proposal is pending for its scope, run the cartographer out of band, score its candidates
// against the current map, and queue the best one as a proposal. Never runs while a turn is open; never blocks one.
import { writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import {
  reduce, historyFromUI, detectDrift, thresholdsFor, scoreMap, diffMaps, changeSignature, summarizeChanges, describeScores,
  parseDomainMap, createMapper, PROPOSAL_MARGIN,
  type DomainMap, type DriftSignal, type DriftSignalKind, type FileFacts, type HistoryTurn, type MapProposal, type MapScore, type ProposalChange, type UIState,
} from '@harness/core';
import { commitPaths } from '../git';
import type { Bus } from '../bus';
import type { Repo } from '../repo';
import { gitHistory } from './history';
import { semanticStore } from '../semantic';
import { sdkProposer, type Candidate, type Proposer } from './runner';
import { listRejected, listStanding, writeRejection } from './records';
import { labelsFor, sdkLabeler, type Labeler } from './labels';

/** Signals the cartographer acts on. Stale labels and bloated cells go to the labels job; reinforcement is the auditor's. */
const CARTOGRAPHER_SIGNALS = new Set<DriftSignalKind>(['unassigned', 'new_top_level', 'wide_turns', 'co_change', 'coupling_growth', 'rule_erosion']);

/** Candidates within this much of the best total count as "similar"; among them the least disruptive wins. */
export const SIMILAR = 0.05;

/**
 * How much a change set disturbs what already exists: moved files, removed ids, and edits to existing domains and
 * rules (rename, purpose rewrite, cell/domain removal, rule change/retire). Additions (new domain, new cell, placing
 * unassigned files, new rule) cost nothing: they extend the map rather than rewrite it.
 */
export function disruption(changes: readonly ProposalChange[]): number {
  const added = new Set(changes.flatMap((c) => (c.kind === 'add_domain' ? [c.domain] : [])));
  return changes.filter((c) => {
    if (c.kind === 'purpose') return !added.has(c.domain);
    return ['move', 'rename_domain', 'remove_domain', 'remove_cell', 'retire_rule', 'change_rule'].includes(c.kind);
  }).length;
}

export type LivingMapOptions = {
  bus: Bus;
  repo: Repo;
  proposer?: Proposer | null; // default: the Agent SDK cartographer (null when HARNESS_CARTOGRAPHER=0)
  labeler?: Labeler | null; // default: the Agent SDK labeler (null when HARNESS_LABELS=0)
  k?: number; // candidates per run (default 4, or HARNESS_CARTOGRAPHER_K)
  gitLimit?: number;
};

export type Result = { ok: true; decision?: string } | { ok: false; status: 400 | 404 | 409; error: string };

type Scored = { candidate: Candidate; map: DomainMap; changes: ReturnType<typeof diffMaps>; score: MapScore };

/** Pick the proposal: lowest total; among totals within SIMILAR of it, the least disruptive (then lowest total, then first). Null unless it beats current by the margin. */
export function chooseCandidate(current: MapScore, scored: readonly Pick<Scored, 'changes' | 'score'>[]): number | null {
  if (!scored.length) return null;
  const best = Math.min(...scored.map((s) => s.score.total));
  if (current.total - best < PROPOSAL_MARGIN) return null;
  let pick = -1;
  scored.forEach((s, i) => {
    if (s.score.total > best + SIMILAR) return;
    const p = scored[pick];
    const [a, b] = [disruption(s.changes), p ? disruption(p.changes) : Infinity];
    if (a < b || (a === b && s.score.total < p!.score.total)) pick = i;
  });
  return pick;
}

export function attachLivingMap(opts: LivingMapOptions) {
  const { bus, repo } = opts;
  const proposer = opts.proposer === undefined ? (process.env.HARNESS_CARTOGRAPHER === '0' ? null : sdkProposer) : opts.proposer;
  const labeler = opts.labeler === undefined ? (process.env.HARNESS_LABELS === '0' ? null : sdkLabeler) : opts.labeler;
  const k = opts.k ?? Number(process.env.HARNESS_CARTOGRAPHER_K ?? 4);
  let previous: DriftSignal[] | null = null;
  let queued = false;
  let cartographing = false;
  let labelling = false;
  const work = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>) => { work.add(p); const off = () => { work.delete(p); }; p.then(off, off); return p; };

  const ready = () => !!repo.map && repo.hasMap();
  /** Real Tier 1 facts, with Tier 2 calls where current (the same facts the graph is built from). */
  const facts = (): Record<string, FileFacts> => semanticStore(repo, bus).merged();
  const history = (ui: UIState): HistoryTurn[] => [...gitHistory(repo.root, opts.gitLimit), ...historyFromUI(ui)];

  /** Ids plus the domains they live in (files and cells), so scopes can be compared at domain granularity. */
  const expand = (ids: readonly string[]) => {
    const out = new Set(ids);
    for (const id of ids) {
      const cell = /^cell:([^/]+)\//.exec(id);
      if (cell) out.add(`domain:${cell[1]}`);
      else if (!id.includes(':')) { const d = repo.mapper.domainOf(id); if (d) out.add(`domain:${d}`); }
    }
    return out;
  };

  /** Measure drift now (or queue until the open turn ends), then start the cartographer / labels jobs if warranted. */
  function survey(): void {
    if (!ready()) return;
    if (bus.turn) { queued = true; return; }
    queued = false;
    const ui = reduce(bus.events);
    previous ??= ui.drift;
    const f = facts();
    const hist = history(ui);
    const t = thresholdsFor(repo.map);
    const signals = detectDrift(repo.map, f, ui, hist, t, previous);
    previous = signals;
    bus.emit('drift_detected', { signals }, { turn: null });

    const pending = Object.values(ui.proposals).filter((p) => p.status === 'pending').map((p) => expand(p.proposal.scope));
    const triggers = signals.filter((s) => CARTOGRAPHER_SIGNALS.has(s.signal) && s.persisted >= t.persist && !pending.some((ps) => [...expand(s.scope)].some((id) => ps.has(id))));
    if (triggers.length && proposer && !cartographing) {
      cartographing = true;
      track(cartograph(triggers, ui, f, hist)
        .catch((e: Error) => { bus.emit('error', { message: `Cartographer run failed: ${e.message}` }, { turn: null }); })
        .finally(() => { cartographing = false; }));
    }

    const stale = signals.find((s) => s.signal === 'stale_label')?.scope.flatMap((target) => {
      const pl = repo.place(target);
      return pl.kind === 'cell' && ui.labels[`group:${target}`] ? [`cell:${pl.domain}/${pl.layer}`] : [];
    }) ?? [];
    const cells = [...signals.filter((s) => s.signal === 'bloated_cell' && s.persisted >= t.persist).flatMap((s) => s.scope), ...stale];
    if (cells.length && labeler && !labelling) {
      labelling = true;
      track(label(cells).finally(() => { labelling = false; }));
    }
  }

  async function cartograph(triggers: DriftSignal[], ui: UIState, f: Record<string, FileFacts>, hist: HistoryTurn[]) {
    const t0 = Date.now();
    const base = repo.map, baseYaml = repo.mapText;
    const trigger = [...new Set(triggers.map((s) => s.signal))].join(',');
    const done = (ok: boolean, cost: number | null) => bus.emit('maintenance_run', { agent: 'cartographer', trigger, ms: Date.now() - t0, cost, ok }, { turn: null });

    // Scope: trigger scopes, their domains, and one hop along import edges.
    const scope = expand(triggers.flatMap((s) => s.scope));
    const mapper = createMapper(base);
    const hop = new Set<string>();
    for (const file of Object.values(f)) for (const imp of file.imports) {
      const a = mapper.domainOf(file.path), b = mapper.domainOf(imp.to);
      if (a && b && a !== b && (scope.has(`domain:${a}`) || scope.has(file.path))) hop.add(`domain:${b}`);
      if (a && b && a !== b && (scope.has(`domain:${b}`) || scope.has(imp.to))) hop.add(`domain:${a}`);
      if (!a && b && scope.has(file.path)) hop.add(`domain:${b}`); // unassigned file importing a domain
    }
    const fullScope = [...new Set([...scope, ...hop])].sort();
    const standing = listStanding(repo.root);
    const rejected = listRejected(repo.root);

    let result;
    try {
      result = await proposer!({
        root: repo.root, yaml: baseYaml, map: base, facts: f, signals: triggers, scope: fullScope, history: hist,
        turns: ui.turns.map((x) => ({ id: x.id, prompt: x.prompt, files: Object.keys(x.paths).filter((p) => x.paths[p]!.edits > 0).sort() })).filter((x) => x.files.length),
        decisions: standing, rejected, k,
      });
    } catch (e) {
      bus.emit('error', { message: `Cartographer failed: ${(e as Error).message}` }, { turn: null });
      return void done(false, (e as { cost?: number }).cost ?? null);
    }
    if (repo.mapText !== baseYaml) return void done(false, result.cost); // the map changed while it ran: stale

    const files = Object.keys(f);
    const seen = new Set(rejected.map((r) => r.signature));
    const scored: Scored[] = [];
    const decisionPaths = Object.fromEntries(standing.filter((d) => d.paths.length).map((d) => [d.id, d.paths]));
    for (const candidate of result.candidates.slice(0, k)) {
      let map: DomainMap;
      try { map = parseDomainMap(candidate.yaml); } catch { continue; } // invalid YAML or schema: dropped
      const changes = diffMaps(base, map, files);
      const sig = changeSignature(changes);
      if (!changes.length || seen.has(sig)) continue; // no-op, a repeat of a rejected proposal, or a duplicate
      seen.add(sig);
      scored.push({ candidate, map, changes, score: scoreMap(map, f, hist, { current: base, decisionPaths }) });
    }
    const current = scoreMap(base, f, hist, { current: base, decisionPaths });
    const chosen = chooseCandidate(current, scored);
    if (chosen === null) return void done(true, result.cost);

    const best = scored[chosen]!;
    const n = Math.max(0, ...Object.keys(reduce(bus.events).proposals).map((id) => Number(/^MP-(\d+)$/.exec(id)?.[1] ?? 0))) + 1;
    const touched = best.changes.flatMap((c): string[] => (c.kind === 'move' ? [`domain:${c.from.domain}`, `domain:${c.to.domain}`] : 'domain' in c ? [`domain:${c.domain}`] : []));
    const proposal: MapProposal = {
      id: `MP-${n}`,
      trigger: triggers,
      scope: [...new Set([...scope, ...touched])].sort(),
      candidates: scored.map((s) => ({ yaml: s.candidate.yaml, score: s.score })),
      chosen,
      current,
      changes: best.changes,
      rationale: `${best.candidate.title} ${best.candidate.rationale}`.trim(),
    };
    bus.emit('map_proposed', { map: base, yaml: baseYaml, proposal }, { turn: null });
    bus.emit('chat', { role: 'system', text: `Cartographer proposal ${proposal.id}: ${summarizeChanges(best.changes)} · ${describeScores(current, best.score)}` }, { turn: null });
    done(true, result.cost);
  }

  async function label(cells: string[]) {
    const t0 = Date.now();
    try {
      const r = await labelsFor({ root: repo.root, map: repo.map, facts: facts(), cells, labeler: labeler! });
      if (r.labels.length) bus.emit('labels_updated', { labels: r.labels }, { turn: null });
      if (r.calls) bus.emit('maintenance_run', { agent: 'cartographer', trigger: 'labels', ms: Date.now() - t0, cost: r.cost, ok: true }, { turn: null });
    } catch (e) {
      bus.emit('maintenance_run', { agent: 'cartographer', trigger: 'labels', ms: Date.now() - t0, cost: null, ok: false }, { turn: null });
      bus.emit('error', { message: `Labels failed: ${(e as Error).message}` }, { turn: null });
    }
  }

  const pendingProposal = (id: string): { proposal: MapProposal; yaml: string } | Result => {
    const p = reduce(bus.events).proposals[id];
    if (!p) return { ok: false, status: 404, error: `No proposal ${id}.` };
    if (p.status !== 'pending') return { ok: false, status: 409, error: `${id} is already ${p.status}.` };
    const at = bus.events.findLast((e) => e.kind === 'map_proposed' && (e.data as { proposal?: MapProposal }).proposal?.id === id);
    return { proposal: p.proposal, yaml: (at?.data as { yaml: string }).yaml };
  };

  /** Accept: write and commit domains.yaml (only it), reload the map, rescan, emit map_confirmed + resolved. */
  function accept(id: string, candidate?: number): Result {
    const p = pendingProposal(id);
    if ('ok' in p) return p;
    if (p.yaml !== repo.mapText) return { ok: false, status: 409, error: `domains.yaml changed since ${id} was proposed; run a survey for a fresh proposal.` };
    const idx = candidate ?? p.proposal.chosen;
    const yaml = p.proposal.candidates[idx]?.yaml;
    if (!yaml) return { ok: false, status: 400, error: `${id} has no candidate ${idx}.` };
    writeFileSync(repo.mapPath, yaml);
    try { commitPaths(repo.root, ['domains.yaml'], `docs(map): accept ${id}: ${summarizeChanges(diffMaps(repo.map, parseDomainMap(yaml), Object.keys(facts())))}`.slice(0, 100)); }
    catch (e) { bus.emit('error', { message: `Could not commit domains.yaml: ${(e as Error).message}` }, { turn: null }); }
    repo.setMap(yaml);
    bus.emit('map_confirmed', { map: repo.map, source: 'cartographer' }, { turn: null });
    repo.scan();
    bus.emit('map_proposal_resolved', { proposal: id, outcome: 'accepted' }, { turn: null });
    schedule();
    return { ok: true };
  }

  /** Reject: record decisions/DR-n.md (status: rejected) and commit only it; the cartographer is told never to repeat it. */
  function reject(id: string, reason?: string): Result {
    const p = pendingProposal(id);
    if ('ok' in p) return p;
    const { id: decision, path } = writeRejection(repo.root, repo.map, p.proposal, reason);
    try { commitPaths(repo.root, [path], `docs(decisions): ${decision} reject map proposal ${id}`); }
    catch (e) { bus.emit('error', { message: `Could not commit ${path}: ${(e as Error).message}` }, { turn: null }); }
    bus.emit('map_proposal_resolved', { proposal: id, outcome: 'rejected', decision }, { turn: null });
    return { ok: true, decision };
  }

  /** Survey on the next tick (after the emitter has finished closing the turn). */
  function schedule() {
    track(new Promise<void>((resolve) => setImmediate(() => {
      try { survey(); }
      catch (e) { bus.emit('error', { message: `Living map survey failed: ${(e as Error).message}` }, { turn: null }); }
      finally { resolve(); }
    })));
  }

  const off = bus.on((e) => {
    if (e.kind === 'turn_ended') schedule();
  });

  return {
    /** Survey now, or (while a turn is open) at its end. */
    survey() { schedule(); return { queued: !!bus.turn }; },
    accept,
    reject,
    get queued() { return queued; },
    /** Resolves once no survey, cartographer or labels job is in flight (for tests and shutdown). */
    async idle() { while (work.size) await Promise.allSettled([...work]); },
    detach: off,
  };
}

export type LivingMap = ReturnType<typeof attachLivingMap>;

/** HTTP endpoints, mounted under /api by the server. */
export function livingMapRoutes(lm: LivingMap) {
  const r = new Hono();
  const reply = (c: { json: (b: unknown, s?: 200 | 400 | 404 | 409) => Response }, res: Result) => (res.ok ? c.json(res) : c.json({ error: res.error }, res.status));
  r.post('/proposals/:id/accept', async (c) => {
    const body = await c.req.json<{ candidate?: number }>().catch(() => ({} as { candidate?: number }));
    return reply(c, lm.accept(c.req.param('id'), body.candidate));
  });
  r.post('/proposals/:id/reject', async (c) => {
    const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
    return reply(c, lm.reject(c.req.param('id'), body.reason));
  });
  r.post('/living-map/survey', (c) => c.json({ ok: true, ...lm.survey() }));
  return r;
}
