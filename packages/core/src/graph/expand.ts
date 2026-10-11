// autoExpand (NAVIGATION_PLAN §1.3): Furnas degree of interest = a-priori importance − tree distance from focus.
import type { TurnActivity } from '../contracts/api';
import type { ContextGraph, LeafActivity } from '../contracts/graph';
import { byId, pathTo } from './util';

/** A-priori importance of a leaf: cursor ≫ new violation > ghost/planned > edited > looked > existing violation > rest. */
export function importance(l: LeafActivity): number {
  if (l.cursor) return 100;
  if (l.violation === 'new') return 8;
  if (l.ghostSteps.length || l.planned) return 6;
  if (l.edited) return 5;
  if (l.looked) return 4;
  if (l.violation === 'existing') return 2;
  return 0;
}

/**
 * Containers to expand for a view of at most `budget` visible nodes. A container's importance is the max over
 * its leaves (plus files with a current violation); its interest is importance − tree distance to the anchor
 * (`focus`, else the agent cursor, else the root). Candidates are containers with some importance and the
 * anchor's ancestors-or-self; the most interesting visible candidate is expanded whenever its children still fit
 * the budget. Ties: interest, then shallower, then id. Symbols are never expanded. Returns ids in expansion order.
 */
export function autoExpand(graph: ContextGraph, activity: TurnActivity, focus: string | null, budget: number): string[] {
  const score = new Map<string, number>();
  const raise = (id: string, s: number) => {
    if (s <= 0) return;
    for (let n: string | null = id; n; n = graph.nodes[n]?.parent ?? null) {
      if ((score.get(n) ?? 0) >= s) break; // ancestors already carry at least this much
      score.set(n, s);
    }
  };
  for (const [id, l] of Object.entries(activity.leaves)) if (graph.nodes[id]) raise(id, importance(l));
  for (const f of activity.violations.files) if (graph.nodes[f]) raise(f, 2);

  const anchor = focus && graph.nodes[focus] ? focus : activity.cursor && graph.nodes[activity.cursor] ? activity.cursor : graph.root;
  const anchorPath = pathTo(graph, anchor);
  const onPath = new Set(anchorPath);
  const dist = (id: string) => {
    const p = pathTo(graph, id);
    let i = 0;
    while (i < p.length && i < anchorPath.length && p[i] === anchorPath[i]) i++;
    return p.length + anchorPath.length - 2 * i;
  };
  const interest = (id: string) => (score.get(id) ?? 0) - dist(id);

  const kids = (id: string) => graph.children[id] ?? [];
  let visible = kids(graph.root).length;
  if (visible > budget) return [];
  const cand: { id: string; interest: number; depth: number }[] = [];
  const offer = (id: string) => {
    const n = graph.nodes[id]!;
    if (n.kind === 'symbol' || !kids(id).length || (!score.has(id) && !onPath.has(id))) return;
    cand.push({ id, interest: interest(id), depth: pathTo(graph, id).length });
  };
  kids(graph.root).forEach(offer);
  const out: string[] = [];
  while (cand.length) {
    cand.sort((a, b) => b.interest - a.interest || a.depth - b.depth || byId(a.id, b.id));
    const { id } = cand.shift()!;
    const n = kids(id).length;
    if (visible + n > budget) continue;
    visible += n;
    out.push(id);
    kids(id).forEach(offer);
  }
  return out;
}
