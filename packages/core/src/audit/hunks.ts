// Unified diffs with new-file line numbers, so the auditor can cite exact lines. Pure.

/**
 * Rewrite a unified diff (`git diff` output, one or more files) so every line carries its line number in the new file:
 * `  31 + code` (added), `     - code` (removed), `  30   code` (context). File headers become `### path` (or
 * `### path (new file)`); hunk headers are dropped. At most `maxLines` body lines per file, then `… (n more lines)`.
 */
export function numberDiff(diff: string, maxLines = 300): string {
  const out: string[] = [];
  let line = 0;
  let count = 0;
  let skipped = 0;
  let isNew = false;
  const flush = () => { if (skipped) out.push(`     … (${skipped} more lines)`); skipped = 0; };
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) { flush(); isNew = false; count = 0; continue; }
    if (raw.startsWith('new file mode') || raw.startsWith('--- /dev/null')) { isNew = true; continue; }
    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).replace(/^b\//, '').trim();
      out.push(`### ${path}${isNew ? ' (new file)' : ''}`);
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('index ') || raw.startsWith('similarity ') || raw.startsWith('rename ') || raw.startsWith('deleted file') || raw.startsWith('old mode') || raw.startsWith('new mode')) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) { line = Number(h[1]); if (count && count < maxLines) out.push('     ⋮'); continue; }
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    if (!line) continue;
    const kind = raw[0];
    if (kind !== '+' && kind !== '-' && kind !== ' ') continue;
    if (count >= maxLines) { skipped++; if (kind !== '-') line++; continue; }
    count++;
    if (kind === '+') out.push(`${String(line++).padStart(4)} + ${raw.slice(1)}`);
    else if (kind === '-') out.push(`     - ${raw.slice(1)}`);
    else out.push(`${String(line++).padStart(4)}   ${raw.slice(1)}`);
  }
  flush();
  return out.join('\n');
}
