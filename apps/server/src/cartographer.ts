import { query } from '@anthropic-ai/claude-agent-sdk';
import { stringify } from 'yaml';
import { scanRepo, DomainMapSchema, type DomainMap } from '@harness/core';
import type { Repo } from './repo';
import type { Bus } from './bus';

const DEFAULT_IGNORE = ['node_modules/**', '.git/**', '.harness/**', 'decisions/**', '*.json', '*.md', '*.config.ts', '.*', 'domains.yaml'];

/** Flat shape for structured output; converted to the domains.yaml schema afterwards. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['layers', 'neutral', 'ignore', 'domains', 'invariants'],
  properties: {
    layers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' } } } },
    neutral: { type: 'array', items: { type: 'string' }, description: 'Globs for shared code that belongs to no domain (types, db helpers, logging).' },
    ignore: { type: 'array', items: { type: 'string' }, description: 'Globs to skip entirely (fixtures, scripts, build output, config).' },
    domains: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'purpose', 'cells', 'tests'],
        properties: {
          id: { type: 'string' }, name: { type: 'string', description: 'Product language, 1–3 words.' }, purpose: { type: 'string' },
          cells: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['layer', 'paths', 'tables'],
              properties: { layer: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } }, tables: { type: 'array', items: { type: 'string' } } },
            },
          },
          tests: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    invariants: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'rule', 'kind', 'targets', 'allowed_from', 'owners', 'from', 'to'],
        properties: {
          id: { type: 'string', description: 'DR-1, DR-2 or DR-3' },
          rule: { type: 'string', description: 'One plain sentence.' },
          kind: { type: 'string', enum: ['only_via', 'owns_writes', 'no_edge'] },
          targets: { type: 'array', items: { type: 'string' }, description: 'only_via: globs of the guarded files (e.g. vendor clients).' },
          allowed_from: { type: 'array', items: { type: 'string' }, description: 'only_via: domain ids allowed to import the targets.' },
          owners: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['table', 'domain'], properties: { table: { type: 'string' }, domain: { type: 'string' } } }, description: 'owns_writes: table → owning domain id.' },
          from: { type: 'string', description: 'no_edge: domain id (empty otherwise).' },
          to: { type: 'string', description: 'no_edge: domain id (empty otherwise).' },
        },
      },
    },
  },
} as const;

type Out = {
  layers: { id: string; name: string }[];
  neutral: string[];
  ignore: string[];
  domains: { id: string; name: string; purpose: string; cells: { layer: string; paths: string[]; tables: string[] }[]; tests: string[] }[];
  invariants: { id: string; rule: string; kind: 'only_via' | 'owns_writes' | 'no_edge'; targets: string[]; allowed_from: string[]; owners: { table: string; domain: string }[]; from: string; to: string }[];
};

function toMap(o: Out): DomainMap {
  const raw = {
    version: 1,
    layers: o.layers,
    neutral: o.neutral,
    ignore: [...new Set([...DEFAULT_IGNORE, ...o.ignore])],
    domains: o.domains.map((d) => ({
      id: d.id, name: d.name, purpose: d.purpose,
      cells: Object.fromEntries(d.cells.map((c) => [c.layer, { ...(c.paths.length ? { paths: c.paths } : {}), ...(c.tables.length ? { tables: c.tables } : {}) }])),
      ...(d.tests.length ? { tests: d.tests } : {}),
    })),
    invariants: o.invariants.map((i) => {
      const base = { id: i.id, rule: i.rule, kind: i.kind, exceptions: [], source: 'cartographer' };
      if (i.kind === 'only_via') return { ...base, targets: i.targets, allowed_from: i.allowed_from };
      if (i.kind === 'owns_writes') return { ...base, owners: Object.fromEntries(i.owners.map((x) => [x.table, x.domain])) };
      return { ...base, from: i.from, to: i.to };
    }),
  };
  return DomainMapSchema.parse(raw);
}

/**
 * One-shot map proposal (SPEC §10): a separate read-only query on a smaller model, given the file tree,
 * import edges and table writes. Never runs inside the coding session. Returns domains.yaml text.
 */
export async function proposeMap(repo: Repo, bus: Bus): Promise<string> {
  const bare: DomainMap = { version: 1, layers: [{ id: 'x', name: 'x' }], ignore: DEFAULT_IGNORE, domains: [], invariants: [] } as DomainMap;
  const facts = scanRepo(repo.root, bare);
  const prompt = [
    'Propose an architecture map for this repo as a domain × layer grid that a product person can read.',
    '- 5–9 domains named in product language (e.g. "Model gateway", not "src/gateway"). Every source file should land in exactly one cell or in `neutral`/`ignore`.',
    '- Layers suited to this repo, top to bottom (for an agent system: entry, logic, data, external). Data cells list the tables that domain writes. External cells hold vendor/third-party client code.',
    '- When a folder holds exactly one cell, use a folder glob (e.g. `src/tools/**`) so files added later land in the right cell. List explicit file paths only where one folder is split across several cells. Map test folders with `tests` globs.',
    '- Exactly 3 invariants, ids DR-1, DR-2, DR-3, the most load-bearing ones you can infer from the facts below: DR-1 `only_via` for the vendor clients that only one domain should import (e.g. all model providers and embeddings in one rule); DR-2 one `owns_writes` rule covering every table with its owning domain; DR-3 one `no_edge` between two domains that must stay independent. The code may already break one of them in a single place; that is expected, still propose the rule.',
    'You may read files to understand purposes. Do not modify anything.',
    '',
    `Files (${facts.files.length}):`, ...facts.files,
    '',
    'Import edges (from → to):', ...facts.imports.map((i) => `${i.from} → ${i.to}`),
    '',
    'Table writes (file: table):', ...facts.writes.map((w) => `${w.file}: ${w.table}`),
  ].join('\n');

  const q = query({
    prompt,
    options: {
      cwd: repo.root,
      model: process.env.HARNESS_CARTOGRAPHER_MODEL ?? 'claude-haiku-5-5',
      tools: ['Read', 'Grep', 'Glob'],
      permissionMode: 'dontAsk',
      allowedTools: ['Read', 'Grep', 'Glob'],
      settingSources: [],
      strictMcpConfig: true,
      outputFormat: { type: 'json_schema', schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> },
      maxTurns: 20,
    },
  });
  for await (const m of q) {
    if (m.type === 'result') {
      if (m.subtype !== 'success' || !m.structured_output) throw new Error(`cartographer ${m.subtype}`);
      const map = toMap(m.structured_output as Out);
      const header = '# Proposed by the Harness cartographer and confirmed by the user.\n# Domains are columns, layers are rows. Edges are derived from imports, never declared.\n\n';
      bus.emit('chat', { role: 'system', text: `Cartographer proposed ${map.domains.length} domains and ${map.invariants.length} rules.` }, { turn: null });
      return header + stringify(map, { collectionStyle: "any", lineWidth: 140 });
    }
  }
  throw new Error('cartographer returned no result');
}
