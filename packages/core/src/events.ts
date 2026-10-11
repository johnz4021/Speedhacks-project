import type { DomainMap } from './schema';
import type { Placement } from './mapper';
import type { ImportEdge, WriteFact, DomainEdge } from './facts';
import type { Violation } from './rules';
import type { PlanStep } from './plan';
import type { FileFacts, SemanticFacts, SymbolDiff, CallConfidence } from './contracts/facts';
import type { AuditFinding, AuditOutcome, DriftSignal, Journey, Label, MapProposal, ProposalOutcome } from './contracts/cartography';

export type Cell = { domain: string; layer: string };

export type EventKind =
  | 'repo_scanned' | 'map_proposed' | 'map_confirmed' | 'file_assigned'
  | 'violation_found'
  | 'turn_started' | 'looked' | 'cursor'
  | 'planned' | 'plan_violation' | 'fork_asked' | 'fork_answered' | 'plan_approved'
  | 'gate_blocked' | 'edited' | 'edge_added' | 'edge_removed'
  | 'test_result' | 'decision_recorded' | 'turn_ended'
  // Additions to SPEC §5 so the chat pane and approval button are also reductions of the log.
  | 'chat' | 'approval_requested' | 'error'
  // NAVIGATION_PLAN: per-file facts for the context graph, and the living map (§3.1, §4.7).
  | 'facts_changed' | 'facts_resolved' | 'call_added' | 'call_removed'
  | 'drift_detected' | 'map_proposal_resolved' | 'labels_updated'
  | 'audit_finding' | 'audit_resolved' | 'maintenance_run' | 'journeys_updated' | 'decision_touched'
  // The agent acting on the map (map-first conversation): notes pinned to nodes, paths it points at, camera hints.
  | 'annotation' | 'highlight' | 'focus';

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
  /** `fileFacts` (Tier 1, every code file) is optional for older logs; without it facts are derived from imports/writes. */
  repo_scanned: { files: { path: string; placement: Placement }[]; imports: ImportEdge[]; writes: WriteFact[]; edges: DomainEdge[]; fileFacts?: FileFacts[] };
  /** Onboarding proposal when `proposal` is absent (sets the map). A living-map proposal (`proposal` set) never changes the map until accepted. */
  map_proposed: { map: DomainMap; yaml: string; proposal?: MapProposal };
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
    /** Approaches the plan deliberately avoids because a standing decision rules them out (stated by the agent, checked by the server). */
    avoided?: { from: string; to: string; decision: string; reason: string }[];
  };
  plan_violation: { violation: Violation };
  fork_asked: { violations: Violation[]; text: string };
  fork_answered: { option: 'A' | 'B'; text: string; violations: Violation[] };
  plan_approved: Record<string, never>;
  gate_blocked: { violation: Violation; tool: string };
  edited: { added: number; removed: number; created: boolean; unattributed?: boolean; tool?: string; symbols?: SymbolDiff };
  edge_added: { edge: ImportEdge; from: string; to: string };
  edge_removed: { edge: ImportEdge; from: string; to: string };
  test_result: { domain: string; passed: number; failed: number };
  /**
   * Re-emitted (merged by id) when Alike confirms (`alike`, `urn`) and when the decision turn ends with what the chosen
   * option built (`protects`: the files and `path#symbol`s that implement it — beat 4's markers).
   */
  decision_recorded: { id: string; title: string; invariant: string; option: 'A' | 'B'; paths: string[]; alike?: boolean; urn?: string; protects?: { paths: string[]; symbols: string[] } };
  turn_ended: { added: number; removed: number; files: string[]; reason: string };
  /** `context`: node ids the user pointed at (shift-click) for this message; shown as chips, sent to Claude resolved. */
  chat: { role: 'user' | 'assistant' | 'system'; text: string; context?: string[] };
  approval_requested: { plan: string };
  error: { message: string };
  /** A file's Tier 1 facts after it changed (null = deleted). Emitted with every `edited`/`file_assigned`. */
  facts_changed: { facts: FileFacts | null };
  /** Tier 2 typed facts; ignored unless `hash` matches the file's current facts. */
  facts_resolved: { facts: SemanticFacts };
  call_added: { from: string; to: string; confidence: CallConfidence };
  call_removed: { from: string; to: string; confidence: CallConfidence };
  drift_detected: { signals: DriftSignal[] }; // the full current set (replaces)
  map_proposal_resolved: { proposal: string; outcome: ProposalOutcome; decision?: string };
  labels_updated: { labels: Label[] }; // upserts by (target, kind)
  audit_finding: { finding: AuditFinding };
  audit_resolved: { id: string; outcome: AuditOutcome };
  maintenance_run: { agent: 'cartographer' | 'auditor'; trigger: string; ms: number; cost: number | null; ok: boolean };
  journeys_updated: { journeys: Journey[] }; // the full current set (replaces)
  /** The agent pins a short note on a node (via an MCP tool); `id` lets it replace or clear (`text: ''`) its own note. */
  annotation: { id: string; node: string; text: string; tone: 'note' | 'finding' | 'question' };
  /** The agent points at nodes/edges to show the user something (replaces the turn's previous highlight; empty clears). */
  highlight: { nodes: string[]; edges: { from: string; to: string }[]; label: string };
  /** The agent asks the camera to look somewhere (a hint; Follow mode honours it, manual navigation wins). */
  focus: { node: string; reason: string };
  /** A plan step or an edit touches code a standing decision protects (deterministic path/symbol match). */
  decision_touched: { decision: string; principle: string; paths: string[]; symbols: string[]; source: 'plan' | 'edit'; step?: number };
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
  avoided: { from: string; to: string; decision: string; reason: string }[];
  /** Protected code this turn's plan or edits touched (beat 4): shown as decision markers and on the approval card. */
  touched: EventData['decision_touched'][];
  /** The agent's notes on the map this turn (by note id) and its current highlight. */
  annotations: Record<string, EventData['annotation']>;
  highlight: EventData['highlight'] | null;
  /** Leaf-level activity (for the context graph): path → what happened to that file this turn. */
  paths: Record<string, PathActivity>;
  callsAdded: { from: string; to: string }[];
  callsRemoved: { from: string; to: string }[];
};

