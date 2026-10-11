import {
  cellKey, cellViews, edgeViews, ledger, reduce, turnLedger,
  type CellView, type EdgeView, type HarnessEvent, type Ledger, type TurnLedger, type TurnState, type UIState, type Violation,
} from '@harness/core/view';
import { useStore } from './store';

/** Everything the UI shows, as a pure function of (events, replay index, selected turn). */
export type View = {
  ui: UIState;
  upTo: number;
  live: boolean;
  turn: TurnState | null;
  turnIndex: number; // 1-based, 0 when no turn
  cells: Record<string, CellView>;
  edges: EdgeView[];
  ledger: Ledger;
  turnLedger: TurnLedger | null;
  /** cellKey → files placed there (product files only; tests are listed under their domain). */
  cellFiles: Record<string, string[]>;
  testFiles: Record<string, string[]>;
  unassigned: string[];
  proposal: { domains: number; rules: number } | null;
  steps: { done: number; total: number };
  turnStarts: number[];
};

let reduceCache: { events: readonly HarnessEvent[]; upTo: number; ui: UIState } | null = null;
let viewCache: { ui: UIState; turnSel: string | null; view: View } | null = null;

function reduced(events: readonly HarnessEvent[], upTo: number): UIState {
  if (reduceCache && reduceCache.events === events && reduceCache.upTo === upTo) return reduceCache.ui;
  const ui = reduce(events, upTo);
  reduceCache = { events, upTo, ui };
  return ui;
}

export function deriveView(events: readonly HarnessEvent[], replay: number | null, turnSel: string | null): View {
  const upTo = replay ?? events.length;
  const ui = reduced(events, upTo);
  if (viewCache && viewCache.ui === ui && viewCache.turnSel === turnSel) return viewCache.view;

  const turn = (turnSel && ui.turns.find((t) => t.id === turnSel)) || ui.turns.at(-1) || null;
  const cellFiles: Record<string, string[]> = {};
  const testFiles: Record<string, string[]> = {};
  const unassigned: string[] = [];
  for (const [path, p] of Object.entries(ui.files)) {
    if (p.kind === 'cell') (cellFiles[cellKey(p)] ??= []).push(path);
    else if (p.kind === 'test') (testFiles[p.domain] ??= []).push(path);
    else if (p.kind === 'unassigned') unassigned.push(path);
  }
  for (const list of Object.values(cellFiles)) list.sort();

  let proposed = -1;
  let confirmed = -1;
  const turnStarts: number[] = [];
  for (let i = 0; i < events.length; i++) {
    const k = events[i]!.kind;
    if (k === 'turn_started') turnStarts.push(i);
    if (i >= upTo) continue;
    if (k === 'map_proposed') proposed = i;
    if (k === 'map_confirmed') confirmed = i;
  }
  const proposal = proposed > confirmed && ui.map ? { domains: ui.map.domains.length, rules: ui.map.invariants.length } : null;

  const l = ledger(ui);
  const view: View = {
    ui,
    upTo,
    live: replay === null,
    turn,
    turnIndex: turn ? ui.turns.indexOf(turn) + 1 : 0,
    cells: cellViews(ui, turn?.id ?? null),
    edges: edgeViews(ui, turn?.id ?? null),
    ledger: l,
    turnLedger: turn ? turnLedger(ui, turn) : null,
    cellFiles,
    testFiles,
    unassigned,
    proposal,
    steps: turn ? stepProgress(turn) : { done: 0, total: 0 },
    turnStarts,
  };
  viewCache = { ui, turnSel, view };
  return view;
}

/** "3 of 6 steps": a step is done when every cell it plans has been edited (or, for a step with no cells, its files). */
function stepProgress(turn: TurnState) {
  const editedFiles = new Set([
    ...Object.values(turn.edited).flatMap((c) => c.files),
    ...Object.values(turn.tests).flat(),
    ...turn.unassigned,
  ]);
  let done = 0;
  for (const step of turn.steps) {
    const cells = Object.entries(turn.planned).filter(([, c]) => c.steps.includes(step.n)).map(([k]) => k);
    const ok = cells.length ? cells.every((k) => !!turn.edited[k]) : step.files.length > 0 && step.files.every((f) => editedFiles.has(f));
    if (ok) done++;
  }
  return { done, total: turn.steps.length };
}

export function useView(): View {
  const events = useStore((s) => s.events);
  const replay = useStore((s) => s.replay);
  const turnSel = useStore((s) => s.turn);
  return deriveView(events, replay, turnSel);
}

/** Violations relevant to the selected turn (load-time plus this turn's plan and gate), for the inspector. */
export function turnViolations(v: View): { v: Violation; source: 'load' | 'plan' | 'gate' }[] {
  const out: { v: Violation; source: 'load' | 'plan' | 'gate' }[] = v.ui.violations.map((x) => ({ v: x, source: 'load' as const }));
  for (const x of v.turn?.planViolations ?? []) out.push({ v: x, source: 'plan' });
  for (const x of v.turn?.gateBlocks ?? []) out.push({ v: x, source: 'gate' });
  return out;
}

export const basename = (p: string) => p.split('/').pop() ?? p;
export const stem = (p: string) => {
  const parts = p.split('/');
  const last = parts.pop() ?? p;
  // vendor/<name>/index.ts reads better as its folder name
  if (/^index\.[tj]sx?$/.test(last) && parts.length) return parts.pop()!;
  return last.replace(/\.[tj]sx?$/, '');
};
