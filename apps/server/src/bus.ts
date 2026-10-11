import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HarnessEvent, EventKind, EventData, Cell } from '@harness/core';

type Listener = (e: HarnessEvent) => void;

/** Append-only event log: `.harness/events.jsonl` in the target repo, broadcast to every listener. */
export class Bus {
  readonly events: HarnessEvent[] = [];
  readonly session = randomUUID().slice(0, 8);
  turn: string | null = null;
  private listeners = new Set<Listener>();
  private file: string;

  constructor(repo: string, opts: { fresh?: boolean } = {}) {
    const dir = join(repo, '.harness');
    mkdirSync(join(dir, 'turns'), { recursive: true });
    // Keep .harness/ out of the target's git without touching its .gitignore.
    if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), '*\n');
    this.file = join(dir, 'events.jsonl');
    if (opts.fresh) writeFileSync(this.file, '');
    else if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (line.trim()) this.events.push(JSON.parse(line) as HarnessEvent);
      }
    }
  }

  emit<K extends EventKind>(kind: K, data: K extends keyof EventData ? EventData[K] : never, extra: { cell?: Cell | null; path?: string; turn?: string | null } = {}): HarnessEvent {
    const e: HarnessEvent = {
      id: randomUUID().slice(0, 12),
      t: Date.now(),
      session: this.session,
      turn: extra.turn === undefined ? this.turn : extra.turn,
      kind,
      ...(extra.cell ? { cell: extra.cell } : {}),
      ...(extra.path ? { path: extra.path } : {}),
      data: data as Record<string, unknown>,
    };
    this.events.push(e);
    appendFileSync(this.file, JSON.stringify(e) + '\n');
    for (const l of this.listeners) l(e);
    return e;
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
