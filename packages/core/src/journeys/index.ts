// Journeys (NAVIGATION_PLAN §2, phase N10), computation only: pure and browser-safe. Naming is the server's
// (apps/server/src/journeys): an injectable namer, cached by journeyHash, inferred until confirmed.
export { computeJourneys, linkFetches, fetchEdges, journeySinks, journeySlug, journeyHash, MAX_BRANCHES, type FetchLink } from './compute';
export { inferDispatch, type InferredEdge } from './dispatch';
export { findFetchSites, matchRoute, urlPath, type FetchSite, type SourceFile } from './fetches';
export { providerPaths } from './provider-paths';
