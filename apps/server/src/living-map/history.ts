// Node-side input for the living map: git commits as history units.
import { git } from '../git';
import type { HistoryTurn } from '@harness/core';

const HARNESS_OWN = (p: string) => p === 'domains.yaml' || p.startsWith('decisions/') || p.startsWith('.harness/');

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
