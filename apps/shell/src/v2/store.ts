import { create } from 'zustand';
import type { ProjectionCursor, VisibleEdge, VisibleNode } from '@harness/core/view';

export type Theme = 'atlas' | 'control' | 'strata';
const params = new URLSearchParams(location.search);
const themeParam = params.get('theme');
export const initialTheme: Theme = themeParam === 'control' || themeParam === 'strata' ? themeParam : 'atlas';

/** Where you are: the containers you opened (domains, cells, groups) and the node you are on. View-only state. */
export type Place = { open: string[]; focus: string | null };

const readMinimap = () => {
  try { return localStorage.getItem('harness.minimap') !== '0'; } catch { return true; }
};

/**
 * View-only state for the v2 map: what is open, the focused node, history, chrome toggles. Plus the current
 * projection's nodes and edges published by id with structural sharing, so each node component re-renders only when
 * its own slice changes. Nothing here duplicates what the event log says.
 */
type V2Store = {
  open: string[];
  focus: string | null;
  back: Place[];
  forward: Place[];
  theme: Theme;
  minimap: boolean;
  palette: boolean;
  /** A node to fly the camera to once it is laid out (⌘K, breadcrumbs). */
  fly: string | null;
  nodes: Record<string, VisibleNode>;
  edges: Record<string, VisibleEdge>;
  hot: Record<string, string[]>;
  /** File id → how many of its symbols this turn changed. */
  symbols: Record<string, number>;
  cursor: ProjectionCursor | null;

  /** Navigate to a place (pushes history unless it is the same place). */
  go(next: Partial<Place>, fly?: string | null): void;
  setFocus(id: string | null): void;
  goBack(): void;
  goForward(): void;
  setPalette(open: boolean): void;
  toggleMinimap(): void;
  publish(p: { nodes: VisibleNode[]; edges: VisibleEdge[]; hot: Record<string, string[]>; symbols: Record<string, number>; cursor: ProjectionCursor | null }): void;
};

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const samePlace = (a: Place, b: Place) => a.focus === b.focus && a.open.join() === b.open.join();
const HISTORY = 50;

export const useV2 = create<V2Store>((set, get) => ({
  open: (params.get('expand') ?? '').split(',').filter(Boolean).map((d) => (d.includes(':') ? d : `domain:${d}`)),
  focus: null,
  back: [],
  forward: [],
  theme: initialTheme,
  minimap: readMinimap(),
  palette: false,
  fly: null,
  nodes: {},
  edges: {},
  hot: {},
  symbols: {},
  cursor: null,

  go: (next, fly = null) => {
    const s = get();
    const cur: Place = { open: s.open, focus: s.focus };
    const to: Place = { open: next.open ?? s.open, focus: next.focus === undefined ? s.focus : next.focus };
    if (samePlace(cur, to)) { if (fly) set({ fly }); return; }
    set({ ...to, back: [...s.back, cur].slice(-HISTORY), forward: [], fly });
  },
  setFocus: (focus) => set({ focus }),
  goBack: () => {
    const s = get();
    const prev = s.back.at(-1);
    if (!prev) return;
    set({ ...prev, back: s.back.slice(0, -1), forward: [{ open: s.open, focus: s.focus }, ...s.forward], fly: prev.focus });
  },
  goForward: () => {
    const s = get();
    const next = s.forward[0];
    if (!next) return;
    set({ ...next, forward: s.forward.slice(1), back: [...s.back, { open: s.open, focus: s.focus }], fly: next.focus });
  },
  setPalette: (palette) => set({ palette }),
  toggleMinimap: () => set((s) => {
    try { localStorage.setItem('harness.minimap', s.minimap ? '0' : '1'); } catch { /* private mode */ }
    return { minimap: !s.minimap };
  }),
  publish: (p) => {
    const prev = get();
    const nodes: Record<string, VisibleNode> = {};
    for (const n of p.nodes) {
      const o = prev.nodes[n.id];
      nodes[n.id] = o && same(o, n) ? o : n;
    }
    const edges: Record<string, VisibleEdge> = {};
    for (const e of p.edges) {
      const o = prev.edges[e.id];
      edges[e.id] = o && same(o, e) ? o : e;
    }
    const hot: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(p.hot)) hot[k] = prev.hot[k] && same(prev.hot[k], v) ? prev.hot[k]! : v;
    set({ nodes, edges, hot, symbols: same(prev.symbols, p.symbols) ? prev.symbols : p.symbols, cursor: same(prev.cursor, p.cursor) ? prev.cursor : p.cursor });
  },
}));
