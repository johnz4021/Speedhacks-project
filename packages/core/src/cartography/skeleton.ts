// Instant onboarding map (NAVIGATION_PLAN §4.2 step 1): deterministic, no model, under a second.
import YAML from 'yaml';
import { DomainMapSchema, type DomainMap } from '../schema';
import type { FileFacts } from '../contracts/facts';
import { topFolder } from './drift';
import { CODE_FILE, TEST_FILE, majority, repoImports, titleCase } from './util';

export const SKELETON_LAYERS = [
  { id: 'entry', name: 'Entry' },
  { id: 'logic', name: 'Logic' },
  { id: 'data', name: 'Data' },
  { id: 'external', name: 'External' },
] as const;

export const SKELETON_IGNORE = [
  'node_modules/**', '.git/**', '.harness/**', 'decisions/**', 'fixtures/**', 'scripts/**', 'dist/**', 'build/**', 'coverage/**',
  '*.json', '*.md', '*.config.ts', '*.config.js', '.*', 'domains.yaml',
];

const VENDOR_DIR = /^(vendor|vendors|third[-_]party|external|clients|integrations)$/;
const NEUTRAL_DIR = /^(shared|common|utils?|types|helpers)$/;
const ENTRY = /(^|[/._-])(routes?|router|cli|server|main|handlers?|controllers?|pages?|bin|cmd|commands?|api)([/._-]|$)/;
const DATA = /(^|[/._-])(stores?|repo|repository|repositories|models?|schema|db|dao|ledger|state|log|sync|migrations?|persistence|storage|cache)([/._-]|$)/;
const EXTERNAL = /(^|[/._-])(client|sdk)([/._-]|$)/;

/** Folder/name heuristic for a file's layer (a file that writes a table is data). */
export function layerFor(path: string, facts?: FileFacts): 'entry' | 'logic' | 'data' | 'external' {
  const parts = path.replace(/\.[^./]+$/, '').split('/');
  if (parts.some((p) => VENDOR_DIR.test(p))) return 'external';
  const tail = parts.slice(-2).join('/');
  if (facts?.writes.length || DATA.test(tail)) return 'data';
  if (ENTRY.test(tail)) return 'entry';
  if (EXTERNAL.test(tail)) return 'external';
  return 'logic';
}

/** Where a code file goes in the skeleton: a domain folder, a vendor unit, neutral, or a test. */
function homeOf(path: string): { kind: 'domain'; folder: string; slug: string } | { kind: 'vendor'; unit: string } | { kind: 'neutral' } | { kind: 'test' } {
  if (TEST_FILE.test(path)) return { kind: 'test' };
  const parts = path.split('/');
  if (parts.length >= 2 && VENDOR_DIR.test(parts[0]!)) return parts.length >= 3 ? { kind: 'vendor', unit: `${parts[0]}/${parts[1]}` } : { kind: 'neutral' };
  const top = topFolder(path);
  if (!top) return { kind: 'domain', folder: '', slug: 'app' };
  const slug = top.split('/').at(-1)!;
  if (NEUTRAL_DIR.test(slug)) return { kind: 'neutral' };
  if (top === 'src' || top === 'lib' || top === 'app') return { kind: 'domain', folder: top, slug: 'app' }; // files directly under src/
  return { kind: 'domain', folder: top, slug };
}

/**
 * One domain per top-level source folder; layers from folder/name heuristics; tables owned by the domain that
 * writes them most. Vendor client folders go to the external cell of the domain that imports them most (else neutral).
 * Single-layer domains use a folder glob so new files land in place; mixed folders list files explicitly.
 */
