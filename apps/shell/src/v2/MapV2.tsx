// The v2 map (N3/N4): the real pipeline (reduce → graphOf → activityFor → project), per-container ELK in a worker,
// the deterministic grid, one SVG layer of precomputed edges, staged FLIP transitions and a van Wijk camera, on a
// React Flow viewport with memoized DOM nodes. Navigation: expand in place, breadcrumbs, history, ⌘K, arrows, minimap.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Background, BackgroundVariant, MiniMap, ReactFlow, ReactFlowProvider, ViewportPortal, useReactFlow, useStore as useFlow, useStoreApi, type Node, type Viewport } from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import '@fontsource/barlow/300.css';
import '@fontsource/barlow/400-italic.css';
import '@fontsource/barlow/700.css';
import '@fontsource/jetbrains-mono/600.css';
import './v2.css';
import { fileOf, type Rollup } from '@harness/core/view';
import { useView } from '../derive';
import { useStore } from '../store';
import { buildFrame, GAP_X, layoutAll, strokeFor, union, UNASSIGNED, UNASSIGNED_COL, type Frame, type FrameEdge, type FrameNode } from './layout/frame';
import { clearLayoutCache, layoutContainer, warmElk } from './layout/elk';
import type { Box } from './layout/containers';
import { dive, neighbour, up, type Dir } from './nav';
import { NavBar } from './NavBar';
import { nodeTypes, useLod } from './nodes';
import { Palette } from './Palette';
import { hotLabels, useScene, type Scene } from './pipeline';
import { selectedEdge, selectedNode, selectionFor } from './select';
import { useV2 } from './store';
import { Transitioner, reducedMotion, T_MOVE, type Enter, type TransitionStats } from './transition';

const params = new URLSearchParams(location.search);
export const COMP = params.has('comp');

export type Insets = { top: number; right: number; bottom: number; left: number };
const DEFAULT_INSETS: Insets = { top: 116, right: 28, bottom: 24, left: 96 };

type Shown = { frame: Frame; enter: Enter };
type Stats = { layoutMs: number; pipelineMs: number; elk: { id: string; files: number; ms: number }[]; transition: TransitionStats | null };

export default function MapV2({ insets = DEFAULT_INSETS, chrome = true }: { insets?: Insets; chrome?: boolean }) {
  return (
    <ReactFlowProvider>
      <Inner insets={insets} chrome={chrome} />
    </ReactFlowProvider>
  );
}

/**
 * Fit a box, but never below `minZoom` (projector legibility: 16 px file labels stay at 13 px or more). When the box
 * does not fit at that zoom, centre on `anchor` (the agent, or the target) and keep the box's top-left in view.
 */
function viewportFor(b: Box, W: number, H: number, ins: Insets, opts: { maxZoom?: number; minZoom?: number; anchor?: Box } = {}): Viewport {
  const aw = Math.max(50, W - ins.left - ins.right);
  const ah = Math.max(50, H - ins.top - ins.bottom);
  const fit = Math.min(opts.maxZoom ?? 1.25, aw / b.w, ah / b.h);
  const zoom = Math.max(0.08, opts.minZoom ? Math.max(fit, opts.minZoom) : fit);
  if (zoom === fit || !opts.minZoom) return { zoom, x: ins.left + (aw - b.w * zoom) / 2 - b.x * zoom, y: ins.top + (ah - b.h * zoom) / 2 - b.y * zoom };
  const a = opts.anchor ?? b;
  const axis = (start: number, size: number, aStart: number, aSize: number, avail: number, inset: number) => {
    if (size * zoom <= avail) return inset + (avail - size * zoom) / 2 - start * zoom;
    const centred = inset + avail / 2 - (aStart + aSize / 2) * zoom;
    return Math.min(inset - start * zoom, Math.max(inset + avail - (start + size) * zoom, centred));
  };
  return { zoom, x: axis(b.x, b.w, a.x, a.w, aw, ins.left), y: axis(b.y, b.h, a.y, a.h, ah, ins.top) };
}

/** Zoom floor for views below System level (16 px file labels at 0.82 are about 13 px). */
const READABLE = 0.82;

