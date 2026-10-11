import type { DomainMap } from './schema';
import type { Placement } from './mapper';
import type { ImportEdge, WriteFact, DomainEdge } from './facts';
import type { Violation } from './rules';
import type { PlanStep } from './plan';

export type Cell = { domain: string; layer: string };

export type EventKind =
  | 'repo_scanned' | 'map_proposed' | 'map_confirmed' | 'file_assigned'
  | 'violation_found'
  | 'turn_started' | 'looked' | 'cursor'
  | 'planned' | 'plan_violation' | 'fork_asked' | 'fork_answered' | 'plan_approved'
  | 'gate_blocked' | 'edited' | 'edge_added' | 'edge_removed'
  | 'test_result' | 'decision_recorded' | 'turn_ended'
  // Additions to SPEC §5 so the chat pane and approval button are also reductions of the log.
  | 'chat' | 'approval_requested' | 'error';

export type HarnessEvent = {
  id: string;
  t: number;
  session: string;
  turn: string | null;
  kind: EventKind;
  cell?: Cell;
  path?: string;
  data?: Record<string, unknown>;
};

/** Typed payloads, by kind. The server builds events with `ev()`; the reducer reads them back. */
export type EventData = {
  repo_scanned: { files: { path: string; placement: Placement }[]; imports: ImportEdge[]; writes: WriteFact[]; edges: DomainEdge[] };
  map_proposed: { map: DomainMap; yaml: string };
  map_confirmed: { map: DomainMap; source: 'file' | 'cartographer' | 'fixture' };
  file_assigned: { placement: Placement };
  violation_found: { violations: Violation[] }; // the full current set (replaces)
  turn_started: { prompt: string; head: string; baseline: string };
  looked: { tool: string };
  cursor: { verb: 'reading' | 'searching' | 'editing' };
  planned: {
    steps: PlanStep[];
    cells: { domain: string; layer: string; steps: number[]; files: string[] }[];
    edges: { from: string; to: string; steps: number[]; imports: ImportEdge[] }[];
    unassigned: string[];
  };
  plan_violation: { violation: Violation };
  fork_asked: { violations: Violation[]; text: string };
  fork_answered: { option: 'A' | 'B'; text: string; violations: Violation[] };
  plan_approved: Record<string, never>;
  gate_blocked: { violation: Violation; tool: string };
  edited: { added: number; removed: number; created: boolean; unattributed?: boolean; tool?: string };
  edge_added: { edge: ImportEdge; from: string; to: string };
  edge_removed: { edge: ImportEdge; from: string; to: string };
  test_result: { domain: string; passed: number; failed: number };
  decision_recorded: { id: string; title: string; invariant: string; option: 'A' | 'B'; paths: string[]; alike?: boolean };
  turn_ended: { added: number; removed: number; files: string[]; reason: string };
  chat: { role: 'user' | 'assistant' | 'system'; text: string };
  approval_requested: { plan: string };
  error: { message: string };
};

export const cellKey = (c: Cell) => `${c.domain}/${c.layer}`;
export const edgeKey = (from: string, to: string) => `${from}->${to}`;

export type PlannedCell = { cell: Cell; steps: number[]; files: string[] };
export type PlannedEdge = { from: string; to: string; steps: number[]; imports: ImportEdge[] };

export type TurnState = {
  id: string;
  prompt: string;
  startedAt: number;
  endedAt: number | null;
  steps: PlanStep[];
  planned: Record<string, PlannedCell>;
  plannedEdges: Record<string, PlannedEdge>;
  planViolations: Violation[]; // the latest plan's (a resubmitted plan replaces them)
  gateBlocks: Violation[]; // unanswered edit-gate blocks
  violationsSeen: { v: Violation; source: 'plan' | 'gate' }[]; // every violation raised in the turn, for the ledger
  looked: Record<string, string[]>; // cellKey → paths
  edited: Record<string, { added: number; removed: number; files: string[]; created: string[]; unattributed: boolean }>;
  tests: Record<string, string[]>; // domain → test files edited
  unassigned: string[];
  edgesAdded: { from: string; to: string; edge: ImportEdge }[];
  edgesRemoved: { from: string; to: string; edge: ImportEdge }[];
  forks: { asked: number; answered: number | null; option: 'A' | 'B' | null; violations: Violation[]; beforeCode: boolean }[];
  decisions: string[];
  approved: boolean;
  firstEditAt: number | null; // event index of first `edited`
  numstat: { added: number; removed: number } | null;
};

export type DomainEdgeState = { from: string; to: string; files: ImportEdge[] };

