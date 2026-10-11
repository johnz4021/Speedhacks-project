import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { diffLines } from 'diff';
import {
  parseDomainMap, createMapper, listRepoFiles, scanRepoFacts, factsForSource, domainEdges, check, fileExistsIn, createFactsIndex,
  settleCalls, diffSymbols, moduleRecord,
  type CallFact, type DomainMap, type Facts, type FileFacts, type ImportEdge, type Violation, type Placement, type SymbolDiff,
} from '@harness/core';
import type { Bus } from './bus';

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|mts)$/;
/** Files that change how imports resolve or what the entries are: a change rescans facts (domains.yaml reloads the map). */
const CONFIG = /(^|\/)(package\.json|tsconfig[^/]*\.json|jsconfig\.json|pnpm-workspace\.yaml)$/;
export const isConfigFile = (rel: string) => rel === 'domains.yaml' || CONFIG.test(rel);
/** Importers re-linked after one file's exports or symbols change (re-exports are followed up to 4 barrels deep). */
export const MAX_RELINK = 200;

const callKey = (c: { from: string; to: string }) => `${c.from}\u0000${c.to}`;
/** Export names, re-export targets and `export *` of a module record: what importers link through. */
const exportShape = (path: string, text: string | null | undefined) => {
  if (text == null) return '';
  const r = moduleRecord(path, text);
  return JSON.stringify([[...r.exports].sort(([a], [b]) => (a < b ? -1 : 1)), r.stars]);
};
const isBarrel = (path: string, text: string | null) => {
  if (text === null) return false;
  const r = moduleRecord(path, text);
  return r.stars.length > 0 || [...r.exports.values()].some((t) => 'spec' in t);
};

export class Repo {
  readonly root: string;
  map!: DomainMap;
  mapText = '';
  mapper!: ReturnType<typeof createMapper>;
  facts: Facts = { files: [], imports: [], writes: [] };
  /** Tier 1 facts per code file (NAVIGATION_PLAN §3.1); the previous value is diffed on every change. */
  fileFacts = new Map<string, FileFacts>();
  private index!: ReturnType<typeof createFactsIndex>;
  violations: Violation[] = [];
  private contents = new Map<string, string>();
  private pending = new Map<string, NodeJS.Timeout>(); // paths a hook is editing; the watcher leaves them alone
  private watcher: FSWatcher | null = null;
  private configQueue = new Set<string>();
  private configTimer: NodeJS.Timeout | null = null;
  exists: ReturnType<typeof fileExistsIn>;

  constructor(root: string, private bus: Bus) {
    this.root = realpathSync(root);
    this.exists = fileExistsIn(this.root);
  }

  get mapPath() { return join(this.root, 'domains.yaml'); }
  hasMap() { return existsSync(this.mapPath); }