export type PathActivity = { looked: boolean; added: number; removed: number; created: boolean; unattributed: boolean; edits: number; symbols: SymbolDiff | null };

export type ProposalState = { proposal: MapProposal; status: 'pending' | ProposalOutcome; at: number; decision?: string };
export type FindingState = AuditFinding & { status: 'open' | AuditOutcome; turn: string | null; at: number };

export type DomainEdgeState = { from: string; to: string; files: ImportEdge[] };

export type Decision = EventData['decision_recorded'] & { turn: string | null; at: number; session: string };

export type UIState = {
  map: DomainMap | null;
  files: Record<string, Placement>;
  edges: Record<string, DomainEdgeState>;
  violations: Violation[];
  turns: TurnState[];
  current: string | null;
  cursor: { cell: Cell | null; path: string; verb: string } | null;
  chat: { role: 'user' | 'assistant' | 'system'; text: string; turn: string | null; t: number; context?: string[] }[];
  awaitingApproval: { turn: string | null; plan: string } | null;
  pendingFork: { turn: string | null; violations: Violation[] } | null;
  decisions: Decision[];
  errors: string[];
  /** event index → provenance lookups */
  edgeOrigin: Record<string, { turn: string | null; at: number }[]>;
  cellOrigin: Record<string, { turn: string | null; at: number }[]>;
  /** Tier 1 facts per file, and Tier 2 facts whose hash still matches. */
  facts: Record<string, FileFacts>;
  semantic: Record<string, SemanticFacts>;
  drift: DriftSignal[];
  proposals: Record<string, ProposalState>;
  labels: Record<string, Label>; // key: `${kind}:${target}`
  findings: Record<string, FindingState>;
  maintenance: (EventData['maintenance_run'] & { t: number })[];
  journeys: Journey[];
  /** Coding-session ids in order of first appearance ("session 1", "session 2", …). */
  sessions: string[];
};