export type Decision = EventData['decision_recorded'] & { turn: string | null; at: number };

export type UIState = {
  map: DomainMap | null;
  files: Record<string, Placement>;
  edges: Record<string, DomainEdgeState>;
  violations: Violation[];
  turns: TurnState[];
  current: string | null;
  cursor: { cell: Cell | null; path: string; verb: string } | null;
  chat: { role: 'user' | 'assistant' | 'system'; text: string; turn: string | null; t: number }[];
  awaitingApproval: { turn: string | null; plan: string } | null;
  pendingFork: { turn: string | null; violations: Violation[] } | null;
  decisions: Decision[];
  errors: string[];
  /** event index → provenance lookups */
  edgeOrigin: Record<string, { turn: string | null; at: number }[]>;
  cellOrigin: Record<string, { turn: string | null; at: number }[]>;
};

export function initialState(): UIState {
  return {
    map: null, files: {}, edges: {}, violations: [], turns: [], current: null, cursor: null, chat: [],
    awaitingApproval: null, pendingFork: null, decisions: [], errors: [], edgeOrigin: {}, cellOrigin: {},
  };
}

function newTurn(id: string, prompt: string, t: number): TurnState {
  return {
    id, prompt, startedAt: t, endedAt: null, steps: [], planned: {}, plannedEdges: {}, planViolations: [], gateBlocks: [], violationsSeen: [],
    looked: {}, edited: {}, tests: {}, unassigned: [], edgesAdded: [], edgesRemoved: [], forks: [], decisions: [],
    approved: false, firstEditAt: null, numstat: null,
  };
}

const push = <T>(rec: Record<string, T[]>, k: string, v: T) => { (rec[k] ??= []).push(v); };

