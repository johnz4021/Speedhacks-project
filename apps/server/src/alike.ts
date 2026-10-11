// Alike integration (ALIKE_INTEGRATION.md, redesigned against Alike's verified capabilities):
// the server records each decision itself through the paired CLI (`alike it`), off the hot path and with no
// model step; anchors are architectural (cell folders, never globs — Alike matches folder prefixes only);
// the URN goes back into the DR file so a decision is recorded once. The MCP instruction is only a fallback.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createMapper, type DomainMap, type Invariant } from '@harness/core';
import { git } from './git';

export type AlikeAnchor =
  | { kind: 'path'; label: string; path: string; repository: string }
  | { kind: 'situation'; label: string; text: string };

export type AlikeDecision = {
  title: string;
  outcome: string;
  rationale: string;
  decision_type: 'standing';
  status: 'made';
  anchors: AlikeAnchor[];
};

/** What Interpretability knows about a decision when it records it. */
export type DecisionInput = {
  id: string;
  title: string;
  outcome: string;
  rejected: string;
  option: 'A' | 'B';
  invariant: Invariant;
  files: string[]; // files the fork was about
  answer: string;
  session: number; // 1-based Interpretability session number
};

const MAX_PATH_ANCHORS = 20; // Alike: at most 20 path + machine_path anchors

/**
 * `owner/name` as Alike's hooks see it: HARNESS_REPO_SLUG, else the origin remote, lowercased.
 * Null when there is neither — Alike's own fallback (the bare folder name) can't hold path anchors.
 */
export function repoSlug(root: string): string | null {
  if (process.env.HARNESS_REPO_SLUG) return process.env.HARNESS_REPO_SLUG.toLowerCase();
  try {
    const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(git(root, ['remote', 'get-url', 'origin']));
    if (m) return m[1]!.toLowerCase();
  } catch { /* no remote */ }
  return null;
}