export function initialState(): UIState {
  return {
    map: null, files: {}, edges: {}, violations: [], turns: [], current: null, cursor: null, chat: [],
    awaitingApproval: null, pendingFork: null, decisions: [], errors: [], edgeOrigin: {}, cellOrigin: {},
    facts: {}, semantic: {}, drift: [], proposals: {}, labels: {}, findings: {}, maintenance: [], journeys: [], sessions: [],
  };
}

function newTurn(id: string, prompt: string, t: number): TurnState {
  return {
    id, prompt, startedAt: t, endedAt: null, steps: [], planned: {}, plannedEdges: {}, planViolations: [], gateBlocks: [], violationsSeen: [],
    looked: {}, edited: {}, tests: {}, unassigned: [], edgesAdded: [], edgesRemoved: [], forks: [], decisions: [],
    approved: false, firstEditAt: null, numstat: null, paths: {}, callsAdded: [], callsRemoved: [], avoided: [], touched: [], annotations: {}, highlight: null,
  };
}

const push = <T>(rec: Record<string, T[]>, k: string, v: T) => { (rec[k] ??= []).push(v); };

const pathActivity = (t: TurnState, path: string): PathActivity =>
  (t.paths[path] ??= { looked: false, added: 0, removed: 0, created: false, unattributed: false, edits: 0, symbols: null });

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

function mergeSymbols(a: SymbolDiff | null, b: SymbolDiff): SymbolDiff {
  if (!a) return { added: [...b.added], removed: [...b.removed], sig: [...b.sig], body: [...b.body], renamed: [...b.renamed] };
  return { added: union(a.added, b.added), removed: union(a.removed, b.removed), sig: union(a.sig, b.sig), body: union(a.body, b.body), renamed: [...a.renamed, ...b.renamed] };
}

/** Facts for a scan from an older log without `fileFacts`: imports and writes only. */
function factsFromScan(scan: EventData['repo_scanned']): Record<string, FileFacts> {
  const out: Record<string, FileFacts> = {};
  const get = (path: string) => (out[path] ??= { path, hash: '', imports: [], writes: [], symbols: [], calls: [], routes: [], entries: [] });
  for (const i of scan.imports) get(i.from).imports.push({ to: i.to, typeOnly: false });
  for (const w of scan.writes) get(w.file).writes.push({ table: w.table, symbol: null, via: 'db' });
  return out;
}

