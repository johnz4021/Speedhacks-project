// What one turn (or one submitted plan) touched, as the auditor sees it (NAVIGATION_PLAN §4.6). Pure: a reduction
// of the event log, so it replays like everything else.
import { reduce, type HarnessEvent, type EventData } from '../events';
import type { PlanStep } from '../plan';
import type { Violation } from '../rules';
import type { FileFacts } from '../contracts/facts';
import { fileOf } from '../contracts/graph';

export type FactDeltaPlus = {
  calls: { from: string; to: string }[];
  imports: { from: string; to: string }[];
  writes: { file: string; table: string }[];
};

export type TurnSurface = {
  turn: string;
  prompt: string;
  /** `turn_started.baseline` (a `git stash create` snapshot, or HEAD); null for a plan review. */
  baseline: string | null;
  source: 'turn' | 'plan';
  /** Files the turn changed (or the plan names), sorted. Harness's own files are never included. */
  files: string[];
  created: string[];
  /** Symbol ids the turn added or changed (renames count as their new id), sorted. */
  symbols: string[];
  /** New calls, imports and table writes in the changed files (facts at turn start → turn end). */
  delta: FactDeltaPlus;
  plan: PlanStep[];
  /** Violations the checker already raised this turn (plan and gate) or holds for these files. Never re-raised by the auditor. */
  violations: Violation[];
};

const HARNESS_OWN = (p: string) => p === 'domains.yaml' || p.startsWith('decisions/') || p.startsWith('.harness/');
const uniqSorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const pairKey = (a: string, b: string) => `${a}\u0000${b}`;

/** New imports, calls and writes of `after` relative to `before`, for `files`. */
export function factDelta(before: Readonly<Record<string, FileFacts>>, after: Readonly<Record<string, FileFacts>>, files: readonly string[]): FactDeltaPlus {
  const out: FactDeltaPlus = { calls: [], imports: [], writes: [] };
  for (const path of files) {
    const a = after[path];
    if (!a) continue;
    const b = before[path];
    const oldImports = new Set(b?.imports.map((i) => i.to) ?? []);
    for (const i of a.imports) if (!oldImports.has(i.to)) out.imports.push({ from: path, to: i.to });
    const oldCalls = new Set(b?.calls.map((c) => pairKey(c.from, c.to)) ?? []);
    for (const c of a.calls) if (!oldCalls.has(pairKey(c.from, c.to))) out.calls.push({ from: c.from, to: c.to });
    const oldWrites = new Set(b?.writes.map((w) => w.table) ?? []);
    for (const w of a.writes) if (!oldWrites.has(w.table)) out.writes.push({ file: path, table: w.table });
  }
  const sort = <T extends object>(xs: T[]) => [...new Map(xs.map((x) => [JSON.stringify(x), x])).values()].sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
  return { calls: sort(out.calls), imports: sort(out.imports), writes: sort(out.writes) };
}

/**
 * The surface of a finished turn: files from the turn's `edited` events plus `turn_ended.files` (numstat), the symbols
 * its edits changed, and the fact delta between the facts at `turn_started` and at `turn_ended`. Null if the turn
 * has not ended (the auditor never reviews half-finished work).
 */
export function turnSurface(events: readonly HarnessEvent[], turnId: string): TurnSurface | null {
  const start = events.findIndex((e) => e.kind === 'turn_started' && e.turn === turnId);
  const end = events.findLastIndex((e) => e.kind === 'turn_ended' && e.turn === turnId);
  if (start < 0 || end < start) return null;
  const before = reduce(events, start);
  const after = reduce(events, end + 1);
  const turn = after.turns.find((t) => t.id === turnId);
  if (!turn) return null;
  const started = events[start]!.data as EventData['turn_started'];
  const ended = events[end]!.data as EventData['turn_ended'];

  const edited = Object.entries(turn.paths).filter(([, a]) => a.edits > 0).map(([p]) => p);
  const files = uniqSorted([...edited, ...ended.files].filter((p) => !HARNESS_OWN(p)));
  const created = uniqSorted(Object.entries(turn.paths).filter(([, a]) => a.created).map(([p]) => p));
  const symbols = uniqSorted(Object.values(turn.paths).flatMap((a) => (a.symbols ? [...a.symbols.added, ...a.symbols.sig, ...a.symbols.body, ...a.symbols.renamed.map(([, to]) => to)] : [])));
  const seen = turn.violationsSeen.map((x) => x.v);
  const standing = after.violations.filter((v) => files.includes(v.file));
  return {
    turn: turnId,
    prompt: turn.prompt,
    baseline: started.baseline || started.head || null,
    source: 'turn',
    files,
    created,
    symbols,
    delta: factDelta(before.facts, after.facts, files),
    plan: turn.steps,
    violations: dedupeViolations([...seen, ...standing]),
  };
}

/** The surface of the latest submitted plan of an open turn (plan review, behind HARNESS_AUDIT_PLANS=1). */
export function planSurface(events: readonly HarnessEvent[], turnId: string): TurnSurface | null {
  const ui = reduce(events);
  const turn = ui.turns.find((t) => t.id === turnId);
  if (!turn || !turn.steps.length) return null;
  const named = turn.steps.flatMap((s) => [...s.files, ...s.imports.map((i) => i.from)]);
  const files = uniqSorted(named.map((f) => fileOf(f) ?? f).filter((p) => !HARNESS_OWN(p)));
  const symbols = uniqSorted(named.filter((f) => f.includes('#')));
  const imports = turn.steps.flatMap((s) => s.imports.map((i) => ({ from: fileOf(i.from) ?? i.from, to: i.to })));
  return {
    turn: turnId,
    prompt: turn.prompt,
    baseline: null,
    source: 'plan',
    files,
    created: files.filter((f) => !ui.files[f]),
    symbols,
    delta: { calls: [], imports: [...new Map(imports.map((i) => [pairKey(i.from, i.to), i])).values()], writes: [] },
    plan: turn.steps,
    violations: dedupeViolations([...turn.planViolations, ...ui.violations.filter((v) => files.includes(v.file))]),
  };
}

function dedupeViolations(vs: Violation[]): Violation[] {
  return [...new Map(vs.map((v) => [`${v.invariant}\u0000${v.file}\u0000${v.target ?? ''}`, v])).values()];
}
