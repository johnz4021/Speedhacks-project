// The auditor's deterministic pre-filter (NAVIGATION_PLAN §4.6): only standing decisions that plausibly bear on what a
// turn touched are sent to the model; with none, the model call is skipped. Pure and cheap.
import { createMapper, matchesAny, type Mapper } from '../mapper';
import type { DomainMap, Invariant } from '../schema';
import { fileOf } from '../contracts/graph';
import type { TurnSurface } from './surface';

/** A standing decision as the auditor reads it (decisions/DR-n.md front matter + body). */
export type AuditDecision = { id: string; title: string; outcome: string; rationale: string; invariant: string; paths: string[] };

export type RelevanceReason = 'anchor' | 'invariant' | 'mention';
export type RelevantDecision = { decision: AuditDecision; reasons: { kind: RelevanceReason; detail: string }[] };

/** Words that read as identifiers but name nothing in particular. Only words of 4+ letters are ever compared. */
const STOP = new Set([
  'this', 'that', 'with', 'from', 'they', 'them', 'their', 'there', 'these', 'those', 'what', 'when', 'where', 'which', 'while', 'will', 'would',
  'should', 'could', 'must', 'have', 'been', 'into', 'only', 'also', 'each', 'every', 'other', 'than', 'then', 'some', 'more', 'most', 'make',
  'made', 'keep', 'kept', 'user', 'users', 'chose', 'choose', 'chosen', 'option', 'words', 'asked', 'during', 'rejected', 'triggered',
  'exception', 'rule', 'rules', 'file', 'files', 'path', 'paths', 'index', 'main', 'types', 'type', 'test', 'tests', 'shared', 'utils', 'util',
  'data', 'call', 'calls', 'called', 'calling', 'code', 'through', 'domain', 'domains', 'layer', 'cell', 'decision', 'decisions', 'standing',
  'outcome', 'title', 'rationale', 'imports', 'import', 'export', 'default', 'function', 'const', 'async', 'await', 'return', 'true', 'false',
  'null', 'undefined', 'string', 'number', 'here', 'just', 'like', 'because', 'instead', 'without', 'within', 'about', 'after', 'before', 'still',
  'goes', 'going', 'uses', 'used', 'using', 'need', 'needs', 'want', 'wants', 'does', 'done', 'into', 'onto', 'over', 'under', 'same', 'both',
]);