/** Roots of the focus region: the selected node, else what is open, else everything (null). */
function regionOf(scene: Scene, sel: string | null): string[] | null {
  const ids = new Set(scene.projection.nodes.map((n) => n.id));
  if (sel && ids.has(sel)) return [sel];
  const open = scene.open.filter((id) => ids.has(id));
  if (open.length) return open;
  // A plan that declines an approach (beat 4): the struck-through edge leads; quiet edges recede to trunks.
  return scene.projection.edges.some((e) => e.decision) ? [] : null;
}

function Inner({ insets, chrome }: { insets: Insets; chrome: boolean }) {
  const scene = useScene();
  const v = useView();
  const rf = useReactFlow();
  const rootRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const stats = useRef<Stats>({ layoutMs: 0, pipelineMs: 0, elk: [], transition: null });
  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  const sel = useStore((s) => selectedNode(s.selection));
  const sceneRef = useSceneRef;
  sceneRef.current = scene;

  const flyTo = useCallback((b: Box, animate: boolean, opts?: Parameters<typeof viewportFor>[4]) => {
    const el = rootRef.current;
    if (!el) return;
    const { width: W, height: H } = el.getBoundingClientRect();
    if (!W || !H) return;
    const ins = insetsRef.current;
    const inspector = useStore.getState().selection ? 400 : 0; // the inspector panel covers the right of the stage
    void rf.setViewport(viewportFor(b, W, H, { ...ins, right: ins.right + inspector }, opts), { duration: animate && !reducedMotion() ? T_MOVE + 150 : 0, interpolate: "smooth" });
  }, [rf]);

  const camera = useCallback((next: Frame, prev: Frame | null, animate: boolean) => {
    const fly = useV2.getState().fly;
    const target = fly ? next.boxes[fly] : undefined;
    if (target) {
      useV2.setState({ fly: null });
      flyTo(pad(next.focus ? union(next.focus, target) : target, 30), animate, { minZoom: READABLE, anchor: pad(target, 40) });
      return;
    }
    if (prev && prev.key === next.key) return; // the camera moves when the view changes, not on every event
    if (!next.focus) return flyTo(next.bounds, animate);
    const c = useV2.getState().cursor;
    const at = c ? next.boxes[c.node] : undefined;
    const inFocus = !!at && at.x >= next.focus.x && at.x <= next.focus.x + next.focus.w;
    flyTo(pad(next.focus, 30), animate, { minZoom: READABLE, anchor: inFocus && at ? pad(at, 60) : { ...next.focus, h: 1 } });
  }, [flyTo]);

  const tr = useMemo(() => new Transitioner({
    root: () => rootRef.current,
    commit: (frame, enter) => flushSync(() => {
      const s = sceneRef.current;
      if (s) publish(s);
      setShown({ frame, enter });
    }),
    camera,
  }), [camera]);

  // Lay out every expanded container (worker, cached, bottom-up), then hand the frame to the transitioner.
  useEffect(() => {
    if (!scene || !v.ui.map) return;
    let live = true;
    const map = v.ui.map;
    const t0 = performance.now();
    void layoutAll(scene.projection, layoutContainer).then((layouts) => {
      if (!live) return;
      stats.current.layoutMs = performance.now() - t0;
      stats.current.elk = [...layouts.values()].map((l) => ({ id: l.id, files: Object.keys(l.nodes).length, ms: +l.ms.toFixed(1) }));
      const meta = { domains: map.domains.map((d) => ({ id: d.id, name: d.name, purpose: d.purpose })), layers: map.layers.map((l) => ({ id: l.id, name: l.name })) };
      tr.go(buildFrame({ projection: scene.projection, meta, layouts, region: regionOf(scene, sel), key: scene.key }));
    });
    return () => { live = false; };
  }, [scene, sel, tr, v.ui.map]);

  // A fly request for a node already on screen (history, breadcrumbs to the same layout).
  const fly = useV2((s) => s.fly);
  useEffect(() => {
    const f = tr.shown;
    if (!fly || !f?.boxes[fly] || f.key !== sceneRef.current?.key) return;
    useV2.setState({ fly: null });
    flyTo(pad(f.focus ? union(f.focus, f.boxes[fly]!) : f.boxes[fly]!, 30), true, { minZoom: READABLE, anchor: pad(f.boxes[fly]!, 40) });
  }, [fly, tr, flyTo, shown]);

  useEffect(() => () => tr.cancel(), [tr]);
  useEffect(() => { void warmElk(); }, []);
  useKeys(tr, rootRef);
  useBenchApi(tr, stats, rf);

  const rfNodes = useMemo<Node[]>(() => {
    if (!shown) return [];
    const { frame, enter } = shown;
    return frame.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: { x: n.x, y: n.y },
      data: {},
      width: n.w,
      height: n.h,
      style: { width: n.w, height: n.h },
      zIndex: n.z,
      draggable: false,
      selectable: false,
      connectable: false,
      focusable: n.type !== 'band',
      ariaLabel: ariaFor(n),
      className: enter.nodes.has(n.id) ? 'v2-enter' : undefined,
    }));
  }, [shown]);

  const select = useStore((s) => s.select);
  const onNodeClick = useCallback((ev: React.MouseEvent, node: Node) => {
    ev.stopPropagation();
    const n = useV2.getState().nodes[node.id];
    if (!n) return;
    useV2.getState().setFocus(node.id);
    const cur = useStore.getState().selection;
    select(selectedNode(cur) === node.id ? null : selectionFor(n));
  }, [select]);
  const onNodeDoubleClick = useCallback((_: unknown, node: Node) => {
    const s = sceneRef.current;
    if (!s) return;
    const st = useV2.getState();
    const id = node.id.startsWith('band:') ? UNASSIGNED : node.id;
    st.go(dive(s.graph, { open: st.open, focus: st.focus }, id));
  }, []);

  const theme = useV2((s) => s.theme);
  const minimap = useV2((s) => s.minimap);
  const open = useV2((s) => s.open);
  return (
    <div ref={rootRef} className={`v2-map theme-${theme}`} data-theme={theme}>
      <ReactFlow
        nodes={rfNodes}
        edges={[]}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnDoubleClick={false}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeClick={onNodeClick}
        onPaneClick={() => select(null)}
        minZoom={0.08}
        maxZoom={2.5}
        proOptions={{ hideAttribution: COMP }}
        onlyRenderVisibleElements={params.get('visible') === '1'}
      >
        {theme === 'control' && <Background variant={BackgroundVariant.Dots} gap={28} size={1.3} color="var(--v2-dots)" />}
        {shown && (
          <ViewportPortal>
            <EdgeLayer frame={shown.frame} enter={shown.enter} />
            <RejectedTop frame={shown.frame} />
            <Cursor frame={shown.frame} />
          </ViewportPortal>
        )}
        {chrome && minimap && open.length > 0 && (
          <MiniMap
            className="v2-minimap"
            style={{ width: 168, height: 108 }}
            pannable
            zoomable
            ariaLabel="Minimap"
            nodeColor={(n) => miniColor(n.id, n.type)}
            nodeStrokeWidth={0}
            maskColor="var(--v2-mini-mask)"
          />
        )}
      </ReactFlow>
      {shown && <Headers frame={shown.frame} insets={insets} />}
      {chrome && <NavBar />}
      {chrome && <Palette />}
      {!v.ui.map && <Empty />}
    </div>
  );
}

