import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { diffLines } from 'diff';
import {
  parseDomainMap, createMapper, scanRepo, factsForSource, domainEdges, check, fileExistsIn,
  type DomainMap, type Facts, type ImportEdge, type Violation, type Placement,
} from '@harness/core';
import type { Bus } from './bus';

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|mts)$/;

export class Repo {
  readonly root: string;
  map!: DomainMap;
  mapText = '';
  mapper!: ReturnType<typeof createMapper>;
  facts: Facts = { files: [], imports: [], writes: [] };
  violations: Violation[] = [];
  private contents = new Map<string, string>();
  private pending = new Map<string, NodeJS.Timeout>(); // paths a hook is editing; the watcher leaves them alone
  private watcher: FSWatcher | null = null;
  exists: ReturnType<typeof fileExistsIn>;

  constructor(root: string, private bus: Bus) {
    this.root = realpathSync(root);
    this.exists = fileExistsIn(this.root);
  }

  get mapPath() { return join(this.root, 'domains.yaml'); }
  hasMap() { return existsSync(this.mapPath); }

  /** Load (or reload) domains.yaml text. */
  setMap(text: string) {
    this.mapText = text;
    this.map = parseDomainMap(text);
    this.mapper = createMapper(this.map);
  }

  loadMapFile() { this.setMap(readFileSync(this.mapPath, 'utf8')); }

  /** Repo-relative POSIX path for an absolute path from a hook, or null if it is outside the repo. */
  rel(p: string): string | null {
    let abs = isAbsolute(p) ? p : join(this.root, p);
    try { abs = realpathSync(abs); } catch {
      // New file: resolve the parent instead.
      const i = abs.lastIndexOf('/');
      try { abs = join(realpathSync(abs.slice(0, i)), abs.slice(i + 1)); } catch { /* keep as is */ }
    }
    const r = relative(this.root, abs);
    if (!r || r.startsWith('..') || isAbsolute(r)) return null;
    return r.split('\\').join('/');
  }

  place(path: string): Placement { return this.mapper.place(path); }

  cellOf(path: string) {
    const p = this.place(path);
    return p.kind === 'cell' ? { domain: p.domain, layer: p.layer } : null;
  }

  /** Placement for a directory (Grep/Glob path): the single cell all known files under it share, if any. */
  cellForDir(dir: string) {
    const prefix = dir.replace(/\/$/, '') + '/';
    let found: { domain: string; layer: string } | null = null;
    for (const f of this.facts.files) {
      if (!f.startsWith(prefix)) continue;
      const c = this.cellOf(f);
      if (!c) continue;
      if (found && (found.domain !== c.domain || found.layer !== c.layer)) return null;
      found = c;
    }
    return found;
  }

  /** Every non-ignored file under the current map. */
  listFiles() { return scanRepo(this.root, this.map).files; }

  /** Full fact scan → `repo_scanned` + `violation_found`. */
  scan() {
    this.facts = scanRepo(this.root, this.map);
    this.contents.clear();
    for (const f of this.facts.files) {
      if (CODE.test(f)) this.contents.set(f, readFileSync(join(this.root, f), 'utf8'));
    }
    this.bus.emit('repo_scanned', {
      files: this.facts.files.map((path) => ({ path, placement: this.place(path) })),
      imports: this.facts.imports,
      writes: this.facts.writes,
      edges: domainEdges(this.facts, this.mapper),
    }, { turn: null });
    this.recheck();
  }

  /** Re-run the checker over the whole repo (load call site) and publish the current set. */
  recheck() {
    this.violations = check(this.map, this.facts, this.mapper);
    this.bus.emit('violation_found', { violations: this.violations }, { turn: null });
  }

  current(path: string): string | null {
    if (this.contents.has(path)) return this.contents.get(path)!;
    const abs = join(this.root, path);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  }

  markPending(path: string) {
    clearTimeout(this.pending.get(path));
    this.pending.set(path, setTimeout(() => this.pending.delete(path), 10_000));
  }

  /**
   * A file changed on disk: emit `edited` (+/− lines) and edge events from its import diff, and update facts.
   * Called by the PostToolUse hook (attributed) and the watcher (unattributed). No-op if the content is unchanged.
   */
  fileChanged(path: string, attr: { tool?: string; unattributed?: boolean }) {
    if (this.mapper.isIgnored(path)) return;
    const abs = join(this.root, path);
    const deleted = !existsSync(abs);
    const next = deleted ? '' : readFileSync(abs, 'utf8');
    const prev = this.contents.get(path);
    const known = this.facts.files.includes(path);
    if (prev === next && known) return;
    if (!attr.unattributed) { clearTimeout(this.pending.get(path)); this.pending.delete(path); }

    let added = 0, removed = 0;
    for (const part of diffLines(prev ?? '', next)) {
      if (part.added) added += part.count ?? 0;
      else if (part.removed) removed += part.count ?? 0;
    }
    const created = !known && !deleted;
    if (created) {
      this.facts.files.push(path);
      this.bus.emit('file_assigned', { placement: this.place(path) }, { path });
    }
    if (deleted) this.facts.files = this.facts.files.filter((f) => f !== path);
    if (created || deleted) this.exists.clear();

    // Import and write facts for this one file.
    const before = this.facts.imports.filter((i) => i.from === path);
    const after = CODE.test(path) && !deleted ? factsForSource(path, next, this.exists) : { imports: [], writes: [] };
    this.facts.imports = [...this.facts.imports.filter((i) => i.from !== path), ...after.imports];
    this.facts.writes = [...this.facts.writes.filter((w) => w.file !== path), ...after.writes];
    if (deleted) this.contents.delete(path); else if (CODE.test(path)) this.contents.set(path, next);

    this.bus.emit('edited', { added, removed, created, ...(attr.unattributed ? { unattributed: true } : {}), ...(attr.tool ? { tool: attr.tool } : {}) }, { path, cell: this.cellOf(path) });

    const key = (i: ImportEdge) => `${i.from}→${i.to}`;
    const beforeKeys = new Set(before.map(key));
    const afterKeys = new Set(after.imports.map(key));
    const gained = after.imports.filter((i) => !beforeKeys.has(key(i)));
    const lost = before.filter((i) => !afterKeys.has(key(i)));
    for (const de of domainEdges({ imports: gained, writes: [] }, this.mapper)) {
      for (const edge of de.files) this.bus.emit('edge_added', { edge, from: de.from, to: de.to }, { path });
    }
    for (const de of domainEdges({ imports: lost, writes: [] }, this.mapper)) {
      for (const edge of de.files) this.bus.emit('edge_removed', { edge, from: de.from, to: de.to }, { path });
    }
  }

  /** Completeness: any write that no hook reported (e.g. from Bash) becomes an unattributed `edited` event. */
  startWatcher() {
    const ignored = (p: string) => {
      const r = relative(this.root, p);
      if (!r || r.startsWith('..')) return false;
      return /(^|\/)(node_modules|\.git|\.harness)(\/|$)/.test(r) || this.mapper.isIgnored(r.split('\\').join('/'));
    };
    this.watcher = watch(this.root, { ignored, ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 } });
    const handle = (abs: string) => {
      const r = this.rel(abs);
      if (!r || this.pending.has(r) || r === 'domains.yaml') return;
      this.fileChanged(r, { unattributed: true });
    };
    this.watcher.on('add', handle).on('change', handle).on('unlink', handle);
  }

  async close() { await this.watcher?.close(); }
}
