// activityFor: the selected turn's activity per leaf (file and symbol ids), a pure read of the reduced UI state.
import type { UIState } from '../events';
import type { TurnActivity } from '../contracts/api';
import { edgeId, fileOf, type ContextGraph, type LeafActivity, type ProposalMark, type ViolationState } from '../contracts/graph';
import { byId, edgeIds, outEdges } from './util';

const PROPOSAL_RANK: Record<NonNullable<ProposalMark>, number> = { rename: 1, add: 2, move_in: 3, move_out: 4, remove: 5 };
/** The stronger of two proposal marks (remove > move_out > move_in > add > rename). */
export const strongerMark = (a: ProposalMark, b: ProposalMark): ProposalMark => (!a ? b : !b ? a : PROPOSAL_RANK[b] > PROPOSAL_RANK[a] ? b : a);

export const emptyLeaf = (): LeafActivity => ({
  looked: false, edited: false, added: 0, removed: 0, created: false, unattributed: false, ghostSteps: [], planned: false,
  unplanned: false, violation: null, cursor: false, symbols: null, audit: 0, proposal: null,
});

const normalize = (p: string) => p.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.').join('/');

/**
 * Per-leaf activity for one turn (default: the latest, like cellViews). Same semantics as cellViews, per leaf:
 * - looked / edited / added / removed / created / unattributed from `turn.paths`; symbol leaves named in a
 *   file's symbol diff are edited (lines stay on the file, so rollups never double count);
 * - ghostSteps: plan steps naming the leaf (files ∪ import sources, or `path#symbol`) while it is not edited;
 * - unplanned: edited, the turn has a plan (`turn.planned` non-empty), and neither the leaf nor its file is planned;
 * - violation: `new` for a turn violation (plan or gate) not already on the map (same file + invariant),
 *   else `existing` for a current violation;
 * - cursor (only for the current turn), audit (open findings), proposal (pending proposals touching the leaf).
 */
