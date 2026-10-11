// Position stability and edge declutter for the v2 layout (NAVIGATION_PLAN §3.3, N4), on the Scout fixture's real
// load events (Tier 1 facts from the sandbox scan) through the real pipeline, with ELK's bundled build in node.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ELK from 'elkjs/lib/elk.bundled.js';
import { describe, expect, it } from 'vitest';
import { reduce, type FileFacts, type HarnessEvent } from '@harness/core/view';
import { cachedLayout, type ElkApi } from '../layout/containers';
import { buildFrame, layoutAll, UNASSIGNED, type Frame } from '../layout/frame';
import { ancestors, dive, jump, up } from '../nav';
import { graphMemo, sceneOf, type Scene } from '../scene';

const base = JSON.parse(readFileSync(fileURLToPath(new URL('../../../scripts/base-events.json', import.meta.url)), 'utf8')) as HarnessEvent[];
const elk = new ELK() as unknown as ElkApi;
const layout = cachedLayout(async () => elk);

let n = 0;
const ev = (kind: HarnessEvent['kind'], data: Record<string, unknown>, extra: Partial<HarnessEvent> = {}): HarnessEvent =>
  ({ id: `x${n++}`, t: n, session: 's', turn: null, kind, data, ...extra });

/** A new file in a cell, as the server reports it: placed, with Tier 1 facts. */
function addFile(path: string, domain: string, layer: string, imports: string[]): HarnessEvent[] {
  const facts: FileFacts = { path, hash: `h-${path}`, imports: imports.map((to) => ({ to, typeOnly: false })), writes: [], symbols: [], calls: [], routes: [], entries: [] };
  return [ev('file_assigned', { placement: { kind: 'cell', domain, layer } }, { path }), ev('facts_changed', { facts }, { path })];
}

const memo = graphMemo();
function sceneFor(events: HarnessEvent[], open: string[]): Scene {
  const ui = reduce(events);
  return sceneOf(ui, memo(ui)!, null, open);
}

async function frameFor(scene: Scene, region: string[] | null = scene.open.length ? scene.open : null): Promise<Frame> {
  const layouts = await layoutAll(scene.projection, layout);
  const map = scene.ui.map!;
  const meta = { domains: map.domains.map((d) => ({ id: d.id, name: d.name, purpose: d.purpose })), layers: map.layers.map((l) => ({ id: l.id, name: l.name })) };
  return buildFrame({ projection: scene.projection, meta, layouts, region, key: scene.key });
}

/** Nodes of a frame inside a container (its children, transitively), with their box relative to the container. */
function inside(f: Frame, scene: Scene, container: string) {
  const out = new Map<string, { abs: { x: number; y: number }; rel: { x: number; y: number } }>();
  const c = f.boxes[container]!;
  for (const node of f.nodes) {
    if (node.id === container || !ancestors(scene.graph, node.id).includes(container)) continue;
    out.set(node.id, { abs: { x: node.x, y: node.y }, rel: { x: node.x - c.x, y: node.y - c.y } });
  }
  return out;
}

