// Node-side inputs for the living map: git commits as history units, and per-file facts from a repo scan.
import { git } from '../git';
import type { Facts, FileFacts, HistoryTurn } from '@harness/core';

const HARNESS_OWN = (p: string) => p === 'domains.yaml' || p.startsWith('decisions/') || p.startsWith('.harness/');
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|mts)$/;

/** The last `limit` non-merge commits, oldest first, as history units (`git log --name-only`). Harness's own files are dropped. */
export function gitHistory(root: string, limit = 200): HistoryTurn[] {
  let out: string;
  try { out = git(root, ['log', `-n${limit}`, '--no-merges', '--name-only', '--format=%x00%H']); }
  catch { return []; } // not a repo, or no commits yet
  const units: HistoryTurn[] = [];
  for (const chunk of out.split('\0')) {
    const [sha, ...rest] = chunk.trim().split('\n');
    if (!sha) continue;
    const files = rest.map((f) => f.trim()).filter((f) => f && !HARNESS_OWN(f));
    if (files.length) units.push({ id: `commit:${sha.slice(0, 10)}`, source: 'commit', files: [...new Set(files)].sort() });
  }
  return units.reverse();
}

/** Tier-1-lite FileFacts (imports and writes only) for every code file of a scan, until the Facts lane emits real ones. */
export function toFileFacts(facts: Facts): Record<string, FileFacts> {
  const out: Record<string, FileFacts> = {};
  for (const path of facts.files) {
    if (CODE.test(path)) out[path] = { path, hash: '', imports: [], writes: [], symbols: [], calls: [], routes: [], entries: [] };
  }
  for (const i of facts.imports) out[i.from]?.imports.push({ to: i.to, typeOnly: false });
  for (const w of facts.writes) out[w.file]?.writes.push({ table: w.table, symbol: null, via: 'db' });
  return out;
}
