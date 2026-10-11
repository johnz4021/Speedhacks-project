// Drift signals (NAVIGATION_PLAN §4.4): deterministic, from facts plus the event log. A signal triggers the
// cartographer only once it has persisted for `thresholds.persist` consecutive surveys.
import { createMapper, type Mapper } from '../mapper';
import type { DomainMap } from '../schema';
import type { FileFacts } from '../contracts/facts';
import { cellId, domainId, fileOf } from '../contracts/graph';
import { DEFAULT_THRESHOLDS, type DriftSignal, type DriftSignalKind, type DriftThresholds, type Label } from '../contracts/cartography';
import type { DetectDrift } from '../contracts/api';
import { cellsLitPerUnit } from './score';
import { isBulk } from './history';
import { TEST_FILE, fnv1a, median, repoImports, round } from './util';

const KIND_ORDER: DriftSignalKind[] = ['unassigned', 'new_top_level', 'wide_turns', 'co_change', 'coupling_growth', 'rule_erosion', 'rule_reinforcement', 'bloated_cell', 'stale_label'];

/** DEFAULT_THRESHOLDS overridden by `cartography.thresholds` in domains.yaml (unknown keys ignored). */
export function thresholdsFor(map: DomainMap | null): DriftThresholds {
  const out = { ...DEFAULT_THRESHOLDS };
  for (const [k, v] of Object.entries(map?.cartography?.thresholds ?? {})) if (k in out) out[k as keyof DriftThresholds] = v;
  return out;
}

/** Folder a path's "top-level code" belongs to: `src/<x>`, `packages/<x>` etc., else the first segment; null for root files. */
export function topFolder(path: string): string | null {
  const parts = path.split('/');
  if (parts.length < 2) return null;
  if (parts.length >= 3 && ['src', 'lib', 'app', 'packages', 'apps', 'services', 'modules'].includes(parts[0]!)) return `${parts[0]}/${parts[1]}`;
  return parts[0]!;
}

/** Code files placed in one cell, sorted. */
export function cellFiles(mapper: Mapper, facts: Readonly<Record<string, FileFacts>>, domain: string, layer: string): string[] {
  return Object.keys(facts).filter((p) => { const pl = mapper.place(p); return pl.kind === 'cell' && pl.domain === domain && pl.layer === layer; }).sort();
}

/** Hash a group label is keyed by: the cell's sorted file list (content edits don't rename sub-groups; membership changes do). */
export const groupHash = (files: readonly string[]) => fnv1a([...files].sort().join('\n'));

/** Current hash of what `label` describes, or null if its target is gone (group: file left its cell; summary: symbol removed). */
export function labelHash(mapper: Mapper, facts: Readonly<Record<string, FileFacts>>, label: Label): string | null {
  if (label.kind === 'summary') {
    const file = fileOf(label.target);
    return (file && facts[file]?.symbols.find((s) => s.id === label.target)?.bodyHash) ?? null;
  }
  if (label.kind === 'group') {
    const p = mapper.place(label.target);
    return p.kind === 'cell' ? groupHash(cellFiles(mapper, facts, p.domain, p.layer)) : null;
  }
  return label.hash; // journeys are re-validated by the journeys lane
}

const overlaps = (a: readonly string[], b: readonly string[]) => (a.length === 0 && b.length === 0) || a.some((x) => b.includes(x));

/**
 * Every signal in §4.4. `persisted` = 1 + the previous survey's `persisted` for a signal of the same kind whose
 * scope overlaps (equal-empty scopes match), so a scope that grows by a file keeps its count.
 * Comparison per signal: counts that must exceed (`unassigned`, `wide_turns`, `bloated_cell`) use `>`; "at least"
 * thresholds (`co_change`, `coupling_growth`, `rule_*`) use `>=`.
 */
