// Event-log snapshots on the server (NAVIGATION_PLAN N11). The bus folds every event into a running UI state; every
// SNAPSHOT_EVERY events that state is written as a content-addressed blob `.harness/snapshots/<sha256>.json` and listed
// in `.harness/snapshots/index.json`. On start the running state is rebuilt from the nearest snapshot plus the events
// after it. Snapshots are a cache of the log (delete the folder and nothing changes but speed); the shell can fetch
// them for replay. Deterministic, no model.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { apply, cloneState, nearestSnapshot, reduceFrom, SNAPSHOT_EVERY, type Snapshot, type SnapshotEntry, type UIState } from '@harness/core';
import type { Bus } from './bus';

export type SnapshotStore = {
  /** The UI state after every event so far (shared; callers must not mutate it). */
  state(): UIState;
  entries(): SnapshotEntry[];
  /** A stored snapshot by hash, or null. */
  read(hash: string): Snapshot | null;
  /** The state after the first `upTo` events, from the nearest snapshot. */
  at(upTo: number): UIState;
  detach(): void;
};

export function attachSnapshots(bus: Bus, root: string, every = SNAPSHOT_EVERY): SnapshotStore {
  const dir = join(root, '.harness', 'snapshots');
  const indexPath = join(dir, 'index.json');
  const readJson = <T>(p: string, fallback: T): T => { try { return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : fallback; } catch { return fallback; } };
  let entries = readJson<{ entries: SnapshotEntry[] }>(indexPath, { entries: [] }).entries;
  const read = (hash: string): Snapshot | null => (/^[0-9a-f]{64}$/.test(hash) ? readJson<Snapshot | null>(join(dir, `${hash}.json`), null) : null);

  const load = (upTo: number): UIState => {
    const e = nearestSnapshot(entries, bus.events, upTo);
    const snap = e ? read(e.hash) : null;
    return reduceFrom(snap && snap.upTo === e!.upTo ? snap : null, bus.events, upTo);
  };

  const save = (upTo: number, state: UIState) => {
    const body = JSON.stringify({ upTo, state });
    const hash = createHash('sha256').update(body).digest('hex');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${hash}.json`);
    if (!existsSync(file)) writeFileSync(file, body);
    entries = [...entries.filter((x) => x.upTo !== upTo), { upTo, hash, lastEvent: bus.events[upTo - 1]!.id }].sort((a, b) => a.upTo - b.upTo);
    writeFileSync(indexPath, JSON.stringify({ entries }, null, 1));
  };

  // The running state: rebuilt from the nearest snapshot, then kept current event by event.
  let running = load(bus.events.length);
  let count = bus.events.length;
  const off = bus.on((e) => {
    apply(running, e, count++);
    if (count % every === 0) {
      try { save(count, cloneState(running)); }
      catch { /* a cache: the log stays the source of truth */ }
    }
  });

  return {
    state: () => running,
    entries: () => entries,
    read,
    at: (upTo) => (upTo >= count ? cloneState(running) : load(upTo)),
    detach: () => { off(); running = load(bus.events.length); },
  };
}

/** HTTP endpoints, mounted under /api: the index, and one snapshot blob by hash (for replay in the shell). */
export function snapshotRoutes(store: SnapshotStore) {
  const r = new Hono();
  r.get('/snapshots', (c) => c.json({ every: SNAPSHOT_EVERY, entries: store.entries() }));
  r.get('/snapshots/:hash', (c) => {
    const s = store.read(c.req.param('hash'));
    return s ? c.json(s) : c.json({ error: 'not found' }, 404);
  });
  return r;
}
