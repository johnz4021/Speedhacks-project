// Dev only. The fixed mid-turn state the D1 design comps show (`?map=v2&fake=comp&comp=1&expand=tools&theme=…`):
// Research tools expanded, the agent on filing-summarize.ts, the gate blocking its direct OpenAI import (new DR-1),
// the existing DR-1 bypass in news-summarize.ts, an unplanned edit in outreach, a plan with ghosts.
//
//   npx tsx apps/shell/scripts/comp-events.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Cell, EventData, EventKind, FileFacts, HarnessEvent, SymbolDiff, SymbolFact, Violation } from '@harness/core/view';

const here = dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(readFileSync(join(here, 'base-events.json'), 'utf8')) as HarnessEvent[];
const session = base[0]?.session ?? 'comp0001';
let TURN = 't1cache';
let t = (base.at(-1)?.t ?? Date.now()) + 60_000;
let n = 0;
const out: HarnessEvent[] = [...base];

function ev<K extends EventKind>(kind: K, data: K extends keyof EventData ? EventData[K] : never, extra: { cell?: Cell; path?: string; gap?: number } = {}) {
  t += extra.gap ?? 1200;
  out.push({ id: `comp-${String(++n).padStart(3, '0')}`, t, session, turn: TURN, kind, ...(extra.cell ? { cell: extra.cell } : {}), ...(extra.path ? { path: extra.path } : {}), data: data as Record<string, unknown> });
}

// Tier 1 facts after an edit (the server emits `facts_changed` with every `edited`): the scanned facts with a new
// hash, or for a created file the imports and symbols it was written with.
const scanned = new Map((base.find((e) => e.kind === 'repo_scanned')?.data as EventData['repo_scanned'] | undefined)?.fileFacts?.map((f) => [f.path, f]) ?? []);
function factsAfter(path: string, created?: { imports: string[]; symbols: string[] }): FileFacts {
  const prev = scanned.get(path);
  if (prev && !created) return { ...prev, hash: `${prev.hash}+${n}` };
  const sym = (name: string, parent: string | null): SymbolFact => ({
    id: `${path}#${name}`, file: path, name, kind: parent ? 'method' : 'const', exported: !parent, parent: parent && `${path}#${parent}`,
    span: { start: 0, end: 0 }, sigHash: name, bodyHash: name,
  });
  const symbols = (created?.symbols ?? []).map((s) => sym(s, s.includes('.') ? s.slice(0, s.indexOf('.')) : null));
  return { path, hash: `new${n}`, imports: (created?.imports ?? []).map((to) => ({ to, typeOnly: false })), writes: [], symbols, calls: [], routes: [], entries: [] };
}
const symbolsOf = (f: FileFacts, created: boolean): SymbolDiff => ({ added: created ? f.symbols.map((s) => s.id) : [], removed: [], sig: [], body: created ? [] : f.symbols.slice(0, 1).map((s) => s.id), renamed: [] });

const c = (domain: string, layer: string): Cell => ({ domain, layer });
const TOOLS = c('tools', 'logic');
const TOOLS_EXT = c('tools', 'external');
const NEW_TOOL = 'src/tools/filing-summarize.ts';
const NEW_TEST = 'test/tools/filing-summarize.test.ts';
const PROMPT = "Add a tool that summarizes a prospect's latest 10-K.";

const dr1: Violation = {
  invariant: 'DR-1',
  kind: 'only_via',
  reason: `${NEW_TOOL} imports vendor/llm-openai/index.ts, but DR-1: Model providers are only called through the model gateway.`,
  file: NEW_TOOL,
  detail: `${NEW_TOOL} → vendor/llm-openai/index.ts`,
  options: [
    'Route it through the Model gateway instead of importing vendor/llm-openai/index.ts directly',
    `Add an exception for ${NEW_TOOL} and record why`,
  ],
  target: 'vendor/llm-openai/index.ts',
};

