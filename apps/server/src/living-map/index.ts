// Living map (NAVIGATION_PLAN §4), server side: git history, the cartographer runner, the drift → proposal loop,
// onboarding (skeleton, then K scored candidates), rejection records and inferred labels. The pure engine (scoring,
// drift, diffs, skeleton) is in @harness/core.
export { gitHistory } from './history';
export { sdkProposer, buildPrompt, CANDIDATES_SCHEMA, type Proposer, type ProposeInput, type ProposerResult, type Candidate, type RejectedProposal } from './runner';
export { writeRejection, listRejected, listStanding } from './records';
export { labelsFor, sdkLabeler, type Labeler, type Group } from './labels';
export { attachLivingMap, livingMapRoutes, chooseCandidate, disruption, SIMILAR, type LivingMap, type LivingMapOptions } from './loop';
export { onboardingSkeleton, proposeOnboarding, type OnboardingResult } from './onboard';
