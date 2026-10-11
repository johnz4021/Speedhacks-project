// Living map engine (NAVIGATION_PLAN §4): drift signals, map scoring, diffs, guesses and the skeleton map.
// Pure and browser-safe; the cartographer agent and the loop that drives it live in apps/server/src/living-map/.
export { historyFromUI, isBulk } from './history';
export { scoreMap, cellsLitPerUnit, modularity, brokenDecisions, removedIds, describeScores, SCORE_WEIGHTS, PROPOSAL_MARGIN } from './score';
export { detectDrift, thresholdsFor, topFolder, cellFiles, groupHash, labelHash } from './drift';
export { diffMaps, changeSignature, summarizeChanges } from './diff';
export { instantGuess, type PlacementGuess } from './guess';
export { skeletonMap, mapToYaml, layerFor, SKELETON_LAYERS, SKELETON_IGNORE } from './skeleton';
export { gini, fnv1a, median, UNASSIGNED_CELL } from './util';
