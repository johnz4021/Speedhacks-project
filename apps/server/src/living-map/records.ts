// Rejected proposals are decisions (NAVIGATION_PLAN §4.5): decisions/DR-n.md with `status: rejected`, so the
// cartographer never proposes the same change again. Same file format and id sequence as fork decisions.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { nextDecisionId, summarizeChanges, changeSignature, describeScores, type MapProposal, type ProposalChange } from '@harness/core';
import { listDecisions } from '../decisions';
import type { RejectedProposal, StandingDecision } from './runner';

/** Paths a proposal touches (placed or moved files), for the decision's anchors. */
function touchedPaths(changes: readonly ProposalChange[]): string[] {
  return [...new Set(changes.flatMap((c) => (c.kind === 'place' || c.kind === 'move' ? [c.path] : [])))].sort();
}

/** Write decisions/DR-n.md recording the rejection; returns its id and repo-relative path. Does not commit. */
export function writeRejection(root: string, map: Parameters<typeof nextDecisionId>[0], proposal: MapProposal, reason?: string): { id: string; path: string } {
  const id = nextDecisionId(map, listDecisions(root).map((d) => d.id));
  const summary = summarizeChanges(proposal.changes);
  const chosen = proposal.candidates[proposal.chosen];
  const fm = {
    id,
    title: `Keep the map as it is: rejected ${proposal.id} (${summary})`,
    outcome: 'Keep the current map',
    status: 'rejected',
    type: 'map_proposal',
    invariant: '',
    proposal: proposal.id,
    anchors: { paths: touchedPaths(proposal.changes) },
    rejected: `${proposal.id}: ${summary}`,
    signature: changeSignature(proposal.changes),
    changes: proposal.changes,
  };
  const body = [
    `The user rejected cartographer proposal ${proposal.id}.${reason?.trim() ? ` In their words: "${reason.trim()}"` : ''}`,
    '',
    `Triggered by: ${proposal.trigger.map((s) => `${s.signal} (${s.metric} = ${s.value})`).join('; ')}`,
    '',
    `Proposal: ${proposal.rationale}`,
    chosen ? `\nScores: ${describeScores(proposal.current, chosen.score)}` : '',
  ].join('\n');
  mkdirSync(join(root, 'decisions'), { recursive: true });
  const path = `decisions/${id}.md`;
  writeFileSync(join(root, path), `---\n${stringifyYaml(fm).trim()}\n---\n\n${body.trim()}\n`);
  return { id, path };
}

type Front = { id: string; status?: string; type?: string; proposal?: string; rejected?: string; changes?: ProposalChange[]; signature?: string; invariant?: string; anchors?: { paths?: string[] }; title: string; outcome: string; rationale: string };

/** Every rejected map proposal on record. */
export function listRejected(root: string): RejectedProposal[] {
  return (listDecisions(root) as unknown as Front[])
    .filter((d) => d.status === 'rejected' && d.type === 'map_proposal')
    .map((d) => ({ decision: d.id, proposal: d.proposal ?? '', summary: d.rejected ?? d.title, changes: d.changes ?? [], signature: d.signature ?? changeSignature(d.changes ?? []) }));
}

/** Standing (made) decisions with their anchored paths. */
export function listStanding(root: string): StandingDecision[] {
  return (listDecisions(root) as unknown as Front[])
    .filter((d) => d.status !== 'rejected')
    .map((d) => ({ id: d.id, title: d.title, outcome: d.outcome, rationale: d.rationale, invariant: d.invariant ?? '', paths: d.anchors?.paths ?? [] }));
}
