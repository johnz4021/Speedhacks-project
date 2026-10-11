// Journeys (NAVIGATION_PLAN §2, phase N10), computation only: pure and browser-safe. Naming is the server's
// (apps/server/src/journeys): an injectable namer, cached by journeyHash, inferred until confirmed.
export { computeJourneys, linkFetches, journeySinks, journeySlug, journeyHash, type FetchLink } from './compute';
export { findFetchSites, matchRoute, urlPath, type FetchSite, type SourceFile } from './fetches';
