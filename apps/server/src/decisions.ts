import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  linkDecision, addException, nextDecisionId, globMatcher, protectsFor, reduce,
  type Violation, type Invariant, type EventData, type Protects,
} from '@harness/core';
import { commitPaths } from './git';
import { alikeDecision, recordDecision, repoSlug, mcpInstruction, type AlikeDecision, type ExecFn } from './alike';
import type { Repo } from './repo';
import type { Bus } from './bus';

export type DecisionRecord = {
  id: string;
  title: string;
  outcome: string;
  status: string;
  type: string;
  invariant: string;
  anchors: { paths: string[] };
  rejected: string;
  rationale: string;
  alike_urn?: string; // set once the decision is in Alike; never recorded twice
  session?: number; // 1-based Interpretability session it was made in ("decided in session N")
  /** The code that implements the chosen option, written when the decision turn ends (beat 4). */
  protects?: Protects;
};

/** Read `decisions/DR-*.md` (front matter + body). */
export function listDecisions(root: string): DecisionRecord[] {
  const dir = join(root, 'decisions');
  if (!existsSync(dir)) return [];
  const out: DecisionRecord[] = [];
  for (const f of readdirSync(dir).filter((f) => /^DR-\d+\.md$/.test(f))) {
    const text = readFileSync(join(dir, f), 'utf8');
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    if (!m) continue;
    const fm = parseYaml(m[1]!) as Omit<DecisionRecord, 'rationale'>;
    out.push({ ...fm, rationale: m[2]!.trim() });
  }
  return out.sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3)));
}