describe('v2 layout: position stability', () => {
  // Three open containers: Channels·Entry (left of and above the change), Research tools·Logic (the change) and
  // Memory·Logic (right of it, same row).
  const open = ['cell:channels/entry', 'cell:tools/logic', 'cell:memory/logic'];

  it('adding a file to one cell moves nodes in other containers by 0 px, and in its own container by a bounded amount', async () => {
    const before = sceneFor(base, open);
    const after = sceneFor([...base, ...addFile('src/tools/sec-filings.ts', 'tools', 'logic', ['src/gateway/complete.ts', 'vendor/sec-edgar/index.ts'])], open);
    const f0 = await frameFor(before);
    const f1 = await frameFor(after);
    expect(f1.boxes['src/tools/sec-filings.ts']).toBeDefined();

    // other containers: identical layout (cache hit), so every node keeps its place inside its container
    for (const c of ['cell:channels/entry', 'cell:memory/logic']) {
      const a = inside(f0, before, c);
      const b = inside(f1, after, c);
      expect(a.size).toBeGreaterThan(0);
      for (const [id, p] of a) expect(b.get(id)!.rel).toEqual(p.rel);
    }
    // and a container whose column is left of the change and whose row is above it does not move at all
    for (const [id, p] of inside(f0, before, 'cell:channels/entry')) expect(inside(f1, after, 'cell:channels/entry').get(id)!.abs).toEqual(p.abs);
    expect(f1.boxes['cell:channels/entry']).toEqual(f0.boxes['cell:channels/entry']);
    // collapsed cells left of the change keep their place (cells in the changed row may only grow taller with it)
    for (const id of ['cell:channels/logic', 'cell:orchestrator/logic', 'cell:channels/entry']) {
      const { x, y, w } = f0.boxes[id]!;
      expect(f1.boxes[id]).toMatchObject({ x, y, w });
    }

    // the changed container: existing nodes move by at most two file rows (and most stay put)
    const a = inside(f0, before, 'cell:tools/logic');
    const b = inside(f1, after, 'cell:tools/logic');
    const moves = [...a].map(([id, p]) => Math.hypot(b.get(id)!.rel.x - p.rel.x, b.get(id)!.rel.y - p.rel.y));
    expect(moves.length).toBeGreaterThan(3);
    expect(Math.max(...moves)).toBeLessThanOrEqual(2 * (42 + 12) + 1);
  });

  it('is deterministic: the same inputs give the same frame', async () => {
    const s = sceneFor(base, open);
    const [a, b] = [await frameFor(s), await frameFor(sceneFor(base, open))];
    expect(b.nodes).toEqual(a.nodes);
    expect(b.edges.map((e) => e.d)).toEqual(a.edges.map((e) => e.d));
  });

  it('a turn event that changes no structure keeps every node in place', async () => {
    const s0 = sceneFor(base, ['domain:tools']);
    const s1 = sceneFor([...base, ev('turn_started', { prompt: 'x', head: '', baseline: '' }, { turn: 't' }), ev('looked', { tool: 'Read' }, { turn: 't', path: 'src/tools/web-search.ts', cell: { domain: 'tools', layer: 'logic' } })], ['domain:tools']);
    expect((await frameFor(s1)).nodes).toEqual((await frameFor(s0)).nodes);
  });
});

