// Contract (NAVIGATION_PLAN §4): the living map. Drift signals and scores are deterministic (core);
// the cartographer agent only proposes candidate maps; the auditor only raises advisory findings.
// Browser-safe: types only. Implementations live in src/cartography/ (Cartography lane).

export type DriftSignalKind =
  | 'unassigned'
  | 'wide_turns'
  | 'co_change'
  | 'coupling_growth'
  | 'rule_erosion'
  | 'rule_reinforcement'
  | 'bloated_cell'
  | 'new_top_level'
  | 'stale_label';

export type DriftSignal = {
  signal: DriftSignalKind;
  metric: string; // human-readable metric name, e.g. "median cells lit per turn (last 10)"
  value: number;
  threshold: number;
  scope: string[]; // graph node ids (domains, cells, files, invariant ids as `rule:<id>`)
  persisted: number; // consecutive turn ends it has held for; triggers at >= 2
};

/** A unit of history to score maps against: a Harness turn or a git commit. */
export type HistoryTurn = { id: string; source: 'turn' | 'commit'; files: string[] };

export type MapScore = {
  cellsLitMean: number;
  cellsLitMedian: number;
  modularity: number; // Newman Q of the file import graph partitioned by domain
  unassigned: number;
  cellSizeGini: number;
  decisionsBroken: number;
  churnFiles: number; // files whose cell changes vs the current map
  churnIds: number; // domain/cell ids removed or renamed-by-id vs the current map
  total: number; // weighted, lower is better
};

export type ProposalChange =
  | { kind: 'place'; path: string; domain: string; layer: string }
  | { kind: 'move'; path: string; from: { domain: string; layer: string }; to: { domain: string; layer: string } }
  | { kind: 'add_domain'; domain: string; name: string }
  | { kind: 'remove_domain'; domain: string }
  | { kind: 'rename_domain'; domain: string; from: string; to: string }
  | { kind: 'purpose'; domain: string; purpose: string }
  | { kind: 'add_cell'; domain: string; layer: string }
  | { kind: 'remove_cell'; domain: string; layer: string }
  | { kind: 'add_rule'; invariant: string; rule: string }
  | { kind: 'retire_rule'; invariant: string }
  | { kind: 'change_rule'; invariant: string; rule: string };

export type MapProposal = {
  id: string; // `MP-<n>`
  trigger: DriftSignal[];
  scope: string[]; // node ids the proposal touches
  candidates: { yaml: string; score: MapScore }[];
  chosen: number; // index into candidates
  current: MapScore;
  changes: ProposalChange[]; // diffMaps(current, chosen)
  rationale: string;
};

export type ProposalOutcome = 'accepted' | 'rejected' | 'amended';

export type LabelKind = 'group' | 'summary' | 'journey';
/** An inferred label. Regenerated only when `hash` (of what it describes) changes. */
export type Label = { target: string; kind: LabelKind; text: string; hash: string; confirmed: boolean };

export type AuditFinding = {
  id: string; // `AF-<n>`
  decision: string | null; // DR id it cites
  files: string[];
  lines: { path: string; line: number }[];
  text: string;
  confidence: 'low' | 'medium' | 'high';
};

export type AuditOutcome = 'dismissed' | 'promoted';

/** Thresholds for drift signals (`cartography.thresholds` in domains.yaml); defaults in NAVIGATION_PLAN §4.4. */
export type DriftThresholds = {
  unassigned: number;
  wideTurnsMedian: number;
  wideTurnsWindow: number;
  coChangeTurns: number;
  coChangeWindow: number;
  couplingGrowthRatio: number;
  couplingGrowthFiles: number;
  ruleErosionExceptions: number;
  ruleErosionB: number;
  ruleReinforcement: number;
  bloatedCellFiles: number;
  bloatedCellShare: number;
  persist: number;
};

export const DEFAULT_THRESHOLDS: DriftThresholds = {
  unassigned: 0,
  wideTurnsMedian: 3,
  wideTurnsWindow: 10,
  coChangeTurns: 3,
  coChangeWindow: 20,
  couplingGrowthRatio: 0.5,
  couplingGrowthFiles: 5,
  ruleErosionExceptions: 3,
  ruleErosionB: 2,
  ruleReinforcement: 3,
  bloatedCellFiles: 25,
  bloatedCellShare: 0.4,
  persist: 2,
};
