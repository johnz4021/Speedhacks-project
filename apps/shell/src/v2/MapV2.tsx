// N0 spike renderer: React Flow viewport + DOM nodes, one SVG edge layer of precomputed paths, ELK per container
// in a worker, staged FLIP transitions and a van Wijk camera (React Flow's d3-zoom transition with interpolateZoom).
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider, ViewportPortal, useReactFlow, useStoreApi, type Node, type Viewport } from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import '@fontsource/barlow/300.css';
import '@fontsource/barlow/400-italic.css';
import '@fontsource/barlow/700.css';
import '@fontsource/jetbrains-mono/600.css';
import './v2.css';
import { domainId, type Rollup } from '@harness/core/view';
import { useView } from '../derive';
import { containerInputs, buildFrame, union, type Frame } from './layout/grid';
import { clearLayoutCache, layoutContainer, warmElk, type Box, type ContainerLayout } from './layout/containers';
import { nodeTypes, useLod } from './nodes';
import { fakeScene } from './spike/fakeProjection';
import { benchScene, bigCell } from './spike/benchScene';
import { useV2 } from './store';
import { Transitioner, reducedMotion, T_MOVE, type Enter, type TransitionStats } from './transition';
import type { Scene } from './scene';

const params = new URLSearchParams(location.search);
const BENCH = Number(params.get('bench') ?? 0);
export const COMP = params.has('comp');

const noop = () => {};

export type Insets = { top: number; right: number; bottom: number; left: number };
const DEFAULT_INSETS: Insets = { top: 64, right: 28, bottom: 28, left: 92 };

type Shown = { frame: Frame; enter: Enter };
type Stats = { layoutMs: number; elk: { id: string; files: number; ms: number }[]; transition: TransitionStats | null };

export default function MapV2({ insets = DEFAULT_INSETS }: { insets?: Insets }) {
  return (
    <ReactFlowProvider>
      <Inner insets={insets} />
    </ReactFlowProvider>
  );
}

function useScene(): Scene | null {
  const v = useView();
  const expanded = useV2((s) => s.expanded);
  return useMemo(() => (BENCH ? benchScene(BENCH, expanded) : fakeScene(v.ui, v.turn, expanded)), [v.ui, v.turn, expanded]);
}

function viewportFor(b: Box, W: number, H: number, ins: Insets, maxZoom = 1.3): Viewport {
  const aw = Math.max(50, W - ins.left - ins.right);
  const ah = Math.max(50, H - ins.top - ins.bottom);
  const zoom = Math.max(0.08, Math.min(maxZoom, aw / b.w, ah / b.h));
  return { zoom, x: ins.left + (aw - b.w * zoom) / 2 - b.x * zoom, y: ins.top + (ah - b.h * zoom) / 2 - b.y * zoom };
}

