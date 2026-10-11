import { create } from 'zustand';
import type { VisibleNode } from '@harness/core/view';
import type { Scene } from './scene';

export type Theme = 'atlas' | 'control' | 'strata';
const params = new URLSearchParams(location.search);
const themeParam = params.get('theme');
export const initialTheme: Theme = themeParam === 'control' || themeParam === 'strata' ? themeParam : 'atlas';

/**
 * View-only state for the v2 map (expanded set, theme), plus the current projection's nodes published by id with
 * structural sharing, so each node component re-renders only when its own slice changes.
 */
type V2Store = {
  expanded: string[];
  theme: Theme;
  nodes: Record<string, VisibleNode>;
  preview: Record<string, string[]>;
  planned: Record<string, true>;
  rules: Record<string, string[]>;
  cursor: Scene['cursor'];
  setExpanded(e: string[]): void;
  toggle(id: string): void;
  publish(scene: Scene): void;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const useV2 = create<V2Store>((set, get) => ({
  expanded: (params.get('expand') ?? '').split(',').filter(Boolean).map((d) => (d.startsWith('domain:') ? d : `domain:${d}`)),
  theme: initialTheme,
  nodes: {},
  preview: {},
  planned: {},
  rules: {},
  cursor: null,
  setExpanded: (expanded) => set({ expanded }),
  toggle: (id) => set((s) => ({ expanded: s.expanded.includes(id) ? s.expanded.filter((x) => x !== id) : [...s.expanded, id] })),
  publish: (scene) => {
    const prev = get();
    const nodes: Record<string, VisibleNode> = {};
    for (const n of scene.projection.nodes) {
      const p = prev.nodes[n.id];
      nodes[n.id] = p && same(p, n) ? p : n;
    }
    const preview: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(scene.preview)) preview[k] = prev.preview[k] && same(prev.preview[k], v) ? prev.preview[k]! : v;
    set({
      nodes,
      preview,
      planned: Object.fromEntries(scene.planned.map((p) => [p, true as const])),
      rules: Object.fromEntries(Object.entries(scene.rules).map(([k, v]) => [k, prev.rules[k] && same(prev.rules[k], v) ? prev.rules[k]! : v])),
      cursor: same(prev.cursor, scene.cursor) ? prev.cursor : scene.cursor,
    });
  },
}));
