// diffMaps: what a candidate map changes, as ghost-able ProposalChanges (NAVIGATION_PLAN §4.5).
import { createMapper } from '../mapper';
import type { DomainMap, Invariant } from '../schema';
import type { ProposalChange } from '../contracts/cartography';
import type { DiffMaps } from '../contracts/api';
import { stableJson } from './util';

/** Rule body without its runtime bookkeeping (exceptions and linked decisions don't make it a different rule). */
const ruleShape = (i: Invariant) => {
  const { exceptions: _e, decisions: _d, source: _s, ...rest } = i;
  return stableJson(rest);
};

/**
 * Domain adds/removes/renames/purposes, cell adds/removes, file placements and moves (over `files`; a file that
 * leaves every cell is covered by its remove_domain/remove_cell and gets no entry of its own), and rule
 * adds/retires/changes, in that order. Deterministic: domains in map order, files and rules sorted.
 */
export const diffMaps: DiffMaps = (current, next, files) => {
  const out: ProposalChange[] = [];
  const before = new Map(current.domains.map((d) => [d.id, d]));
  const after = new Map(next.domains.map((d) => [d.id, d]));

  for (const d of next.domains) {
    const b = before.get(d.id);
    if (!b) {
      out.push({ kind: 'add_domain', domain: d.id, name: d.name });
      out.push({ kind: 'purpose', domain: d.id, purpose: d.purpose });
      for (const layer of Object.keys(d.cells)) out.push({ kind: 'add_cell', domain: d.id, layer });
      continue;
    }
    if (b.name !== d.name) out.push({ kind: 'rename_domain', domain: d.id, from: b.name, to: d.name });
    if (b.purpose !== d.purpose) out.push({ kind: 'purpose', domain: d.id, purpose: d.purpose });
    for (const layer of Object.keys(d.cells)) if (!(layer in b.cells)) out.push({ kind: 'add_cell', domain: d.id, layer });
    for (const layer of Object.keys(b.cells)) if (!(layer in d.cells)) out.push({ kind: 'remove_cell', domain: d.id, layer });
  }
  for (const d of current.domains) if (!after.has(d.id)) out.push({ kind: 'remove_domain', domain: d.id });

  const a = createMapper(current);
  const n = createMapper(next);
  for (const path of [...new Set(files)].sort()) {
    const from = a.place(path), to = n.place(path);
    if (to.kind !== 'cell') continue;
    if (from.kind === 'cell') {
      if (from.domain !== to.domain || from.layer !== to.layer) out.push({ kind: 'move', path, from: { domain: from.domain, layer: from.layer }, to: { domain: to.domain, layer: to.layer } });
    } else {
      out.push({ kind: 'place', path, domain: to.domain, layer: to.layer }); // from unassigned (or neutral/test/ignored) into a cell
    }
  }

  const rulesBefore = new Map(current.invariants.map((i) => [i.id, i]));
  const rulesAfter = new Map(next.invariants.map((i) => [i.id, i]));
  for (const id of [...rulesAfter.keys()].sort()) {
    const i = rulesAfter.get(id)!, b = rulesBefore.get(id);
    if (!b) out.push({ kind: 'add_rule', invariant: id, rule: i.rule });
    else if (ruleShape(b) !== ruleShape(i)) out.push({ kind: 'change_rule', invariant: id, rule: i.rule });
  }
  for (const id of [...rulesBefore.keys()].sort()) if (!rulesAfter.has(id)) out.push({ kind: 'retire_rule', invariant: id });
  return out;
};

/** Canonical key of a change set, used to recognize a proposal the user already rejected. */
export function changeSignature(changes: readonly ProposalChange[]): string {
  return changes.map(stableJson).sort().join('\n');
}

/** Short human summary of a change set ("add domain Billing; place 3 files; …"). */
export function summarizeChanges(changes: readonly ProposalChange[]): string {
  const parts: string[] = [];
  const count = (k: ProposalChange['kind']) => changes.filter((c) => c.kind === k).length;
  for (const c of changes) {
    if (c.kind === 'add_domain') parts.push(`add domain ${c.name} (${c.domain})`);
    else if (c.kind === 'remove_domain') parts.push(`remove domain ${c.domain}`);
    else if (c.kind === 'rename_domain') parts.push(`rename ${c.domain} "${c.from}" → "${c.to}"`);
    else if (c.kind === 'add_rule') parts.push(`add rule ${c.invariant}: ${c.rule}`);
    else if (c.kind === 'retire_rule') parts.push(`retire rule ${c.invariant}`);
    else if (c.kind === 'change_rule') parts.push(`change rule ${c.invariant}: ${c.rule}`);
  }
  const placed = count('place'), moved = count('move');
  if (placed) parts.push(`place ${placed} file${placed === 1 ? '' : 's'}`);
  if (moved) parts.push(`move ${moved} file${moved === 1 ? '' : 's'}`);
  return parts.join('; ') || 'no structural change';
}