function Inner({ insets }: { insets: Insets }) {
  const scene = useScene();
  const rf = useReactFlow();
  const rootRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const stats = useRef<Stats>({ layoutMs: 0, elk: [], transition: null });
  const insetsRef = useRef(insets);
  insetsRef.current = insets;

  const camera = useCallback((next: Frame, prev: Frame | null, animate: boolean) => {
    if (prev && prev.key === next.key) return; // the camera moves only when the view changes, not on every event
    const el = rootRef.current;
    if (!el) return;
    const { width: W, height: H } = el.getBoundingClientRect();
    let vp = viewportFor(next.bounds, W, H, insetsRef.current);
    if (next.focus && vp.zoom < 0.62) vp = viewportFor(union(next.focus, { ...next.focus, x: next.focus.x - 120, w: next.focus.w + 240 }), W, H, insetsRef.current);
    void rf.setViewport(vp, { duration: animate ? T_MOVE : 0, interpolate: 'smooth' });
  }, [rf]);

  const tr = useMemo(() => new Transitioner({
    root: () => rootRef.current,
    commit: (frame, enter) => flushSync(() => {
      useV2.getState().publish(frame.scene);
      setShown({ frame, enter });
    }),
    camera,
  }), [camera]);

  // Lay out every expanded container (worker, cached), then hand the frame to the transitioner.
  useEffect(() => {
    if (!scene) return;
    let live = true;
    const key = useV2.getState().expanded.join(',');
    const t0 = performance.now();
    void Promise.all(containerInputs(scene).map(layoutContainer)).then((ls: ContainerLayout[]) => {
      if (!live) return;
      stats.current.layoutMs = performance.now() - t0;
      stats.current.elk = ls.map((l) => ({ id: l.id, files: Object.keys(l.nodes).length, ms: +l.ms.toFixed(1) }));
      tr.go(buildFrame(scene, new Map(ls.map((l) => [l.id, l])), key));
    });
    return () => { live = false; };
  }, [scene, tr]);

  useEffect(() => () => tr.cancel(), [tr]);
  useEffect(() => { void warmElk(); }, []);

  // Keyboard: Esc collapses the last expanded domain; Enter on a focused node (or header button) expands its domain.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('textarea, input')) return;
      const st = useV2.getState();
      if (e.key === 'Escape' && st.expanded.length) st.setExpanded(st.expanded.slice(0, -1));
      const nodeId = e.key === 'Enter' ? target?.closest<HTMLElement>('.react-flow__node')?.dataset.id : undefined;
      const domain = nodeId && st.nodes[nodeId]?.domain;
      if (domain && !st.expanded.includes(domainId(domain))) st.toggle(domainId(domain));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
      className: enter.nodes.has(n.id) ? 'v2-enter' : undefined,
    }));
  }, [shown]);

  const toggle = useV2((s) => s.toggle);
  const onNodeDoubleClick = useCallback((_: unknown, node: Node) => {
    const n = useV2.getState().nodes[node.id];
    if (n?.domain) toggle(domainId(n.domain));
  }, [toggle]);

  const theme = useV2((s) => s.theme);
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
        onNodeClick={noop /* React Flow only gives nodes pointer events when a click handler is set */}
        minZoom={0.08}
        maxZoom={2.5}
        proOptions={{ hideAttribution: COMP }}
        onlyRenderVisibleElements={params.get('visible') === '1'}
      >
        {theme === 'control' && <Background variant={BackgroundVariant.Dots} gap={28} size={1.3} color="var(--v2-dots)" />}
        {shown && (
          <ViewportPortal>
            <EdgeLayer frame={shown.frame} enter={shown.enter} />
            <Cursor frame={shown.frame} />
          </ViewportPortal>
        )}
      </ReactFlow>
      {shown && <Headers frame={shown.frame} insets={insets} />}
    </div>
  );
}

// ---------------------------------------------------------------- edges: one SVG of precomputed paths