const pad = (b: Box, p: number): Box => ({ x: b.x - p, y: b.y - p, w: b.w + 2 * p, h: b.h + 2 * p });

function ariaFor(n: FrameNode): string {
  const vn = useV2.getState().nodes[n.id];
  if (!vn) return n.id;
  return `${vn.kind} ${vn.label}${vn.rollup.violation ? `, crosses ${vn.rollup.rules.join(' ')}` : ''}${vn.rollup.edited ? ', edited' : ''}`;
}

function miniColor(id: string, type: string | undefined): string {
  const n = useV2.getState().nodes[id];
  if (type === 'band') return 'var(--v2-mini-band)';
  if (!n) return 'var(--v2-mini-node)';
  const r = n.rollup;
  if (r.violation === 'new') return 'var(--v2-red)';
  if (r.cursor) return 'var(--v2-agent)';
  if (r.edited) return r.unplanned ? 'var(--v2-amber)' : 'var(--v2-agent)';
  if (r.violation) return 'var(--v2-red-wash)';
  return 'var(--v2-mini-node)';
}

/** Publish the projection by id (structural sharing) so node components re-render only for their own changes. */
function publish(s: Scene) {
  const symbols: Record<string, number> = {};
  for (const n of s.projection.nodes) {
    if (n.kind !== 'file') continue;
    const d = s.activity.leaves[n.id]?.symbols;
    const k = d ? new Set([...d.added, ...d.removed, ...d.sig, ...d.body, ...d.renamed.map((r) => r[1])]).size : 0;
    if (k) symbols[n.id] = k;
  }
  const columns: Record<string, string[]> = {};
  for (const n of s.projection.nodes) {
    const c = n.kind === 'table' ? s.graph.nodes[n.id]?.columns : undefined;
    if (c?.length) columns[n.id] = c;
  }
  useV2.getState().publish({ columns, nodes: s.projection.nodes, edges: s.projection.edges, hot: hotLabels(s.graph, s.activity, s.projection), symbols, cursor: s.projection.cursor });
}


