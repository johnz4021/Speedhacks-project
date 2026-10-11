import { cellKey, type Cell, type TurnState, type UIState } from './events';
import type { Violation } from './rules';

export type Severity = 1 | 2 | 3 | 4;

export type Finding = {
  severity: Severity;
  kind: 'invariant' | 'new_edge' | 'new_external' | 'unplanned' | 'planned';
  cell: Cell | null;
  text: string;
  files: string[];
  invariant?: string;
};

export type TurnLedger = {
  turn: string;
  linesChanged: number | null; // null until turn_ended brings the git numstat
  cellsToReview: number;
  forksCaughtBeforeCode: number;
  rejectedOptionsBlocked: number;
  findings: Finding[];
};

export type Ledger = {
  turns: TurnLedger[];
  session: { linesChanged: number; cellsToReview: number; forksCaughtBeforeCode: number; rejectedOptionsBlocked: number };
};

const vkey = (v: Violation) => `${v.invariant}|${v.file}|${v.target ?? ''}`;

function cellOf(s: UIState, turn: TurnState, file: string): Cell | null {
  const p = s.files[file];
  if (p?.kind === 'cell') return { domain: p.domain, layer: p.layer };
  const edited = Object.entries(turn.edited).find(([, c]) => c.files.includes(file));
  if (edited) { const [domain, layer] = edited[0].split('/') as [string, string]; return { domain, layer }; }
  return Object.values(turn.planned).find((c) => c.files.includes(file))?.cell ?? null;
}

/** Severity-ranked findings for one turn (SPEC §9): 1 invariant hit · 2 new edge / new external · 3 unplanned · 4 planned. */
export function turnFindings(s: UIState, turn: TurnState): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const { v } of turn.violationsSeen) {
    if (seen.has(vkey(v))) continue;
    seen.add(vkey(v));
    out.push({ severity: 1, kind: 'invariant', cell: cellOf(s, turn, v.file), text: v.reason, files: [v.file], invariant: v.invariant });
  }
  const edges = new Map<string, { from: string; to: string; files: string[] }>();
  for (const e of turn.edgesAdded) {
    const k = `${e.from}->${e.to}`;
    const cur = edges.get(k) ?? { from: e.from, to: e.to, files: [] };
    if (!cur.files.includes(e.edge.from)) cur.files.push(e.edge.from);
    edges.set(k, cur);
  }
  for (const e of edges.values()) {
    const cell = cellOf(s, turn, e.files[0]!);
    out.push({ severity: 2, kind: 'new_edge', cell, text: `New dependency: ${name(s, e.from)} → ${name(s, e.to)}`, files: e.files });
  }
  const hasPlan = Object.keys(turn.planned).length > 0;
  for (const [k, c] of Object.entries(turn.edited)) {
    const [domain, layer] = k.split('/') as [string, string];
    const cell = { domain, layer };
    if (layer === 'external' && c.created.length) {
      out.push({ severity: 2, kind: 'new_external', cell, text: `New external service in ${name(s, domain)}`, files: c.created });
    }
    if (hasPlan && !turn.planned[k]) {
      out.push({ severity: 3, kind: 'unplanned', cell, text: `Edited ${name(s, domain)} · ${layer} without planning it`, files: c.files });
    } else {
      out.push({ severity: 4, kind: 'planned', cell, text: `${name(s, domain)} · ${layer}: ${c.files.length} file(s), +${c.added} −${c.removed}`, files: c.files });
    }
  }
  for (const file of turn.unassigned) {
    if (hasPlan && !Object.values(turn.planned).some((c) => c.files.includes(file))) {
      out.push({ severity: 3, kind: 'unplanned', cell: null, text: `Edited ${file}, which belongs to no domain`, files: [file] });
    }
  }
  return out.sort((a, b) => a.severity - b.severity);
}

function name(s: UIState, domain: string) {
  return s.map?.domains.find((d) => d.id === domain)?.name ?? domain;
}

export function turnLedger(s: UIState, turn: TurnState): TurnLedger {
  const findings = turnFindings(s, turn);
  const review = new Set(findings.filter((f) => f.severity <= 3).map((f) => (f.cell ? cellKey(f.cell) : `file:${f.files[0]}`)));
  // A fork counts once per distinct plan violation it resolved, if it was answered before any edit in the turn.
  let forks = 0;
  for (const f of turn.forks) {
    if (f.answered === null || !f.beforeCode) continue;
    forks += new Set(f.violations.map(vkey).filter((k) => turn.violationsSeen.some((x) => x.source === 'plan' && vkey(x.v) === k))).size;
  }
  const rejected = new Set(turn.violationsSeen.filter((x) => x.v.decision).map((x) => vkey(x.v))).size;
  return {
    turn: turn.id,
    linesChanged: turn.numstat ? turn.numstat.added + turn.numstat.removed : null,
    cellsToReview: review.size,
    forksCaughtBeforeCode: forks,
    rejectedOptionsBlocked: rejected,
    findings,
  };
}

export function ledger(s: UIState): Ledger {
  const turns = s.turns.map((t) => turnLedger(s, t));
  const sum = (f: (t: TurnLedger) => number) => turns.reduce((a, t) => a + f(t), 0);
  return {
    turns,
    session: {
      linesChanged: sum((t) => t.linesChanged ?? 0),
      cellsToReview: sum((t) => t.cellsToReview),
      forksCaughtBeforeCode: sum((t) => t.forksCaughtBeforeCode),
      rejectedOptionsBlocked: sum((t) => t.rejectedOptionsBlocked),
    },
  };
}
