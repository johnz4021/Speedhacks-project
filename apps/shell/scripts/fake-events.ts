// Dev only. Synthesizes one realistic demo turn on top of the real load events from the sandbox server,
// so the shell's turn visuals can be checked without starting a (paid) Claude session.
//
//   curl -s localhost:4310/api/events > apps/shell/scripts/base-events.json   # optional refresh
//   npx tsx apps/shell/scripts/fake-events.ts
//   open http://localhost:5173/?fake=1        (or ?fake=play to stream it, &at=N to open the replay at event N)
//
// Payload shapes follow EventData in packages/core/src/events.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Cell, EventData, EventKind, HarnessEvent, Violation } from '@harness/core/view';

const here = dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(readFileSync(join(here, 'base-events.json'), 'utf8')) as HarnessEvent[];
const session = base[0]?.session ?? 'fake0001';
const TURN = 't10kfs';
let t = (base.at(-1)?.t ?? Date.now()) + 60_000;
let n = 0;
const out: HarnessEvent[] = [...base];

function ev<K extends EventKind>(kind: K, data: K extends keyof EventData ? EventData[K] : never, extra: { cell?: Cell; path?: string; turn?: string | null; gap?: number } = {}) {
  t += extra.gap ?? 1200;
  out.push({
    id: `fake-${String(++n).padStart(3, '0')}`,
    t,
    session,
    turn: extra.turn === undefined ? TURN : extra.turn,
    kind,
    ...(extra.cell ? { cell: extra.cell } : {}),
    ...(extra.path ? { path: extra.path } : {}),
    data: data as Record<string, unknown>,
  });
}

const c = (domain: string, layer: string): Cell => ({ domain, layer });
const TOOLS_LOGIC = c('tools', 'logic');
const TOOLS_EXT = c('tools', 'external');
const GW_LOGIC = c('gateway', 'logic');
const GW_EXT = c('gateway', 'external');
const OUT_LOGIC = c('outreach', 'logic');
const NEW_TOOL = 'src/tools/filing-summary.ts';
const NEW_TEST = 'test/tools/filing-summary.test.ts';
const PROMPT = "Add a tool that summarizes a prospect's latest 10-K.";

const dr1: Violation = {
  invariant: 'DR-1',
  kind: 'only_via',
  reason: `${NEW_TOOL} imports vendor/llm-openai/index.ts, but DR-1: Model providers are only called through the model gateway.`,
  file: NEW_TOOL,
  detail: `${NEW_TOOL} → vendor/llm-openai/index.ts`,
  options: [
    'Route it through the Model gateway (every model call, with redaction and cost logging) instead of importing vendor/llm-openai/index.ts directly',
    `Add an exception for ${NEW_TOOL} and record why`,
  ],
  target: 'vendor/llm-openai/index.ts',
};

// ---------------------------------------------------------------- turn start + exploration
ev('turn_started', { prompt: PROMPT, head: 'a1b2c3d', baseline: 'e4f5a6b' }, { gap: 0 });
ev('chat', { role: 'user', text: PROMPT }, { gap: 50 });
ev('looked', { tool: 'Read' }, { path: 'src/tools/index.ts', cell: TOOLS_LOGIC, gap: 1800 });
ev('looked', { tool: 'Read' }, { path: 'src/tools/news-summarize.ts', cell: TOOLS_LOGIC });
ev('cursor', { verb: 'searching' }, { path: 'vendor/sec-edgar', cell: TOOLS_EXT });
ev('looked', { tool: 'Read' }, { path: 'vendor/sec-edgar/index.ts', cell: TOOLS_EXT });
ev('looked', { tool: 'Read' }, { path: 'vendor/llm-openai/index.ts', cell: GW_EXT });
ev('chat', { role: 'assistant', text: "I'll model the new tool on `news-summarize.ts`: fetch the filing from SEC EDGAR, then summarize it with the same OpenAI call." });

// ---------------------------------------------------------------- first plan: copies the bypass
const steps1 = [
  { n: 1, text: 'Add fetchLatest10K() to the SEC EDGAR client', files: ['vendor/sec-edgar/index.ts'], imports: [] },
  { n: 2, text: 'Create the filing-summary tool, modeled on news-summarize', files: [NEW_TOOL], imports: [{ from: NEW_TOOL, to: 'vendor/sec-edgar/index.ts' }, { from: NEW_TOOL, to: 'vendor/llm-openai/index.ts' }] },
  { n: 3, text: 'Register filingSummary in the tool index', files: ['src/tools/index.ts'], imports: [] },
  { n: 4, text: 'Add a test with a recorded filing', files: [NEW_TEST], imports: [] },
];
ev('planned', {
  steps: steps1,
  cells: [
    { domain: 'tools', layer: 'external', steps: [1], files: ['vendor/sec-edgar/index.ts'] },
    { domain: 'tools', layer: 'logic', steps: [2, 3], files: [NEW_TOOL, 'src/tools/index.ts'] },
  ],
  edges: [{ from: 'tools', to: 'gateway', steps: [2], imports: [{ from: NEW_TOOL, to: 'vendor/llm-openai/index.ts' }] }],
  unassigned: [],
}, { gap: 2400 });
ev('plan_violation', { violation: dr1 }, { gap: 40 });
const ask = 'My plan crosses **DR-1**: `filing-summary.ts` would call OpenAI directly, like `news-summarize.ts` does. Which do you want?\n\n- **A**: route it through `gateway.complete()`, with redaction and cost logging\n- **B**: add an exception for `filing-summary.ts` and record why';
ev('chat', { role: 'assistant', text: ask }, { gap: 2200 });
ev('fork_asked', { violations: [dr1], text: ask }, { gap: 30 });

