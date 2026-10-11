// Inferred sub-group labels for bloated cells (NAVIGATION_PLAN §4.5): applied automatically, marked inferred,
// cached under .harness/labels/<hash>.json keyed by the cell's file set, regenerated only when that set changes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { cellFiles, createMapper, groupHash, type DomainMap, type FileFacts, type Label } from '@harness/core';

export type Group = { name: string; files: string[] };
export type LabelerInput = { root: string; cell: string; files: string[]; facts: Readonly<Record<string, FileFacts>> };
export type Labeler = (input: LabelerInput) => Promise<{ groups: Group[]; cost: number | null }>;

const GROUPS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['groups'],
  properties: {
    groups: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['name', 'files'], properties: { name: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } } },
    },
  },
} as const;

/** Real labeler: a small, tool-less structured query. Model: `HARNESS_LABELER_MODEL` (default `claude-haiku-5-5`). */
export const sdkLabeler: Labeler = async ({ root, cell, files, facts }) => {
  const lines = files.map((f) => `- ${f}${facts[f]?.symbols.length ? `: ${facts[f]!.symbols.map((s) => s.name).join(', ')}` : ''}${facts[f]?.imports.length ? ` (imports ${facts[f]!.imports.map((i) => i.to).join(', ')})` : ''}`);
  const q = query({
    prompt: [
      `The architecture-map cell ${cell} holds ${files.length} files. Split them into 3–7 sub-groups by purpose, with short product-language names (1–3 words).`,
      'Every file goes in exactly one group. Use the exact paths given.', '', ...lines,
    ].join('\n'),
    options: {
      cwd: root, model: process.env.HARNESS_LABELER_MODEL ?? 'claude-haiku-5-5', tools: [], settingSources: [], strictMcpConfig: true,
      outputFormat: { type: 'json_schema', schema: GROUPS_SCHEMA as unknown as Record<string, unknown> }, maxTurns: 3,
    },
  });
  for await (const m of q) {
    if (m.type !== 'result') continue;
    if (m.subtype !== 'success' || !m.structured_output) throw new Error(`labeler ${m.subtype}`);
    return { groups: (m.structured_output as { groups: Group[] }).groups, cost: m.total_cost_usd };
  }
  throw new Error('labeler returned no result');
};

/**
 * Group labels for `cells` (`cell:<domain>/<layer>` ids): one `group` Label per file, its text the sub-group name.
 * Cached by the cell's file-set hash; the labeler runs only on a cache miss.
 */
export async function labelsFor(opts: { root: string; map: DomainMap; facts: Readonly<Record<string, FileFacts>>; cells: string[]; labeler: Labeler }) {
  const mapper = createMapper(opts.map);
  const dir = join(opts.root, '.harness', 'labels');
  mkdirSync(dir, { recursive: true });
  const labels: Label[] = [];
  let cost = 0, calls = 0;
  for (const cell of [...new Set(opts.cells)].sort()) {
    const m = /^cell:([^/]+)\/(.+)$/.exec(cell);
    if (!m) continue;
    const files = cellFiles(mapper, opts.facts, m[1]!, m[2]!);
    if (!files.length) continue;
    const hash = groupHash(files);
    const file = join(dir, `${hash}.json`);
    let groups: Group[];
    if (existsSync(file)) groups = (JSON.parse(readFileSync(file, 'utf8')) as { groups: Group[] }).groups;
    else {
      const r = await opts.labeler({ root: opts.root, cell, files, facts: opts.facts });
      calls++;
      cost += r.cost ?? 0;
      groups = r.groups;
      writeFileSync(file, JSON.stringify({ cell, files, groups }, null, 2));
    }
    const inCell = new Set(files);
    for (const g of groups) for (const f of g.files) if (inCell.has(f)) labels.push({ target: f, kind: 'group', text: g.name, hash, confirmed: false });
  }
  return { labels, cost, calls };
}