const EdgeLayer = memo(function EdgeLayer({ frame, enter }: { frame: Frame; enter: Enter }) {
  const lod = useLod();
  return (
    <svg className="v2-edges" width={1} height={1}>
      <defs>
        {(['existing', 'new', 'ghost', 'violation'] as const).map((k) => (
          <marker key={k} id={`v2-arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 z" className={`v2-arrowhead is-${k}`} />
          </marker>
        ))}
      </defs>
      <path className="v2-ticks" d={frame.gutters.x.flatMap((x) => frame.gutters.y.map((y) => `M${x - 6},${y}h12M${x},${y - 6}v12`)).join('')} />
      {frame.edges.map((e) => {
        const kind = e.violation ? 'violation' : e.status;
        const entering = enter.edges.has(e.id);
        return (
          <g
            key={entering ? `${e.id}#${enter.seq}` : e.id}
            data-edge={e.id}
            className={`v2-edge is-${e.status} ${e.violation ? `is-violation is-violation-${e.violation}` : ''} ${entering ? 'is-enter' : ''}`}
          >
            <path className="v2-edge-line" d={e.d} markerEnd={`url(#v2-arrow-${kind})`} {...(entering && e.status !== 'ghost' ? { pathLength: 1 } : {})} />
            {lod !== 'far' && (e.count > 1 || e.steps.length > 0) && (
              <g className="v2-edge-tag" transform={`translate(${e.mid.x.toFixed(1)},${e.mid.y.toFixed(1)})`}>
                <rect x={-12} y={-9} width={24} height={18} rx={9} />
                <text textAnchor="middle" dy="0.35em">{e.steps.length ? e.steps.join(',') : e.count}</text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
});

function Cursor({ frame }: { frame: Frame }) {
  const c = useV2((s) => s.cursor);
  const b = c ? frame.boxes[c.node] : undefined;
  if (!c || !b) return null;
  const name = c.path.split('/').pop();
  return (
    <div className="v2-cursor" style={{ transform: `translate(${b.x + 10}px, ${b.y + b.h - 6}px)` }} aria-live="polite">
      <span className="v2-cursor-avatar" aria-hidden="true">C</span>
      <span className="v2-cursor-label">Claude · {c.verb} <code>{name}</code></span>
    </div>
  );
}

// ---------------------------------------------------------------- screen-space headers (crisp at any zoom)

function Headers({ frame, insets }: { frame: Frame; insets: Insets }) {
  const store = useStoreApi();
  const colRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const toggle = useV2((s) => s.toggle);
  const nodes = useV2((s) => s.nodes);

  useLayoutEffect(() => {
    const place = ([tx, ty, k]: [number, number, number]) => {
      frame.cols.forEach((c, i) => {
        const el = colRefs.current[i];
        if (!el) return;
        const w = c.spine ? Math.max(c.w * k, 120) : c.w * k;
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

  return (
    <div className="v2-headers" style={{ ['--hdr-h' as string]: `${insets.top - 12}px`, ['--lbl-w' as string]: `${insets.left - 12}px` }}>
      <div className="v2-colheads">
        {frame.cols.map((c, i) => {
          const r = nodes[domainId(c.id)]?.rollup;
          return (
            <button
              key={c.id}
              ref={(el) => { colRefs.current[i] = el; }}
              type="button"
              className={`v2-colhead ${c.spine ? 'is-spine' : ''} ${c.expanded ? 'is-expanded' : ''}`}
              onClick={() => toggle(domainId(c.id))}
              title={c.purpose}
              aria-expanded={c.expanded}
            >
              <span className="v2-colhead-title">
                <Ring cells={(frame.scene.grid.cells[c.id] ?? []).map((l) => nodes[`cell:${c.id}/${l}`]?.rollup)} />
                <span className="v2-colhead-name">{c.name}</span>
              </span>
              {c.expanded && <span className="v2-colhead-purpose">{c.purpose}</span>}
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

// ---------------------------------------------------------------- measurement hooks for the N0 bench (Playwright)

type Bench = {
  ready: () => boolean;
  count: () => number;
  stats: () => Stats & { reducedMotion: boolean };
  zoom: (ms?: number) => Promise<FrameStats>;
  toggle: (domain: string) => Promise<TransitionStats & { layoutMs: number }>;
  elkCell: (n: number) => Promise<{ files: number; edges: number; workerMs: number; roundTripMs: number }>;
  setTheme: (t: 'atlas' | 'control' | 'strata') => void;
  inputs: () => unknown;
  relayout: () => Promise<{ id: string; files: number; edges: number; ports: number; ms: number }[]>;
};
type FrameStats = { frames: number; fps: number; p50: number; p95: number; p99: number; max: number; domNodes: number };

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
      toggle: (domain) => new Promise((resolve) => {
        tr.onDone = (s) => {
          tr.onDone = null;
          resolve({ ...s, layoutMs: +stats.current.layoutMs.toFixed(1) });
        };
        useV2.getState().toggle(domain.startsWith('domain:') ? domain : `domain:${domain}`);
      }),
      elkCell: async (n) => {
        const c = bigCell(n);
        clearLayoutCache();
        const t0 = performance.now();
        const l = await layoutContainer(c);
        return { files: n, edges: c.edges.length, workerMs: +l.ms.toFixed(1), roundTripMs: +(performance.now() - t0).toFixed(1) };
      },
      setTheme: (theme) => useV2.setState({ theme }),
      inputs: () => (tr.shown ? containerInputs(tr.shown.scene) : []),
      relayout: async () => {
        clearLayoutCache();
        const out = [];
        for (const c of tr.shown ? containerInputs(tr.shown.scene) : []) {
          const l = await layoutContainer(c);
          out.push({ id: c.id, files: c.children.length, edges: c.edges.length, ports: c.ports.length, ms: +l.ms.toFixed(1) });
        }
        return out;
      },
    };
    (window as unknown as { __v2: Bench }).__v2 = api;
  }, [tr, stats, rf]);
}