/** Fold one event into the state. Mutates and returns `s`; callers that need immutability use `reduce`. */
export function apply(s: UIState, e: HarnessEvent, index: number): UIState {
  const turn = e.turn ? s.turns.find((x) => x.id === e.turn) ?? null : null;
  const d = (e.data ?? {}) as never;
  if (e.session && !s.sessions.includes(e.session)) s.sessions.push(e.session);

  switch (e.kind) {
    case 'map_confirmed': {
      s.map = (d as EventData['map_confirmed']).map;
      break;
    }
    case 'map_proposed': {
      const p = d as EventData['map_proposed'];
      if (p.proposal) s.proposals[p.proposal.id] = { proposal: p.proposal, status: 'pending', at: index };
      else s.map = p.map;
      break;
    }
    case 'repo_scanned': {
      const scan = d as EventData['repo_scanned'];
      s.files = {};
      for (const f of scan.files) s.files[f.path] = f.placement;
      s.edges = {};
      for (const ed of scan.edges) s.edges[edgeKey(ed.from, ed.to)] = { from: ed.from, to: ed.to, files: [...ed.files] };
      if (scan.fileFacts) {
        s.facts = {};
        for (const f of scan.fileFacts) s.facts[f.path] = f;
      } else {
        s.facts = factsFromScan(scan);
      }
      s.semantic = {};
      break;
    }
    case 'facts_changed': {
      const { facts } = d as EventData['facts_changed'];
      const path = facts?.path ?? e.path;
      if (!path) break;
      if (facts) s.facts[path] = facts;
      else delete s.facts[path];
      if (s.semantic[path] && s.semantic[path]!.hash !== facts?.hash) delete s.semantic[path];
      break;
    }
    case 'facts_resolved': {
      const { facts } = d as EventData['facts_resolved'];
      if (s.facts[facts.path]?.hash === facts.hash) s.semantic[facts.path] = facts;
      break;
    }
    case 'call_added':
    case 'call_removed': {
      const { from, to } = d as EventData['call_added'];
      (e.kind === 'call_added' ? turn?.callsAdded : turn?.callsRemoved)?.push({ from, to });
      break;
    }
    case 'drift_detected':
      s.drift = (d as EventData['drift_detected']).signals;
      break;
    case 'map_proposal_resolved': {
      const r = d as EventData['map_proposal_resolved'];
      const p = s.proposals[r.proposal];
      if (p) { p.status = r.outcome; if (r.decision) p.decision = r.decision; }
      break;
    }
    case 'labels_updated':
      for (const l of (d as EventData['labels_updated']).labels) s.labels[`${l.kind}:${l.target}`] = l;
      break;
    case 'audit_finding': {
      const { finding } = d as EventData['audit_finding'];
      s.findings[finding.id] = { ...finding, status: 'open', turn: e.turn, at: index };
      break;
    }
    case 'audit_resolved': {
      const r = d as EventData['audit_resolved'];
      const f = s.findings[r.id];
      if (f) f.status = r.outcome;
      break;
    }
    case 'annotation': {
      const a = d as EventData['annotation'];
      if (!turn) break;
      if (a.text) turn.annotations[a.id] = a;
      else delete turn.annotations[a.id];
      break;
    }
    case 'highlight': {
      const h = d as EventData['highlight'];
      if (turn) turn.highlight = h.nodes.length || h.edges.length ? h : null;
      break;
    }
    case 'focus':
      break; // view hint only; the shell's Follow mode reads it from the log
    case 'decision_touched': {
      const t = d as EventData['decision_touched'];
      if (turn && !turn.touched.some((x) => x.decision === t.decision && x.source === t.source && x.step === t.step && x.paths.join() === t.paths.join() && x.symbols.join() === t.symbols.join())) turn.touched.push(t);
      break;
    }
    case 'journeys_updated':
      s.journeys = (d as EventData['journeys_updated']).journeys;
      break;
    case 'maintenance_run':
      s.maintenance.push({ ...(d as EventData['maintenance_run']), t: e.t });
      break;
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
      const { role, text, context } = d as EventData['chat'];
      s.chat.push({ role, text, turn: e.turn, t: e.t, ...(context?.length ? { context } : {}) });
      break;
    }
    case 'looked':
    case 'cursor': {
      if (e.path) s.cursor = { cell: e.cell ?? null, path: e.path, verb: e.kind === 'cursor' ? (d as EventData['cursor']).verb : 'reading' };
      if (e.kind === 'looked' && turn && e.path) pathActivity(turn, e.path).looked = true;
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
      turn.avoided = p.avoided ?? [];
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
      const pa = pathActivity(turn, e.path);
      pa.added += ed.added;
      pa.removed += ed.removed;
      pa.edits += 1;
      if (ed.created) pa.created = true;
      if (ed.unattributed) pa.unattributed = true;
      if (ed.symbols) pa.symbols = mergeSymbols(pa.symbols, ed.symbols);
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
      else s.decisions.push({ ...dec, turn: e.turn, at: index, session: e.session });
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

/** 1-based session number for "decided in session N", or 0 if unknown. */
export const sessionNumber = (s: UIState, session: string) => s.sessions.indexOf(session) + 1;

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
