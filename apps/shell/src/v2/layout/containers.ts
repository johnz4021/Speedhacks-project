// Per-container ELK layout: one layered run per expanded cell, in a worker, cached by the container's content.
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import type { Port } from '@harness/core/view';

export type Pt = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };

/** Fixed sizes per kind (layout never depends on zoom or content, so positions stay put). */
export const FILE_W = 220;
export const FILE_H = 42;
export const PAD = { top: 44, left: 18, right: 18, bottom: 18 };

export type ContainerInput = {
  id: string;
  children: string[]; // sorted by model order
  edges: { id: string; from: string; to: string }[];
  ports: (Port & { node: string })[]; // node = the child the edge attaches to
};

export type ContainerLayout = {
  id: string;
  w: number;
  h: number;
  nodes: Record<string, Box>; // relative to the container
  edges: Record<string, Pt[]>; // internal edges, relative
  ports: Record<string, { at: Pt; route: Pt[] }>; // by `${edge}|${container}`: border point + route from/to the child
  ms: number;
};

const ELK_SIDE = { top: 'NORTH', right: 'EAST', bottom: 'SOUTH', left: 'WEST' } as const;
/**
 * The side a port sits on is the renderer's call (it depends on the layout): toward the other column when it is to the
 * left or right; for the same column, out on the right and in on the left, so ELK keeps a left-to-right flow
 * (north/south ports in a rightward layered layout cost a layer each: Scout's External cell went from 244 to 1126 px).
 */
export function portSide(p: Pick<Port, 'side' | 'direction'>): Port['side'] {
  if (p.side === 'left' || p.side === 'right') return p.side;
  return p.direction === 'out' ? 'right' : 'left';
}
export const portKey = (edge: string, container: string) => `${edge}|${container}`;

export function elkGraph(c: ContainerInput): ElkNode {
  const edges: ElkExtendedEdge[] = c.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] }));
  const ports = c.ports.map((p, i) => {
    const pid = `port:${i}`;
    edges.push(p.direction === 'out' ? { id: `pe:${i}`, sources: [p.node], targets: [pid] } : { id: `pe:${i}`, sources: [pid], targets: [p.node] });
    return { id: pid, width: 2, height: 2, layoutOptions: { 'elk.port.side': ELK_SIDE[portSide(p)], 'elk.port.index': String(i) } };
  });
  // The container is wrapped in a root so its ports are real external ports (ELK rejects edges to the root's own ports).
  const node: ElkNode = {
    id: c.id,
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.randomSeed': '1',
      'elk.portConstraints': 'FIXED_SIDE',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      // Model order as a tie-break only: forcing it cost 2.6× on a 300-file cell (247 → 93 ms in node) for little
      // extra stability; big containers also drop crossing-minimisation thoroughness (7 → 3).
      'elk.layered.crossingMinimization.forceNodeModelOrder': 'false',
      'elk.layered.thoroughness': c.children.length > 100 ? '3' : '7',
      'elk.padding': `[top=${PAD.top},left=${PAD.left},bottom=${PAD.bottom},right=${PAD.right}]`,
      'elk.spacing.nodeNode': '12',
      'elk.spacing.componentComponent': '14',
      'elk.layered.spacing.nodeNodeBetweenLayers': '44',
      'elk.layered.spacing.edgeNodeBetweenLayers': '14',
      'elk.spacing.edgeEdge': '8',
      'elk.aspectRatio': '1.4',
    },
    ports,
    children: c.children.map((id) => ({ id, width: FILE_W, height: FILE_H })),
    edges,
  };
  return { id: `root:${c.id}`, layoutOptions: { 'elk.algorithm': 'layered', 'elk.padding': '[top=0,left=0,bottom=0,right=0]' }, children: [node] };
}

function sectionPoints(e: ElkExtendedEdge): Pt[] {
  const s = e.sections?.[0];
  if (!s) return [];
  return [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => ({ x: p.x, y: p.y }));
}

export function readLayout(c: ContainerInput, root: ElkNode, ms: number): ContainerLayout {
  const out = root.children?.[0] ?? root;
  const nodes: ContainerLayout['nodes'] = {};
  for (const n of out.children ?? []) nodes[n.id] = { x: n.x ?? 0, y: n.y ?? 0, w: n.width ?? FILE_W, h: n.height ?? FILE_H };
  const edges: ContainerLayout['edges'] = {};
  const ports: ContainerLayout['ports'] = {};
  const portAt = new Map((out.ports ?? []).map((p) => [p.id, { x: (p.x ?? 0) + (p.width ?? 0) / 2, y: (p.y ?? 0) + (p.height ?? 0) / 2 }]));
  for (const e of out.edges ?? []) {
    if (e.id.startsWith('pe:')) {
      const i = Number(e.id.slice(3));
      const p = c.ports[i]!;
      const at = portAt.get(`port:${i}`) ?? { x: 0, y: 0 };
      ports[portKey(p.edge, c.id)] = { at, route: sectionPoints(e) };
    } else edges[e.id] = sectionPoints(e);
  }
  return { id: c.id, w: out.width ?? 0, h: out.height ?? 0, nodes, edges, ports, ms };
}

// ---------------------------------------------------------------- worker client

// elkjs's own worker script, loaded only on the first layout (the v1 map never pulls it in).
type ElkApi = { layout(g: ElkNode): Promise<ElkNode> };
let elk: Promise<ElkApi> | null = null;
const cache = new Map<string, ContainerLayout>();

function getElk(): Promise<ElkApi> {
  elk ??= Promise.all([import('elkjs/lib/elk-api.js'), import('elkjs/lib/elk-worker.min.js?url')]).then(([api, url]) => {
    const ELK = api.default;
    return new ELK({ workerFactory: () => new Worker(url.default) }) as unknown as ElkApi;
  });
  return elk;
}

/** Cached by the container's children, edges and ports (and the elkjs version, via the bundle). `ms` is the worker round trip. */
export async function layoutContainer(c: ContainerInput): Promise<ContainerLayout> {
  const key = JSON.stringify(c);
  const hit = cache.get(key);
  if (hit) return hit;
  const api = await getElk();
  const t0 = performance.now();
  const out = await api.layout(elkGraph(c));
  const l = readLayout(c, out, performance.now() - t0);
  cache.set(key, l);
  return l;
}

export const clearLayoutCache = () => cache.clear();

/** Boot the worker and JIT ELK before the first expand (the cold first layout took ~160 ms on the M1). */
export const warmElk = () => getElk().then((api) => api.layout({ id: 'warm', layoutOptions: { 'elk.algorithm': 'layered' }, children: [{ id: 'a', width: 10, height: 10 }, { id: 'b', width: 10, height: 10 }], edges: [{ id: 'e', sources: ['a'], targets: ['b'] }] } as ElkNode));
