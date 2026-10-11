import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { planFootprint, withExtra, type PlanStep, type Violation } from '@harness/core';
import { listDecisions } from './decisions';
import { findNode, neighborsText, sinksFor, symbolsText, traceText } from './graph-tools';
import { semanticStore } from './semantic';
import type { Repo } from './repo';
import type { Bus } from './bus';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export function violationText(vs: Violation[]): string {
  return vs.map((v) => `${v.reason}\n  (A) ${v.options[0]}\n  (B) ${v.options[1]}`).join('\n');
}

export const ASK_RULE =
  'Stop and ask the user to choose A or B, in one short message that names both options, then wait for the answer. ' +
  'Never work around a violation or try another route.';

export type PlanHooks = {
  /** Called after each submit_plan with its violations, so the session can track the fork. */
  onPlan(steps: PlanStep[], violations: Violation[]): void;
  /** Instructions queued for the next tool result (e.g. recording a decision in Alike). */
  takeNotes(): string[];
};

export function harnessTools(repo: Repo, bus: Bus, hooks: PlanHooks) {
  const store = semanticStore(repo, bus);
  const rel = (p: string) => repo.rel(p);
  const cellName = (domain: string, layer: string) =>
    `${repo.map.domains.find((d) => d.id === domain)?.name ?? domain} · ${repo.map.layers.find((l) => l.id === layer)?.name ?? layer}`;

  return createSdkMcpServer({
    name: 'harness',
    version: '0.1.0',
    tools: [
      tool(
        'submit_plan',
        'Submit your implementation plan before editing anything. Numbered steps; each lists the exact repo-relative file paths it will create or modify, and every new import it adds as { from: path, to: path }. Returns the architecture footprint and any rule violations.',
        {
          steps: z.array(z.object({
            n: z.number().int(),
            text: z.string(),
            files: z.array(z.string()),
            imports: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
          })),
        },
        async ({ steps }) => {
          const norm = (p: string) => repo.rel(p) ?? p.replace(/^\.\//, '');
          const clean: PlanStep[] = steps.map((s) => ({
            n: s.n, text: s.text, files: s.files.map(norm),
            imports: s.imports.map((i) => ({ from: norm(i.from), to: i.to.startsWith('.') ? i.to : norm(i.to) })),
          }));
          const exists = withExtra(repo.exists, clean.flatMap((s) => s.files));
          const fp = planFootprint(repo.map, clean, exists, repo.mapper);
          bus.emit('planned', {
            steps: clean,
            cells: fp.cells.map((c) => ({ domain: c.domain, layer: c.layer, steps: c.steps, files: c.files })),
            edges: fp.edges.map((e) => ({ from: e.from, to: e.to, steps: e.steps, imports: e.imports })),
            unassigned: fp.unassigned,
          });
          for (const v of fp.violations) bus.emit('plan_violation', { violation: v }, { path: v.file, cell: repo.cellOf(v.file) });
          hooks.onPlan(clean, fp.violations);

          const lines = [
            `Plan recorded: ${clean.length} step(s).`,
            `Cells: ${fp.cells.map((c) => `${cellName(c.domain, c.layer)} (steps ${c.steps.join(', ')})`).join('; ') || 'none'}.`,
            `New cross-domain dependencies: ${fp.edges.map((e) => `${e.from} → ${e.to}`).join('; ') || 'none'}.`,
          ];
          if (fp.unassigned.length) lines.push(`Files outside every domain: ${fp.unassigned.join(', ')}.`);
          if (fp.violations.length) {
            lines.push('', `VIOLATIONS (${fp.violations.length}):`, violationText(fp.violations), '', ASK_RULE + ' Do not exit plan mode until the user has answered and you have resubmitted the plan.');
          } else {
            lines.push('No violations. Exit plan mode when ready.');
          }
          const notes = hooks.takeNotes();
          if (notes.length) lines.push('', ...notes);
          return text(lines.join('\n'));
        },
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
      }),
      tool('who_writes', 'Which domain owns a table, and which files write it today.', { table: z.string() }, async ({ table }) => {
        const owner = repo.mapper.ownerOf(table);
        const writers = repo.facts.writes.filter((w) => w.table === table).map((w) => w.file);
        return text(JSON.stringify({ table, owner, writers }, null, 2));
      }),
      tool('decisions_for', 'Standing decisions whose anchors overlap these paths.', { paths: z.array(z.string()) }, async ({ paths }) => {
        const rel = paths.map((p) => repo.rel(p) ?? p);
        const all = listDecisions(repo.root);
        const hits = all.filter((d) => d.anchors.paths.some((a) => rel.some((p) => p === a || p.startsWith(a.replace(/\*\*?.*$/, '')))));
        return text(hits.length ? hits.map((d) => `${d.id}: ${d.title}\nOutcome: ${d.outcome}\nRejected: ${d.rejected}\n${d.rationale}`).join('\n\n') : 'No standing decisions for these paths.');
      }),
      // ---- graph tools (NAVIGATION_PLAN §3.4): the graph the user sees, no model calls; not in the brief.
      tool(
        'graph_neighbors',
        'Edges around a node of the live architecture graph (the one the user sees): imports, calls (syntactic | typed | dispatch), implements, handles, writes, uses. `id`: a repo path, path#symbol, a route like "POST /api/runs", vendor:<pkg>, domain:<id> or cell:<domain>/<layer>. Read-only.',
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
      ),
      tool(
        'trace',
        'Shortest call chains from a symbol, route or file to where they end: vendors, tables and external cells, or `to` (a node, or a path prefix like vendor/llm-openai). Follows calls, route handlers and interface dispatch ("via registry"); hops inside one cell are collapsed. Read-only.',
        { from: z.string(), to: z.string().optional() },
        async ({ from, to }) => {
          const g = store.graph();
          const start = findNode(g, from, rel);
          if ('error' in start) return text(start.error);
          const sinks = to === undefined ? undefined : sinksFor(g, to, rel);
          if (sinks && 'error' in sinks) return text(sinks.error);
          return text(traceText(g, repo.map, start.id, sinks, store.coverage()));
        },
      ),
      tool(
        'symbols_in',
        'Symbols of a file (functions, classes, methods, consts, types) with line numbers, outgoing call counts and the interfaces they implement, plus its routes and entries; or the files under a directory. Read-only.',
        { path: z.string() },
        async ({ path }) => text(symbolsText(store.graph(), repo.map, repo.fileFacts, repo.rel(path) ?? path, (p) => repo.current(p))),
      ),
    ],
  });
}
