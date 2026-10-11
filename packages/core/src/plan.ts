import { withExtra, type Exists, type FactDelta, type ImportEdge } from './facts';
import { isRelative, normalizePath, resolveImport, resolvePath } from './imports';
import { createMapper, type Mapper } from './mapper';
import { check, type Violation } from './rules';
import type { DomainMap } from './schema';

/** One step of a `submit_plan` call. Import `to` is a repo path (extension optional) or a specifier relative to `from`. */
/** `symbols`: optional `path#qualified.name` ids the step changes or adds (drives symbol-level ghosts). */
export type PlanStep = { n: number; text: string; files: string[]; imports: { from: string; to: string }[]; symbols?: string[] };

export type PlanFootprint = {
  cells: { domain: string; layer: string; steps: number[]; files: string[] }[];
  tests: { domain: string; files: string[] }[];
  unassigned: string[];
  edges: { from: string; to: string; steps: number[]; imports: ImportEdge[] }[];
  delta: FactDelta;
  violations: Violation[];
};

/** Ghost footprint of a plan: the cells and tests it touches, its new cross-domain edges, and the violations its imports would cause. */
export function planFootprint(map: DomainMap, steps: PlanStep[], exists: Exists, mapper: Mapper = createMapper(map)): PlanFootprint {
  const norm = (p: string) => normalizePath(p) ?? p;
  const planned = withExtra(exists, steps.flatMap((s) => s.files));

  const cells = new Map<string, { domain: string; layer: string; steps: Set<number>; files: Set<string> }>();
  const tests = new Map<string, Set<string>>();
  const unassigned = new Set<string>();
  const edges = new Map<string, { from: string; to: string; steps: Set<number>; imports: ImportEdge[] }>();
  const imports: ImportEdge[] = [];
  const seen = new Set<string>();

  for (const step of steps) {
    const stepImports = step.imports.map((imp) => {
      const from = norm(imp.from);
      const to = (isRelative(imp.to) ? resolveImport(from, imp.to, planned) : resolvePath(imp.to, planned)) ?? norm(imp.to);
      return { from, to };
    });
    // A file that gains an import is edited by the step even if the step didn't list it.
    for (const file of new Set([...step.files.map(norm), ...stepImports.map((i) => i.from)])) {
      const p = mapper.place(file);
      if (p.kind === 'cell') {
        const key = `${p.domain}\u0000${p.layer}`;
        let cell = cells.get(key);
        if (!cell) cells.set(key, (cell = { domain: p.domain, layer: p.layer, steps: new Set(), files: new Set() }));
        cell.steps.add(step.n);
        cell.files.add(file);
      } else if (p.kind === 'test') {
        tests.set(p.domain, (tests.get(p.domain) ?? new Set()).add(file));
      } else if (p.kind === 'unassigned') unassigned.add(file);
    }
    for (const imp of stepImports) {
      const k = `${imp.from}\u0000${imp.to}`;
      if (!seen.has(k)) {
        seen.add(k);
        imports.push(imp);
      }
      const a = mapper.place(imp.from);
      const b = mapper.place(imp.to);
      if (a.kind !== 'cell' || b.kind !== 'cell' || a.domain === b.domain) continue;
      const key = `${a.domain}\u0000${b.domain}`;
      let edge = edges.get(key);
      if (!edge) edges.set(key, (edge = { from: a.domain, to: b.domain, steps: new Set(), imports: [] }));
      edge.steps.add(step.n);
      if (!edge.imports.some((i) => i.from === imp.from && i.to === imp.to)) edge.imports.push(imp);
    }
  }

  const domainIdx = (id: string) => map.domains.findIndex((d) => d.id === id);
  const layerIdx = (id: string) => map.layers.findIndex((l) => l.id === id);
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
  const delta: FactDelta = { imports, writes: [] };

  return {
    cells: [...cells.values()]
      .sort((a, b) => domainIdx(a.domain) - domainIdx(b.domain) || layerIdx(a.layer) - layerIdx(b.layer))
      .map((c) => ({ domain: c.domain, layer: c.layer, steps: sorted(c.steps), files: [...c.files] })),
    tests: [...tests].sort(([a], [b]) => domainIdx(a) - domainIdx(b)).map(([domain, files]) => ({ domain, files: [...files] })),
    unassigned: [...unassigned],
    edges: [...edges.values()].map((e) => ({ from: e.from, to: e.to, steps: sorted(e.steps), imports: e.imports })),
    delta,
    violations: check(map, delta, mapper),
  };
}
