// Dev only. DEMO_PLAN beats 3 and 4 on the load events (`?fake=beat4`): session 1 decides DR-4 (research tools
// never read outreach data; the run loop passes it in); session 2 asks for a tool that reads past emails, and the plan
// avoids it, so the edge it would have needed shows struck through, "rejected in DR-4, session 1".
//
//   npx tsx apps/shell/scripts/beat4-events.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Cell, EventData, EventKind, HarnessEvent, Violation } from '@harness/core/view';

const here = dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(readFileSync(join(here, 'base-events.json'), 'utf8')) as HarnessEvent[];
const S1 = base[0]?.session ?? 'session-1';
const S2 = 'session-2';
let session = S1;
let turn = 't-beat3';
let t = (base.at(-1)?.t ?? Date.now()) + 60_000;
let n = 0;
const out: HarnessEvent[] = [...base];

function ev<K extends EventKind>(kind: K, data: K extends keyof EventData ? EventData[K] : never, extra: { cell?: Cell; path?: string; gap?: number } = {}) {
  t += extra.gap ?? 1200;
  out.push({ id: `b4-${String(++n).padStart(3, '0')}`, t, session, turn, kind, ...(extra.cell ? { cell: extra.cell } : {}), ...(extra.path ? { path: extra.path } : {}), data: data as Record<string, unknown> });
}
const c = (domain: string, layer: string): Cell => ({ domain, layer });

// ---------------------------------------------------------------- beat 3 (session 1): the decision is made
const HISTORY = 'src/tools/outreach-history.ts';
const dr3: Violation = {
  invariant: 'DR-3', kind: 'no_edge', file: HISTORY, target: 'src/outreach/outreach-log.ts',
  reason: `${HISTORY} imports src/outreach/outreach-log.ts, but DR-3: Research tools never depend on outreach.`,
  detail: `${HISTORY} → src/outreach/outreach-log.ts`,
  options: ['Keep research tools out of outreach data; the run loop passes outreach context in', `Add an exception for ${HISTORY} and record why`],
};
ev('turn_started', { prompt: "Can we add a research tool that checks whether we've already emailed this contact?", head: 'a1', baseline: 'a1' }, { gap: 0 });
ev('chat', { role: 'user', text: "Can we add a research tool that checks whether we've already emailed this contact?" }, { gap: 50 });
ev('planned', {
  steps: [{ n: 1, text: 'Add the outreach-history tool', files: [HISTORY], imports: [{ from: HISTORY, to: 'src/outreach/outreach-log.ts' }] }],
  cells: [{ domain: 'tools', layer: 'logic', steps: [1], files: [HISTORY] }],
  edges: [{ from: 'tools', to: 'outreach', steps: [1], imports: [{ from: HISTORY, to: 'src/outreach/outreach-log.ts' }] }],
  unassigned: [],
}, { gap: 2000 });
ev('plan_violation', { violation: dr3 }, { gap: 40 });
ev('fork_asked', { violations: [dr3], text: 'This breaks DR-3. A or B?' }, { gap: 600 });
ev('fork_answered', { option: 'A', text: 'A. Research tools never read outreach data; the run loop passes it in.', violations: [dr3] }, { gap: 4000 });
ev('decision_recorded', { id: 'DR-4', title: 'Research tools never read outreach data; the run loop passes it in', invariant: 'DR-3', option: 'A', paths: ['src/orchestrator/agent.ts'] }, { gap: 300 });
ev('turn_ended', { added: 0, removed: 0, files: [], reason: 'success' }, { gap: 900 });

// ---------------------------------------------------------------- beat 4 (session 2): memory stops something being built
session = S2;
turn = 't-beat4';
const PROMPT = 'Can we build a research tool that reads our past emails with this contact and suggests a personalized opener?';
ev('turn_started', { prompt: PROMPT, head: 'b2', baseline: 'b2' }, { gap: 0 });
ev('chat', { role: 'user', text: PROMPT }, { gap: 50 });
ev('looked', { tool: 'Read' }, { path: 'src/orchestrator/agent.ts', cell: c('orchestrator', 'logic') });
ev('looked', { tool: 'Read' }, { path: 'src/outreach/draft-email.ts', cell: c('outreach', 'logic') });
ev('planned', {
  steps: [
    { n: 1, text: 'Pass a summary of past emails from the run loop', files: ['src/orchestrator/agent.ts'], imports: [] },
    { n: 2, text: 'Use it for the opener in the email draft', files: ['src/outreach/draft-email.ts'], imports: [] },
  ],
  cells: [{ domain: 'orchestrator', layer: 'logic', steps: [1], files: ['src/orchestrator/agent.ts'] }, { domain: 'outreach', layer: 'logic', steps: [2], files: ['src/outreach/draft-email.ts'] }],
  edges: [],
  unassigned: [],
  avoided: [{ from: 'src/tools/email-opener.ts', to: 'domain:outreach', decision: 'DR-4', reason: 'Research tools never read outreach data' }],
}, { gap: 2400 });
ev('chat', { role: 'assistant', text: "Per **DR-4**, I won't build this as a research tool. The run loop will pass a summary of past emails into the email draft." }, { gap: 800 });
ev('approval_requested', { plan: '1. Pass a summary of past emails from the run loop\n2. Use it for the opener in the email draft' }, { gap: 300 });

writeFileSync(join(here, '../public/beat4-events.json'), JSON.stringify(out, null, 1));
console.log(`${out.length} events → public/beat4-events.json`);
