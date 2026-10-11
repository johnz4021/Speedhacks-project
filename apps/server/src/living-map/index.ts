// Living map (NAVIGATION_PLAN §4), server side: git history, the cartographer runner, the drift → proposal loop,
// rejection records and inferred labels. The pure engine (scoring, drift, diffs, skeleton) is in @harness/core.
import { scanRepo, skeletonMap, mapToYaml, SKELETON_IGNORE, type DomainMap } from '@harness/core';
import { toFileFacts } from './history';

export { gitHistory, toFileFacts } from './history';
export { sdkProposer, buildPrompt, CANDIDATES_SCHEMA, type Proposer, type ProposeInput, type ProposerResult, type Candidate, type RejectedProposal } from './runner';
export { writeRejection, listRejected, listStanding } from './records';
export { labelsFor, sdkLabeler, type Labeler, type Group } from './labels';
export { attachLivingMap, livingMapRoutes, chooseCandidate, disruption, SIMILAR, type LivingMap, type LivingMapOptions } from './loop';

/** Instant onboarding proposal (no model, < 1 s): the deterministic skeleton map as domains.yaml text. */
export function onboardingSkeleton(root: string): string {
  const bare = { version: 1, layers: [{ id: 'x', name: 'x' }], ignore: SKELETON_IGNORE, domains: [], invariants: [] } as DomainMap;
  const facts = scanRepo(root, bare);
  return mapToYaml(skeletonMap(facts.files, toFileFacts(facts)), '# Instant skeleton (deterministic, no model). The cartographer refines it.\n\n');
}
