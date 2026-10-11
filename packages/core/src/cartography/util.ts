// Small pure helpers shared by the cartography modules. Browser-safe (no node builtins).
import type { Placement } from '../mapper';
import type { FileFacts } from '../contracts/facts';

/** Key of the cell a placement counts as for footprints: `domain/layer`, `UNASSIGNED_CELL`, or null (neutral, ignored, test). */
export const UNASSIGNED_CELL = '(unassigned)';
export function cellKeyOf(p: Placement): string | null {
  if (p.kind === 'cell') return `${p.domain}/${p.layer}`;
  if (p.kind === 'unassigned') return UNASSIGNED_CELL;
  return null;
}

/** Full placement key for churn: every kind, so a move between any two homes counts. */
export function placementKey(p: Placement): string {
  if (p.kind === 'cell') return `cell:${p.domain}/${p.layer}`;
  if (p.kind === 'test') return `test:${p.domain}`;
  return p.kind;
}

export const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts)$/;
export const TEST_FILE = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/** Repo-internal import targets of a file (drops `vendor:<pkg>` bare imports and self-imports). */
export function repoImports(f: FileFacts): string[] {
  return f.imports.map((i) => i.to).filter((to) => !to.startsWith('vendor:') && to !== f.path);
}

export function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Gini coefficient of non-negative counts (0 = perfectly even). */
export function gini(xs: readonly number[]): number {
  const n = xs.length;
  const total = xs.reduce((a, b) => a + b, 0);
  if (n < 2 || total === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  let acc = 0;
  s.forEach((x, i) => { acc += (2 * (i + 1) - n - 1) * x; });
  return acc / (n * total);
}

/** FNV-1a 32-bit, hex. Deterministic content hash for label cache keys (not cryptographic). */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** "news-digest" → "News digest". */
export function titleCase(slug: string): string {
  const words = slug.replace(/[-_.]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : slug;
}

/** Majority key (ties → lexically smallest), or null for an empty tally. */
export function majority(keys: readonly string[]): string | null {
  const tally = new Map<string, number>();
  for (const k of keys) tally.set(k, (tally.get(k) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [k, c] of [...tally].sort(([a], [b]) => a.localeCompare(b))) if (c > n) { best = k; n = c; }
  return best;
}

/** JSON with object keys sorted at every depth (canonical form for comparing values). */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

export const round =(x: number, places = 3) => Math.round(x * 10 ** places) / 10 ** places;
