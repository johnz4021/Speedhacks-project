// Event-log snapshots (NAVIGATION_PLAN N11): the UI state after the first `upTo` events, so load and replay on a long
// log fold only the events after the nearest snapshot. A snapshot is a cache of `reduce(events, upTo)`, never a source
// of truth: `reduceFrom(snapshot, events, n)` must equal `reduce(events, n)` (tested). Pure and browser-safe.
import { apply, initialState, reduce, type HarnessEvent, type UIState } from '../events';

/** How often the server snapshots (in events). */
export const SNAPSHOT_EVERY = 500;

export type Snapshot = { upTo: number; state: UIState };
/** One stored snapshot: blob `.harness/snapshots/<hash>.json` holds `{ upTo, state }`. */
export type SnapshotEntry = { upTo: number; hash: string; lastEvent: string };

/** The snapshot of the first `upTo` events (a fresh state; the events are not touched). */
export const snapshotOf = (events: readonly HarnessEvent[], upTo: number): Snapshot => ({ upTo: Math.min(upTo, events.length), state: reduce(events, upTo) });

/** A deep copy of a state, so folding more events never changes a snapshot (states are plain JSON). */
export const cloneState = (s: UIState): UIState => JSON.parse(JSON.stringify(s)) as UIState;

/**
 * `reduce(events, upTo)` starting from a snapshot of a prefix of the same log: copy the snapshot's state, then apply
 * events `snapshot.upTo … upTo-1` with their real indexes (provenance uses them). A snapshot past `upTo` is unusable
 * for that point, so it falls back to a full reduce.
 */
export function reduceFrom(snapshot: Snapshot | null, events: readonly HarnessEvent[], upTo = events.length): UIState {
  const n = Math.min(upTo, events.length);
  if (!snapshot || snapshot.upTo > n) return reduce(events, n);
  const s = snapshot.upTo ? cloneState(snapshot.state) : initialState();
  for (let i = snapshot.upTo; i < n; i++) apply(s, events[i]!, i);
  return s;
}

/** The latest entry at or before `upTo` whose last event id matches the log (a snapshot of a different log is ignored). */
export function nearestSnapshot(entries: readonly SnapshotEntry[], events: readonly HarnessEvent[], upTo = events.length): SnapshotEntry | null {
  let best: SnapshotEntry | null = null;
  for (const e of entries) {
    if (e.upTo < 1 || e.upTo > Math.min(upTo, events.length) || events[e.upTo - 1]?.id !== e.lastEvent) continue;
    if (!best || e.upTo > best.upTo) best = e;
  }
  return best;
}

/** Snapshot points for a log of `length` events: every `every` events. */
export const snapshotPoints = (length: number, every = SNAPSHOT_EVERY): number[] =>
  Array.from({ length: Math.floor(length / every) }, (_, i) => (i + 1) * every);
