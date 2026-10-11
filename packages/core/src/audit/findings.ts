// Auditor findings after the model (NAVIGATION_PLAN §4.6): sanitized against what was asked, deduplicated, and
// checked against the dismissal memory so a dismissed finding never comes back. Pure.
import type { AuditFinding } from '../contracts/cartography';
import { fnv1a } from '../cartography/util';

/** A finding as the model returns it (no id yet). */
export type RawFinding = Omit<AuditFinding, 'id'>;

/** A dismissed finding, as remembered in `.harness/audit/dismissed.json`. */
export type DismissedFinding = { signature: string; decision: string | null; files: string[]; text: string; id?: string; at?: number };

const CONFIDENCE = new Set(['low', 'medium', 'high']);

/** Lowercased, line references and punctuation dropped, whitespace collapsed: rephrasing a line number is not a new finding. */
export function normalizeFindingText(text: string): string {
  return text.toLowerCase()
    .replace(/(?:\blines?\s*|:)\d+(?:\s*[-–]\s*\d+)?/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Same decision + same files + same (normalized) text = same finding. */
export function findingSignature(f: { decision: string | null; files: readonly string[]; text: string }): string {
  return fnv1a([f.decision ?? '', [...new Set(f.files)].sort().join(','), normalizeFindingText(f.text)].join('\u0000'));
}

const wordSet = (t: string) => new Set(normalizeFindingText(t).split(' ').filter((w) => w.length > 2));
/** Jaccard similarity of the two texts' word sets. */
export function textSimilarity(a: string, b: string): number {
  const x = wordSet(a), y = wordSet(b);
  if (!x.size && !y.size) return 1;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/** Rephrasings of a dismissed finding (same decision, same files) at or above this similarity stay dismissed. */
export const DISMISS_SIMILARITY = 0.6;

/** True if `f` was dismissed: identical signature, or the same decision and files with near-identical text. */
export function isDismissed(f: { decision: string | null; files: readonly string[]; text: string }, dismissed: readonly DismissedFinding[]): boolean {
  const sig = findingSignature(f);
  const files = [...new Set(f.files)].sort().join(',');
  return dismissed.some((d) => d.signature === sig || (d.decision === f.decision && [...new Set(d.files)].sort().join(',') === files && textSimilarity(d.text, f.text) >= DISMISS_SIMILARITY));
}

/**
 * Keep only findings worth showing: they cite a decision that was sent (`decisions`), concern files the turn changed
 * (`files`; other files are dropped from the finding, and a finding left with none is dropped), have text, and are
 * neither dismissed nor a repeat of an open finding or of each other. Lines outside the finding's files are dropped;
 * an unknown confidence becomes `low`. Order is kept.
 */
export function acceptFindings(raw: readonly RawFinding[], ctx: { decisions: readonly string[]; files: readonly string[]; dismissed: readonly DismissedFinding[]; open: readonly { decision: string | null; files: readonly string[]; text: string }[] }): RawFinding[] {
  const sent = new Set(ctx.decisions);
  const changed = new Set(ctx.files);
  const norm = (p: string) => p.replace(/^\.\//, '');
  const seen = new Set(ctx.open.map(findingSignature));
  const out: RawFinding[] = [];
  for (const r of raw) {
    const text = (r.text ?? '').trim();
    if (!text || !r.decision || !sent.has(r.decision)) continue;
    const files = [...new Set((r.files ?? []).map(norm))].filter((f) => changed.has(f)).sort();
    for (const l of r.lines ?? []) if (changed.has(norm(l.path)) && !files.includes(norm(l.path))) files.push(norm(l.path));
    if (!files.length) continue;
    files.sort();
    const lines = (r.lines ?? [])
      .map((l) => ({ path: norm(l.path), line: Math.trunc(Number(l.line)) }))
      .filter((l) => files.includes(l.path) && Number.isFinite(l.line) && l.line > 0);
    const f: RawFinding = { decision: r.decision, files, lines: [...new Map(lines.map((l) => [`${l.path}:${l.line}`, l])).values()], text, confidence: CONFIDENCE.has(r.confidence) ? r.confidence : 'low' };
    const sig = findingSignature(f);
    if (seen.has(sig) || isDismissed(f, ctx.dismissed)) continue;
    seen.add(sig);
    out.push(f);
  }
  return out;
}

/** Next free `AF-n` above every existing finding id. */
export function nextFindingId(existing: Iterable<string>): string {
  let max = 0;
  for (const id of existing) max = Math.max(max, Number(/^AF-(\d+)$/.exec(id)?.[1] ?? 0));
  return `AF-${max + 1}`;
}
