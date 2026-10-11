// Journeys (NAVIGATION_PLAN §2, phase N10), server side: compute journeys from the repo's Tier 1 facts and fetch sites
// (pure, in @harness/core), name them with a small model (cached under .harness/journeys/<hash>.json by the hash of
// the step list; inferred until confirmed), and publish `journeys_updated` on load, after turns that change them, and on
// confirm. The namer never blocks anything: placeholder names go out first, model names follow.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  buildGraph, computeJourneys, findFetchSites, inferDispatch, journeyHash, reduce,
  type ContextGraph, type FileFacts, type Journey,
} from '@harness/core';
import type { Bus } from '../bus';
import type { Repo } from '../repo';

export type NamerInput = { root: string; journeys: { id: string; steps: string[] }[] };
export type Namer = (input: NamerInput) => Promise<{ names: { id: string; name: string }[]; cost: number | null }>;

const NAMES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['names'],
  properties: {
    names: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' } } },
    },
  },
} as const;

export function namerPrompt(input: NamerInput): string {
  return [
    'Each block below is a user flow through a codebase: an entry point (UI page, HTTP route, CLI, script) followed by the code it runs, down to the services and tables it ends at.',
    'Give each flow a short product-language name a PM would use: 2–4 words, verb first, sentence case, no code names or URLs (e.g. "Start research", "Send a drafted email", "View usage").',
    'Return one name per id, using the exact ids given.',
    '',
    ...input.journeys.flatMap((j) => [`## ${j.id}`, ...j.steps.map((s, i) => `${i + 1}. ${s}`), '']),
  ].join('\n');
}

/** Real namer: a small, tool-less structured query. Model: `HARNESS_JOURNEY_MODEL` (default `claude-haiku-5-5`). */
export const sdkNamer: Namer = async (input) => {
  const q = query({
    prompt: namerPrompt(input),
    options: {
      cwd: input.root, model: process.env.HARNESS_JOURNEY_MODEL ?? 'claude-haiku-5-5', tools: [], settingSources: [], strictMcpConfig: true,
      outputFormat: { type: 'json_schema', schema: NAMES_SCHEMA as unknown as Record<string, unknown> }, maxTurns: 3,
    },
  });
  for await (const m of q) {
    if (m.type !== 'result') continue;
    if (m.subtype !== 'success' || !m.structured_output) throw Object.assign(new Error(`journey namer ${m.subtype}`), { cost: m.total_cost_usd });
    return { names: (m.structured_output as { names: { id: string; name: string }[] }).names ?? [], cost: m.total_cost_usd };
  }
  throw new Error('journey namer returned no result');
};

/** How a step reads in the namer's prompt: `<kind>: <label>` with the node's path or id for context. */
export function describeStep(graph: ContextGraph, step: Journey['steps'][number]): string {
  const n = graph.nodes[step.node];
  const where = step.node.includes('#') ? step.node : n?.path ?? step.node;
  return `${step.kind}: ${n?.label ?? step.node}${where !== n?.label ? ` (${where})` : ''}`;
}

/** Journeys for the repo's current facts and sources (deterministic; names are placeholders). */
export function journeysFor(repo: Repo): { journeys: Journey[]; graph: ContextGraph } {
  const facts: Record<string, FileFacts> = Object.fromEntries(repo.fileFacts);
  const sources = Object.values(facts).flatMap((f) => {
    const source = repo.current(f.path);
    return source === null ? [] : [{ path: f.path, source, symbols: f.symbols }];
  });
  const graph = buildGraph(repo.map, facts);
  return { journeys: computeJourneys(graph, facts, findFetchSites(sources), inferDispatch(sources, facts)), graph };
}

type Cache = { id: string; hash: string; steps: string[]; name: string };
type Confirmed = Record<string, { name: string; at: number }>;

export type JourneysOptions = { bus: Bus; repo: Repo; namer?: Namer | null };
export type Result = { ok: true; journey: Journey } | { ok: false; status: 404 | 409; error: string };

