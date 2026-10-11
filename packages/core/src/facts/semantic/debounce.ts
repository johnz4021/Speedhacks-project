// Per-key debounce with batching: each key waits `ms` after its last `push`; keys that come due together flush as one
// batch (one snapshot update in the resolver). Only the latest value per key is kept.

export class KeyedDebounce<T> {
  private latest = new Map<string, T>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private due = new Map<string, T>();
  private flushing: ReturnType<typeof setTimeout> | null = null;

  constructor(private ms: number, private flush: (batch: Map<string, T>) => void) {}

  push(key: string, value: T) {
    this.latest.set(key, value);
    this.due.delete(key); // a newer value restarts the wait even if the old one was about to flush
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      if (!this.latest.has(key)) return;
      this.due.set(key, this.latest.get(key)!);
      this.latest.delete(key);
      this.flushing ??= setTimeout(() => this.drain(), 0);
    }, this.ms));
  }

  /** Keys waiting (not yet flushed). */
  get pending(): number {
    return this.latest.size + this.due.size;
  }

  /** Drop everything queued (e.g. a full reload supersedes it). */
  clear() {
    for (const t of this.timers.values()) clearTimeout(t);
    if (this.flushing) clearTimeout(this.flushing);
    this.timers.clear();
    this.latest.clear();
    this.due.clear();
    this.flushing = null;
  }

  private drain() {
    this.flushing = null;
    if (!this.due.size) return;
    const batch = this.due;
    this.due = new Map();
    this.flush(batch);
  }
}
