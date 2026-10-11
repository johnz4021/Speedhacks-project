import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { planFootprint, protectsSummary, stepTouches, editTouches, touchText, withExtra, type PlanStep, type SymbolDiff, type Touch, type Violation } from '@harness/core';
import { decidedIn, listDecisions, type DecisionRecord } from './decisions';
import { findNode, neighborsText, overviewText, sinksFor, symbolsText, traceText } from './graph-tools';
import { semanticStore } from './semantic';
import type { Repo } from './repo';
import type { Bus } from './bus';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export function violationText(vs: Violation[]): string {
  return vs.map((v) => `${v.reason}\n  (A) ${v.options[0]}\n  (B) ${v.options[1]}`).join('\n');
}

/**
 * Beat 4: a violation of an invariant with a linked decision is not a fork. Claude is told what was decided and to
 * plan that way, never to ask again. One line per decision, from decisions/DR-n.md.
 */
export function decidedText(root: string, vs: readonly Violation[]): string {
  const records = new Map(listDecisions(root).map((d) => [d.id, d]));
  return [...new Set(vs.flatMap((v) => (v.decision ? [v.decision] : [])))].map((id) => {
    const d = records.get(id);
    const outcome = d?.outcome ?? vs.find((v) => v.decision === id)!.options[0];
    return `Already decided in ${id}${d ? ` (${d.title})` : ''}: ${outcome}. Plan it the decided way and resubmit; do not ask the user.`;
  }).join('\n');
}

/** Undecided violations are forks (ask A or B); decided ones are replanned without asking. */
export const splitDecided = (vs: readonly Violation[]) => ({ open: vs.filter((v) => !v.decision), decided: vs.filter((v) => !!v.decision) });

export const ASK_RULE =
  'Stop and ask the user to choose A or B, in one short message that names both options, then wait for the answer. ' +
  'Never work around a violation or try another route.';

/** Standing decisions that protect code (beat 4): made, not rejected, with `protects` recorded. */
export const protecting = (root: string) =>
  listDecisions(root).filter((d): d is DecisionRecord & { protects: NonNullable<DecisionRecord['protects']> } => d.status !== 'rejected' && !!d.protects?.paths.length);

/** The reminder for one decision a plan or edit touched, with "decided in session N" from the log or the DR file. */
export function touchReminder(bus: Bus, d: DecisionRecord, touch: Touch, source: 'plan' | 'edit'): string {
  return touchText({ id: d.id, title: d.title, outcome: d.outcome, session: decidedIn(bus, d) }, touch, source);
}

/**
 * Beat 4, plan side: each step's files, symbols and import sources against every standing decision's `protects`.
 * Emits `decision_touched { source: 'plan', step }` per (decision, step) and returns one reminder per decision.
 */
export function planTouches(repo: Repo, bus: Bus, steps: readonly PlanStep[]): string[] {
  const out: string[] = [];
  for (const d of protecting(repo.root)) {
    const paths = new Set<string>();
    const symbols = new Set<string>();
    for (const step of steps) {
      const t = stepTouches(d.protects, step);
      if (!t) continue;
      const path = t.paths[0];
      bus.emit('decision_touched', { decision: d.id, principle: d.title, paths: t.paths, symbols: t.symbols, source: 'plan', step: step.n },
        path ? { path, cell: repo.cellOf(path) } : {});
      t.paths.forEach((p) => paths.add(p));
      t.symbols.forEach((s) => symbols.add(s));
    }
    if (paths.size || symbols.size) out.push(touchReminder(bus, d, { paths: [...paths].sort(), symbols: [...symbols].sort() }, 'plan'));
  }
  return out;
}

/**
 * Beat 4, edit side: an edit's symbol diff against every standing decision's `protects`. Emits `decision_touched
 * { source: 'edit' }` for each decision it touches and returns those decisions with their reminders; the caller
 * decides which reminders reach Claude (once per decision per turn).
 */
