// Decisions protect the code that implements them (DEMO_PLAN beat 4). Pure, deterministic, browser-safe: no model.
//
// 1. `protectsFor`: when the turn that made a decision ends, the files and `path#symbol`s it built to implement the
//    chosen option. 2. `stepTouches` / `editTouches`: whether a plan step or an edit touches that code.
import type { SymbolDiff } from './contracts/facts';
import type { PlanStep } from './plan';
import type { Mapper } from './mapper';

/** What a decision protects: whole files (`paths` with no symbol of theirs in `symbols`) and specific symbols. */
export type Protects = { paths: string[]; symbols: string[] };

/** One path's activity in the decision turn (a subset of the reducer's `PathActivity`). */
export type TurnPath = { edits: number; created: boolean; symbols: SymbolDiff | null };

const fileOf = (id: string) => (id.includes('#') ? id.slice(0, id.indexOf('#')) : id);
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
/** Anonymous callbacks (`<cb1>`) are renumbered by unrelated edits: never protected by id. */
const stable = (id: string) => !/<cb\d*>/.test(id);

/**
 * The code a decision protects, from the turn that made it:
 * - **candidates:** every file the turn edited (`edits > 0`), except Interpretability's own (`domains.yaml`,
 *   `decisions/`, `.harness/`);
 * - **option A** (comply): minus the files that triggered the fork (`violating`, e.g. the new tool) and minus the
 *   other non-test files of the violating files' domain(s) — that side is the feature asking for the shortcut, not
 *   the chosen option. If that leaves no non-test file (the fix lives in the same domain), only the violating files
 *   are dropped;
 * - **option B** (exception): the violating files the turn edited — the exception is what the decision is about;
 * - **tests** the turn added or changed are always kept, as whole files (tests protect the decision too);
 * - **symbols:** for each kept non-test file, what the turn added or changed there (`added`, `sig`, `body`, the new
 *   side of `renamed`; never `removed`, never anonymous callbacks). A file with no such symbol is protected whole.
 */
export function protectsFor(
  paths: Readonly<Record<string, TurnPath>>,
  decision: { paths: readonly string[]; option: 'A' | 'B' },
  mapper: Mapper,
): Protects {
  const own = (p: string) => p === 'domains.yaml' || p.startsWith('decisions/') || p.startsWith('.harness/'); // Interpretability's files
  const edited = Object.keys(paths).filter((p) => paths[p]!.edits > 0 && !own(p)).sort();
  const isTest = (p: string) => mapper.place(p).kind === 'test';
  const violating = new Set(decision.paths);
  const tests = edited.filter(isTest);
  const code = edited.filter((p) => !isTest(p));
  let keep: string[];
  if (decision.option === 'B') keep = code.filter((p) => violating.has(p));
  else {
    const sides = new Set(decision.paths.map((p) => mapper.domainOf(p)).filter((d): d is string => !!d));
    const outside = code.filter((p) => !violating.has(p) && !sides.has(mapper.domainOf(p) ?? ''));
    keep = outside.length ? outside : code.filter((p) => !violating.has(p));
  }
  const symbols: string[] = [];
  for (const p of keep) {
    const d = paths[p]!.symbols;
    if (!d) continue;
    const removed = new Set(d.removed);
    for (const s of [...d.added, ...d.sig, ...d.body, ...d.renamed.map((r) => r[1])]) if (stable(s) && !removed.has(s) && fileOf(s) === p) symbols.push(s);
  }
  return { paths: sorted([...keep, ...tests]), symbols: sorted(symbols) };
}

/** What a plan step or an edit touched of a decision's protected code (null: nothing). */
export type Touch = { paths: string[]; symbols: string[] };

/** `a` is `b`, or one contains the other (`x.ts#Redactor` ⊃ `x.ts#Redactor.redact`). */
const related = (a: string, b: string) => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);

