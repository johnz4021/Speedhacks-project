// Auditor helpers (NAVIGATION_PLAN §4.6, phase N9): pure and deterministic. The model call and git live in the server
// (apps/server/src/auditor). Flow per finished turn: turnSurface → relevantDecisions (skip the model if none) →
// auditor(model) → acceptFindings (signatures, dismissal memory) → `audit_finding` events.
export { turnSurface, planSurface, factDelta, type TurnSurface, type FactDeltaPlus } from './surface';
export { relevantDecisions, type AuditDecision, type RelevantDecision, type RelevanceReason } from './filter';
export { acceptFindings, findingSignature, normalizeFindingText, isDismissed, textSimilarity, nextFindingId, DISMISS_SIMILARITY, type RawFinding, type DismissedFinding } from './findings';
export { numberDiff } from './hunks';
export {
  setRuleText, reinforcements, changeRuleProposal, manualRuleProposal, reinforcedRuleText, amendedRuleText, reinforcementSignal,
  type Reinforcement, type RuleProposalInput,
} from './rules';
