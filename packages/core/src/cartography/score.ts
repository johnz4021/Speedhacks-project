// scoreMap (NAVIGATION_PLAN §4.5): candidates are judged by deterministic metrics, never by the model's opinion.
import { createMapper, type Mapper } from '../mapper';
import type { DomainMap } from '../schema';
import type { FileFacts } from '../contracts/facts';
import type { HistoryTurn, MapScore } from '../contracts/cartography';
import type { ScoreMap } from '../contracts/api';
import { isBulk } from './history';
import { cellKeyOf, gini, mean, median, placementKey, repoImports, round } from './util';

/**
 * Weights of `MapScore.total` (lower is better). Rationale:
 * - cells lit per unit is the headline ("a typical turn lights 1.8 cells"): 1 per cell on the mean, 0.5 on the median;
 * - modularity Q lives in [-0.5, 1]; ×2 makes a clearly better partition (+0.1 Q) worth 0.2, about one in five turns lighting one fewer cell;
 * - each unassigned file costs 0.5, so placing even one file clears the proposal margin unless it widens turns;
 * - Gini of cell sizes (0..1) is a mild evenness nudge;
 * - breaking a standing decision costs 3, more than any plausible gain, so candidates practically never do it;
 * - churn is small per moved file (0.1) and larger per removed id (0.5): moving files beats re-cutting domains.
 */
export const SCORE_WEIGHTS = {
  cellsLitMean: 1,
  cellsLitMedian: 0.5,
  modularity: -2,
  unassigned: 0.5,
  cellSizeGini: 1,
  decisionsBroken: 3,
  churnFiles: 0.1,
  churnIds: 0.5,
} as const;

/**
 * A candidate is proposed only if `current.total - candidate.total >= PROPOSAL_MARGIN`. 0.25 is a quarter of a
 * cell per turn: below that the improvement is within the noise of a few odd turns, and proposing would churn.
 */
export const PROPOSAL_MARGIN = 0.25;

/** Distinct cells each history unit lights under `map` (unassigned files share one "Unassigned" cell). Bulk and empty units are skipped. */
export function cellsLitPerUnit(map: DomainMap | Mapper, facts: Readonly<Record<string, FileFacts>>, history: readonly HistoryTurn[]): number[] {
  const mapper = 'place' in map ? map : createMapper(map);
  const known = new Set(Object.keys(facts));
  const out: number[] = [];
  for (const unit of history) {
    if (isBulk(unit.files, known)) continue;
    const cells = new Set<string>();
    for (const f of unit.files) {
      if (!known.has(f)) continue; // deleted or non-code files say nothing about the current map
      const k = cellKeyOf(mapper.place(f));
      if (k) cells.add(k);
    }
    if (cells.size) out.push(cells.size);
  }
  return out;
}

/**
 * Newman modularity Q of the undirected file import graph, partitioned by domain. Nodes are code files in a cell
 * or unassigned (each unassigned file is its own community, so leaving coupled files unplaced is penalized);
 * neutral, ignored and test files are left out, as they draw no edges on the map.
 */
export function modularity(mapper: Mapper, facts: Readonly<Record<string, FileFacts>>): number {
  const community = new Map<string, string>();
  for (const path of Object.keys(facts)) {
    const p = mapper.place(path);
    if (p.kind === 'cell') community.set(path, p.domain);
    else if (p.kind === 'unassigned') community.set(path, `?${path}`);
  }
  const edges = new Set<string>();
  for (const f of Object.values(facts)) {
    if (!community.has(f.path)) continue;
    for (const to of repoImports(f)) {
      if (!community.has(to)) continue;
      edges.add(f.path < to ? `${f.path}\u0000${to}` : `${to}\u0000${f.path}`);
    }
  }
  const m = edges.size;
  if (!m) return 0;
  const intra = new Map<string, number>();
  const degree = new Map<string, number>();
  for (const e of edges) {
    const [a, b] = e.split('\u0000') as [string, string];
    const ca = community.get(a)!, cb = community.get(b)!;
    degree.set(ca, (degree.get(ca) ?? 0) + 1);
    degree.set(cb, (degree.get(cb) ?? 0) + 1);
    if (ca === cb) intra.set(ca, (intra.get(ca) ?? 0) + 1);
  }
  let q = 0;
  for (const [c, d] of degree) q += (intra.get(c) ?? 0) / m - (d / (2 * m)) ** 2;
  return q;
}