describe('v2 layout: grid, ports and declutter', () => {
  it('System level: every cell on the grid, no containers, every edge drawn in full', async () => {
    const s = sceneFor(base, []);
    const f = await frameFor(s);
    expect(f.nodes.every((x) => x.type === 'cell')).toBe(true);
    expect(f.nodes.length).toBe(s.projection.grid.cells.length + (f.boxes[UNASSIGNED] ? 1 : 0));
    expect(f.edges.length).toBeGreaterThan(0);
    expect(f.edges.some((e) => e.faint)).toBe(false);
    // the gateway bypass on load is a red edge from Research tools·Logic to Model gateway·External
    expect(f.edges.find((e) => e.from === 'cell:tools/logic' && e.to === 'cell:gateway/external')?.violation).toBe('existing');
    // flow down a column is implied: no edge between two cells of one domain
    expect(f.edges.some((e) => e.from.startsWith('cell:') && e.to.startsWith('cell:') && e.from.split('/')[0] === e.to.split('/')[0])).toBe(false);
  });

  it('a domain open: its column widens, the others become spines, edges leave through the container border', async () => {
    const s = sceneFor(base, ['domain:tools']);
    const f = await frameFor(s);
    const tools = f.cols.find((c) => c.id === 'tools')!;
    expect(tools.open).toBe(true);
    expect(f.cols.filter((c) => c.id !== 'tools').every((c) => c.spine)).toBe(true);
    expect(f.boxes['cell:tools/logic']!.type).toBe('container');
    expect(f.boxes['src/tools/news-summarize.ts']!.type).toBe('file');
    // the existing bypass now starts at the file, inside the container
    const bypass = f.edges.find((e) => e.from === 'src/tools/news-summarize.ts' && e.violation === 'existing')!;
    expect(bypass).toBeDefined();
    const box = f.boxes['src/tools/news-summarize.ts']!;
    const [x0, y0] = bypass.d.slice(1).split(/[LQ ]/)[0]!.split(',').map(Number) as [number, number];
    expect(x0).toBeCloseTo(box.x + box.w, 0);
    expect(y0).toBeGreaterThanOrEqual(box.y);
    expect(y0).toBeLessThanOrEqual(box.y + box.h);
  });

  it('declutters: edges away from the open region merge into faint trunks with a count; loud edges stay', async () => {
    const s = sceneFor(base, ['domain:tools']);
    const f = await frameFor(s);
    const trunks = f.edges.filter((e) => e.trunk);
    expect(trunks.length).toBeGreaterThan(0);
    for (const t of trunks) {
      expect(t.faint).toBe(true);
      expect(t.count).toBe(t.trunk!.reduce((sum, id) => sum + s.projection.edges.find((e) => e.id === id)!.count, 0));
      // nothing in a trunk touches the open domain
      for (const id of t.trunk!) {
        const e = s.projection.edges.find((x) => x.id === id)!;
        expect([e.from, e.to].some((x) => s.projection.nodes.find((nn) => nn.id === x)!.domain === 'tools')).toBe(false);
      }
    }
    expect(f.edges.filter((e) => e.violation).every((e) => !e.faint)).toBe(true);
    // a selected node narrows the region further: edges not touching it fade, its own stay
    const sel = await frameFor(s, ['src/tools/news-summarize.ts']);
    expect(sel.edges.filter((e) => !e.faint).every((e) => e.from === 'src/tools/news-summarize.ts' || e.to === 'src/tools/news-summarize.ts' || e.violation || e.status !== 'existing')).toBe(true);
  });
});

describe('v2 navigation', () => {
  const s = sceneFor(base, []);
  const g = s.graph;

  it('dives into cells and domains, and Esc goes back up one level at a time', () => {
    let p = dive(g, { open: [], focus: null }, 'cell:tools/logic');
    expect(p).toEqual({ open: ['cell:tools/logic'], focus: 'cell:tools/logic' });
    p = { ...p, focus: 'src/tools/news-summarize.ts' };
    p = up(g, p);
    expect(p).toEqual({ open: [], focus: 'cell:tools/logic' });
    p = up(g, p);
    expect(p).toEqual({ open: [], focus: 'domain:tools' });
    expect(up(g, p)).toEqual({ open: [], focus: null });
    // opening the domain replaces its cells; closing one cell keeps the others open
    const d = dive(g, { open: ['cell:tools/logic'], focus: null }, 'domain:tools');
    expect(d.open).toEqual(['domain:tools']);
    const back = up(g, { ...d, focus: 'src/tools/web-search.ts' });
    expect(back.focus).toBe('cell:tools/logic');
    expect(back.open).toEqual(['cell:tools/entry', 'cell:tools/external'].filter((c) => g.nodes[c]));
  });

  it('jumps to a symbol by opening its cell and focusing its file', () => {
    const sym = Object.keys(g.nodes).find((id) => id.startsWith('src/memory/retrieve.ts#'))!;
    expect(jump(g, { open: [], focus: null }, sym)).toEqual({ open: ['cell:memory/logic'], focus: 'src/memory/retrieve.ts' });
    expect(jump(g, { open: ['domain:memory'], focus: null }, 'src/memory/retrieve.ts')).toEqual({ open: ['domain:memory'], focus: 'src/memory/retrieve.ts' });
  });
});
