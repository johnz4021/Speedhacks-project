// Per-container ELK layout (NAVIGATION_PLAN §3.3): one layered run per expanded container, bottom-up (an open group
// is laid out first and enters its cell's run as a fixed-size node with fixed ports), cached by the container's input.
// The ELK instance is injected: the browser uses elkjs's worker, tests use the bundled build in node.
import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api';

export type Pt = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number };
export type Side = 'top' | 'right' | 'bottom' | 'left';

/** Fixed sizes per kind (layout never depends on zoom or text, so positions stay put). */
export const SIZE = {
  file: { w: 220, h: 42 },
  chip: { w: 220, h: 34 }, // tables, vendors, routes
  group: { w: 220, h: 50 }, // a collapsed group
} as const;
export const PAD = { top: 46, left: 18, right: 18, bottom: 18 };

export type ChildSpec = { id: string; w: number; h: number; ports: { id: string; at: Pt; side: Side }[] };
export type ContainerInput = {
  id: string;
  children: ChildSpec[]; // sorted by model order
  edges: { id: string; from: string; to: string }[]; // child ids, or a child's port id
  /** Edges leaving (out) or entering (in) this container; `node` is the child (or child port) inside it. */
  ports: { key: string; edge: string; node: string; side: Side; direction: 'out' | 'in' }[];
};

export type ContainerLayout = {
  id: string;
  w: number;
  h: number;
  nodes: Record<string, Box>; // relative to the container
  /** Every route this container draws, by projection edge id, in edge direction (child → port for out, port → child for in). */
  edges: Record<string, Pt[]>;
  ports: Record<string, { at: Pt; side: Side }>; // by port key, relative to the container
  ms: number;
};

export const portKey = (edge: string, container: string) => `${edge}|${container}`;

const ELK_SIDE = { top: 'NORTH', right: 'EAST', bottom: 'SOUTH', left: 'WEST' } as const;

export function elkGraph(c: ContainerInput): ElkNode {
  const edges: ElkExtendedEdge[] = c.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] }));
  const ports: ElkPort[] = c.ports.map((p, i) => {
    edges.push(p.direction === 'out' ? { id: `pe:${i}`, sources: [p.node], targets: [p.key] } : { id: `pe:${i}`, sources: [p.key], targets: [p.node] });
    return { id: p.key, width: 2, height: 2, layoutOptions: { 'elk.port.side': ELK_SIDE[p.side], 'elk.port.index': String(i) } };
  });
  const node: ElkNode = {
    id: c.id,
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.randomSeed': '1',
      'elk.portConstraints': 'FIXED_SIDE',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      // Model order as a tie-break only: forcing it cost 2.6× on a 300-file cell for little extra stability.
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
    children: c.children.map((ch) => ({
      id: ch.id,
      width: ch.w,
      height: ch.h,
      ...(ch.ports.length
        ? {
            layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
            ports: ch.ports.map((p) => ({ id: p.id, x: p.at.x - 1, y: p.at.y - 1, width: 2, height: 2, layoutOptions: { 'elk.port.side': ELK_SIDE[p.side] } })),
          }
        : {}),
    })),
    edges,
  };
  // Wrapped in a root so the container's ports are real external ports (ELK rejects edges to the root's own ports).
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
  for (const n of out.children ?? []) nodes[n.id] = { x: n.x ?? 0, y: n.y ?? 0, w: n.width ?? 0, h: n.height ?? 0 };
  const edges: ContainerLayout['edges'] = {};
  const ports: ContainerLayout['ports'] = {};
  const portAt = new Map((out.ports ?? []).map((p) => [p.id, { x: (p.x ?? 0) + (p.width ?? 0) / 2, y: (p.y ?? 0) + (p.height ?? 0) / 2 }]));
  const w = out.width ?? 0;
  const h = out.height ?? 0;
  for (const p of c.ports) {
    const at = portAt.get(p.key) ?? { x: p.side === 'left' ? 0 : w, y: h / 2 };
    // snap to the border on the declared side (ELK centres a 2 px port on it)
    if (p.side === 'left') at.x = 0;
    if (p.side === 'right') at.x = w;
    if (p.side === 'top') at.y = 0;
    if (p.side === 'bottom') at.y = h;
    ports[p.key] = { at, side: p.side };
  }
  for (const e of out.edges ?? []) {
    if (e.id.startsWith('pe:')) {
      const p = c.ports[Number(e.id.slice(3))]!;
      const pts = sectionPoints(e);
      const at = ports[p.key]!.at;
      if (pts.length) pts[p.direction === 'out' ? pts.length - 1 : 0] = { ...at };
      edges[p.edge] = pts;
    } else edges[e.id] = sectionPoints(e);
  }
  return { id: c.id, w, h, nodes, edges, ports, ms };
}

export type ElkApi = { layout(g: ElkNode): Promise<ElkNode> };
export type LayoutFn = (c: ContainerInput) => Promise<ContainerLayout>;

/** A layout function over an ELK instance, cached by the container's whole input (children, sizes, edges, ports). */
export function cachedLayout(getElk: () => Promise<ElkApi>, cache = new Map<string, ContainerLayout>()): LayoutFn & { cache: Map<string, ContainerLayout> } {
  const fn = async (c: ContainerInput) => {
    const key = JSON.stringify(c);
    const hit = cache.get(key);
    if (hit) return hit;
    const api = await getElk();
    const t0 = performance.now();
    const out = await api.layout(elkGraph(c));
    const l = readLayout(c, out, performance.now() - t0);
    cache.set(key, l);
    return l;
  };
  return Object.assign(fn, { cache });
}