/** A cell path glob as Alike anchors: `src/tools/**` → `src/tools/`; plain files stay; other wildcards → null. */
export function anchorPath(glob: string): string | null {
  if (glob.endsWith('/**')) {
    const dir = glob.slice(0, -3);
    return /[*?[{]/.test(dir) ? null : `${dir}/`;
  }
  return /[*?[{]/.test(glob) ? null : glob;
}

/**
 * Folder/file anchors for a domain's cells, logic first (it's where rules usually bite). With the repo's `files`, a
 * cell's plain file paths collapse to their folder when every file under that folder belongs to this domain
 * (`src/gateway/complete.ts`, `…/redact.ts`, … → `src/gateway/`), so files added there later are covered too.
 */
function domainPaths(map: DomainMap, domainId: string, expand: (glob: string) => string[], files?: readonly string[]): string[] {
  const d = map.domains.find((x) => x.id === domainId);
  if (!d) return [];
  const mapper = files ? createMapper(map) : null;
  const ownFolder = new Map<string, boolean>();
  const folderOf = (path: string): string | null => {
    if (!files || !mapper) return null;
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (!dir) return null;
    let own = ownFolder.get(dir);
    if (own === undefined) {
      const under = files.filter((f) => f.startsWith(`${dir}/`) && !mapper.isIgnored(f));
      own = under.length > 0 && under.every((f) => mapper.domainOf(f) === domainId);
      ownFolder.set(dir, own);
    }
    return own ? `${dir}/` : null;
  };
  const order = (layer: string) => (layer === 'logic' ? 0 : layer === 'data' ? 1 : layer === 'ui' ? 2 : 3);
  const out: string[] = [];
  for (const [, cell] of Object.entries(d.cells).sort(([a], [b]) => order(a) - order(b))) {
    for (const g of cell.paths ?? []) {
      const p = anchorPath(g);
      const folder = p && !p.endsWith('/') ? folderOf(p) : null;
      for (const x of folder ? [folder] : p ? [p] : expand(g)) if (!out.includes(x)) out.push(x);
    }
  }
  return out;
}

/**
 * The architecture a decision governs, as Alike anchors (folders, never globs — Alike matches folder prefixes):
 * - **the side that asked:** the cells of the violating files' domain(s) (`governs`) — e.g. a DR-1 decision made for a
 *   new research tool anchors `src/tools/`, so the next tool written there is given the decision;
 * - **the rule:** for `no_edge`, both domains' cells (the `from` side governs, the `to` side is context); for
 *   `only_via`, the guarded targets (`governs`) plus the allowed domains (`context`: `src/gateway/` for DR-1); for
 *   `owns_writes`, the owners' data cells;
 * - an exception (option B) also anchors the excepted file.
 * Order is violating side, rule, context; at most MAX_PATH_ANCHORS path anchors, then one `applies_when` situation.
 * `expand` turns a glob Alike can't take (e.g. `vendor/llm-*` + `/**`) into concrete folders; `files` (the repo's
 * files) lets a cell's file list collapse to its folder.
 *
 * What the decision *protects* (`protects`, known only when the decision turn ends) is never added: Alike's device
 * token has no update call (`update_entity` is MCP-only), and recording a second entity would duplicate the decision.
 * Those files are covered by the folder anchors above (`src/gateway/` holds DR-4's filing mode and is a context anchor).
 */
export function decisionAnchors(map: DomainMap, d: DecisionInput, repository: string | null, expand: (glob: string) => string[] = () => [], files?: readonly string[]): AlikeAnchor[] {
  const governs = new Set<string>();
  const context = new Set<string>();
  const inv = d.invariant;
  const mapper = createMapper(map);
  const sides = [...new Set(d.files.map((f) => mapper.domainOf(f)).filter((x): x is string => !!x))].sort();
  for (const dom of sides) for (const p of domainPaths(map, dom, expand, files)) governs.add(p);
  if (inv.kind === 'no_edge') {
    for (const p of domainPaths(map, inv.from, expand, files)) governs.add(p);
    for (const p of domainPaths(map, inv.to, expand, files)) context.add(p);
  } else if (inv.kind === 'only_via') {
    for (const g of inv.targets) for (const p of anchorPath(g) ? [anchorPath(g)!] : expand(g)) governs.add(p);
    for (const dom of inv.allowed_from) for (const p of domainPaths(map, dom, expand, files)) context.add(p);
  } else {
    for (const owner of new Set(Object.values(inv.owners))) {
      const cell = map.domains.find((x) => x.id === owner)?.cells.data;
      for (const g of cell?.paths ?? []) for (const p of anchorPath(g) ? [anchorPath(g)!] : expand(g)) governs.add(p);
    }
  }
  if (d.option === 'B') for (const f of d.files) governs.add(f);

  const anchors: AlikeAnchor[] = [];
  if (repository) {
    const push = (path: string, label: string) => {
      if (anchors.length < MAX_PATH_ANCHORS && !anchors.some((a) => a.kind === 'path' && a.path === path)) anchors.push({ kind: 'path', label, path, repository });
    };
    for (const p of governs) push(p, 'governs');
    for (const p of context) push(p, 'context');
  }
  anchors.push({ kind: 'situation', label: 'applies_when', text: situationFor(map, inv) });
  return anchors;
}

function situationFor(map: DomainMap, inv: Invariant): string {
  const name = (id: string) => map.domains.find((d) => d.id === id)?.name ?? id;
  if (inv.kind === 'no_edge') return `Adding or changing code in ${name(inv.from)} that would depend on ${name(inv.to)}`;
  if (inv.kind === 'only_via') return `Adding code that calls ${inv.targets.join(', ')} from outside ${inv.allowed_from.map(name).join(', ')}`;
  return `Adding code that writes ${Object.keys(inv.owners).join(', ')}`;
}

/** The principle, not the incident: title and rationale an agent elsewhere can act on. */
export function alikeDecision(map: DomainMap, d: DecisionInput, repository: string | null, expand?: (glob: string) => string[], files?: readonly string[]): AlikeDecision {
  return {
    title: `${d.id}: ${d.title}`,
    outcome: d.outcome,
    rationale: [
      `Refines ${d.invariant.id} (${d.invariant.rule}).`,
      `Chosen: ${d.outcome}.`,
      `Rejected: ${d.rejected}.`,
      `In the user's words: "${d.answer.trim()}".`,
      `Decided in Interpretability session ${d.session}.`,
    ].join(' '),
    decision_type: 'standing',
    status: 'made',
    anchors: decisionAnchors(map, d, repository, expand, files),
  };
}

export type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string }>;

const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 30_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr) }));
      else resolve({ stdout: String(stdout) });
    });
  });

export const alikeCli = () => process.env.HARNESS_ALIKE_CLI ?? join(homedir(), '.alike', 'bin', 'alike');

/** Record one decision with the paired CLI. Resolves to its URN, or rejects with the CLI's error. */
export async function recordDecision(decision: AlikeDecision, exec: ExecFn = defaultExec): Promise<string> {
  const { title, ...rest } = decision;
  const { stdout } = await exec(alikeCli(), ['it', title, '--json', JSON.stringify(rest)]);
  const urn = /urn:alike:decision:[0-9a-f]+/.exec(stdout)?.[0];
  if (!urn) throw new Error(`alike it returned no decision URN: ${stdout.slice(0, 200)}`);
  return urn;
}

/** The old path, kept as a fallback when the CLI is missing or fails: ask the coding session to call MCP. */
export function mcpInstruction(decision: AlikeDecision): string {
  return `Record this decision in Alike now: call mcp__alike__record_decision with exactly these arguments: ${JSON.stringify(decision)}. If the Alike tools are unavailable, skip this silently.`;
}