/** Decision ids a candidate would break vs `current` (see `ScoreMap`). */
export function brokenDecisions(map: DomainMap, current: DomainMap, decisionPaths: Readonly<Record<string, string[]>>): string[] {
  const before = createMapper(current);
  const after = createMapper(map);
  const broken = new Set<string>();
  for (const [id, paths] of Object.entries(decisionPaths)) {
    if (paths.some((p) => { const d = before.domainOf(p); return d !== null && d !== after.domainOf(p); })) broken.add(id);
  }
  const kept = new Set(map.invariants.map((i) => i.id));
  for (const inv of current.invariants) {
    if (kept.has(inv.id)) continue;
    for (const d of [...(inv.decisions ?? []), ...inv.exceptions.flatMap((e) => (e.decision ? [e.decision] : []))]) broken.add(d);
  }
  return [...broken].sort();
}

/** Domain ids, cells (in surviving domains) and invariant ids that `current` has and `map` lacks. */
export function removedIds(map: DomainMap, current: DomainMap): string[] {
  const out: string[] = [];
  const next = new Map(map.domains.map((d) => [d.id, d]));
  for (const d of current.domains) {
    const n = next.get(d.id);
    if (!n) { out.push(`domain:${d.id}`); continue; }
    for (const layer of Object.keys(d.cells)) if (!(layer in n.cells)) out.push(`cell:${d.id}/${layer}`);
  }
  const inv = new Set(map.invariants.map((i) => i.id));
  for (const i of current.invariants) if (!inv.has(i.id)) out.push(`rule:${i.id}`);
  return out;
}

/**
 * Score a map against facts and history (deterministic). Churn counts files that move between homes (cells, tests,
 * neutral); placing a previously unassigned file is not churn, it is what `unassigned` rewards.
 */
export const scoreMap: ScoreMap = (map, facts, history, opts = {}) => {
  const mapper = createMapper(map);
  const lit = cellsLitPerUnit(mapper, facts, history);
  const paths = Object.keys(facts).sort();

  let unassigned = 0;
  const cellSizes = new Map<string, number>();
  for (const d of map.domains) for (const layer of Object.keys(d.cells)) cellSizes.set(`${d.id}/${layer}`, 0);
  for (const p of paths) {
    const pl = mapper.place(p);
    if (pl.kind === 'unassigned') unassigned++;
    else if (pl.kind === 'cell') cellSizes.set(`${pl.domain}/${pl.layer}`, (cellSizes.get(`${pl.domain}/${pl.layer}`) ?? 0) + 1);
  }

  let churnFiles = 0, churnIds = 0, decisionsBroken = 0;
  if (opts.current) {
    const before = createMapper(opts.current);
    for (const p of paths) {
      const a = before.place(p);
      if (a.kind === 'unassigned' || a.kind === 'ignored') continue;
      if (placementKey(a) !== placementKey(mapper.place(p))) churnFiles++;
    }
    churnIds = removedIds(map, opts.current).length;
    decisionsBroken = brokenDecisions(map, opts.current, opts.decisionPaths ?? {}).length;
  }

  const s: Omit<MapScore, 'total'> = {
    cellsLitMean: round(mean(lit)),
    cellsLitMedian: round(median(lit)),
    modularity: round(modularity(mapper, facts)),
    unassigned,
    cellSizeGini: round(gini([...cellSizes.values()])),
    decisionsBroken,
    churnFiles,
    churnIds,
  };
  const w = SCORE_WEIGHTS;
  const total =
    w.cellsLitMean * s.cellsLitMean + w.cellsLitMedian * s.cellsLitMedian + w.modularity * s.modularity +
    w.unassigned * s.unassigned + w.cellSizeGini * s.cellSizeGini + w.decisionsBroken * s.decisionsBroken +
    w.churnFiles * s.churnFiles + w.churnIds * s.churnIds;
  return { ...s, total: round(total) };
};

/** One line for the proposal card: "turns would light 1.2 cells instead of 1.5 · 3 files placed · no decisions broken". */
export function describeScores(current: MapScore, next: MapScore): string {
  const parts = [`turns would light ${next.cellsLitMean} cell${next.cellsLitMean === 1 ? '' : 's'} instead of ${current.cellsLitMean}`];
  const placed = current.unassigned - next.unassigned;
  if (placed > 0) parts.push(`${placed} file${placed === 1 ? '' : 's'} placed`);
  if (next.churnFiles) parts.push(`${next.churnFiles} file${next.churnFiles === 1 ? '' : 's'} move`);
  parts.push(`modularity ${current.modularity} → ${next.modularity}`);
  parts.push(next.decisionsBroken ? `${next.decisionsBroken} decision${next.decisionsBroken === 1 ? '' : 's'} broken` : 'no decisions broken');
  return parts.join(' · ');
}
