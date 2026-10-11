// The cartographer agent (NAVIGATION_PLAN §4.5): a separate, read-only Agent SDK session that proposes K candidate
// domains.yaml maps for a set of drift signals. It never edits anything and never blocks the coding session; the
// loop scores its candidates deterministically. The model call is behind `Proposer` so tests inject a fake.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createMapper, type DomainMap, type DriftSignal, type FileFacts, type HistoryTurn, type ProposalChange } from '@harness/core';

export type RejectedProposal = { decision: string; proposal: string; summary: string; changes: ProposalChange[]; signature: string };
export type StandingDecision = { id: string; title: string; outcome: string; rationale: string; invariant: string; paths: string[] };

export type ProposeInput = {
  root: string;
  yaml: string; // current domains.yaml text
  map: DomainMap;
  facts: Readonly<Record<string, FileFacts>>;
  signals: DriftSignal[]; // the persisted signals that triggered this run
  scope: string[]; // node ids: trigger scopes plus the affected domains and one hop
  history: readonly HistoryTurn[];
  turns: { id: string; prompt: string; files: string[] }[]; // recent Harness turns
  decisions: StandingDecision[];
  rejected: RejectedProposal[]; // never propose these again
  k: number;
};
export type Candidate = { title: string; rationale: string; yaml: string };
export type ProposerResult = { candidates: Candidate[]; cost: number | null };
export type Proposer = (input: ProposeInput) => Promise<ProposerResult>;

export const CANDIDATES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'rationale', 'yaml'],
        properties: {
          title: { type: 'string', description: 'One line, e.g. "Add a Billing domain for src/billing/".' },
          rationale: { type: 'string', description: 'Two or three sentences: what changes and why it fixes the signals.' },
          yaml: { type: 'string', description: 'The COMPLETE domains.yaml text for this candidate (not a diff).' },
        },
      },
    },
  },
} as const;

/** Co-changed file pairs across the history (top 10), for the prompt. */
function coChange(history: readonly HistoryTurn[], known: Set<string>): string[] {
  const pairs = new Map<string, number>();
  for (const u of history.slice(-50)) {
    const fs = u.files.filter((f) => known.has(f)).sort();
    if (fs.length > 12) continue;
    for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) pairs.set(`${fs[i]} + ${fs[j]}`, (pairs.get(`${fs[i]} + ${fs[j]}`) ?? 0) + 1);
  }
  return [...pairs].filter(([, n]) => n > 1).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).slice(0, 10).map(([k, n]) => `${k} (${n}×)`);
}

