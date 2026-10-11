// Contract (NAVIGATION_PLAN §1, §3.2): one containment tree plus leaf edges; every level is a projection.
// Browser-safe: types and id helpers only. Implementations live in src/graph/ (Graph lane).
import type { CallConfidence, SymbolDiff } from './facts';

export type NodeKind =
  | 'repo'
  | 'domain'
  | 'cell'
  | 'group' // a directory or confirmed component inside a cell
  | 'file'
  | 'symbol'
  | 'table'
  | 'vendor' // bare package or external service not claimed by a cell
  | 'route'
  | 'entry'
  | 'unassigned' // pseudo-domain for files that match no cell
  | 'neutral' // shared code (domains.yaml `neutral`): never creates edges
  | 'tests'; // a domain's test files

export type GraphNode = {
  id: string;
  kind: NodeKind;
  parent: string | null;
  label: string;
  order: number; // stable sort key among siblings (model order for layout)
  domain?: string; // domain id, for nodes inside a domain
  layer?: string; // layer id, for cells and everything inside them
  path?: string; // repo path for files and groups (directory)
  symbol?: { kind: string; exported: boolean };
};

export type EdgeKind = 'imports' | 'calls' | 'implements' | 'handles' | 'writes' | 'reads' | 'uses' | 'fetches' | 'starts';

export type GraphEdge = {
  id: string; // edgeId(kind, from, to)
  kind: EdgeKind;
  from: string; // leaf node id
  to: string;
  count: number;
  owner: string; // the file whose facts produced it; replaced when that file changes
  confidence?: CallConfidence;
  typeOnly?: boolean;
};

export type ContextGraph = {
  root: string; // 'repo'
  nodes: Record<string, GraphNode>;
  children: Record<string, string[]>; // parent id → child ids, sorted by `order`
  edges: GraphEdge[];
};

/** View-only state held by the shell (not in the event log unless D5 says so). */
export type ViewState = {
  expanded: readonly string[];
  focus: string | null;
  lens: { kinds: readonly EdgeKind[]; turnOnly: boolean };
  budget: number; // max detailed visible nodes for autoExpand (DOI)
  follow: boolean;
};

export type ViolationState = 'existing' | 'new' | null;
export type ProposalMark = 'add' | 'move_in' | 'move_out' | 'remove' | 'rename' | null;

/** Agent and map activity for one leaf (file or symbol id) in the selected turn. */
export type LeafActivity = {
  looked: boolean;
  edited: boolean;
  added: number;
  removed: number;
  created: boolean;
  unattributed: boolean;
  ghostSteps: number[]; // planned in these steps and not yet edited
  planned: boolean;
  unplanned: boolean; // edited, the turn has a plan, and this leaf is not in it
  violation: ViolationState;
  cursor: boolean;
  symbols: SymbolDiff | null; // for files: which symbols the turn changed
  audit: number; // open advisory findings
  proposal: ProposalMark; // pending cartographer proposal touching this leaf
};

/** Activity rolled up to a visible node: booleans OR, counts sum, severity MAX (never averaged). */
export type Rollup = {
  looked: boolean;
  edited: boolean;
  added: number;
  removed: number;
  ghostSteps: number[];
  unplanned: boolean;
  violation: ViolationState;
  violationFiles: string[];
  newViolationFiles: string[];
  cursor: boolean;
  audit: number;
  proposal: ProposalMark;
  leaves: number; // files (or symbols) underneath
};

export type VisibleNode = {
  id: string;
  kind: NodeKind;
  parent: string | null; // nearest visible ancestor
  label: string;
  depth: number;
  expanded: boolean;
  expandable: boolean;
  order: number;
  domain?: string;
  layer?: string;
  path?: string;
  rollup: Rollup;
};

export type EdgeStatus = 'existing' | 'new' | 'ghost';

/** Leaf edges aggregated to their nearest visible endpoints. A ghost edge never merges with a solid one. */
export type VisibleEdge = {
  id: string;
  from: string; // visible node ids
  to: string;
  kinds: EdgeKind[];
  count: number;
  status: EdgeStatus;
  violation: ViolationState;
  confidence: CallConfidence | null; // weakest confidence among its call edges, null if none
  steps: number[]; // plan steps, for ghost edges
  leafEdges: string[]; // GraphEdge ids (or plan import keys for ghosts)
};

/** Where an aggregated edge crosses out of an expanded container. */
export type Port = { container: string; edge: string; side: 'top' | 'right' | 'bottom' | 'left'; direction: 'out' | 'in' };

export type Projection = { nodes: VisibleNode[]; edges: VisibleEdge[]; ports: Port[] };

// ---------------------------------------------------------------- ids

export const ROOT_ID = 'repo';
export const UNASSIGNED_ID = 'unassigned';
export const NEUTRAL_ID = 'neutral';
export const domainId = (domain: string) => `domain:${domain}`;
export const cellId = (domain: string, layer: string) => `cell:${domain}/${layer}`;
export const groupId = (domain: string, layer: string, dir: string) => `group:${domain}/${layer}/${dir}`;
export const testsId = (domain: string) => `tests:${domain}`;
export const tableId = (table: string) => `table:${table}`;
export const vendorId = (name: string) => `vendor:${name}`;
export const symbolId = (path: string, qualified: string) => `${path}#${qualified}`;
export const edgeId = (kind: EdgeKind, from: string, to: string) => `${kind}|${from}|${to}`;

/** The file a leaf id belongs to: `src/a.ts#f.g` → `src/a.ts`; file ids are returned as-is; others → null. */
export function fileOf(id: string): string | null {
  if (/^(domain|cell|group|tests|table|vendor|route|entry|journey):/.test(id) || id === ROOT_ID || id === UNASSIGNED_ID || id === NEUTRAL_ID) return null;
  const i = id.indexOf('#');
  return i === -1 ? id : id.slice(0, i);
}
