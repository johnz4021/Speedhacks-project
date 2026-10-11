// The real pipeline wired to the stores: ui = reduce(events, upTo) → graph = graphOf(ui) (memoized) →
// activity = activityFor(ui, graph, turn) → projection = project(graph, view, activity).
import { useMemo } from 'react';
import { useView } from '../derive';
import { graphMemo, sceneOf, type Scene } from './scene';
import { useV2 } from './store';

export { hotLabels, type Scene } from './scene';

const memoGraph = graphMemo();

/** The scene for the current events, replay index, selected turn and open set. */
export function useScene(): Scene | null {
  const v = useView();
  const open = useV2((s) => s.open);
  const graph = useMemo(() => memoGraph(v.ui), [v.ui]);
  return useMemo(() => (graph ? sceneOf(v.ui, graph, v.turn?.id ?? null, open) : null), [v.ui, v.turn, graph, open]);
}
