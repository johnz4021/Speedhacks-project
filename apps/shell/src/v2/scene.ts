import type { Projection } from '@harness/core/view';

/** The fixed grid the projection is drawn on: domain columns × layer rows (from domains.yaml). */
export type GridSpec = {
  domains: { id: string; name: string; purpose: string }[];
  layers: { id: string; name: string }[];
  /** domain id → layer ids that have a cell */
  cells: Record<string, string[]>;
};

/** Everything the v2 renderer draws. `projection` is the contract type; the rest is what it lacks today (see report). */
export type Scene = {
  grid: GridSpec;
  projection: Projection;
  cursor: { node: string; verb: string; path: string } | null;
  /** Collapsed node id → labels of its first children, for the near level of detail. */
  preview: Record<string, string[]>;
  /** File ids that do not exist yet (planned new files): drawn as ghosts. */
  planned: string[];
  /** Node id → invariant ids it crosses (Rollup only says how badly, not which rule). */
  rules: Record<string, string[]>;
};

export const DOMAIN = 'domain:';
export const CELL = 'cell:';
export const domainOf = (id: string) => id.slice(DOMAIN.length);