export function skeletonMap(files: readonly string[], facts: Readonly<Record<string, FileFacts>>): DomainMap {
  const code = [...new Set(files.filter((f) => CODE_FILE.test(f)))].sort();
  const domains = new Map<string, { slug: string; folder: string; cells: Map<string, string[]>; tables: Map<string, number> }>();
  const vendors = new Map<string, string[]>();
  const neutral = new Set<string>();
  const tests: string[] = [];
  const domainOfFile = new Map<string, string>();

  for (const f of code) {
    const h = homeOf(f);
    if (h.kind === 'test') { tests.push(f); continue; }
    if (h.kind === 'neutral') {
      const parts = f.split('/');
      neutral.add(parts.length >= 3 || (parts.length === 2 && !VENDOR_DIR.test(parts[0]!)) ? `${parts.slice(0, -1).join('/')}/**` : f);
      continue;
    }
    if (h.kind === 'vendor') { vendors.set(h.unit, [...(vendors.get(h.unit) ?? []), f]); continue; }
    const d = domains.get(h.slug) ?? { slug: h.slug, folder: h.folder, cells: new Map(), tables: new Map() };
    domains.set(h.slug, d);
    const layer = layerFor(f, facts[f]);
    d.cells.set(layer, [...(d.cells.get(layer) ?? []), f]);
    for (const w of facts[f]?.writes ?? []) d.tables.set(w.table, (d.tables.get(w.table) ?? 0) + 1);
    domainOfFile.set(f, h.slug);
  }

  // Vendor units → external cell of their main importer.
  const vendorCells = new Map<string, string[]>();
  for (const [unit, unitFiles] of [...vendors].sort(([a], [b]) => a.localeCompare(b))) {
    const importers = Object.values(facts).flatMap((ff) => (repoImports(ff).some((to) => unitFiles.includes(to)) ? [domainOfFile.get(ff.path)] : [])).filter((x): x is string => !!x);
    const owner = majority(importers);
    if (owner) vendorCells.set(owner, [...(vendorCells.get(owner) ?? []), `${unit}/**`]);
    else neutral.add(`${unit}/**`);
  }

  // Each table goes to the domain that writes it most (ties: first id).
  const tableOwner = new Map<string, string>();
  const tableBest = new Map<string, number>();
  for (const d of [...domains.values()].sort((a, b) => a.slug.localeCompare(b.slug))) {
    for (const [t, n] of d.tables) if (n > (tableBest.get(t) ?? 0)) { tableBest.set(t, n); tableOwner.set(t, d.slug); }
  }

  const raw = {
    version: 1,
    layers: SKELETON_LAYERS.map((l) => ({ ...l })),
    neutral: [...neutral].sort(),
    ignore: SKELETON_IGNORE,
    domains: [...domains.values()].sort((a, b) => a.slug.localeCompare(b.slug)).map((d) => {
      const cells: Record<string, { paths: string[]; tables?: string[] }> = {};
      const single = d.cells.size === 1 && d.folder !== '' && d.slug !== 'app';
      for (const layer of SKELETON_LAYERS.map((l) => l.id)) {
        const own = d.cells.get(layer) ?? [];
        const ext = layer === 'external' ? vendorCells.get(d.slug) ?? [] : [];
        if (!own.length && !ext.length) continue;
        const paths = [...(single && own.length ? [`${d.folder}/**`] : own), ...ext];
        const tables = [...tableOwner].filter(([, o]) => o === d.slug).map(([t]) => t).sort();
        const writesHere = own.some((f) => facts[f]?.writes.length);
        cells[layer] = { paths, ...(tables.length && writesHere ? { tables } : {}) };
      }
      const testGlobs = ['test', 'tests'].map((t) => `${t}/${d.slug}/**`).filter((g) => tests.some((f) => f.startsWith(g.slice(0, -2))));
      return {
        id: d.slug,
        name: d.slug === 'app' ? 'App' : titleCase(d.slug),
        purpose: d.folder ? `Code under ${d.folder}/` : 'Top-level code',
        cells,
        ...(testGlobs.length ? { tests: testGlobs } : {}),
      };
    }),
    invariants: [],
  };
  return DomainMapSchema.parse(raw);
}

/** domains.yaml text for a map (stable key order; flow style kept for short lists). */
export function mapToYaml(map: DomainMap, header = ''): string {
  return header + YAML.stringify(map, { lineWidth: 140 });
}