export const detectDrift: DetectDrift = (map, facts, ui, history, t, previous = []) => {
  const mapper = createMapper(map);
  const paths = Object.keys(facts).sort();
  const known = new Set(paths);
  const out: Omit<DriftSignal, 'persisted'>[] = [];

  // Unplaced code, one signal per folder; and folders the map knows nothing about.
  const unassignedByDir = new Map<string, string[]>();
  const byTop = new Map<string, { all: number; unassigned: string[] }>();
  for (const p of paths) {
    const pl = mapper.place(p);
    if (pl.kind === 'unassigned') {
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.';
      unassignedByDir.set(dir, [...(unassignedByDir.get(dir) ?? []), p]);
    }
    const top = topFolder(p);
    if (top && !TEST_FILE.test(p) && pl.kind !== 'ignored') {
      const e = byTop.get(top) ?? { all: 0, unassigned: [] };
      e.all++;
      if (pl.kind === 'unassigned') e.unassigned.push(p);
      byTop.set(top, e);
    }
  }
  for (const [dir, files] of unassignedByDir) {
    if (files.length > t.unassigned) out.push({ signal: 'unassigned', metric: `files in Unassigned under ${dir}/`, value: files.length, threshold: t.unassigned, scope: files });
  }
  for (const [top, e] of byTop) {
    if (e.all > 0 && e.unassigned.length === e.all) out.push({ signal: 'new_top_level', metric: `new top-level folder ${top}/ (no file on the map)`, value: e.all, threshold: 0, scope: e.unassigned });
  }

  // Turns too wide: median cells lit over the last N Harness turns (needs min(3, N) turns).
  const turns = history.filter((h) => h.source === 'turn').slice(-t.wideTurnsWindow);
  const lit = cellsLitPerUnit(mapper, facts, turns);
  if (lit.length >= Math.min(3, t.wideTurnsWindow) && median(lit) > t.wideTurnsMedian) {
    const domains = new Set<string>();
    for (const u of turns) for (const f of u.files) { const d = known.has(f) ? mapper.domainOf(f) : null; if (d) domains.add(domainId(d)); }
    out.push({ signal: 'wide_turns', metric: `median cells lit per turn (last ${t.wideTurnsWindow})`, value: round(median(lit)), threshold: t.wideTurnsMedian, scope: [...domains].sort() });
  }

  // Co-change across a boundary: file pairs in different domains edited together in >= K of the last N units.
  const pairs = new Map<string, number>();
  for (const u of history.slice(-t.coChangeWindow)) {
    if (isBulk(u.files, known)) continue;
    const placed = [...new Set(u.files)].filter((f) => known.has(f)).map((f) => ({ f, d: mapper.place(f) }))
      .flatMap(({ f, d }) => (d.kind === 'cell' ? [{ f, domain: d.domain }] : [])).sort((a, b) => a.f.localeCompare(b.f));
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
      if (placed[i]!.domain === placed[j]!.domain) continue;
      const k = `${placed[i]!.f}\u0000${placed[j]!.f}`;
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
  }
  [...pairs].filter(([, n]) => n >= t.coChangeTurns).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).slice(0, 10).forEach(([k, n]) => {
    const [a, b] = k.split('\u0000') as [string, string];
    out.push({ signal: 'co_change', metric: `${a} and ${b} changed together (last ${t.coChangeWindow} turns or commits)`, value: n, threshold: t.coChangeTurns, scope: [a, b] });
  });

  // Coupling growth: importing files per directed domain pair now, vs before this log's turns added edges.
  const current = new Map<string, Set<string>>();
  const pairOf = (from: string, to: string) => {
    const a = mapper.place(from), b = mapper.place(to);
    return a.kind === 'cell' && b.kind === 'cell' && a.domain !== b.domain ? `${a.domain}\u0000${b.domain}` : null;
  };
  for (const f of Object.values(facts)) for (const to of repoImports(f)) {
    const k = pairOf(f.path, to);
    if (k) (current.get(k) ?? current.set(k, new Set()).get(k)!).add(f.path);
  }
  const added = new Set<string>();
  for (const turn of ui.turns) {
    for (const e of turn.edgesAdded) added.add(`${e.edge.from}\u0000${e.edge.to}`);
    for (const e of turn.edgesRemoved) added.delete(`${e.edge.from}\u0000${e.edge.to}`);
  }
  const grown = new Map<string, Set<string>>();
  for (const key of added) {
    const [from, to] = key.split('\u0000') as [string, string];
    const k = pairOf(from, to);
    if (k && facts[from] && repoImports(facts[from]!).includes(to)) (grown.get(k) ?? grown.set(k, new Set()).get(k)!).add(from);
  }
  for (const [k, g] of [...grown].sort(([a], [b]) => a.localeCompare(b))) {
    const [a, b] = k.split('\u0000') as [string, string];
    const base = (current.get(k)?.size ?? 0) - g.size;
    const scope = [domainId(a), domainId(b)];
    if (g.size >= t.couplingGrowthFiles) out.push({ signal: 'coupling_growth', metric: `files importing ${a} → ${b} added since the map was confirmed`, value: g.size, threshold: t.couplingGrowthFiles, scope });
    else if (base > 0 && g.size / base >= t.couplingGrowthRatio) out.push({ signal: 'coupling_growth', metric: `growth of ${a} → ${b} importing files since the map was confirmed`, value: round(g.size / base), threshold: t.couplingGrowthRatio, scope });
  }

  // Rule erosion and reinforcement, from invariants and recorded decisions (deduped by id).
  const decisions = [...new Map(ui.decisions.map((d) => [d.id, d])).values()];
  for (const inv of map.invariants) {
    const b = decisions.filter((d) => d.invariant === inv.id && d.option === 'B').length;
    if (inv.exceptions.length >= t.ruleErosionExceptions) out.push({ signal: 'rule_erosion', metric: `exceptions to ${inv.id}`, value: inv.exceptions.length, threshold: t.ruleErosionExceptions, scope: [`rule:${inv.id}`] });
    else if (b >= t.ruleErosionB) out.push({ signal: 'rule_erosion', metric: `option B (exception) chosen for ${inv.id}`, value: b, threshold: t.ruleErosionB, scope: [`rule:${inv.id}`] });
  }
  const reinforce = new Map<string, number>();
  for (const d of decisions) {
    if (d.option !== 'A') continue;
    const k = `${d.invariant}\u0000${(d.paths[0] && mapper.domainOf(d.paths[0])) ?? 'unassigned'}`;
    reinforce.set(k, (reinforce.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...reinforce].sort(([a], [b]) => a.localeCompare(b))) {
    const [inv, dom] = k.split('\u0000') as [string, string];
    if (n >= t.ruleReinforcement) out.push({ signal: 'rule_reinforcement', metric: `option A chosen for ${inv} in ${dom}`, value: n, threshold: t.ruleReinforcement, scope: [`rule:${inv}`, domainId(dom)] });
  }

  // Bloated cells: > N files, or > share of the domain (share rule only above N/2 files, so tiny domains never fire).
  for (const d of map.domains) {
    const sizes = Object.keys(d.cells).map((layer) => ({ layer, n: cellFiles(mapper, facts, d.id, layer).length }));
    const total = sizes.reduce((a, s) => a + s.n, 0);
    for (const { layer, n } of sizes) {
      const scope = [cellId(d.id, layer)];
      if (n > t.bloatedCellFiles) out.push({ signal: 'bloated_cell', metric: `files in ${d.id}/${layer}`, value: n, threshold: t.bloatedCellFiles, scope });
      else if (n > Math.ceil(t.bloatedCellFiles / 2) && n / total > t.bloatedCellShare) out.push({ signal: 'bloated_cell', metric: `share of ${d.id}'s files in ${layer}`, value: round(n / total), threshold: t.bloatedCellShare, scope });
    }
  }

  // Stale labels: what a label describes changed since it was written.
  const stale = Object.values(ui.labels).filter((l) => labelHash(mapper, facts, l) !== l.hash).map((l) => l.target).sort();
  if (stale.length) out.push({ signal: 'stale_label', metric: 'labels whose target changed', value: stale.length, threshold: 0, scope: stale });

  return out
    .sort((a, b) => KIND_ORDER.indexOf(a.signal) - KIND_ORDER.indexOf(b.signal) || a.scope.join().localeCompare(b.scope.join()))
    .map((s) => ({ ...s, persisted: (previous.find((p) => p.signal === s.signal && overlaps(p.scope, s.scope))?.persisted ?? 0) + 1 }));
};
