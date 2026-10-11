// Graph lane (NAVIGATION_PLAN §3.2): ContextGraph, activity, projection, DOI expansion and trace. Pure, browser-safe.
//
// Typical use: `const g = graphOf(ui); const p = project(g, view, activityFor(ui, g, turnId));`
// Parity with today's views is defined at "domains expanded one level" (view.expanded = every domain id,
// lens.kinds = ['imports']): the visible `cell:` nodes equal cellViews and the cross-domain cell→cell edges,
// grouped by domain pair, equal edgeViews (test/graph-parity.test.ts checks every prefix of the demo log).
export { buildGraph, graphFacts, graphOf, fileLabel, VENDORS_ID, GROUP_THRESHOLD, EXTERNAL_LAYER } from './build';
export { activityFor, emptyLeaf, strongerMark } from './activity';
export { project, gridOf, worse, isActive } from './project';
export { autoExpand, importance } from './expand';
export { trace, MAX_TRACE_PATHS } from './trace';