/** Fold one event into the state. Mutates and returns `s`; callers that need immutability use `reduce`. */
export function apply(s: UIState, e: HarnessEvent, index: number): UIState {
  const turn = e.turn ? s.turns.find((x) => x.id === e.turn) ?? null : null;
  const d = (e.data ?? {}) as never;

  switch (e.kind) {
    case 'map_confirmed':
    case 'map_proposed': {
      const { map } = d as EventData['map_confirmed'];
      s.map = map;
      break;
    }
    case 'repo_scanned': {
      const { files, edges } = d as EventData['repo_scanned'];
      s.files = {};
      for (const f of files) s.files[f.path] = f.placement;
      s.edges = {};
      for (const ed of edges) s.edges[edgeKey(ed.from, ed.to)] = { from: ed.from, to: ed.to, files: [...ed.files] };
      break;
    }
    case 'file_assigned': {
      if (e.path) s.files[e.path] = (d as EventData['file_assigned']).placement;
      break;
    }
    case 'violation_found':
      s.violations = (d as EventData['violation_found']).violations;
      break;
    case 'turn_started': {
      const t = newTurn(e.turn ?? e.id, (d as EventData['turn_started']).prompt, e.t);
      s.turns.push(t);
      s.current = t.id;
      s.cursor = null;
      break;
    }
    case 'chat': {
      const { role, text } = d as EventData['chat'];
      s.chat.push({ role, text, turn: e.turn, t: e.t });
      break;
    }
    case 'looked':
    case 'cursor': {
      if (e.path) s.cursor = { cell: e.cell ?? null, path: e.path, verb: e.kind === 'cursor' ? (d as EventData['cursor']).verb : 'reading' };
      if (e.kind === 'looked' && turn && e.cell && e.path) {
        const k = cellKey(e.cell);
        const list = (turn.looked[k] ??= []);
        if (!list.includes(e.path)) list.push(e.path);
      }
      break;
    }
    case 'planned': {
      if (!turn) break;
      const p = d as EventData['planned'];
      turn.steps = p.steps;
      turn.planned = {};
      for (const c of p.cells) turn.planned[cellKey(c)] = { cell: { domain: c.domain, layer: c.layer }, steps: c.steps, files: c.files };
      turn.plannedEdges = {};
      for (const ed of p.edges) turn.plannedEdges[edgeKey(ed.from, ed.to)] = ed;
      turn.unassigned = p.unassigned;
      turn.planViolations = []; // a resubmitted plan replaces the previous one's violations
      break;
    }
    case 'plan_violation': {
      const { violation } = d as EventData['plan_violation'];
      turn?.planViolations.push(violation);
      turn?.violationsSeen.push({ v: violation, source: 'plan' });
      break;
    }
    case 'gate_blocked': {
      const { violation } = d as EventData['gate_blocked'];
      turn?.gateBlocks.push(violation);
      turn?.violationsSeen.push({ v: violation, source: 'gate' });
      break;
    }
    case 'fork_asked': {
      const { violations } = d as EventData['fork_asked'];
      s.pendingFork = { turn: e.turn, violations };
      turn?.forks.push({ asked: index, answered: null, option: null, violations, beforeCode: turn.firstEditAt === null });
      break;
    }
    case 'fork_answered': {
      const { option } = d as EventData['fork_answered'];
      s.pendingFork = null;
      const f = turn?.forks.findLast((x) => x.answered === null);
      if (f) { f.answered = index; f.option = option; f.beforeCode = f.beforeCode && turn!.firstEditAt === null; }
      if (turn) turn.gateBlocks = []; // answered; the decision now governs
      break;
    }
    case 'approval_requested':
      s.awaitingApproval = { turn: e.turn, plan: (d as EventData['approval_requested']).plan };
      break;
    case 'plan_approved':
      s.awaitingApproval = null;
      if (turn) turn.approved = true;
      break;
    case 'edited': {
      const ed = d as EventData['edited'];
      if (s.cursor && e.path && !ed.unattributed) s.cursor = { cell: e.cell ?? null, path: e.path, verb: 'editing' };
      if (!turn || !e.path) break;
      if (turn.firstEditAt === null) turn.firstEditAt = index;
      const placement = s.files[e.path];
      if (placement?.kind === 'test') { push(turn.tests, placement.domain, e.path); break; }
      if (!e.cell) { if (!turn.unassigned.includes(e.path)) turn.unassigned.push(e.path); break; }
      const k = cellKey(e.cell);
      const c = (turn.edited[k] ??= { added: 0, removed: 0, files: [], created: [], unattributed: false });
      c.added += ed.added;
      c.removed += ed.removed;
      if (!c.files.includes(e.path)) c.files.push(e.path);
      if (ed.created && !c.created.includes(e.path)) c.created.push(e.path);
      if (ed.unattributed) c.unattributed = true;
      push(s.cellOrigin, k, { turn: e.turn, at: index });
      break;
    }
    case 'edge_added': {
      const { edge, from, to } = d as EventData['edge_added'];
      const k = edgeKey(from, to);
      const cur = (s.edges[k] ??= { from, to, files: [] });
      if (!cur.files.some((f) => f.from === edge.from && f.to === edge.to)) cur.files.push(edge);
      push(s.edgeOrigin, k, { turn: e.turn, at: index });
      turn?.edgesAdded.push({ from, to, edge });
      break;
    }
    case 'edge_removed': {
      const { edge, from, to } = d as EventData['edge_removed'];
      const k = edgeKey(from, to);
      const cur = s.edges[k];
      if (cur) {
        cur.files = cur.files.filter((f) => !(f.from === edge.from && f.to === edge.to));
        if (!cur.files.length) delete s.edges[k];
      }
      turn?.edgesRemoved.push({ from, to, edge });
      break;
    }
    case 'decision_recorded': {
      const dec = d as EventData['decision_recorded'];
      const existing = s.decisions.find((x) => x.id === dec.id);
      if (existing) Object.assign(existing, dec); // the Alike confirmation re-emits with alike: true
      else s.decisions.push({ ...dec, turn: e.turn, at: index });
      if (turn && !turn.decisions.includes(dec.id)) turn.decisions.push(dec.id);
      break;
    }
    case 'turn_ended': {
      if (!turn) break;
      const { added, removed } = d as EventData['turn_ended'];
      turn.endedAt = e.t;
      turn.numstat = { added, removed };
      s.awaitingApproval = null;
      if (s.current === turn.id) s.cursor = null;
      break;
    }
    case 'error':
      s.errors.push((d as EventData['error']).message);
      break;
    case 'test_result':
      break;
  }
  return s;
}

/** UI state = reduce(events). Replay is `reduce(events, i)`: the state after the first `i` events. */
export function reduce(events: readonly HarnessEvent[], upTo = events.length): UIState {
  const s = initialState();
  const n = Math.min(upTo, events.length);
  for (let i = 0; i < n; i++) apply(s, events[i]!, i);
  return s;
}

// ---------------------------------------------------------------- derived views

export type CellView = {
  cell: Cell;
  looked: boolean;
  edited: boolean;
  ghost: number[] | null; // planned step numbers while not yet edited
  unplanned: boolean; // amber: edited but not in this turn's plan
  violation: 'existing' | 'new' | null;
  violationFiles: string[];
  newViolationFiles: string[];
  added: number;
  removed: number;
};

