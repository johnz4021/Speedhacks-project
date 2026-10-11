// Dev only. A synthetic 500-file repo as a real event log (map_confirmed + repo_scanned with Tier 1 facts), so the
// v2 renderer can be measured through the whole pipeline (reduce → graphOf → activityFor → project → ELK → React Flow):
//   npx tsx apps/shell/scripts/bench-events.ts [files]   →  /?fake=bench, then window.__v2.zoom() / .toggle('d0')
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DomainMap, FileFacts, HarnessEvent } from '@harness/core/view';

const here = dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2] ?? 500);
let seed = 7;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

const LAYERS = ['ui', 'entry', 'logic', 'data', 'external'];
const NAMES = ['Channels', 'Agent loop', 'Research tools', 'Model gateway', 'Memory', 'Outreach'];
const map = {
  version: 1,
  layers: LAYERS.map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1) })),
  neutral: [],
  ignore: [],
  domains: NAMES.map((name, i) => ({ id: `d${i}`, name, purpose: 'Synthetic', cells: Object.fromEntries(LAYERS.map((l) => [l, { paths: [`src/d${i}/${l}/**`] }])) })),
  invariants: [],
} as unknown as DomainMap;

const files: { path: string; d: number; l: number }[] = [];
for (let i = 0; i < N; i++) {
  const d = i % 3;
  const l = Math.floor(rnd() * LAYERS.length);
  files.push({ path: `src/d${d}/${LAYERS[l]}/f${String(i).padStart(4, '0')}.ts`, d, l });
}
for (let i = 0; i < 60; i++) files.push({ path: `src/d${3 + (i % 3)}/${LAYERS[i % 5]}/o${i}.ts`, d: 3 + (i % 3), l: i % 5 });
files.sort((a, b) => a.path.localeCompare(b.path));

const facts: FileFacts[] = files.map((f) => {
  const imports = new Set<string>();
  const k = 1 + Math.floor(rnd() * 2);
  for (let j = 0; j < k; j++) {
    // mostly inside the same cell, sometimes another cell or domain
    const r = rnd();
    const pool = r < 0.7 ? files.filter((g) => g.d === f.d && g.l === f.l) : r < 0.9 ? files.filter((g) => g.d === f.d) : files;
    const t = pool[Math.floor(rnd() * pool.length)]!;
    if (t.path !== f.path) imports.add(t.path);
  }
  return { path: f.path, hash: `h${f.path}`, imports: [...imports].map((to) => ({ to, typeOnly: false })), writes: [], symbols: [], calls: [], routes: [], entries: [] };
});

// cross-domain imports are recorded as domain edges (the reducer's `edges`, which graphFacts follows)
const domainOf = new Map(files.map((f) => [f.path, `d${f.d}`]));
const edges = new Map<string, { from: string; to: string; files: { from: string; to: string }[] }>();
for (const f of facts) {
  for (const i of f.imports) {
    const a = domainOf.get(f.path)!;
    const b = domainOf.get(i.to)!;
    if (a === b) continue;
    const e = edges.get(`${a}->${b}`) ?? { from: a, to: b, files: [] };
    e.files.push({ from: f.path, to: i.to });
    edges.set(`${a}->${b}`, e);
  }
}

const ev = (n: number, kind: HarnessEvent['kind'], data: Record<string, unknown>): HarnessEvent => ({ id: `bench-${n}`, t: 1000 + n, session: 'bench', turn: null, kind, data });
const out: HarnessEvent[] = [
  ev(0, 'map_confirmed', { map, source: 'fixture' }),
  ev(1, 'repo_scanned', {
    files: files.map((f) => ({ path: f.path, placement: { kind: 'cell', domain: `d${f.d}`, layer: LAYERS[f.l] } })),
    imports: [], writes: [], edges: [...edges.values()], fileFacts: facts,
  }),
];
writeFileSync(join(here, '../public/bench-events.json'), JSON.stringify(out));
console.log(`${files.length} files, ${facts.reduce((s, f) => s + f.imports.length, 0)} imports → public/bench-events.json`);