export function attachJourneys(opts: JourneysOptions) {
  const { bus, repo } = opts;
  const namer = opts.namer === undefined ? (process.env.HARNESS_JOURNEYS === '0' ? null : sdkNamer) : opts.namer;
  const dir = join(repo.root, '.harness', 'journeys');
  const confirmedPath = join(dir, 'confirmed.json');
  const work = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>) => { work.add(p); const off = () => { work.delete(p); }; p.then(off, off); return p; };
  let naming = false;
  let again = false;
  let current: { journeys: Journey[]; graph: ContextGraph } | null = null;

  const readJson = <T>(p: string, fallback: T): T => { try { return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : fallback; } catch { return fallback; } };
  const cached = (hash: string) => readJson<Cache | null>(join(dir, `${hash}.json`), null);
  const confirmed = () => readJson<Confirmed>(confirmedPath, {});

  /** Confirmed names win (inferred: false); then cached model names; else the placeholder (both inferred). */
  function named(js: Journey[]): { journeys: Journey[]; unnamed: Journey[] } {
    const conf = confirmed();
    const unnamed: Journey[] = [];
    const journeys = js.map((j) => {
      const c = conf[j.id];
      if (c) return { ...j, name: c.name, inferred: false };
      const hit = cached(journeyHash(j));
      if (hit) return { ...j, name: hit.name, inferred: true };
      unnamed.push(j);
      return j;
    });
    return { journeys, unnamed };
  }

  const lastEmitted = () => JSON.stringify(reduce(bus.events).journeys);

  function publish(js: Journey[]) {
    if (JSON.stringify(js) !== lastEmitted()) bus.emit('journeys_updated', { journeys: js }, { turn: null });
  }

  /** Recompute, publish if anything changed, and name new journeys in the background. */
  function refresh(): Journey[] {
    if (!repo.map || !repo.hasMap()) return [];
    current = journeysFor(repo);
    const { journeys, unnamed } = named(current.journeys);
    publish(journeys);
    if (unnamed.length && namer) {
      if (naming) again = true;
      else track(name(unnamed));
    }
    return journeys;
  }

  async function name(list: Journey[]) {
    naming = true;
    const t0 = Date.now();
    const graph = current!.graph;
    try {
      const input = { root: repo.root, journeys: list.map((j) => ({ id: j.id, steps: j.steps.map((s) => describeStep(graph, s)) })) };
      const r = await namer!(input);
      mkdirSync(dir, { recursive: true });
      const byId = new Map(r.names.map((n) => [n.id, n.name.trim()]));
      for (const j of list) {
        const n = byId.get(j.id);
        if (!n) continue;
        const hash = journeyHash(j);
        writeFileSync(join(dir, `${hash}.json`), JSON.stringify({ id: j.id, hash, steps: j.steps.map((s) => s.node), name: n } satisfies Cache, null, 2));
      }
      bus.emit('maintenance_run', { agent: 'cartographer', trigger: 'journeys', ms: Date.now() - t0, cost: r.cost, ok: true }, { turn: null });
      if (current) publish(named(current.journeys).journeys);
    } catch (e) {
      bus.emit('maintenance_run', { agent: 'cartographer', trigger: 'journeys', ms: Date.now() - t0, cost: (e as { cost?: number }).cost ?? null, ok: false }, { turn: null });
      bus.emit('error', { message: `Journey naming failed: ${(e as Error).message}` }, { turn: null });
    } finally {
      naming = false;
      if (again) { again = false; schedule(); }
    }
  }

  /** Confirm a journey (optionally renaming it): it is no longer inferred. */
  function confirm(id: string, name?: string): Result {
    const js = reduce(bus.events).journeys;
    const j = js.find((x) => x.id === id);
    if (!j) return { ok: false, status: 404, error: `No journey ${id}.` };
    const text = (name ?? j.name).trim();
    if (!text) return { ok: false, status: 409, error: 'A journey name cannot be empty.' };
    mkdirSync(dir, { recursive: true });
    writeFileSync(confirmedPath, JSON.stringify({ ...confirmed(), [id]: { name: text, at: Date.now() } }, null, 2));
    const next = js.map((x) => (x.id === id ? { ...x, name: text, inferred: false } : x));
    publish(next);
    return { ok: true, journey: next.find((x) => x.id === id)! };
  }

  function schedule() {
    track(new Promise<void>((resolve) => setImmediate(() => {
      try { refresh(); }
      catch (e) { bus.emit('error', { message: `Journeys failed: ${(e as Error).message}` }, { turn: null }); }
      finally { resolve(); }
    })));
  }

  // After a scan (load, map accepted) and after every turn: recompute; emit only when the journeys changed.
  const off = bus.on((e) => { if (e.kind === 'repo_scanned' || e.kind === 'turn_ended') schedule(); });

  return {
    refresh() { schedule(); },
    confirm,
    /** Resolves once no recompute or naming job is in flight (for tests and shutdown). */
    async idle() { while (work.size) await Promise.allSettled([...work]); },
    detach: off,
  };
}

export type JourneysLoop = ReturnType<typeof attachJourneys>;

/** HTTP endpoints, mounted under /api by the server. */
export function journeyRoutes(j: JourneysLoop) {
  const r = new Hono();
  r.post('/journeys/:id/confirm', async (c) => {
    const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
    const id = c.req.param('id');
    const res = j.confirm(id.startsWith('journey:') ? id : `journey:${id}`, body.name); // the bare slug works too
    return res.ok ? c.json(res) : c.json({ error: res.error }, res.status);
  });
  r.post('/journeys/refresh', (c) => { j.refresh(); return c.json({ ok: true }); });
  return r;
}