/** The cartographer's prompt: rules, signals, scoped facts, recent turns, decisions, rejected proposals, current map. */
export function buildPrompt(input: ProposeInput): string {
  const mapper = createMapper(input.map);
  const scopeDomains = new Set(input.scope.filter((s) => s.startsWith('domain:')).map((s) => s.slice(7)));
  const scopeIds = new Set(input.scope);
  const inScope = (p: string) => {
    const pl = mapper.place(p);
    return scopeIds.has(p) || pl.kind === 'unassigned' || ((pl.kind === 'cell' || pl.kind === 'test') && scopeDomains.has(pl.domain));
  };
  const files = Object.values(input.facts).filter((f) => inScope(f.path)).sort((a, b) => a.path.localeCompare(b.path));
  const where = (p: string) => { const pl = mapper.place(p); return pl.kind === 'cell' ? `${pl.domain}/${pl.layer}` : pl.kind === 'test' ? `${pl.domain} tests` : pl.kind; };
  const together = coChange(input.history, new Set(Object.keys(input.facts)));
  const counts = new Map<string, number>();
  for (const p of Object.keys(input.facts)) counts.set(where(p), (counts.get(where(p)) ?? 0) + 1);

  return [
    'You are the cartographer for this repo\'s architecture map, `domains.yaml` (domains are columns, layers are rows; files are placed by path globs).',
    `Deterministic drift signals have fired. Propose up to ${input.k} DIFFERENT candidate maps that would fix them. Each candidate is the complete new domains.yaml.`,
    'Your candidates are scored by code, not by you: cells lit per past turn/commit (fewer is better), import-graph modularity by domain, unassigned files, evenness of cell sizes, decisions broken, and churn (files moved, ids removed).',
    '',
    '## Rules',
    '- Change as little as possible. Start from the current domains.yaml text and keep everything you do not need to change (comments, ids, order, invariants, exceptions, decisions, cartography settings).',
    '- A rename keeps the `id`; change only `name`. Prefer placing or moving files over re-cutting domains. Never remove an invariant that lists `decisions` or exceptions with a `decision`.',
    '- New domains: lowercase id, product-language name (1–3 words), a one-line purpose. When a folder sits in one cell, use a folder glob (e.g. `src/billing/**`) so later files land there.',
    '- A table belongs to exactly one cell\'s `tables` (the domain that writes it). Every `owns_writes` owner, `only_via.allowed_from` and `no_edge` endpoint must name an existing domain id. Layers must exist in `layers`.',
    '- Make the candidates genuinely different from each other (e.g. a new domain vs. placing the files in an existing domain vs. a different split).',
    '- NEVER propose a change the user already rejected (listed below), nor one with the same effect.',
    '- You may Read/Grep/Glob files to understand purposes. Do not modify anything.',
    '',
    '## Signals',
    ...input.signals.map((s) => `- ${s.signal}: ${s.metric} = ${s.value} (threshold ${s.threshold}, held ${s.persisted} turns) · scope: ${s.scope.join(', ')}`),
    '',
    `## Scope (affected domains plus one hop): ${input.scope.join(', ')}`,
    '',
    '## Files in scope (placement · imports · table writes)',
    ...files.map((f) => {
      const imports = f.imports.map((i) => i.to).filter((t) => !t.startsWith('vendor:'));
      return `- ${f.path} [${where(f.path)}]${imports.length ? ` → ${imports.join(', ')}` : ''}${f.writes.length ? ` · writes ${[...new Set(f.writes.map((w) => w.table))].join(', ')}` : ''}`;
    }),
    '',
    '## File counts per placement (whole repo)',
    ...[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `- ${k}: ${n}`),
    '',
    '## Recent turns (prompt → files edited)',
    ...(input.turns.length ? input.turns.slice(-10).map((t) => `- ${t.id}: "${t.prompt.slice(0, 160)}" → ${t.files.join(', ')}`) : ['(none)']),
    '',
    '## Files that often change together',
    ...(together.length ? together.map((x) => `- ${x}`) : ['(none)']),
    '',
    '## Standing decisions (do not break them)',
    ...(input.decisions.length ? input.decisions.map((d) => `- ${d.id}${d.invariant ? ` (on ${d.invariant})` : ''}: ${d.title}. Outcome: ${d.outcome}. Governs: ${d.paths.join(', ') || '-'}`) : ['(none)']),
    '',
    '## Proposals the user REJECTED (never propose these again)',
    ...(input.rejected.length ? input.rejected.map((r) => `- ${r.proposal} (${r.decision}): ${r.summary}\n  changes: ${JSON.stringify(r.changes)}`) : ['(none)']),
    '',
    '## Current domains.yaml',
    '```yaml',
    input.yaml.trimEnd(),
    '```',
  ].join('\n');
}

/**
 * The real proposer: a read-only Agent SDK query on the strongest model at high effort, with structured output.
 * Model: `HARNESS_CARTOGRAPHER_MODEL` (default `claude-opus-5-5`).
 */
export const sdkProposer: Proposer = async (input) => {
  const q = query({
    prompt: buildPrompt(input),
    options: {
      cwd: input.root,
      model: process.env.HARNESS_CARTOGRAPHER_MODEL ?? 'claude-opus-5-5',
      effort: 'high',
      tools: ['Read', 'Grep', 'Glob'],
      allowedTools: ['Read', 'Grep', 'Glob'],
      permissionMode: 'dontAsk',
      settingSources: [],
      strictMcpConfig: true,
      outputFormat: { type: 'json_schema', schema: CANDIDATES_SCHEMA as unknown as Record<string, unknown> },
      maxTurns: 30,
    },
  });
  for await (const m of q) {
    if (m.type !== 'result') continue;
    if (m.subtype !== 'success' || !m.structured_output) throw Object.assign(new Error(`cartographer ${m.subtype}`), { cost: m.total_cost_usd });
    const out = m.structured_output as { candidates?: Candidate[] };
    return { candidates: (out.candidates ?? []).slice(0, input.k), cost: m.total_cost_usd };
  }
  throw new Error('cartographer returned no result');
};
