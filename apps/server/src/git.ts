import { execFileSync } from 'node:child_process';

/** Paths Harness itself writes; never counted as the coding session's work. */
const HARNESS_PATHS = [':(exclude)domains.yaml', ':(exclude)decisions', ':(exclude).harness'];

export function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(repo: string, args: string[]): string {
  try { return git(repo, args); } catch { return ''; }
}

export type Baseline = { head: string; snapshot: string; untracked: string[] };

/** Turn baseline: HEAD plus a `git stash create` snapshot of the working tree (no stash entry is stored). */
export function baseline(repo: string): Baseline {
  const head = tryGit(repo, ['rev-parse', 'HEAD']);
  const snapshot = tryGit(repo, ['stash', 'create']) || head;
  const untracked = untrackedFiles(repo);
  return { head, snapshot, untracked };
}

function untrackedFiles(repo: string): string[] {
  return tryGit(repo, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
}

/** Lines added/removed since the baseline, including files created during the turn (untracked). */
export function numstat(repo: string, base: Baseline): { added: number; removed: number; files: string[] } {
  let added = 0, removed = 0;
  const files: string[] = [];
  const parse = (out: string, name?: string) => {
    for (const line of out.split('\n')) {
      const [a, r, ...rest] = line.split('\t');
      if (!rest.length) continue;
      added += Number(a) || 0;
      removed += Number(r) || 0;
      files.push(name ?? rest.join('\t'));
    }
  };
  if (base.snapshot) parse(tryGit(repo, ['diff', '--numstat', base.snapshot, '--', '.', ...HARNESS_PATHS]));
  const before = new Set(base.untracked);
  for (const f of untrackedFiles(repo)) {
    if (before.has(f) || f.startsWith('decisions/') || f.startsWith('.harness/') || f === 'domains.yaml') continue;
    // --no-index exits 1 when files differ, so read stdout from the error.
    try { execFileSync('git', ['diff', '--no-index', '--numstat', '/dev/null', f], { cwd: repo, encoding: 'utf8' }); }
    catch (e) { parse(String((e as { stdout?: string }).stdout ?? ''), f); }
  }
  return { added, removed, files };
}

/** Commit only Harness's own files, so the coding session's uncommitted edits stay out (SPEC §8). */
export function commitPaths(repo: string, paths: string[], message: string) {
  git(repo, ['add', '--', ...paths]);
  git(repo, ['commit', '-q', '-m', message, '--', ...paths]);
}