// ---------------------------------------------------------------- keyboard: Enter dives, Esc goes up, arrows move, ⌘K, ⌘[ ⌘], m

function useKeys(tr: Transitioner, rootRef: React.RefObject<HTMLDivElement>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target?.closest('textarea, input, [contenteditable]');
      const st = useV2.getState();
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); st.setPalette(!st.palette); return; }
      if (typing || st.palette) return;
      if (meta && e.key === '[') { e.preventDefault(); st.goBack(); return; }
      if (meta && e.key === ']') { e.preventDefault(); st.goForward(); return; }
      if (meta || e.altKey) return;
      const scene = useSceneRef.current;
      if (!scene) return;
      const place = { open: st.open, focus: st.focus };
      if (e.key === 'Escape') {
        if (useStore.getState().selection) return; // the inspector closes first
        e.preventDefault();
        st.go(up(scene.graph, place));
      } else if (e.key === 'Enter') {
        const id = target?.closest<HTMLElement>('.react-flow__node')?.dataset.id ?? st.focus;
        if (!id) return;
        e.preventDefault();
        st.go(dive(scene.graph, place, id.startsWith('band:') ? UNASSIGNED : id));
      } else if (e.key.startsWith('Arrow')) {
        const f = tr.shown;
        if (!f) return;
        const dir = e.key.slice(5).toLowerCase() as Dir;
        const next = neighbour(f, st.focus, dir);
        if (!next) return;
        e.preventDefault();
        st.setFocus(next);
        rootRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(next)}"]`)?.focus({ preventScroll: true });
      } else if (e.key === 'm') st.toggleMinimap();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [tr, rootRef]);
}

/** The latest scene for event handlers outside React's render (keyboard, palette, headers). */
export const useSceneRef: { current: Scene | null } = { current: null };

// ---------------------------------------------------------------- edges: one SVG of precomputed paths