function index(p: Protects) {
  const bySymbolFile = new Map<string, string[]>();
  for (const s of p.symbols) (bySymbolFile.get(fileOf(s)) ?? bySymbolFile.set(fileOf(s), []).get(fileOf(s))!).push(s);
  /** A protected path with no protected symbol is protected whole. */
  const whole = new Set(p.paths.filter((f) => !bySymbolFile.has(f)));
  return { bySymbolFile, whole };
}

const result = (paths: Iterable<string>, symbols: Iterable<string>): Touch | null => {
  const t = { paths: sorted(paths), symbols: sorted(symbols) };
  return t.paths.length || t.symbols.length ? t : null;
};

/**
 * A plan step touches protected code when:
 * - it names (`symbols`) a protected symbol, or one containing or inside it;
 * - it names any symbol in, or edits, a file protected whole;
 * - it edits a file that holds protected symbols (`files`, or an `imports` source) **without naming any symbol in
 *   that file** — the step doesn't say which part changes, so it may change the protected part.
 * A step that names only other symbols in that file doesn't touch it.
 */
export function stepTouches(p: Protects, step: Pick<PlanStep, 'files' | 'imports' | 'symbols'>): Touch | null {
  const { bySymbolFile, whole } = index(p);
  const named = step.symbols ?? [];
  const files = new Set([...step.files, ...step.imports.map((i) => i.from)]);
  const paths = new Set<string>();
  const symbols = new Set<string>();
  for (const s of named) {
    const f = fileOf(s);
    if (whole.has(f)) paths.add(f);
    for (const ps of bySymbolFile.get(f) ?? []) if (related(s, ps)) { symbols.add(ps); paths.add(f); }
  }
  for (const f of files) {
    if (whole.has(f)) paths.add(f);
    else if (bySymbolFile.has(f) && !named.some((s) => fileOf(s) === f)) { paths.add(f); for (const s of bySymbolFile.get(f)!) symbols.add(s); }
  }
  return result(paths, symbols);
}

/**
 * An edit to `path` touches protected code when the file is protected whole (any change), or when its symbol diff
 * changes a protected symbol (or one containing or inside it): `sig`, `body`, `removed`, or the old side of `renamed`.
 * Added symbols never touch a symbol-protected file. Without a symbol diff (not code, or text that didn't parse) only
 * whole-file protection applies.
 */
export function editTouches(p: Protects, path: string, diff: SymbolDiff | null | undefined): Touch | null {
  const { bySymbolFile, whole } = index(p);
  if (whole.has(path)) return result([path], []);
  const protectedHere = bySymbolFile.get(path);
  if (!protectedHere || !diff) return null;
  const changed = [...diff.sig, ...diff.body, ...diff.removed, ...diff.renamed.map((r) => r[0])];
  const symbols = protectedHere.filter((ps) => changed.some((c) => related(c, ps)));
  return symbols.length ? result([path], symbols) : null;
}

/** Everything protected, short: files protected whole, and `path#a, b` for symbols. */
export function protectsSummary(p: Protects): string {
  const { bySymbolFile, whole } = index(p);
  const parts = [...[...bySymbolFile].map(([f, ss]) => `${f}#${ss.map((s) => s.slice(f.length + 1)).join(', ')}`), ...whole];
  return parts.sort().join('; ');
}

/**
 * The reminder Claude gets when a plan or an edit touches protected code (the submit_plan result, or PostToolUse
 * `additionalContext`). Not a block and not a fork: the decision stands, so Claude scopes the change to keep it true.
 */
export function touchText(
  d: { id: string; title: string; outcome: string; session: number | null },
  touch: Touch,
  source: 'plan' | 'edit',
): string {
  const what = source === 'plan' ? 'This plan touches' : 'This edit touches';
  const where = [...touch.symbols, ...touch.paths.filter((f) => !touch.symbols.some((s) => fileOf(s) === f))].join(', ');
  const when = d.session ? ` (decided in session ${d.session})` : '';
  const outcome = d.outcome.trim().replace(/[.\s]+$/, '');
  return `${what} what ${d.id} protects: ${d.title}. ${outcome}. Keep it true${when}: scope the change so it still holds, and extend its test.${where ? ` Protected code here: ${where}.` : ''}`;
}