/** Per-cell visual state for one turn (defaults to the latest), plus load-time violations. */
export function cellViews(s: UIState, turnId: string | null = s.turns.at(-1)?.id ?? null): Record<string, CellView> {
  const out: Record<string, CellView> = {};
  const map = s.map;
  if (!map) return out;
  const turn = turnId ? s.turns.find((t) => t.id === turnId) ?? null : null;
  const hasPlan = !!turn && Object.keys(turn.planned).length > 0;

  for (const dom of map.domains) {
    for (const layer of map.layers) {
      if (!(layer.id in dom.cells)) continue;
      const cell = { domain: dom.id, layer: layer.id };
      const k = cellKey(cell);
      const edited = turn?.edited[k];
      const planned = turn?.planned[k];
      out[k] = {
        cell,
        looked: !!turn?.looked[k]?.length,
        edited: !!edited,
        ghost: planned && !edited ? planned.steps : null,
        unplanned: hasPlan && !!edited && !planned,
        violation: null,
        violationFiles: [],
        newViolationFiles: [],
        added: edited?.added ?? 0,
        removed: edited?.removed ?? 0,
      };
    }
  }
  const mark = (file: string, isNew: boolean, planCell?: Cell) => {
    const p = s.files[file];
    const cell = p?.kind === 'cell' ? { domain: p.domain, layer: p.layer } : planCell;
    if (!cell) return;
    const v = out[cellKey(cell)];
    if (!v) return;
    if (isNew) {
      v.violation = 'new';
      if (!v.newViolationFiles.includes(file)) v.newViolationFiles.push(file);
    } else {
      v.violation ??= 'existing';
      if (!v.violationFiles.includes(file)) v.violationFiles.push(file);
    }
  };
  for (const v of s.violations) mark(v.file, false);
  if (turn) {
    const plannedCellOf = (file: string) => Object.values(turn.planned).find((c) => c.files.includes(file))?.cell;
    for (const v of [...turn.planViolations, ...turn.gateBlocks]) {
      if (s.violations.some((x) => x.file === v.file && x.invariant === v.invariant)) continue; // already on the map before this turn
      mark(v.file, true, plannedCellOf(v.file));
    }
  }
  return out;
}

export type EdgeView = {
  from: string;
  to: string;
  state: 'existing' | 'ghost' | 'new';
  violation: boolean;
  steps: number[];
  files: ImportEdge[];
};

/**
 * Edges for one turn. A planned edge always gets its own `ghost` entry, even when a solid edge between the same
 * domains exists, so a plan that repeats an existing violation still looks different from the map before the turn.
 */
export function edgeViews(s: UIState, turnId: string | null = s.turns.at(-1)?.id ?? null): EdgeView[] {
  const turn = turnId ? s.turns.find((t) => t.id === turnId) ?? null : null;
  const violating = (from: string, files: ImportEdge[], list: Violation[]) =>
    list.some((v) => files.some((f) => f.from === v.file && (!v.target || v.target === f.to)));
  const out: EdgeView[] = [];
  const addedThisTurn = new Set(turn?.edgesAdded.map((x) => edgeKey(x.from, x.to)) ?? []);
  for (const [k, e] of Object.entries(s.edges)) {
    out.push({ from: e.from, to: e.to, state: addedThisTurn.has(k) ? 'new' : 'existing', violation: violating(e.from, e.files, s.violations), steps: [], files: e.files });
  }
  if (turn) {
    for (const pe of Object.values(turn.plannedEdges)) {
      const built = pe.imports.every((imp) => s.edges[edgeKey(pe.from, pe.to)]?.files.some((f) => f.from === imp.from && f.to === imp.to));
      if (built) continue;
      out.push({ from: pe.from, to: pe.to, state: 'ghost', violation: violating(pe.from, pe.imports, turn.planViolations), steps: pe.steps, files: pe.imports });
    }
  }
  return out;
}

/** Decisions and turns behind an edge or a cell, for the inspector. */
export function provenance(s: UIState, target: { edge: string } | { cell: string }) {
  const origins = 'edge' in target ? s.edgeOrigin[target.edge] ?? [] : s.cellOrigin[target.cell] ?? [];
  const turnIds = [...new Set(origins.map((o) => o.turn).filter((x): x is string => !!x))];
  const turns = turnIds.map((id) => ({ id, index: s.turns.findIndex((t) => t.id === id) + 1, prompt: s.turns.find((t) => t.id === id)?.prompt ?? '' }));
  const decisions = s.decisions.filter((d) => d.turn && turnIds.includes(d.turn));
  return { turns, decisions };
}