const EdgeLayer = memo(function EdgeLayer({ frame, enter }: { frame: Frame; enter: Enter }) {
  const lod = useLod();
  const sel = useStore((s) => selectedEdge(s.selection));
  const select = useStore((s) => s.select);
  return (
    <svg className="v2-edges" width={1} height={1}>
      <defs>
        {(['existing', 'new', 'ghost', 'violation', 'rejected'] as const).map((k) => (
          <marker key={k} id={`v2-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 z" className={`v2-arrowhead is-${k}`} />
          </marker>
        ))}
      </defs>
      <path className="v2-ticks" d={frame.gutters.x.flatMap((x) => frame.gutters.y.map((y) => `M${x - 6},${y}h12M${x},${y - 6}v12`)).join('')} />
      {frame.edges.map((e) => {
        if (e.decision) return <Rejected key={e.id} e={e} enter={enter} sel={sel} onSelect={() => select(sel === e.id ? null : { link: e.id })} />;
        const kind = e.violation ? 'violation' : e.status;
        const entering = enter.edges.has(e.id);
        const id = e.trunk ? e.trunk[0]! : e.id;
        return (
          <g
            key={entering ? `${e.id}#${enter.seq}` : e.id}
            data-edge={e.id}
            className={`v2-edge is-${e.status} ${e.violation ? `is-violation is-violation-${e.violation}` : ''} ${e.faint ? 'is-faint' : ''} ${e.trunk ? 'is-trunk' : ''} ${entering ? 'is-enter' : ''} ${sel === id ? 'is-selected' : ''}`}
            onClick={(ev) => { ev.stopPropagation(); select(sel === id ? null : { link: id }); }}
          >
            <title>{e.trunk ? `${e.count} imports between these columns` : `${e.count} ${e.count === 1 ? 'link' : 'links'}`}</title>
            <path className="v2-edge-hit" d={e.d} />
            <path
              className="v2-edge-line"
              d={e.d}
              style={{ strokeWidth: e.faint ? undefined : strokeFor(e.count) }}
              markerEnd={e.trunk ? undefined : `url(#v2-arrow-${kind})`}
              {...(entering && e.status !== 'ghost' ? { pathLength: 1 } : {})}
            />
            {enter.pulse.has(e.id) && !reducedMotion() && <Pulse key={enter.seq} d={e.d} />}
            {lod !== 'far' && (e.count > 1 || e.steps.length > 0) && (
              <g className="v2-edge-tag" transform={`translate(${e.mid.x.toFixed(1)},${e.mid.y.toFixed(1)})`}>
                <rect x={-13} y={-10} width={26} height={20} rx={10} />
                <text textAnchor="middle" dy="0.35em">{e.steps.length ? e.steps.join(',') : e.count}</text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
});

export const rejectedLabel = (d: { id: string; session: number }) => `rejected in ${d.id}${d.session ? `, session ${d.session}` : ''}`;

/**
 * Beat 4's hero: an approach a standing decision rules out. Drawn struck through in ink (not red: nothing is being
 * crossed, it is being declined), with a slash across its middle and a label that stays readable at any zoom.
 */
function Rejected({ e, enter, sel, onSelect }: { e: FrameEdge; enter: Enter; sel: string | null; onSelect: () => void }) {
  return (
    <g data-edge={e.id} className={`v2-edge is-rejected ${enter.edges.has(e.id) ? 'is-enter' : ''} ${sel === e.id ? 'is-selected' : ''}`} onClick={(ev) => { ev.stopPropagation(); onSelect(); }}>
      <title>{`${rejectedLabel(e.decision!)}: ${e.count} planned ${e.count === 1 ? 'link' : 'links'} not built`}</title>
      <path className="v2-edge-hit" d={e.d} />
      <path className="v2-edge-line" d={e.d} markerEnd="url(#v2-arrow-rejected)" />
    </g>
  );
}

/** The strike and the label of rejected edges, above the nodes and at a constant on-screen size (about 15 px). */
function RejectedTop({ frame }: { frame: Frame }) {
  const k = useFlow((s) => s.transform[2]);
  const sel = useStore((s) => selectedEdge(s.selection));
  const select = useStore((s) => s.select);
  const list = frame.edges.filter((e) => e.decision);
  if (!list.length) return null;
  const z = 1 / Math.max(k, 0.2);
  return (
    <svg className="v2-edges is-top" width={1} height={1}>
      {list.map((e) => {
        const label = rejectedLabel(e.decision!);
        const fs = 15 * z;
        const w = label.length * fs * 0.5 + 24 * z;
        const h = 28 * z;
        const s = 10 * z;
        const { x, y } = e.mid;
        return (
          <g key={e.id} className={`v2-rejected ${sel === e.id ? 'is-selected' : ''}`} onClick={(ev) => { ev.stopPropagation(); select(sel === e.id ? null : { link: e.id }); }}>
            <path className="v2-strike" d={`M${x - s},${y + s}L${x + s},${y - s}M${x - s + 7 * z},${y + s}L${x + s + 7 * z},${y - s}`} style={{ strokeWidth: 3.5 * z }} />
            <g transform={`translate(${(x - w / 2).toFixed(1)},${(y - h - 14 * z).toFixed(1)})`} className="v2-rejected-tag">
              <rect width={w} height={h} rx={h / 2} />
              <text x={w / 2} y={h / 2} dy="0.35em" textAnchor="middle" style={{ fontSize: fs }}>{label}</text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}

/** One dot that travels once along an edge that was just added (never loops). */
function Pulse({ d }: { d: string }) {
  const ref = useRef<SVGCircleElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    const len = path.getTotalLength();
    const t0 = performance.now() + 320; // after the draw-in starts
    let raf = 0;
    const step = (t: number) => {
      const k = Math.max(0, Math.min(1, (t - t0) / 900));
      const p = path.getPointAtLength(len * (1 - (1 - k) ** 2));
      c.setAttribute('cx', p.x.toFixed(1));
      c.setAttribute('cy', p.y.toFixed(1));
      c.style.opacity = String(k < 0.85 ? 1 : (1 - k) / 0.15);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [d]);
  return <circle ref={ref} className="v2-pulse" r={5} cx={-9999} cy={-9999} />;
}

function Cursor({ frame }: { frame: Frame }) {
  const c = useV2((s) => s.cursor);
  const ui = useView().ui;
  const b = c ? frame.boxes[c.node] : undefined;
  if (!c || !b) return null;
  const path = fileOf(c.leaf) ?? ui.cursor?.path ?? c.leaf;
  const name = path.split('/').filter(Boolean).pop();
  const inBox = b.h > 60 && b.w > 120;
  return (
    <div className="v2-cursor" style={{ transform: `translate(${b.x + (inBox ? 10 : -6)}px, ${b.y + b.h - (inBox ? 12 : 0)}px)` }} aria-live="polite">
      <span className="v2-cursor-avatar" aria-hidden="true">C</span>
      <span className="v2-cursor-label">Claude · {c.verb} <code>{name}</code></span>
    </div>
  );
}

function Empty() {
  const conn = useStore((s) => s.conn);
  return (
    <div className="v2-empty">
      <p className="v2-empty-title">{conn === 'down' ? 'Waiting for the Interpretability server' : 'Reading the repo'}</p>
      <p>{conn === 'down' ? 'Start it with HARNESS_REPO=<path> npm run dev. This page reconnects on its own.' : 'The map appears once domains.yaml is loaded or proposed.'}</p>
    </div>
  );
}

// ---------------------------------------------------------------- screen-space headers (crisp at any zoom)

function Headers({ frame, insets }: { frame: Frame; insets: Insets }) {
  const store = useStoreApi();
  const colRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const nodes = useV2((s) => s.nodes);

  useLayoutEffect(() => {
    const place = ([tx, ty, k]: [number, number, number]) => {
      frame.cols.forEach((c, i) => {
        const el = colRefs.current[i];
        if (!el) return;
        const w = c.spine ? (c.w + GAP_X) * k - 6 : c.w * k;
        el.style.transform = `translate(${(tx + (c.x + c.w / 2) * k - w / 2).toFixed(1)}px, 0)`;
        el.style.width = `${w.toFixed(1)}px`;
      });
      frame.rows.forEach((r, j) => {
        const el = rowRefs.current[j];
        if (!el) return;
        el.style.transform = `translate(0, ${(ty + r.y * k).toFixed(1)}px)`;
        el.style.height = `${(r.h * k).toFixed(1)}px`;
      });
    };
    place(store.getState().transform);
    return store.subscribe((s, p) => { if (s.transform !== p.transform) place(s.transform); });
  }, [frame, store]);

  const toggle = (col: string) => {
    const scene = useSceneRef.current;
    if (!scene) return;
    const st = useV2.getState();
    st.go(dive(scene.graph, { open: st.open, focus: st.focus }, col === UNASSIGNED_COL ? UNASSIGNED : `domain:${col}`));
  };

  return (
    <div className="v2-headers" style={{ ['--hdr-h' as string]: `${insets.top - 56}px`, ['--lbl-w' as string]: `${insets.left - 12}px` }}>
      <div className="v2-colheads">
        {frame.cols.map((c, i) => {
          const r = nodes[c.id === UNASSIGNED_COL ? UNASSIGNED : `domain:${c.id}`]?.rollup;
          const cellRollups = frame.nodes.filter((n) => n.id.startsWith(`cell:${c.id}/`)).map((n) => nodes[n.id]?.rollup);
          return (
            <button
              key={c.id}
              ref={(el) => { colRefs.current[i] = el; }}
              type="button"
              className={`v2-colhead ${c.spine ? 'is-spine' : ''} ${c.open ? 'is-expanded' : ''} ${c.id === UNASSIGNED_COL ? 'is-unassigned' : ''}`}
              onClick={() => toggle(c.id)}
              title={`${c.purpose}\n${c.open ? 'Click to close' : 'Click to open'}`}
              aria-expanded={c.open}
            >
              <span className="v2-colhead-title">
                <Ring cells={cellRollups} />
                <span className="v2-colhead-name">{c.name}</span>
              </span>
              {c.open && <span className="v2-colhead-purpose">{c.purpose}</span>}
              {r && (r.violation || r.edited || r.ghostSteps.length > 0) && (
                <span className="v2-colhead-marks" aria-hidden="true">
                  {r.edited && <i className={r.unplanned ? 'is-unplanned' : 'is-edited'} />}
                  {r.ghostSteps.length > 0 && <i className="is-ghost" />}
                  {r.violation && <i className={`is-${r.violation}-violation`} />}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="v2-rowheads">
        {frame.rows.map((r, j) => (
          <div key={r.id} ref={(el) => { rowRefs.current[j] = el; }} className="v2-rowhead">
            <span>{r.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Control Room: a static ring per domain showing the state mix of its cells (no motion). */
function Ring({ cells }: { cells: (Rollup | undefined)[] }) {
  const parts: [string, number][] = [
    ['var(--v2-red)', cells.filter((r) => r?.violation).length],
    ['var(--v2-amber)', cells.filter((r) => r?.unplanned).length],
    ['var(--v2-agent)', cells.filter((r) => r && r.edited && !r.unplanned && !r.violation).length],
    ['color-mix(in srgb, var(--v2-agent) 45%, transparent)', cells.filter((r) => r && !r.edited && !r.violation && (r.looked || r.ghostSteps.length > 0)).length],
  ];
  const total = Math.max(1, cells.length);
  let at = 0;
  const stops = parts.filter(([, n]) => n > 0).map(([color, n]) => {
    const from = (at / total) * 360;
    at += n;
    return `${color} ${from}deg ${(at / total) * 360}deg`;
  });
  stops.push(`var(--v2-line) ${(at / total) * 360}deg 360deg`);
  return <span className="v2-ring" aria-hidden="true" style={{ background: `conic-gradient(${stops.join(', ')})` }} />;
}

// ---------------------------------------------------------------- measurement hooks (Playwright)

type FrameStats = { frames: number; fps: number; p50: number; p95: number; p99: number; max: number; domNodes: number };
type Bench = {
  ready: () => boolean;
  count: () => number;
  frame: () => { nodes: number; edges: number; key: string } | null;
  stats: () => Stats & { reducedMotion: boolean };
  zoom: (ms?: number) => Promise<FrameStats>;
  toggle: (id: string) => Promise<TransitionStats & { layoutMs: number }>;
  relayout: () => Promise<number>;
};

function measureFrames(ms: number, step: (p: number) => void): Promise<FrameStats> {
  return new Promise((resolve) => {
    const times: number[] = [];
    const t0 = performance.now();
    const frame = (t: number) => {
      times.push(t);
      const p = Math.min(1, (t - t0) / ms);
      step(p);
      if (p < 1) requestAnimationFrame(frame);
      else {
        const dts = times.slice(1).map((x, i) => x - times[i]!).sort((a, b) => a - b);
        const q = (f: number) => +dts[Math.min(dts.length - 1, Math.floor(dts.length * f))]!.toFixed(2);
        resolve({ frames: times.length, fps: +((1000 * (times.length - 1)) / (times.at(-1)! - times[0]!)).toFixed(1), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1), domNodes: document.querySelectorAll('.react-flow__node').length });
      }
    };
    requestAnimationFrame(frame);
  });
}

function useBenchApi(tr: Transitioner, stats: React.MutableRefObject<Stats>, rf: ReturnType<typeof useReactFlow>) {
  useEffect(() => {
    const api: Bench = {
      ready: () => !!tr.shown,
      count: () => document.querySelectorAll('.react-flow__node').length,
      frame: () => (tr.shown ? { nodes: tr.shown.nodes.length, edges: tr.shown.edges.length, key: tr.shown.key } : null),
      stats: () => ({ ...stats.current, transition: tr.last, reducedMotion: reducedMotion() }),
      zoom: (ms = 3000) => {
        const b = tr.shown!.bounds;
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        const el = document.querySelector('.v2-map')!.getBoundingClientRect();
        return measureFrames(ms, (p) => {
          const z = 0.2 + 1.2 * Math.sin(p * Math.PI); // far → near → far, crossing every LOD bucket twice
          void rf.setViewport({ zoom: z, x: el.width / 2 - (cx + (p - 0.5) * b.w * 0.4) * z, y: el.height / 2 - cy * z });
        });
      },
      toggle: (id) => new Promise((resolve) => {
        tr.onDone = (s) => {
          tr.onDone = null;
          resolve({ ...s, layoutMs: +stats.current.layoutMs.toFixed(1) });
        };
        const scene = useSceneRef.current!;
        const st = useV2.getState();
        st.go(dive(scene.graph, { open: st.open, focus: st.focus }, id.includes(':') ? id : `domain:${id}`));
      }),
      relayout: async () => { clearLayoutCache(); return 0; },
    };
    (window as unknown as { __v2: Bench }).__v2 = api;
  }, [tr, stats, rf]);
}