  /** Load (or reload) domains.yaml text. */
  setMap(text: string) {
    const map = parseDomainMap(text); // throws before anything changes
    this.mapText = text;
    this.map = map;
    this.mapper = createMapper(this.map);
    this.index = createFactsIndex(this.root, this.map, this.exists, (p) => this.current(p));
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
  listFiles() { return listRepoFiles(this.root, this.map, this.mapper); }

  /** Full fact scan → `repo_scanned` (with Tier 1 `fileFacts`) + `violation_found`. */
  scan() {
    this.exists.clear();
    const { fileFacts, ...facts } = scanRepoFacts(this.root, this.map);
    this.facts = facts;
    this.fileFacts = new Map(Object.entries(fileFacts));
    this.contents.clear();
    for (const f of this.facts.files) {
      if (CODE.test(f)) this.contents.set(f, readFileSync(join(this.root, f), 'utf8'));
    }
    this.bus.emit('repo_scanned', {
      files: this.facts.files.map((path) => ({ path, placement: this.place(path) })),
      imports: this.facts.imports,
      writes: this.facts.writes,
      edges: domainEdges(this.facts, this.mapper),
      fileFacts: [...this.fileFacts.values()],
    }, { turn: null });
    this.recheck();
  }

  /**
   * Tier 1 facts for a changed code file (null when deleted), calls settled against the rest of the repo. If the new
   * text doesn't parse (mid-edit), symbols, calls, routes and entries stay as they were instead of reading as removed.
   */
  private refreshFacts(path: string, text: string | null): { prev: FileFacts | null; next: FileFacts | null; parsed: boolean } {
    const prev = this.fileFacts.get(path) ?? null;
    if (text === null) {
      this.fileFacts.delete(path);
      return { prev, next: null, parsed: true };
    }
    const { facts, parsed } = this.index.extract(path, text);
    if (!parsed && prev) Object.assign(facts, { symbols: prev.symbols, calls: prev.calls, routes: prev.routes, entries: prev.entries });
    else {
      const names = (file: string) => {
        const f = file === path ? facts : this.fileFacts.get(file);
        return f ? new Set(f.symbols.map((s) => s.name)) : null;
      };
      facts.calls = settleCalls(facts.calls, names);
    }
    this.fileFacts.set(path, facts);
    return { prev, next: facts, parsed };
  }

  /** `call_added` / `call_removed` for one file's outgoing call edges, diffed like imports. */
  private emitCallDiff(path: string, before: readonly CallFact[], after: readonly CallFact[]) {
    const oldCalls = new Set(before.map(callKey));
    const newCalls = new Set(after.map(callKey));
    for (const c of after) if (!oldCalls.has(callKey(c))) this.bus.emit('call_added', { from: c.from, to: c.to, confidence: c.confidence }, { path });
    for (const c of before) if (!newCalls.has(callKey(c))) this.bus.emit('call_removed', { from: c.from, to: c.to, confidence: c.confidence }, { path });
  }

  /**
   * Barrel relink (Tier 1): `changed`'s exports or symbol names changed, so calls its importers resolved through it (or
   * through barrels re-exporting it) may now point elsewhere. Re-extract those importers from their current text and
   * publish the ones whose calls or imports moved. Returns the re-linked paths.
   */
  relink(changed: string): string[] {
    const affected = new Set<string>();
    let frontier = new Set([changed]);
    for (let depth = 0; depth < 4 && frontier.size; depth++) {
      const next = new Set<string>();
      for (const [p, f] of this.fileFacts) {
        if (p === changed || affected.has(p) || !f.imports.some((i) => frontier.has(i.to))) continue;
        affected.add(p);
        if (isBarrel(p, this.current(p))) next.add(p);
      }
      frontier = next;
    }
    const moved: string[] = [];
    for (const p of [...affected].sort().slice(0, MAX_RELINK)) {
      const text = this.current(p);
      if (text === null) continue;
      const { prev, next } = this.refreshFacts(p, text);
      if (!prev || !next) continue;
      const same = JSON.stringify(prev.calls.map(callKey).sort()) === JSON.stringify(next.calls.map(callKey).sort())
        && JSON.stringify(prev.imports) === JSON.stringify(next.imports);
      if (same) continue;
      moved.push(p);
      this.bus.emit('facts_changed', { facts: next }, { path: p, cell: this.cellOf(p) });
      this.emitCallDiff(p, prev.calls, next.calls);
    }
    return moved;
  }

  /**
   * A config file changed on disk (watcher): `domains.yaml` reloads the map unless its text is what Harness itself last
   * loaded (every Harness write goes through `setMap`, so its own writes never rescan); `package.json`, `tsconfig*.json`
   * and `pnpm-workspace.yaml` rebuild the resolver and entries. Either way the facts are rescanned once.
   * Returns whether a rescan ran.
   */
  applyConfigChanges(paths: readonly string[]): boolean {
    let rescan = false;
    if (paths.includes('domains.yaml')) {
      let text: string | null = null;
      try { text = readFileSync(this.mapPath, 'utf8'); } catch { /* deleted: keep the map in memory */ }
      if (text !== null && text !== this.mapText) {
        try {
          this.setMap(text);
          this.bus.emit('map_confirmed', { map: this.map, source: 'file' }, { turn: null });
          rescan = true;
        } catch (e) {
          this.bus.emit('error', { message: `domains.yaml changed on disk but is invalid; keeping the previous map. ${(e as Error).message}` }, { turn: null });
        }
      }
    }
    if (paths.some((p) => p !== 'domains.yaml')) {
      this.exists = fileExistsIn(this.root); // fresh resolver: tsconfig paths, package exports, workspace links
      this.setMap(this.mapText); // fresh facts index: package.json entries
      rescan = true;
    }
    if (rescan) this.scan();
    return rescan;
  }

  private configChanged(rel: string) {
    this.configQueue.add(rel);
    if (this.configTimer) clearTimeout(this.configTimer);
    this.configTimer = setTimeout(() => {
      this.configTimer = null;
      const paths = [...this.configQueue].sort();
      this.configQueue.clear();
      this.applyConfigChanges(paths);
    }, 150);
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
    const code = CODE.test(path);
    // Tier 1 first: its parse leaves the import/write record cached for the gate facts below.
    const tier1 = code ? this.refreshFacts(path, deleted ? null : next) : null;
    const names = (f: FileFacts | null | undefined) => (f ? f.symbols.map((x) => x.name).sort().join('\n') : null);
    // (Mid-edit text that doesn't parse keeps its old shape: no relink churn.)
    const shapeChanged = !!tier1?.parsed && (names(tier1.prev) !== names(tier1.next) || exportShape(path, prev) !== exportShape(path, deleted ? null : next));
    const before = this.facts.imports.filter((i) => i.from === path);
    const after = code && !deleted ? factsForSource(path, next, this.exists) : { imports: [], writes: [] };
    this.facts.imports = [...this.facts.imports.filter((i) => i.from !== path), ...after.imports];
    this.facts.writes = [...this.facts.writes.filter((w) => w.file !== path), ...after.writes];
    if (deleted) this.contents.delete(path); else if (code) this.contents.set(path, next);

    // Which symbols changed; the file's new facts follow right after `edited`.
    const symbols: SymbolDiff | undefined = tier1 ? diffSymbols(tier1.prev?.symbols ?? [], tier1.next?.symbols ?? []) : undefined;
    this.bus.emit('edited', {
      added, removed, created, ...(attr.unattributed ? { unattributed: true } : {}), ...(attr.tool ? { tool: attr.tool } : {}), ...(symbols ? { symbols } : {}),
    }, { path, cell: this.cellOf(path) });
    if (tier1) this.bus.emit('facts_changed', { facts: tier1.next }, { path, cell: this.cellOf(path) });

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

    // Outgoing call edges, diffed like imports.
    if (tier1) this.emitCallDiff(path, tier1.prev?.calls ?? [], tier1.next?.calls ?? []);

    // Exports or symbol names moved: importers that linked through this file re-link (barrels included).
    if (tier1 && shapeChanged) this.relink(path);
  }

  /** Completeness: any write that no hook reported (e.g. from Bash) becomes an unattributed `edited` event. */
  startWatcher() {
    const ignored = (p: string) => {
      const r = relative(this.root, p);
      if (!r || r.startsWith('..')) return false;
      if (/(^|\/)(node_modules|\.git|\.harness)(\/|$)/.test(r)) return true;
      const rel = r.split('\\').join('/');
      return !isConfigFile(rel) && this.mapper.isIgnored(rel);
    };
    this.watcher = watch(this.root, { ignored, ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 } });
    const handle = (abs: string) => {
      const r = this.rel(abs);
      if (!r || this.pending.has(r)) return;
      if (isConfigFile(r)) return this.configChanged(r);
      this.fileChanged(r, { unattributed: true });
    };
    this.watcher.on('add', handle).on('change', handle).on('unlink', handle);
  }

  async close() {
    if (this.configTimer) clearTimeout(this.configTimer);
    await this.watcher?.close();
  }
}
