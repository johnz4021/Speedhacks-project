// Onboarding a repo without domains.yaml (NAVIGATION_PLAN §4.2): the instant deterministic skeleton first, then the
// cartographer's K candidate maps, each scored by code (scoreMap over git history); the best one is shown.
import {
  mapToYaml, parseDomainMap, scanRepoFacts, scoreMap, skeletonMap, SKELETON_IGNORE,
  type DomainMap, type FileFacts, type HistoryTurn, type MapScore,
} from '@harness/core';
import type { Bus } from '../bus';
import { gitHistory } from './history';
import { listRejected, listStanding } from './records';
import type { Candidate, Proposer } from './runner';

const BARE = { version: 1, layers: [{ id: 'x', name: 'x' }], ignore: SKELETON_IGNORE, domains: [], invariants: [] } as unknown as DomainMap;

/** Tier 1 facts of every code file a fresh repo has (skeleton ignore rules). */
function bareFacts(root: string) {
  const { files, fileFacts } = scanRepoFacts(root, BARE);
  return { files, facts: fileFacts };
}

/** Instant onboarding proposal (no model, < 1 s): the deterministic skeleton map as domains.yaml text. */
export function onboardingSkeleton(root: string): string {
  const { files, facts } = bareFacts(root);
  return mapToYaml(skeletonMap(files, facts), '# Instant skeleton (deterministic, no model). The cartographer refines it.\n\n');
}

export type OnboardingResult = {
  yaml: string;
  candidate: Candidate;
  score: MapScore;
  skeleton: MapScore;
  scored: number; // valid candidates scored
  cost: number | null;
};

const HEADER = '# Proposed by the Harness cartographer and confirmed by the user.\n# Domains are columns, layers are rows. Edges are derived from imports, never declared.\n\n';

/**
 * Ask the proposer for `k` candidate maps for a repo with no map yet, score each (lower total wins; invalid YAML is
 * dropped) and return the best, or null when none is valid. Emits `maintenance_run` (trigger `onboarding`).
 */
export async function proposeOnboarding(opts: { root: string; bus: Bus; proposer: Proposer; k: number; gitLimit?: number }): Promise<OnboardingResult | null> {
  const t0 = Date.now();
  const { root, bus, proposer, k } = opts;
  const { files, facts } = bareFacts(root);
  const skeleton = skeletonMap(files, facts);
  const yaml = mapToYaml(skeleton);
  const history: HistoryTurn[] = gitHistory(root, opts.gitLimit);
  const done = (ok: boolean, cost: number | null) => bus.emit('maintenance_run', { agent: 'cartographer', trigger: 'onboarding', ms: Date.now() - t0, cost, ok }, { turn: null });

  let result;
  try {
    result = await proposer({
      root, yaml, map: skeleton, facts: facts as Record<string, FileFacts>, signals: [], scope: skeleton.domains.map((d) => `domain:${d.id}`).sort(),
      history, turns: [], decisions: listStanding(root), rejected: listRejected(root), k, mode: 'onboard',
    });
  } catch (e) {
    done(false, (e as { cost?: number }).cost ?? null);
    throw e;
  }
  const skeletonScore = scoreMap(skeleton, facts, history);
  let best: OnboardingResult | null = null;
  let scored = 0;
  for (const candidate of result.candidates.slice(0, k)) {
    let map: DomainMap;
    try { map = parseDomainMap(candidate.yaml); } catch { continue; }
    if (!map.domains.length) continue;
    scored++;
    const score = scoreMap(map, facts, history);
    if (!best || score.total < best.score.total) best = { yaml: candidate.yaml, candidate, score, skeleton: skeletonScore, scored: 0, cost: result.cost };
  }
  done(true, result.cost);
  if (!best) return null;
  best.scored = scored;
  if (!best.yaml.trimStart().startsWith('#')) best.yaml = HEADER + best.yaml;
  return best;
}
