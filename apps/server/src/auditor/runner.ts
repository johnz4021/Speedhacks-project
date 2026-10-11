// The auditor agent (NAVIGATION_PLAN §4.6): a separate, read-only Agent SDK session that reads a finished turn against
// the standing decisions the pre-filter picked, and returns advisory findings. It never edits anything and never
// blocks the coding session. The model call is behind `Auditor` so tests inject a fake.
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Invariant, RawFinding, RelevantDecision, TurnSurface } from '@harness/core';

export type AuditInput = {
  root: string;
  surface: TurnSurface;
  decisions: RelevantDecision[]; // the pre-filter's picks (never empty when the auditor runs)
  invariants: Invariant[];
  diff: string; // numberDiff output: new-file line numbers on every line
};
export type AuditorResult = { findings: RawFinding[]; cost: number | null };
export type Auditor = (input: AuditInput) => Promise<AuditorResult>;

export const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      description: 'Usually empty. One entry per likely contradiction of a standing decision\'s rationale.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['decision', 'files', 'lines', 'text', 'confidence'],
        properties: {
          decision: { type: 'string', description: 'The DR id of the standing decision the change contradicts, e.g. "DR-4".' },
          files: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths of the changed files involved.' },
          lines: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['path', 'line'], properties: { path: { type: 'string' }, line: { type: 'integer' } } },
            description: 'The exact lines (new-file line numbers, as shown in the diff) that contradict the decision.',
          },
          text: { type: 'string', description: 'One or two sentences: what the decision says (cite it) and what the line does instead. Plain and specific.' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
      },
    },
  },
} as const;

const list = (xs: readonly string[], none = '(none)') => (xs.length ? xs.map((x) => `- ${x}`) : [none]);

/** The auditor's prompt: its job, what not to report, the decisions that matter, invariants, the turn's diff and fact delta. */
export function buildAuditPrompt(input: AuditInput): string {
  const s = input.surface;
  const what = s.source === 'plan' ? 'a submitted plan (nothing is written yet)' : 'a finished coding turn';
  return [
    `You are the auditor for this repo. You review ${what} against the user's standing architecture decisions.`,
    '',
    '## Your job',
    '- Flag only LIKELY contradictions of a standing decision\'s *rationale* (its intent, the reason it was made) that the three rule kinds (only_via, owns_writes, no_edge) cannot express. Example: a decision says filings must keep exact figures by using a filings redaction mode; new code sends filings through the gateway without that mode.',
    '- Cite the decision id and the exact changed lines (the new-file line numbers shown in the diff). Every finding must be about a file this turn changed.',
    '- NEVER restate a rule violation: the deterministic checker already catches imports and table writes that break an invariant (listed below). Do not report style, bugs, tests, naming or anything unrelated to a listed decision.',
    '- Empty is the expected answer most of the time. Report nothing unless the contradiction is concrete; when unsure, use low confidence or leave it out.',
    '- You may Read/Grep/Glob files to check context (e.g. what an option or mode does). Do not modify anything.',
    '',
    `## The turn: "${s.prompt.trim().slice(0, 400)}"`,
    '',
    '## Plan steps',
    ...list(s.plan.map((p) => `${p.n}. ${p.text}${p.files.length ? ` (${p.files.join(', ')})` : ''}`)),
    '',
    '## Standing decisions to check (picked because they bear on what the turn touched)',
    ...input.decisions.flatMap(({ decision: d, reasons }) => [
      `### ${d.id}: ${d.title}`,
      `Outcome: ${d.outcome}`,
      d.invariant ? `Linked invariant: ${d.invariant}` : 'Linked invariant: none',
      `Anchored to: ${d.paths.join(', ') || '-'}`,
      `Why it was picked: ${reasons.map((r) => `${r.kind} (${r.detail})`).join('; ')}`,
      'Rationale:',
      d.rationale.trim().split('\n').map((l) => `> ${l}`).join('\n'),
      '',
    ]),
    '## Invariants (enforced by the checker; context only)',
    ...list(input.invariants.map((i) => `${i.id} [${i.kind}]: ${i.rule}`)),
    '',
    '## Violations the checker already raised for this turn (do NOT report these again)',
    ...list(s.violations.map((v) => `${v.invariant}: ${v.reason}`)),
    '',
    '## Fact delta (new in the changed files)',
    ...list([
      ...s.delta.calls.map((c) => `call ${c.from} → ${c.to}`),
      ...s.delta.imports.map((i) => `import ${i.from} → ${i.to}`),
      ...s.delta.writes.map((w) => `write ${w.file} → table ${w.table}`),
    ]),
    '',
    `## Changed files: ${s.files.join(', ') || '(none)'}`,
    `Changed symbols: ${s.symbols.join(', ') || '(none)'}`,
    '',
    s.source === 'plan' ? '## Diff\n(none: this is a plan review)' : '## Diff (new-file line numbers on the left)',
    ...(s.source === 'plan' ? [] : ['```', input.diff.trimEnd() || '(empty)', '```']),
  ].join('\n');
}

/**
 * The real auditor: a read-only Agent SDK query with structured output, on the strongest model.
 * Model: `HARNESS_AUDITOR_MODEL` (default `claude-opus-5-5`).
 */
export const sdkAuditor: Auditor = async (input) => {
  const q = query({
    prompt: buildAuditPrompt(input),
    options: {
      cwd: input.root,
      model: process.env.HARNESS_AUDITOR_MODEL ?? 'claude-opus-5-5',
      effort: 'high',
      tools: ['Read', 'Grep', 'Glob'],
      allowedTools: ['Read', 'Grep', 'Glob'],
      permissionMode: 'dontAsk',
      settingSources: [],
      strictMcpConfig: true,
      outputFormat: { type: 'json_schema', schema: FINDINGS_SCHEMA as unknown as Record<string, unknown> },
      maxTurns: 20,
    },
  });
  for await (const m of q) {
    if (m.type !== 'result') continue;
    if (m.subtype !== 'success' || !m.structured_output) throw Object.assign(new Error(`auditor ${m.subtype}`), { cost: m.total_cost_usd });
    const out = m.structured_output as { findings?: RawFinding[] };
    return { findings: out.findings ?? [], cost: m.total_cost_usd };
  }
  throw new Error('auditor returned no result');
};
