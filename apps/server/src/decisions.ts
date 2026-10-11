import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { linkDecision, addException, nextDecisionId, type Violation } from '@harness/core';
import { commitPaths, git } from './git';
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
 * `owner/name`, which Alike's path anchors require: HARNESS_REPO_SLUG, else the origin remote,
 * else `<git user>/<folder>` for a repo with no remote.
 */
function repoAnchor(root: string) {
  if (process.env.HARNESS_REPO_SLUG) return { repository: process.env.HARNESS_REPO_SLUG };
  try {
    const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(git(root, ['remote', 'get-url', 'origin']));
    if (m) return { repository: m[1]! };
  } catch { /* no remote */ }
  let owner = 'local';
  try { owner = git(root, ['config', 'user.name']).replace(/[^\w.-]+/g, '-') || owner; } catch { /* unset */ }
  return { repository: `${owner}/${basename(root)}` };
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
  let yamlText = repo.mapText;
  for (const [invariantId, vs] of byInvariant) {
    const inv = repo.map.invariants.find((i) => i.id === invariantId);
    if (!inv) continue;
    const id = nextDecisionId(repo.map, [...existing, ...made.map((d) => d.id)]);
    const files = [...new Set(vs.map((v) => v.file))];
    const v0 = vs[0]!;
    const [chosen, rejected] = option === 'A' ? [v0.options[0], v0.options[1]] : [v0.options[1], v0.options[0]];
    const title = titleFromAnswer(answer) ?? (option === 'A'
      ? `${files.join(', ')} follows ${inv.id}: ${inv.rule}`
      : `Exception to ${inv.id} for ${files.join(', ')}`);
    const rec: DecisionRecord = {
      id, title, outcome: chosen, status: 'made', type: 'standing', invariant: inv.id,
      anchors: { paths: files }, rejected,
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
  if (!made.length) return { decisions: [], alikeInstruction: '' };

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

  const anchor = repoAnchor(repo.root);
  // Field names checked against Alike's record_decision schema (VERIFY.md, step 0d).
  const alikeInstruction = made.map((d) => {
    const args = {
      title: `${d.id}: ${d.title}`,
      outcome: d.outcome,
      rationale: d.rationale.replace(/\n+/g, ' '),
      decision_type: 'standing',
      status: 'made',
      anchors: d.anchors.paths.map((path) => ({ kind: 'path', label: 'governs', path, repository: anchor.repository })),
    };
    return `Record ${d.id} in Alike now: call mcp__alike__record_decision with exactly these arguments: ${JSON.stringify(args)}. If the Alike tools are unavailable, skip this silently.`;
  }).join('\n');
  return { decisions: made, alikeInstruction };
}