/** Parse which option the user picked. Explicit A/B wins; "exception" leans B; otherwise A (comply). */
export function parseOption(text: string): 'A' | 'B' {
  const t = text.trim();
  const m = /^\(?\s*(?:option\s+)?([ab])\b/i.exec(t) ?? /\b(?:option|choose|pick|go with)\s+\(?([ab])\b/i.exec(t);
  if (m) return m[1]!.toUpperCase() as 'A' | 'B';
  return /\bexception\b/i.test(t) ? 'B' : 'A';
}

/** The decision in the user's own words: their answer minus the "A —" prefix, first sentence, if it says something. */
export function titleFromAnswer(answer: string): string | null {
  const t = answer.trim().replace(/^\(?\s*(?:option\s+)?[ab]\b\)?\s*[—–:,.-]*\s*/i, '');
  const first = (t.split(/(?<=[.!?])\s/)[0] ?? '').replace(/[.!?]+$/, '').trim();
  if (first.length < 12) return null;
  const s = first[0]!.toUpperCase() + first.slice(1);
  return s.length > 100 ? s.slice(0, 99).replace(/\s+\S*$/, '') + '…' : s;
}

/**
 * An answered fork becomes a standing decision (SPEC §8): write decisions/DR-n.md, update domains.yaml
 * (A links the decision to the invariant, B adds an exception), commit just those two files, emit
 * `decision_recorded`, and return the instruction that asks Claude to record it in Alike.
 */
export function recordFork(repo: Repo, bus: Bus, violations: Violation[], option: 'A' | 'B', answer: string, prompt: string) {
  const existing = listDecisions(repo.root).map((d) => d.id);
  const byInvariant = new Map<string, Violation[]>();
  for (const v of violations) byInvariant.set(v.invariant, [...(byInvariant.get(v.invariant) ?? []), v]);

  const made: DecisionRecord[] = [];
  const session = sessionNumber(bus);
  let yamlText = repo.mapText;
  for (const [invariantId, vs] of byInvariant) {
    const inv = repo.map.invariants.find((i) => i.id === invariantId);
    if (!inv) continue;
    const id = nextDecisionId(repo.map, [...existing, ...made.map((d) => d.id)]);
    const files = [...new Set(vs.map((v) => v.file))];
    const v0 = vs[0]!;
    const [chosen, rejected] = option === 'A' ? [v0.options[0], v0.options[1]] : [v0.options[1], v0.options[0]];
    // The principle, not the incident: the user's own sentence, else the rule they upheld.
    const title = titleFromAnswer(answer) ?? (option === 'A' ? inv.rule : `Exception to ${inv.id} for ${files.join(', ')}`);
    const rec: DecisionRecord = {
      id, title, outcome: chosen, status: 'made', type: 'standing', invariant: inv.id,
      anchors: { paths: files }, rejected, session,
      rationale: [
        `The user chose ${option}, in their words: "${answer.trim()}"`,
        '',
        `Asked during: "${prompt.trim()}"`,
        '',
        `What triggered it: ${v0.reason}`,
        '',
        `Rejected: ${rejected}`,
      ].join('\n'),
    };
    made.push(rec);
    yamlText = option === 'A' ? linkDecision(yamlText, inv.id, id) : addException(yamlText, inv.id, files[0]!, id);
  }
  if (!made.length) return { decisions: [], forAlike: [] };

  mkdirSync(join(repo.root, 'decisions'), { recursive: true });
  const paths: string[] = ['domains.yaml'];
  for (const d of made) {
    const { rationale, ...fm } = d;
    const rel = `decisions/${d.id}.md`;
    writeFileSync(join(repo.root, rel), `---\n${stringifyYaml(fm).trim()}\n---\n\n${rationale}\n`);
    paths.push(rel);
  }
  writeFileSync(repo.mapPath, yamlText);
  try { commitPaths(repo.root, paths, `docs(decisions): ${made.map((d) => d.id).join(', ')} ${made[0]!.title}`.slice(0, 100)); }
  catch (e) { bus.emit('error', { message: `Could not commit ${paths.join(', ')}: ${(e as Error).message}` }); }

  repo.setMap(yamlText);
  bus.emit('map_confirmed', { map: repo.map, source: 'file' });
  for (const d of made) {
    bus.emit('decision_recorded', { id: d.id, title: d.title, invariant: d.invariant, option, paths: d.anchors.paths, alike: false });
  }

  const invariants = new Map(repo.map.invariants.map((i) => [i.id, i] as [string, Invariant]));
  const forAlike = made.map((d) => ({
    id: d.id,
    decision: alikeDecision(repo.map, {
      id: d.id, title: d.title, outcome: d.outcome, rejected: d.rejected, option, invariant: invariants.get(d.invariant)!,
      files: d.anchors.paths, answer, session,
    }, repoSlug(repo.root), (glob) => concreteFolders(repo.facts.files, glob), repo.facts.files),
  }));
  return { decisions: made, forAlike };
}

/** 1-based number of the current coding session ("decided in session 2"). */
export function sessionNumber(bus: Bus): number {
  const seen: string[] = [];
  for (const e of bus.events) if (!seen.includes(e.session)) seen.push(e.session);
  if (!seen.includes(bus.session)) seen.push(bus.session);
  return seen.indexOf(bus.session) + 1;
}

/** Folders Alike can anchor for a glob it can't take: `vendor/llm-*` + `/**` → `vendor/llm-anthropic/`, … */
function concreteFolders(files: readonly string[], glob: string): string[] {
  const match = globMatcher(glob);
  const depth = glob.split('/').findIndex((seg) => /[*?[{]/.test(seg));
  const out = new Set<string>();
  for (const f of files) {
    if (!match(f)) continue;
    const parts = f.split('/');
    out.add(depth >= 0 && depth < parts.length - 1 ? `${parts.slice(0, depth + 1).join('/')}/` : f);
  }
  return [...out].sort();
}

/**
 * Record decisions in Alike from the server (async, after the commit; never in the hot path). On success the
 * URN is written into the DR file (committed alone) and `decision_recorded { alike: true, urn }` is emitted.
 * Returns MCP fallback instructions for any decision the CLI couldn't record.
 */
export async function recordInAlike(repo: Repo, bus: Bus, items: { id: string; decision: AlikeDecision }[], exec?: ExecFn): Promise<string[]> {
  const fallback: string[] = [];
  for (const { id, decision } of items) {
    const rel = `decisions/${id}.md`;
    const path = join(repo.root, rel);
    if (!existsSync(path)) continue;
    const before = listDecisions(repo.root).find((d) => d.id === id);
    if (before?.alike_urn) continue;
    try {
      const urn = await recordDecision(decision, exec);
      const text = readFileSync(path, 'utf8');
      writeFileSync(path, text.replace(/\n---\n/, `\nalike_urn: ${urn}\n---\n`));
      try { commitPaths(repo.root, [rel], `docs(decisions): ${id} recorded in Alike`); } catch { /* the URN stays in the working tree */ }
      const prev = bus.events.findLast((e) => e.kind === 'decision_recorded' && (e.data as { id: string }).id === id);
      if (prev) bus.emit('decision_recorded', { ...(prev.data as EventData['decision_recorded']), alike: true, urn }, { turn: prev.turn });
    } catch (e) {
      bus.emit('error', { message: `Alike didn't record ${id} (${(e as Error).message.split('\n')[0]}); asking the session instead.` });
      fallback.push(mcpInstruction(decision));
    }
  }
  return fallback;
}

/**
 * "decided in session N" for a decision: the session of its first `decision_recorded` event in the log (sessions
 * numbered by first appearance), else the `session` written into its DR file, else null.
 */
export function decidedIn(bus: Bus, rec: Pick<DecisionRecord, 'id' | 'session'>): number | null {
  const first = bus.events.find((e) => e.kind === 'decision_recorded' && (e.data as { id: string }).id === rec.id);
  if (first) {
    const seen: string[] = [];
    for (const e of bus.events) if (!seen.includes(e.session)) seen.push(e.session);
    return seen.indexOf(first.session) + 1;
  }
  return rec.session ?? null;
}

/** Insert or replace top-level keys in a DR file's front matter, keeping the body as written. */
function setFrontMatter(path: string, fields: Record<string, unknown>) {
  const text = readFileSync(path, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return;
  const fm = { ...(parseYaml(m[1]!) as Record<string, unknown>), ...fields };
  writeFileSync(path, `---\n${stringifyYaml(fm).trim()}\n---\n${m[2]!.startsWith('\n') ? '' : '\n'}${m[2]}`);
}

/**
 * Beat 4: when the turn that made decisions ends, record what each one protects (`protectsFor` in core: the files and
 * symbols the turn built for the chosen option, plus its tests), write `protects:` into decisions/DR-n.md, commit only
 * those files, and re-emit `decision_recorded { …, protects }`. A decision already carrying `protects`, or whose turn
 * built nothing, is left alone. Returns the decisions updated.
 */
export function recordProtects(repo: Repo, bus: Bus, turnId: string): { id: string; protects: Protects }[] {
  const ui = reduce(bus.events);
  const turn = ui.turns.find((t) => t.id === turnId);
  if (!turn?.decisions.length) return [];
  const records = new Map(listDecisions(repo.root).map((d) => [d.id, d]));
  const done: { id: string; protects: Protects }[] = [];
  for (const id of turn.decisions) {
    const dec = ui.decisions.find((d) => d.id === id);
    const rec = records.get(id);
    if (!dec || !rec || rec.protects) continue;
    const protects = protectsFor(turn.paths, { paths: dec.paths, option: dec.option }, repo.mapper);
    if (!protects.paths.length) continue;
    setFrontMatter(join(repo.root, 'decisions', `${id}.md`), { protects });
    done.push({ id, protects });
  }
  if (!done.length) return [];
  const paths = done.map((d) => `decisions/${d.id}.md`);
  try { commitPaths(repo.root, paths, `docs(decisions): what ${done.map((d) => d.id).join(', ')} protect${done.length > 1 ? '' : 's'}`); }
  catch (e) { bus.emit('error', { message: `Could not commit ${paths.join(', ')}: ${(e as Error).message}` }); }
  for (const { id, protects } of done) {
    const prev = bus.events.findLast((e) => e.kind === 'decision_recorded' && (e.data as { id: string }).id === id);
    if (prev) bus.emit('decision_recorded', { ...(prev.data as EventData['decision_recorded']), protects }, { turn: turnId });
  }
  return done;
}