// ---------------------------------------------------------------- an earlier, finished turn (gives the ledger history)
const dr3: Violation = {
  invariant: 'DR-3', kind: 'no_edge', file: 'src/tools/company-profile.ts', target: 'src/outreach/crm-sync.ts',
  reason: 'src/tools/company-profile.ts imports src/outreach/crm-sync.ts, but DR-3: Research tools never depend on outreach.',
  detail: 'src/tools/company-profile.ts → src/outreach/crm-sync.ts', options: ['Read contacts through the agent loop instead', 'Add an exception and record why'],
};
ev('turn_started', { prompt: 'Cache company profiles for a day, and reuse CRM contacts when we have them.', head: '9f8e7d6', baseline: '9f8e7d6' }, { gap: 0 });
ev('planned', {
  steps: [{ n: 1, text: 'Cache profiles in memory notes', files: ['src/memory/notes-store.ts'], imports: [] }, { n: 2, text: 'Read CRM contacts in company-profile', files: ['src/tools/company-profile.ts'], imports: [{ from: 'src/tools/company-profile.ts', to: 'src/outreach/crm-sync.ts' }] }],
  cells: [{ domain: 'memory', layer: 'data', steps: [1], files: ['src/memory/notes-store.ts'] }, { domain: 'tools', layer: 'logic', steps: [2], files: ['src/tools/company-profile.ts'] }],
  edges: [{ from: 'tools', to: 'outreach', steps: [2], imports: [{ from: 'src/tools/company-profile.ts', to: 'src/outreach/crm-sync.ts' }] }],
  unassigned: [],
}, { gap: 2000 });
ev('plan_violation', { violation: dr3 }, { gap: 40 });
ev('fork_asked', { violations: [dr3], text: 'My plan crosses DR-3. A: read contacts through the agent loop. B: add an exception.' }, { gap: 900 });
ev('fork_answered', { option: 'A', text: 'A', violations: [dr3] }, { gap: 4000 });
ev('plan_approved', {} as never, { gap: 1500 });
ev('edited', { added: 31, removed: 4, created: false, tool: 'Edit' }, { path: 'src/memory/notes-store.ts', cell: c('memory', 'data') });
ev('edited', { added: 17, removed: 2, created: false, tool: 'Edit' }, { path: 'src/orchestrator/agent.ts', cell: c('orchestrator', 'logic') });
ev('turn_ended', { added: 48, removed: 6, files: ['src/memory/notes-store.ts', 'src/orchestrator/agent.ts'], reason: 'success' }, { gap: 800 });

// ---------------------------------------------------------------- the current turn, mid-build
TURN = 't10kcomp';
ev('turn_started', { prompt: PROMPT, head: 'a1b2c3d', baseline: 'e4f5a6b' }, { gap: 0 });
ev('chat', { role: 'user', text: PROMPT }, { gap: 50 });
ev('looked', { tool: 'Read' }, { path: 'src/tools/index.ts', cell: TOOLS });
ev('looked', { tool: 'Read' }, { path: 'src/tools/news-summarize.ts', cell: TOOLS });
ev('looked', { tool: 'Read' }, { path: 'vendor/sec-edgar/index.ts', cell: TOOLS_EXT });
ev('looked', { tool: 'Read' }, { path: 'src/gateway/complete.ts', cell: c('gateway', 'logic') });

const steps = [
  { n: 1, text: 'Add fetchLatest10K() to the SEC EDGAR client', files: ['vendor/sec-edgar/index.ts'], imports: [] },
  { n: 2, text: 'Create filing-summarize; summarize with gateway.complete()', files: [NEW_TOOL], imports: [{ from: NEW_TOOL, to: 'vendor/sec-edgar/index.ts' }, { from: NEW_TOOL, to: 'src/gateway/complete.ts' }] },
  { n: 3, text: 'Register filingSummarize in the tool index', files: ['src/tools/index.ts'], imports: [] },
  { n: 4, text: 'Add a test with a recorded filing', files: [NEW_TEST], imports: [] },
];
ev('planned', {
  steps,
  cells: [
    { domain: 'tools', layer: 'external', steps: [1], files: ['vendor/sec-edgar/index.ts'] },
    { domain: 'tools', layer: 'logic', steps: [2, 3], files: [NEW_TOOL, 'src/tools/index.ts'] },
  ],
  edges: [
    { from: 'tools', to: 'gateway', steps: [2], imports: [{ from: NEW_TOOL, to: 'src/gateway/complete.ts' }] },
    { from: 'tools', to: 'tools', steps: [2], imports: [{ from: NEW_TOOL, to: 'vendor/sec-edgar/index.ts' }] },
  ],
  unassigned: [],
}, { gap: 2400 });
ev('approval_requested', { plan: steps.map((s) => `${s.n}. ${s.text}`).join('\n') }, { gap: 300 });
ev('plan_approved', {} as never, { gap: 4200 });

function edit(path: string, cell: Cell, added: number, removed: number) {
  ev('cursor', { verb: 'editing' }, { path, cell, gap: 1400 });
  const facts = factsAfter(path);
  ev('edited', { added, removed, created: false, tool: 'Edit', symbols: symbolsOf(facts, false) }, { path, cell, gap: 300 });
  ev('facts_changed', { facts }, { path, cell, gap: 5 });
}
edit('vendor/sec-edgar/index.ts', TOOLS_EXT, 22, 1);
edit('src/outreach/draft-email.ts', c('outreach', 'logic'), 3, 1); // not in the plan: amber
ev('cursor', { verb: 'editing' }, { path: NEW_TOOL, cell: TOOLS, gap: 1400 });
ev('gate_blocked', { violation: dr1, tool: 'Write' }, { path: NEW_TOOL, cell: TOOLS, gap: 600 });

writeFileSync(join(here, '../public/comp-events.json'), JSON.stringify(out, null, 1));
console.log(`${out.length} events → public/comp-events.json`);