export function activityFor(ui: UIState, graph: ContextGraph, turnId: string | null = ui.turns.at(-1)?.id ?? null): TurnActivity {
  const turn = turnId ? ui.turns.find((t) => t.id === turnId) ?? null : null;
  const out = outEdges(graph);
  const ids = edgeIds(graph);
  const leaves: Record<string, LeafActivity> = {};
  const has = (id: string) => !!graph.nodes[id];
  const leaf = (id: string) => (leaves[id] ??= emptyLeaf());

  if (turn) {
    for (const [path, pa] of Object.entries(turn.paths)) {
      if (!has(path)) continue;
      const l = leaf(path);
      l.looked = pa.looked;
      l.edited = pa.edits > 0;
      l.added = pa.added;
      l.removed = pa.removed;
      l.created = pa.created;
      l.unattributed = pa.unattributed;
      l.symbols = pa.symbols;
      if (!pa.symbols) continue;
      const added = new Set(pa.symbols.added);
      for (const s of [...pa.symbols.added, ...pa.symbols.sig, ...pa.symbols.body, ...pa.symbols.renamed.map((r) => r[1])]) {
        if (!has(s)) continue;
        const sl = leaf(s);
        sl.edited = true;
        if (added.has(s)) sl.created = true;
      }
    }
    const steps = new Map<string, Set<number>>();
    for (const s of turn.steps) {
      for (const raw of [...s.files, ...s.imports.map((i) => i.from)]) {
        const hash = raw.indexOf('#');
        const id = hash < 0 ? normalize(raw) : `${normalize(raw.slice(0, hash))}${raw.slice(hash)}`;
        if (!has(id)) continue;
        (steps.get(id) ?? steps.set(id, new Set()).get(id)!).add(s.n);
      }
    }
    for (const [id, set] of steps) {
      const l = leaf(id);
      l.planned = true;
      if (!l.edited) l.ghostSteps = [...set].sort((a, b) => a - b);
    }
    const hasPlan = Object.keys(turn.planned).length > 0;
    for (const [id, l] of Object.entries(leaves)) {
      const file = fileOf(id);
      l.unplanned = hasPlan && l.edited && !l.planned && !(file && steps.has(file));
    }
  }

  // violations: current ones are `existing`; a turn's plan/gate violation not already on the map is `new`
  const files = new Set<string>();
  const edges = new Set<string>();
  for (const v of ui.violations) {
    if (!has(v.file)) continue;
    files.add(v.file);
    const l = leaf(v.file);
    l.violation ??= 'existing';
    for (const e of out.get(v.file) ?? []) if (e.kind === 'imports' && (!v.target || v.target === e.to)) edges.add(e.id);
  }
  const known = (file: string, invariant: string) => ui.violations.some((x) => x.file === file && x.invariant === invariant);
  if (turn) {
    for (const v of [...turn.planViolations, ...turn.gateBlocks]) {
      if (known(v.file, v.invariant) || !has(v.file)) continue;
      leaf(v.file).violation = 'new';
    }
  }

  let cursor: string | null = null;
  if (ui.cursor && (!turn || turn.id === ui.current) && has(ui.cursor.path)) {
    cursor = ui.cursor.path;
    leaf(cursor).cursor = true;
  }

  for (const f of Object.values(ui.findings)) {
    if (f.status !== 'open') continue;
    for (const p of new Set(f.files)) if (has(p)) leaf(p).audit += 1;
  }

  const mark = (id: string, m: ProposalMark) => { if (has(id)) leaf(id).proposal = strongerMark(leaf(id).proposal, m); };
  const filesWhere = (pred: (domain?: string, layer?: string) => boolean) =>
    Object.values(graph.nodes).filter((n) => n.kind === 'file' && pred(n.domain, n.layer)).map((n) => n.id);
  for (const p of Object.values(ui.proposals)) {
    if (p.status !== 'pending') continue;
    for (const c of p.proposal.changes) {
      if (c.kind === 'place') mark(c.path, 'add');
      else if (c.kind === 'move') mark(c.path, 'move_out');
      else if (c.kind === 'remove_domain') for (const f of filesWhere((d) => d === c.domain)) mark(f, 'remove');
      else if (c.kind === 'remove_cell') for (const f of filesWhere((d, l) => d === c.domain && l === c.layer)) mark(f, 'remove');
      else if (c.kind === 'rename_domain') for (const f of filesWhere((d) => d === c.domain)) mark(f, 'rename');
    }
  }

  // planned imports not yet built (a planned domain edge disappears only once all of its imports exist, as in edgeViews)
  const plannedEdges: TurnActivity['plannedEdges'] = [];
  if (turn) {
    for (const pe of Object.values(turn.plannedEdges)) {
      if (pe.imports.every((i) => ids.has(edgeId('imports', i.from, i.to)))) continue;
      for (const i of pe.imports) {
        const hit = turn.planViolations.find((v) => v.file === i.from && (!v.target || v.target === i.to));
        const violation: ViolationState = !hit ? null : known(hit.file, hit.invariant) ? 'existing' : 'new';
        plannedEdges.push({ from: i.from, to: i.to, steps: [...pe.steps], violation });
      }
    }
    plannedEdges.sort((a, b) => byId(a.from, b.from) || byId(a.to, b.to));
  }

  const added = new Set<string>();
  for (const e of turn?.edgesAdded ?? []) added.add(edgeId('imports', e.edge.from, e.edge.to));
  for (const c of turn?.callsAdded ?? []) added.add(edgeId('calls', c.from, c.to));

  return {
    turn: turn?.id ?? null,
    leaves,
    plannedEdges,
    addedEdges: [...added].filter((id) => ids.has(id)).sort(byId),
    cursor,
    violations: { files: [...files].sort(byId), edges: [...edges].sort(byId) },
  };
}