const words = (s: string) => (s.match(/[A-Za-z_$][\w$]*/g) ?? []).flatMap((w) => [w, ...w.split(/(?<=[a-z0-9])(?=[A-Z])|[_$]+/)]).map((w) => w.toLowerCase()).filter((w) => w.length >= 4 && !STOP.has(w));
const stemWords = (path: string) => (path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '').match(/[A-Za-z0-9]+/g) ?? []).map((w) => w.toLowerCase()).filter((w) => w.length >= 4 && !STOP.has(w));
const symbolNames = (id: string) => {
  const i = id.indexOf('#');
  if (i < 0) return [];
  const q = id.slice(i + 1).replace(/~\d+$/, '');
  return [q, ...q.split('.')].map((w) => w.toLowerCase()).filter((w) => w.length >= 4 && !STOP.has(w) && !w.startsWith('<'));
};
/** Path-like tokens (`src/tools/x.ts`, `vendor/llm-openai`) in prose. */
const pathTokens = (s: string) => (s.match(/[\w.@-]+(?:\/[\w.@*-]+)+/g) ?? []).map((p) => p.replace(/[.,;:]+$/, '').replace(/^\.\//, ''));
const under = (path: string, token: string) => path === token || path.startsWith(`${token.replace(/\/$/, '')}/`) || path.startsWith(token.replace(/\.[cm]?[jt]sx?$/, ''));

/** Files the turn reaches: changed files plus the files of new import/call targets (vendors and tables excluded). */
function touchedTargets(s: TurnSurface): string[] {
  const out = new Set<string>();
  for (const i of s.delta.imports) if (!i.to.includes(':')) out.add(i.to);
  for (const c of s.delta.calls) { const f = fileOf(c.to); if (f) out.add(f); }
  return [...out].sort();
}

/** Does `inv` bear on what the turn touched? Returns a short reason, or null. */
function invariantTouches(inv: Invariant, s: TurnSurface, mapper: Mapper, targets: readonly string[]): string | null {
  const domainOf = (p: string) => mapper.domainOf(p);
  const changedDomains = new Set(s.files.map(domainOf).filter((d): d is string => !!d));
  const targetDomains = new Set(targets.map(domainOf).filter((d): d is string => !!d));
  const exception = inv.exceptions.find((e) => s.files.includes(e.path));
  if (exception) return `${exception.path} is an exception to ${inv.id}`;
  if (inv.kind === 'only_via') {
    const hit = [...s.files, ...targets].find((p) => matchesAny(inv.targets, p));
    if (hit) return `${hit} is a target of ${inv.id}`;
    const via = inv.allowed_from.find((d) => targetDomains.has(d) && [...changedDomains].some((c) => c !== d));
    if (via) return `the turn now reaches ${via}, the only way ${inv.id} allows`;
    const inside = inv.allowed_from.find((d) => changedDomains.has(d));
    if (inside) return `the turn changed ${inside}, the way ${inv.id} allows`;
    return null;
  }
  if (inv.kind === 'owns_writes') {
    const w = s.delta.writes.find((x) => x.table in inv.owners);
    return w ? `${w.file} newly writes "${w.table}"` : null;
  }
  // no_edge: the protected side changed, or code in the `from` domain gained a dependency outside its own domain
  // (the checker catches a direct edge into `to`; the rationale may cover indirect routes).
  if (changedDomains.has(inv.to)) return `the turn changed ${inv.to}, which ${inv.id} keeps ${inv.from} away from`;
  const reach = [...s.delta.imports.map((i) => ({ from: i.from, to: i.to })), ...s.delta.calls.map((c) => ({ from: fileOf(c.from) ?? c.from, to: fileOf(c.to) ?? c.to }))]
    .find((e) => domainOf(e.from) === inv.from && domainOf(e.to) !== inv.from);
  return reach ? `${reach.from} (${inv.from}) newly depends on ${reach.to}` : null;
}

/**
 * Standing decisions relevant to a turn, sorted by DR number, each with why:
 * - **anchor**: an anchored path (exact, glob or directory) is a changed file or a file the turn newly imports/calls;
 * - **invariant**: its invariant exempts a changed file; or (only_via) a changed or newly reached file is a target, or
 *   the turn newly reaches / changes an allowed domain; or (owns_writes) the turn newly writes an owned table; or
 *   (no_edge) the `to` domain changed, or code in the `from` domain gained a dependency outside its domain;
 * - **mention**: its title, outcome or rationale names a path the turn touches, or a symbol/file name it changed or calls.
 */
export function relevantDecisions(decisions: readonly AuditDecision[], map: DomainMap, s: TurnSurface, mapper: Mapper = createMapper(map)): RelevantDecision[] {
  const targets = touchedTargets(s);
  const touched = [...new Set([...s.files, ...targets])];
  const names = new Map<string, string>(); // lowercased name → what it is
  for (const id of s.symbols) for (const n of symbolNames(id)) names.set(n, id);
  for (const c of s.delta.calls) for (const n of symbolNames(c.to)) if (!names.has(n)) names.set(n, c.to);
  for (const f of s.files) for (const n of stemWords(f)) if (!names.has(n)) names.set(n, f);

  const out: RelevantDecision[] = [];
  for (const d of decisions) {
    const reasons: RelevantDecision['reasons'] = [];
    const anchored = d.paths.flatMap((a) => touched.filter((p) => p === a || matchesAny([a], p) || under(p, a)).map((p) => `${a} ↔ ${p}`));
    if (anchored.length) reasons.push({ kind: 'anchor', detail: anchored.join(', ') });
    const inv = d.invariant ? map.invariants.find((i) => i.id === d.invariant) : undefined;
    const why = inv ? invariantTouches(inv, s, mapper, targets) : null;
    if (why) reasons.push({ kind: 'invariant', detail: why });
    const prose = `${d.title}\n${d.outcome}\n${d.rationale}`;
    const tokens = pathTokens(prose);
    const paths = tokens.flatMap((t) => touched.filter((p) => under(p, t)).map((p) => `${t} ↔ ${p}`));
    const bare = tokens.reduce((text, t) => text.split(t).join(' '), prose); // folder names inside paths aren't mentions
    const named = [...new Set(words(bare))].filter((w) => names.has(w)).map((w) => `"${w}" ↔ ${names.get(w)}`);
    if (paths.length || named.length) reasons.push({ kind: 'mention', detail: [...new Set(paths), ...named].join(', ') });
    if (reasons.length) out.push({ decision: d, reasons });
  }
  return out.sort((a, b) => num(a.decision.id) - num(b.decision.id) || (a.decision.id < b.decision.id ? -1 : 1));
}

const num = (id: string) => Number(/(\d+)$/.exec(id)?.[1] ?? 0);