// ---------------------------------------------------------------- the user answers A; decision recorded
const answer = "A — through the gateway. Redaction is the point; if it mangles the filing's figures, fix redaction.";
ev('chat', { role: 'user', text: answer }, { gap: 5200 });
ev('fork_answered', { option: 'A', text: answer, violations: [dr1] }, { gap: 20 });
ev('decision_recorded', { id: 'DR-4', title: 'Filing summaries call models through the gateway', invariant: 'DR-1', option: 'A', paths: [NEW_TOOL] }, { gap: 300 });

// ---------------------------------------------------------------- second plan: through the gateway
const steps2 = [
  { n: 1, text: 'Add fetchLatest10K() to the SEC EDGAR client', files: ['vendor/sec-edgar/index.ts'], imports: [] },
  { n: 2, text: 'Create the filing-summary tool; summarize with gateway.complete()', files: [NEW_TOOL], imports: [{ from: NEW_TOOL, to: 'vendor/sec-edgar/index.ts' }, { from: NEW_TOOL, to: 'src/gateway/complete.ts' }] },
  { n: 3, text: 'Register filingSummary in the tool index', files: ['src/tools/index.ts'], imports: [] },
  { n: 4, text: 'Keep currency figures intact in redaction', files: ['src/gateway/redact.ts'], imports: [] },
  { n: 5, text: 'Add a test with a recorded filing', files: [NEW_TEST], imports: [] },
];
ev('planned', {
  steps: steps2,
  cells: [
    { domain: 'tools', layer: 'external', steps: [1], files: ['vendor/sec-edgar/index.ts'] },
    { domain: 'tools', layer: 'logic', steps: [2, 3], files: [NEW_TOOL, 'src/tools/index.ts'] },
    { domain: 'gateway', layer: 'logic', steps: [4], files: ['src/gateway/redact.ts'] },
  ],
  edges: [{ from: 'tools', to: 'gateway', steps: [2], imports: [{ from: NEW_TOOL, to: 'src/gateway/complete.ts' }] }],
  unassigned: [],
}, { gap: 3000 });
const plan = steps2.map((s) => `${s.n}. ${s.text}`).join('\n');
ev('chat', { role: 'assistant', text: 'Recorded as **DR-4**. The new plan goes through the gateway, and step 4 keeps dollar figures out of redaction.' }, { gap: 900 });
ev('approval_requested', { plan }, { gap: 300 });
ev('plan_approved', {} as never, { gap: 4200 });

// ---------------------------------------------------------------- build
function edit(path: string, cell: Cell, added: number, removed: number, created = false, gap = 1400) {
  ev('cursor', { verb: 'editing' }, { path, cell, gap });
  if (created) ev('file_assigned', { placement: { kind: 'cell', domain: cell.domain, layer: cell.layer } }, { path, turn: TURN, gap: 60 });
  ev('edited', { added, removed, created, tool: created ? 'Write' : 'Edit' }, { path, cell, gap: 300 });
}
edit('vendor/sec-edgar/index.ts', TOOLS_EXT, 22, 1);
edit(NEW_TOOL, TOOLS_LOGIC, 64, 0, true);
ev('edge_added', { edge: { from: NEW_TOOL, to: 'src/gateway/complete.ts' }, from: 'tools', to: 'gateway' }, { gap: 200 });
edit('src/tools/index.ts', TOOLS_LOGIC, 2, 0);
edit('src/gateway/redact.ts', GW_LOGIC, 9, 3);
// Not in the plan: the agent also tweaks outreach. This is the amber cell.
edit('src/outreach/draft-email.ts', OUT_LOGIC, 3, 1);
ev('cursor', { verb: 'editing' }, { path: NEW_TEST, gap: 1400 });
ev('file_assigned', { placement: { kind: 'test', domain: 'tools' } }, { path: NEW_TEST, gap: 60 });
ev('edited', { added: 31, removed: 0, created: true, tool: 'Write' }, { path: NEW_TEST, gap: 300 });
ev('decision_recorded', { id: 'DR-4', title: 'Filing summaries call models through the gateway', invariant: 'DR-1', option: 'A', paths: [NEW_TOOL], alike: true }, { gap: 900 });
ev('chat', {
  role: 'assistant',
  text: 'Done. `filingSummary` fetches the latest 10-K and summarizes it through `gateway.complete()`; redaction now leaves currency figures alone. I also touched `draft-email.ts` to cite filings, which was not in the plan.',
}, { gap: 1600 });
ev('turn_ended', {
  added: 131,
  removed: 5,
  files: ['vendor/sec-edgar/index.ts', NEW_TOOL, 'src/tools/index.ts', 'src/gateway/redact.ts', 'src/outreach/draft-email.ts', NEW_TEST],
  reason: 'success',
}, { gap: 200 });

const dest = join(here, '../public/fake-events.json');
writeFileSync(dest, JSON.stringify(out, null, 1));
const turnStart = out.findIndex((e) => e.kind === 'turn_started');
const at = (kind: EventKind, nth = 0) => out.map((e, i) => [e, i] as const).filter(([e]) => e.kind === kind)[nth]?.[1];
console.log(`${out.length} events → ${dest}`);
console.log(`turn starts at ${turnStart}; fork_asked at ${at('fork_asked')}; approval at ${at('approval_requested')}; mid-build at ${at('edited', 2)! + 1}`);
