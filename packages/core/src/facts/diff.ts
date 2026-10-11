// Which symbols an edit changed (NAVIGATION_PLAN §3.1). Pure and browser-safe.
import type { SymbolDiff, SymbolFact } from '../contracts/facts';

/**
 * Classify symbols as added, removed, signature-changed or body-changed by comparing hashes.
 * A removed and an added symbol of the same kind with the same `bodyHash` is a rename, listed only under `renamed`.
 */
export function diffSymbols(before: readonly SymbolFact[], after: readonly SymbolFact[]): SymbolDiff {
  const old = new Map(before.map((s) => [s.id, s]));
  const now = new Map(after.map((s) => [s.id, s]));
  const sig: string[] = [];
  const body: string[] = [];
  for (const s of after) {
    const o = old.get(s.id);
    if (!o) continue;
    if (o.sigHash !== s.sigHash) sig.push(s.id);
    else if (o.bodyHash !== s.bodyHash) body.push(s.id);
  }
  const removed = before.filter((s) => !now.has(s.id));
  const added = after.filter((s) => !old.has(s.id));
  const renamed: [string, string][] = [];
  const taken = new Set<string>();
  for (const r of removed) {
    const a = added.find((x) => !taken.has(x.id) && x.kind === r.kind && x.bodyHash === r.bodyHash);
    if (!a) continue;
    taken.add(a.id);
    taken.add(r.id);
    renamed.push([r.id, a.id]);
  }
  return {
    added: added.filter((s) => !taken.has(s.id)).map((s) => s.id),
    removed: removed.filter((s) => !taken.has(s.id)).map((s) => s.id),
    sig,
    body,
    renamed,
  };
}
