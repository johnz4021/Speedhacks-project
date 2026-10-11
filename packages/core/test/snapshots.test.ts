// Event-log snapshots (N11): reduceFrom(snapshot, events, n) equals reduce(events, n) at every cut, snapshots never
// change when more events are folded, and the server stores them content-addressed and reloads from the nearest one.
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reduce, type HarnessEvent } from '../src/events';
import { nearestSnapshot, reduceFrom, snapshotOf, snapshotPoints } from '../src/snapshots';
import { Bus } from '../../../apps/server/src/bus';
import { attachSnapshots } from '../../../apps/server/src/snapshots';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as HarnessEvent[];
const logs = { 'beats-3-4-4b': fixture('beats-3-4-4b.events.json'), 'beats-3-4': fixture('beats-3-4.events.json') };
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('reduceFrom', () => {
  for (const [name, events] of Object.entries(logs)) {
    it(`equals a full reduce at every replay point from every snapshot (${name}, ${events.length} events)`, () => {
      const cuts = [0, 1, 7, Math.floor(events.length / 3), Math.floor(events.length / 2), events.length - 1, events.length];
      for (const at of cuts) {
        const snap = snapshotOf(events, at);
        for (const n of cuts.filter((c) => c >= at)) expect(reduceFrom(snap, events, n)).toEqual(reduce(events, n));
        expect(reduceFrom(snap, events, Math.max(0, at - 1))).toEqual(reduce(events, Math.max(0, at - 1))); // past the point: full reduce
      }
      expect(reduceFrom(null, events)).toEqual(reduce(events));
    });
  }

  it('never mutates the snapshot', () => {
    const events = logs['beats-3-4-4b'];
    const snap = snapshotOf(events, 50);
    const before = JSON.stringify(snap);
    reduceFrom(snap, events);
    reduceFrom(snap, events, 120);
    expect(JSON.stringify(snap)).toBe(before);
  });

  it('picks the nearest snapshot of this log only', () => {
    const events = logs['beats-3-4-4b'];
    const entries = [
      { upTo: 50, hash: 'a', lastEvent: events[49]!.id },
      { upTo: 100, hash: 'b', lastEvent: events[99]!.id },
      { upTo: 150, hash: 'c', lastEvent: 'from another log' },
    ];
    expect(nearestSnapshot(entries, events)?.hash).toBe('b');
    expect(nearestSnapshot(entries, events, 99)?.hash).toBe('a');
    expect(nearestSnapshot(entries, events, 10)).toBeNull();
    expect(snapshotPoints(1234)).toEqual([500, 1000]);
  });
});

describe('server snapshots', () => {
  it('saves every N events as a content-addressed blob with an index, and reloads from the nearest one', () => {
    const root = mkdtempSync(join(process.env.HARNESS_TEST_TMP ?? tmpdir(), 'harness-snap-'));
    dirs.push(root);
    const source = logs['beats-3-4-4b'];
    const bus = new Bus(root, { fresh: true });
    const store = attachSnapshots(bus, root, 40);
    for (const e of source) bus.emit(e.kind, e.data as never, { turn: e.turn, path: e.path, cell: e.cell });
    const n = source.length;
    expect(store.entries().map((e) => e.upTo)).toEqual(snapshotPoints(n, 40));
    const dir = join(root, '.harness', 'snapshots');
    expect(readdirSync(dir).filter((f) => f !== 'index.json')).toHaveLength(Math.floor(n / 40));
    expect(store.state()).toEqual(reduce(bus.events));
    expect(store.at(100)).toEqual(reduce(bus.events, 100));
    const last = store.entries().at(-1)!;
    expect(store.read(last.hash)).toEqual(JSON.parse(JSON.stringify({ upTo: last.upTo, state: reduce(bus.events, last.upTo) })));
    expect(store.read('../../etc/passwd')).toBeNull();
    store.detach();

    // A restart: a new bus on the same log rebuilds its running state from the nearest snapshot.
    const bus2 = new Bus(root);
    const store2 = attachSnapshots(bus2, root, 40);
    expect(store2.state()).toEqual(reduce(bus2.events));
    expect(existsSync(join(dir, 'index.json'))).toBe(true);
    store2.detach();
  });
});
