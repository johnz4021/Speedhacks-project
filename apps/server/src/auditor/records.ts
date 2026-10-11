// Node-side inputs and memory for the auditor: the turn's git diff vs its baseline, standing decisions, and the
// dismissal memory under .harness/audit/dismissed.json (a dismissed finding is never raised again).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findingSignature, numberDiff, type AuditDecision, type DismissedFinding, type FindingState } from '@harness/core';
import { listDecisions } from '../decisions';

const run = (root: string, args: string[]): string => {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 << 20 }); }
  catch (e) { return String((e as { stdout?: string }).stdout ?? ''); } // `--no-index` exits 1 when files differ
};

/**
 * The turn's diff for `files`, numbered by new-file line: `git diff <baseline>` for files the baseline knows, and a
 * whole-file diff for files created since (untracked, so the baseline snapshot doesn't have them).
 */
export function turnDiff(root: string, baseline: string | null, files: readonly string[], maxLinesPerFile = 300): string {
  const parts: string[] = [];
  for (const f of files) {
    let d = baseline ? run(root, ['diff', '--no-color', '--no-ext-diff', '-U3', baseline, '--', f]) : '';
    if (!d.trim() && existsSync(join(root, f)) && !run(root, ['ls-files', '--', f]).trim()) {
      d = run(root, ['diff', '--no-color', '--no-index', '--', '/dev/null', f]);
    }
    if (d.trim()) parts.push(d.trimEnd());
  }
  return numberDiff(parts.join('\n'), maxLinesPerFile);
}

/** Standing decisions (status `made`) as the auditor reads them. */
export function standingDecisions(root: string): AuditDecision[] {
  return listDecisions(root)
    .filter((d) => d.status === 'made')
    .map((d) => ({ id: d.id, title: d.title, outcome: d.outcome ?? '', rationale: d.rationale ?? '', invariant: d.invariant ?? '', paths: d.anchors?.paths ?? [] }));
}

const dismissedPath = (root: string) => join(root, '.harness', 'audit', 'dismissed.json');

export function loadDismissed(root: string): DismissedFinding[] {
  const p = dismissedPath(root);
  if (!existsSync(p)) return [];
  try { return (JSON.parse(readFileSync(p, 'utf8')) as { dismissed?: DismissedFinding[] }).dismissed ?? []; }
  catch { return []; }
}

/** Remember a dismissed finding (signature + decision + files + text). Idempotent by signature. */
export function rememberDismissed(root: string, f: Pick<FindingState, 'id' | 'decision' | 'files' | 'text'>): DismissedFinding {
  const all = loadDismissed(root);
  const entry: DismissedFinding = { signature: findingSignature(f), decision: f.decision, files: [...f.files].sort(), text: f.text, id: f.id, at: Date.now() };
  if (!all.some((d) => d.signature === entry.signature)) all.push(entry);
  mkdirSync(join(root, '.harness', 'audit'), { recursive: true });
  writeFileSync(dismissedPath(root), JSON.stringify({ dismissed: all }, null, 2));
  return entry;
}