export function editTouchesFor(repo: Repo, bus: Bus, path: string, diff: SymbolDiff | null | undefined): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  for (const d of protecting(repo.root)) {
    const t = editTouches(d.protects, path, diff);
    if (!t) continue;
    bus.emit('decision_touched', { decision: d.id, principle: d.title, paths: t.paths, symbols: t.symbols, source: 'edit' }, { path, cell: repo.cellOf(path) });
    out.push({ id: d.id, text: touchReminder(bus, d, t, 'edit') });
  }
  return out;
}

export type PlanHooks = {
  /** Called after each submit_plan with its violations, so the session can track the fork. */
  onPlan(steps: PlanStep[], violations: Violation[]): void;
  /** Instructions queued for the next tool result (e.g. recording a decision in Alike). */
  takeNotes(): string[];
};

export type PlanInput = {
  steps: { n: number; text: string; files: string[]; imports: { from: string; to: string }[]; symbols?: string[] }[];
  avoided?: { from: string; to: string; decision: string; reason: string }[];
};

/** `submit_plan`: footprint, plan check (the one checker), `planned` + `plan_violation` events, and the tool's reply. */
export function submitPlan(repo: Repo, bus: Bus, hooks: PlanHooks, { steps, avoided: avoidedIn }: PlanInput): string {
  const cellName = (domain: string, layer: string) =>
    `${repo.map.domains.find((d) => d.id === domain)?.name ?? domain} · ${repo.map.layers.find((l) => l.id === layer)?.name ?? layer}`;
  const norm = (p: string) => repo.rel(p) ?? p.replace(/^\.\//, '');
  const normSymbol = (id: string) => { const i = id.indexOf('#'); return i > 0 ? `${norm(id.slice(0, i))}#${id.slice(i + 1)}` : id; };
  const clean: PlanStep[] = steps.map((s) => ({
    n: s.n, text: s.text, files: s.files.map(norm),
    imports: s.imports.map((i) => ({ from: norm(i.from), to: i.to.startsWith('.') ? i.to : norm(i.to) })),
    ...(s.symbols?.length ? { symbols: s.symbols.filter((x) => x.includes('#')).map(normSymbol) } : {}),
  }));
  const exists = withExtra(repo.exists, clean.flatMap((s) => s.files));
  const fp = planFootprint(repo.map, clean, exists, repo.mapper);
  // Avoided approaches must cite a decision that exists in decisions/; unknown ids are dropped (and said so).
  const known = new Set(listDecisions(repo.root).map((d) => d.id));
  const end = (x: string) => (x.startsWith('domain:') ? x : norm(x));
  const avoided = (avoidedIn ?? []).filter((a) => known.has(a.decision.trim())).map((a) => ({ from: end(a.from), to: end(a.to), decision: a.decision.trim(), reason: a.reason }));
  const dropped = (avoidedIn ?? []).filter((a) => !known.has(a.decision.trim()));
  bus.emit('planned', {
    steps: clean,
    cells: fp.cells.map((c) => ({ domain: c.domain, layer: c.layer, steps: c.steps, files: c.files })),
    edges: fp.edges.map((e) => ({ from: e.from, to: e.to, steps: e.steps, imports: e.imports })),
    unassigned: fp.unassigned,
    ...(avoided.length ? { avoided } : {}),
  });
  for (const v of fp.violations) bus.emit('plan_violation', { violation: v }, { path: v.file, cell: repo.cellOf(v.file) });
  hooks.onPlan(clean, fp.violations);

  const lines = [
    `Plan recorded: ${clean.length} step(s).`,
    `Cells: ${fp.cells.map((c) => `${cellName(c.domain, c.layer)} (steps ${c.steps.join(', ')})`).join('; ') || 'none'}.`,
    `New cross-domain dependencies: ${fp.edges.map((e) => `${e.from} → ${e.to}`).join('; ') || 'none'}.`,
  ];
  if (fp.unassigned.length) lines.push(`Files outside every domain: ${fp.unassigned.join(', ')}.`);
  if (avoided.length) lines.push(`Avoided (per standing decisions): ${avoided.map((a) => `${a.from} → ${a.to} (${a.decision})`).join('; ')}.`);
  if (dropped.length) lines.push(`Not recorded as avoided (no such decision in decisions/): ${dropped.map((a) => `${a.from} → ${a.to} (${a.decision})`).join('; ')}.`);
  const { open, decided } = splitDecided(fp.violations);
  if (open.length) {
    lines.push('', `VIOLATIONS (${open.length}):`, violationText(open), '', ASK_RULE + ' Do not exit plan mode until the user has answered and you have resubmitted the plan.');
  }
  if (decided.length) {
    lines.push('', `ALREADY DECIDED (${decided.length}):`, ...decided.map((v) => v.reason), decidedText(repo.root, decided),
      'Do not exit plan mode until a resubmitted plan no longer crosses it.');
  }
  // Beat 4: protected code is not a violation and never a fork; the decision reaches Claude now, when it matters.
  const touched = planTouches(repo, bus, clean);
  if (!fp.violations.length) lines.push(touched.length ? 'No violations.' : 'No violations. Exit plan mode when ready.');
  if (touched.length) {
    lines.push('', ...touched, 'If the steps don\'t already keep it true, resubmit them scoped so it holds (and say so in the plan). Then exit plan mode; do not ask the user.');
  }
  const notes = hooks.takeNotes();
  if (notes.length) lines.push('', ...notes);
  return lines.join('\n');
}

export function harnessTools(repo: Repo, bus: Bus, hooks: PlanHooks) {
  const store = semanticStore(repo, bus);
  const rel = (p: string) => repo.rel(p);
  const cellName = (domain: string, layer: string) =>
    `${repo.map.domains.find((d) => d.id === domain)?.name ?? domain} · ${repo.map.layers.find((l) => l.id === layer)?.name ?? layer}`;

  return createSdkMcpServer({
    name: 'interpretability',
    version: '0.1.0',
    tools: [
      tool(
        'submit_plan',
        'Submit your implementation plan before editing anything. Numbered steps; each lists the exact repo-relative file paths it will create or modify, every new import it adds as { from: path, to: path }, and the functions it adds or changes as `symbols` ("path#name", e.g. "src/gateway/redact.ts#Redactor.redact"). If a standing decision rules out the obvious approach, list that approach in `avoided` ({ from, to: repo paths or domain:<id>, decision: "DR-n", reason }). Returns the architecture footprint, any rule violations, and any standing decision whose protected code the plan touches.',
        {
          steps: z.array(z.object({
            n: z.number().int(),
            text: z.string(),
            files: z.array(z.string()),
            imports: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
            symbols: z.array(z.string()).optional(),
          })),
          avoided: z.array(z.object({ from: z.string(), to: z.string(), decision: z.string(), reason: z.string() })).optional(),
        },
        async (input) => text(submitPlan(repo, bus, hooks, input)),
        { alwaysLoad: true },
      ),
      tool('cell_for', 'Which domain × layer cell a repo path belongs to.', { path: z.string() }, async ({ path }) => {
        const rel = repo.rel(path) ?? path;
        const p = repo.place(rel);
        return text(p.kind === 'cell' ? `${rel} → ${cellName(p.domain, p.layer)} (${p.domain}/${p.layer})` : `${rel} → ${p.kind}${'domain' in p ? ` (${p.domain})` : ''}`);
      }, { alwaysLoad: true }),
      tool('domain', 'A domain: purpose, cells with their paths and tables, files, and the rules that involve it.', { id: z.string() }, async ({ id }) => {
        const d = repo.map.domains.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase());
        if (!d) return text(`No domain "${id}". Domains: ${repo.map.domains.map((x) => x.id).join(', ')}`);
        const files = repo.facts.files.filter((f) => repo.mapper.domainOf(f) === d.id);
        const rules = repo.map.invariants.filter((i) => JSON.stringify(i).includes(`"${d.id}"`)).map((i) => `${i.id}: ${i.rule}`);
        return text(JSON.stringify({ id: d.id, name: d.name, purpose: d.purpose, cells: d.cells, files, rules }, null, 2));
      }, { alwaysLoad: true }),
      tool('who_writes', 'Which domain owns a table, and which files write it today.', { table: z.string() }, async ({ table }) => {
        const owner = repo.mapper.ownerOf(table);
        const writers = repo.facts.writes.filter((w) => w.table === table).map((w) => w.file);
        return text(JSON.stringify({ table, owner, writers }, null, 2));
      }, { alwaysLoad: true }),
      tool('decisions_for', 'Standing decisions whose anchors or protected code overlap these paths.', { paths: z.array(z.string()) }, async ({ paths }) => {
        const rel = paths.map((p) => repo.rel(p) ?? p);
        const all = listDecisions(repo.root);
        const under = (p: string, a: string) => p === a || p.startsWith(a.replace(/\*\*?.*$/, ''));
        const hits = all.filter((d) => [...d.anchors.paths, ...(d.protects?.paths ?? [])].some((a) => rel.some((p) => under(p, a))));
        return text(hits.length ? hits.map((d) => `${d.id}: ${d.title}\nOutcome: ${d.outcome}\nRejected: ${d.rejected}${d.protects ? `\nProtects: ${protectsSummary(d.protects)}` : ''}\n${d.rationale}`).join('\n\n') : 'No standing decisions for these paths.');
      }),
      // ---- graph tools (NAVIGATION_PLAN §3.4): the graph the user sees, no model calls. Always loaded, so Claude
      // answers questions about the system from them without a ToolSearch round trip (beat 1).
      tool(
        'overview',
        'The whole system at a glance, from the live architecture graph the user sees: domains with purposes and file counts, cross-domain dependencies with counts, current rule violations, and every path to a model provider (through the gateway, a rule violation, or uncosted). Start here for questions about the architecture. Read-only, no arguments.',
        {},
        async () => text(overviewText(store.graph(), repo.map, repo.facts, repo.mapper, repo.violations)),
        { alwaysLoad: true },
      ),
      tool(
        'graph_neighbors',
        'Edges around a node of the live architecture graph (the one the user sees): imports, calls (syntactic | typed | dispatch), implements, handles, fetches (UI → route), writes, reads, uses. `id`: a repo path, path#symbol, a route like "POST /api/runs", vendor:<pkg>, domain:<id> or cell:<domain>/<layer>. Read-only.',
        {
          id: z.string(),
          kinds: z.array(z.enum(['imports', 'calls', 'implements', 'handles', 'writes', 'reads', 'uses', 'fetches', 'starts'])).optional(),
          hops: z.number().int().min(1).max(3).optional(),
        },
        async ({ id, kinds, hops }) => {
          const g = store.graph();
          const hit = findNode(g, id, rel);
          return text('error' in hit ? hit.error : neighborsText(g, repo.map, hit.id, kinds, hops ?? 1));
        },
        { alwaysLoad: true },
      ),
      tool(
        'trace',
        'Shortest call chains from a symbol, route or file to where they end: vendors, tables and external cells, or `to` (a node, or a path prefix like vendor/llm-anthropic). Follows UI fetches to routes, calls, route handlers and interface dispatch ("via registry"); hops inside one cell are collapsed. Read-only.',
        { from: z.string(), to: z.string().optional() },
        async ({ from, to }) => {
          const g = store.graph();
          const start = findNode(g, from, rel);
          if ('error' in start) return text(start.error);
          const sinks = to === undefined ? undefined : sinksFor(g, to, rel);
          if (sinks && 'error' in sinks) return text(sinks.error);
          return text(traceText(g, repo.map, start.id, sinks, store.coverage()));
        },
        { alwaysLoad: true },
      ),
      tool(
        'symbols_in',
        'Symbols of a file (functions, classes, methods, consts, types) with line numbers, outgoing call counts and the interfaces they implement, plus its routes and entries; or the files under a directory. Read-only.',
        { path: z.string() },
        async ({ path }) => text(symbolsText(store.graph(), repo.map, repo.fileFacts, repo.rel(path) ?? path, (p) => repo.current(p))),
        { alwaysLoad: true },
      ),
    ],
  });
}
