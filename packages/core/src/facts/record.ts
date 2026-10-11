// The import/export record and table writes of one file: what the edit gate, the load scan and extractFacts share.
// Node-only (oxc-parser native binding). Parsing is skipped for large or minified files, so the gate stays fast.
import { initSync as initLexer, parse as lex } from 'es-module-lexer';
import { parseSync, type ParseResult } from 'oxc-parser';
import { findWrites, maskComments, type WriteHit } from './adapters';
import { REQUIRE, regexImports, stripComments, type SpecSite } from './regex';

/** Above this size (or when minified) the record comes from es-module-lexer: oxc's AST transfer costs ~40 ms/MB. */
export const LEX_MIN = 128_000;
/** Above this size (or when minified) a file gets the import/export record only: no symbols, calls or routes. */
export const BULK_MIN = 500_000;

/** What an export name points at: a local binding, or `name` (`'*'` = namespace) of the module `spec`. */
export type ExportTarget = { local: string } | { spec: string; name: string };

export type ModuleRecord = {
  specs: SpecSite[]; // imports, re-exports, dynamic imports, require(), in source order
  exports: Map<string, ExportTarget>;
  stars: string[]; // `export * from` specs
  writes: WriteHit[];
  mode: 'oxc' | 'lexer' | 'regex';
};

const CODE_EXT = /\.(?:[cm]?[jt]sx?|d\.ts)$/;
/** File name oxc uses to pick the language (`.ts` when the path has no code extension). */
export const parseName = (path: string) => (CODE_EXT.test(path) ? path : `${path || 'source'}.ts`);

/** Long average line length means generated or minified code. */
export function isMinified(source: string): boolean {
  if (source.length < 20_000) return false;
  const sample = Math.min(source.length, 100_000);
  let lines = 1;
  for (let i = source.indexOf('\n'); i !== -1 && i < sample; i = source.indexOf('\n', i + 1)) lines++;
  return sample / lines > 400;
}

const literal = (text: string): string | null => {
  const m = /^(['"])([^'"\n]*)\1$/.exec(text) ?? /^`([^`$\n]*)`$/.exec(text);
  return m ? (m[2] ?? m[1]!) : null;
};

const requires = (code: string, out: SpecSite[]) => {
  for (const m of code.matchAll(REQUIRE)) out.push({ spec: m[2]!, typeOnly: false, at: m.index });
};

function fromOxc(source: string, r: ParseResult): ModuleRecord {
  const m = r.module;
  const specs: SpecSite[] = [];
  const exports = new Map<string, ExportTarget>();
  const stars: string[] = [];
  for (const si of m.staticImports) specs.push({ spec: si.moduleRequest.value, typeOnly: si.entries.length > 0 && si.entries.every((e) => e.isType), at: si.start });
  for (const se of m.staticExports) {
    const req = se.entries.find((e) => e.moduleRequest)?.moduleRequest;
    if (req) specs.push({ spec: req.value, typeOnly: se.entries.every((e) => e.isType), at: se.start });
    for (const e of se.entries) {
      const key = e.exportName.kind === 'Default' ? 'default' : e.exportName.name;
      if (e.moduleRequest) {
        if (e.importName.kind === 'AllButDefault') stars.push(e.moduleRequest.value);
        else if (key) exports.set(key, { spec: e.moduleRequest.value, name: e.importName.kind === 'All' ? '*' : (e.importName.name ?? 'default') });
      } else if (key) {
        // `import { a } from './x'; export { a }`: oxc points importName at the import specifier.
        const at = e.importName.start;
        const si = at === null ? undefined : m.staticImports.find((s) => s.start <= at && at < s.end);
        const ie = si?.entries.find((x) => x.importName.start === at || x.localName.start === at);
        if (si && ie) {
          const name = ie.importName.kind === 'Default' ? 'default' : ie.importName.kind === 'NamespaceObject' ? '*' : ie.importName.name!;
          exports.set(key, { spec: si.moduleRequest.value, name });
        } else exports.set(key, { local: e.localName.name ?? 'default' });
      }
    }
  }
  for (const di of m.dynamicImports) {
    const spec = literal(source.slice(di.moduleRequest.start, di.moduleRequest.end));
    if (spec !== null) specs.push({ spec, typeOnly: false, at: di.start });
  }
  const code = maskComments(source, r.comments);
  requires(code, specs);
  return { specs: specs.sort((a, b) => a.at - b.at), exports, stars, writes: findWrites(code), mode: 'oxc' };
}

function fromLexer(source: string): ModuleRecord | null {
  initLexer();
  let parsed;
  try {
    parsed = lex(source);
  } catch {
    return null; // e.g. JSX: let oxc handle it
  }
  const [imps, exps] = parsed;
  const specs: SpecSite[] = [];
  for (const i of imps) {
    if (i.n === undefined || i.t === 3) continue; // non-literal dynamic import, import.meta
    specs.push({ spec: i.n, typeOnly: i.t === 1 && /^(?:import|export)\s+type[\s{*]/.test(source.slice(i.ss, i.ss + 16)), at: i.ss });
  }
  requires(source, specs);
  const exports = new Map<string, ExportTarget>();
  for (const e of exps) exports.set(e.n, { local: e.ln ?? e.n });
  return { specs: specs.sort((a, b) => a.at - b.at), exports, stars: [], writes: findWrites(source), mode: 'lexer' };
}

function fromRegex(source: string): ModuleRecord {
  const code = stripComments(source);
  return { specs: regexImports(code), exports: new Map(), stars: [], writes: findWrites(code), mode: 'regex' };
}

/**
 * Parse `source` and build its record. `parsed` is the oxc result (for the AST walk) when oxc parsed it cleanly.
 * Large or minified files go through es-module-lexer; source with syntax errors falls back to regex.
 */
export function parseModule(path: string, source: string): { record: ModuleRecord; parsed: ParseResult | null } {
  if (source.length > LEX_MIN || isMinified(source)) {
    const record = fromLexer(source);
    if (record) return { record, parsed: null };
  }
  const r = parseSync(parseName(path), source);
  if (r.errors.length > 0) return { record: fromRegex(source), parsed: null };
  return { record: fromOxc(source, r), parsed: r };
}

const CACHE_PATHS = 1024;
const cache = new Map<string, { source: string; record: ModuleRecord }[]>(); // path → last two texts (old and new)

/** `parseModule(...).record`, remembering the last two records per path, so the gate's old text is usually a hit. */
export function moduleRecord(path: string, source: string): ModuleRecord {
  const hit = cache.get(path)?.find((e) => e.source === source);
  return hit ? hit.record : remember(path, source, parseModule(path, source).record);
}

export function remember(path: string, source: string, record: ModuleRecord): ModuleRecord {
  const list = (cache.get(path) ?? []).filter((e) => e.source !== source);
  cache.delete(path);
  cache.set(path, [{ source, record }, ...list.slice(0, 1)]);
  if (cache.size > CACHE_PATHS) cache.delete(cache.keys().next().value!);
  return record;
}
