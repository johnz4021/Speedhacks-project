// Tier 1 facts for Python and Go (NAVIGATION_PLAN §3.1, N11) with web-tree-sitter. The runtime and grammars come pinned
// together from @vscode/tree-sitter-wasm (tree-sitter 0.25.1). Loading is async (`initTreeSitter`, once per process);
// after that every parse is synchronous, so these files go through the same sync scan, edit gate and PostToolUse
// paths as TypeScript. Before it is loaded, Python and Go files simply have no facts.
//
// Produces the same `FileFacts` as the TypeScript extractor: imports (repo paths, else `vendor:<package>`), symbols
// (functions, classes, methods; Go types), calls through import bindings and same-file/package definitions, routes
// (FastAPI/Flask decorators; Go `HandleFunc`/`Handle`, chi `r.Get`, gin `r.GET`), entries (routes, `__main__`, Go
// `main`), and table writes/reads (Django `Model.objects…`, SQLAlchemy `session.add(Model(…))` / `insert(Model)`, raw SQL).
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import type { CallFact, EntryFact, FileFacts, RouteFact, SymbolFact, SymbolKind, WriteSite } from '../contracts/facts';
import { hashText, squash } from './hash';
import { routeFact } from './routes';
import { normalizePath } from '../imports';

type TS = typeof import('@vscode/tree-sitter-wasm');
type Node = import('@vscode/tree-sitter-wasm').Node;
type Parser = import('@vscode/tree-sitter-wasm').Parser;

export type TreeSitterLang = 'python' | 'go';
export const TREE_SITTER_EXTENSIONS: Record<string, TreeSitterLang> = { '.py': 'python', '.go': 'go' };
export const treeSitterLang = (path: string): TreeSitterLang | null => {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? null : TREE_SITTER_EXTENSIONS[path.slice(dot)] ?? null;
};

let parsers: Partial<Record<TreeSitterLang, Parser>> | null = null;
let loading: Promise<void> | null = null;

/** Load the runtime and the Python and Go grammars (idempotent). Rejects if the wasm files can't be loaded. */
export function initTreeSitter(): Promise<void> {
  return (loading ??= (async () => {
    const require = createRequire(import.meta.url);
    const main = require.resolve('@vscode/tree-sitter-wasm');
    const dir = dirname(main);
    const ts = require('@vscode/tree-sitter-wasm') as TS;
    await ts.Parser.init({ locateFile: (file: string) => join(dir, file) });
    const out: Partial<Record<TreeSitterLang, Parser>> = {};
    for (const [lang, file] of [['python', 'tree-sitter-python.wasm'], ['go', 'tree-sitter-go.wasm']] as const) {
      const p = new ts.Parser();
      p.setLanguage(await ts.Language.load(join(dir, file)));
      out[lang] = p;
    }
    parsers = out;
  })());
}

/** Whether Python and Go files can be parsed now (after `initTreeSitter` resolved). */
export const treeSitterReady = () => parsers !== null;

/** What the extractor may look up about the rest of the repo (all optional; without them imports stay unresolved). */
export type LangContext = {
  exists?: (path: string) => boolean;
  /** Files directly in a repo directory (Go packages are directories). */
  listDir?: (dir: string) => string[];
  read?: (path: string) => string | null;
  /** go.mod `module` path. */
  goModule?: string | null;
};

/** A LangContext on the files under `root` on disk (go.mod read once). */
export function diskLangContext(root: string, exists?: (path: string) => boolean): LangContext {
  let goModule: string | null | undefined;
  return {
    exists: exists ?? ((p) => { try { return fs.statSync(join(root, p)).isFile(); } catch { return false; } }),
    listDir: (dir) => { try { return fs.readdirSync(join(root, dir), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => (dir ? `${dir}/${e.name}` : e.name)).sort(); } catch { return []; } },
    read: (p) => { try { return fs.readFileSync(join(root, p), 'utf8'); } catch { return null; } },
    get goModule() {
      if (goModule === undefined) {
        try { goModule = /^\s*module\s+(\S+)/m.exec(fs.readFileSync(join(root, 'go.mod'), 'utf8'))?.[1] ?? null; } catch { goModule = null; }
      }
      return goModule;
    },
  };
}

/** Facts for a Python or Go file. `parsed` is false when the tree has syntax errors (or tree-sitter isn't loaded). */
export function extractTreeSitter(path: string, source: string, ctx: LangContext = {}): { facts: FileFacts; parsed: boolean } {
  const facts: FileFacts = { path, hash: hashText(source), imports: [], writes: [], reads: [], symbols: [], calls: [], routes: [], entries: [] };
  const lang = treeSitterLang(path);
  const parser = lang ? parsers?.[lang] : undefined;
  if (!lang || !parser) return { facts, parsed: false };
  const tree = parser.parse(source);
  if (!tree) return { facts, parsed: false };
  try {
    const x = new Extraction(path, source, ctx, facts);
    if (lang === 'python') x.python(tree.rootNode);
    else x.go(tree.rootNode);
    x.finish();
    return { facts, parsed: !tree.rootNode.hasError };
  } finally {
    tree.delete();
  }
}

// ---------------------------------------------------------------- shared

const SQL_WRITE = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO)\s+[`"[]?([A-Za-z_][\w.]*)/gi;
const SQL_READ = /\b(?:FROM|JOIN)\s+[`"[]?([A-Za-z_][\w.]*)/gi;
const snake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();

type Binding = { kind: 'module'; file: string | null; dir?: string; vendor: string | null } | { kind: 'symbol'; to: string };

class Extraction {
  readonly symbols: SymbolFact[] = [];
  private readonly calls = new Map<string, CallFact>();
  private readonly imports = new Map<string, boolean>();
  private readonly routes = new Map<string, RouteFact>();
  private readonly entries = new Map<string, EntryFact>();
  private readonly writes = new Map<string, WriteSite>();
  private readonly reads = new Map<string, WriteSite>();
  private readonly bindings = new Map<string, Binding>();
  private readonly tableNames = new Map<string, string>(); // class name → table (`__tablename__`, Meta.db_table)
  private readonly ids = new Set<string>();
  private readonly byName = new Map<string, string>(); // qualified name → first symbol id
  private byStart: SymbolFact[] | null = null; // symbols sorted by span start, for `enclosing`

  constructor(private readonly path: string, private readonly source: string, private readonly ctx: LangContext, private readonly facts: FileFacts) {}

  finish() {
    const f = this.facts;
    f.imports = [...this.imports].map(([to, typeOnly]) => ({ to, typeOnly }));
    f.symbols = this.symbols;
    f.calls = [...this.calls.values()];
    f.routes = [...this.routes.values()];
    for (const r of f.routes) this.entry('route', `${r.method} ${r.path}`, r.handler);
    f.entries = [...this.entries.values()];
    f.writes = [...this.writes.values()];
    f.reads = [...this.reads.values()];
  }

  private importTo(to: string) { if (to !== this.path) this.imports.set(to, false); }
  private entry(kind: EntryFact['kind'], label: string, symbol: string | null) {
    this.entries.set(`entry:${kind}:${label}`, { id: `entry:${kind}:${label}`, kind, file: this.path, symbol, label });
  }
  private call(from: string, to: string | null) {
    if (!to || to === from) return;
    const k = `${from}\u0000${to}`;
    const c = this.calls.get(k);
    if (c) c.count++;
    else this.calls.set(k, { from, to, confidence: 'syntactic', count: 1 });
  }
  private site(map: Map<string, WriteSite>, table: string, symbol: string | null, via: string) {
    map.set(`${table}\u0000${symbol}\u0000${via}`, { table, symbol, via });
  }
  private symbol(name: string, kind: SymbolKind, node: Node, parent: SymbolFact | null, sig: string, body: string, exported: boolean): SymbolFact {
    const s: SymbolFact = {
      id: `${this.path}#${name}`, file: this.path, name, kind, exported, parent: parent?.id ?? null,
      span: { start: node.startIndex, end: node.endIndex }, sigHash: hashText(`${squash(sig)}|${exported ? 'export' : ''}`), bodyHash: hashText(squash(body)),
    };
    let n = 2;
    while (this.ids.has(s.id)) s.id = `${this.path}#${name}~${n++}`;
    this.ids.add(s.id);
    if (!this.byName.has(name)) this.byName.set(name, s.id);
    this.symbols.push(s);
    this.byStart = null;
    return s;
  }
  /**
   * The innermost symbol containing `at`, else the file. Spans nest, so it is the latest-starting symbol that contains
   * `at`: binary search for the last start ≤ `at`, then walk back to the first one that contains it.
   */
  private enclosing(at: number): string {
    const list = (this.byStart ??= this.symbols.filter((s) => s.kind !== 'type').sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end));
    let lo = 0;
    let hi = list.length - 1;
    let i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.span.start <= at) { i = mid; lo = mid + 1; } else hi = mid - 1;
    }
    for (; i >= 0; i--) if (at < list[i]!.span.end) return list[i]!.id;
    return this.path;
  }
  private sql(text: string, at: number) {
    const from = this.enclosing(at);
    for (const m of text.matchAll(SQL_WRITE)) this.site(this.writes, m[1]!.split('.').pop()!, from === this.path ? null : from, 'sql');
    if (/^\s*(?:SELECT|WITH)\b/i.test(text)) for (const m of text.matchAll(SQL_READ)) this.site(this.reads, m[1]!.split('.').pop()!, from === this.path ? null : from, 'sql');
  }
  private own(name: string): string | null {
    return this.byName.get(name) ?? null;
  }

  // ---------------------------------------------------------------- Python

  /** `a.b.c` (level dots) → repo file: `a/b/c.py` or `a/b/c/__init__.py`, from the importing file's package (relative) or the repo root / `src/`. */
  private pyModule(dotted: string, level: number): { file: string | null; vendor: string | null } {
    const parts = dotted ? dotted.split('.') : [];
    const exists = this.ctx.exists ?? (() => false);
    const bases: string[] = [];
    if (level > 0) {
      let dir = dirname(this.path);
      for (let i = 1; i < level; i++) dir = dirname(dir);
      bases.push(dir === '.' ? '' : dir);
    } else bases.push('', 'src');
    for (const base of bases) {
      const stem = [base, ...parts].filter(Boolean).join('/');
      for (const cand of [`${stem}.py`, `${stem}/__init__.py`]) {
        const p = normalizePath(cand) ?? cand;
        if (p && exists(p)) return { file: p, vendor: null };
      }
    }
    return { file: null, vendor: level > 0 || !parts[0] ? null : parts[0] };
  }

  python(root: Node) {
    // 1. imports and bindings (module level and anywhere: imports inside functions bind too)
    for (const n of root.descendantsOfType(['import_statement', 'import_from_statement'])) {
      if (!n) continue;
      if (n.type === 'import_statement') {
        for (const name of n.childrenForFieldName('name')) {
          if (!name) continue;
          const dotted = name.type === 'aliased_import' ? name.childForFieldName('name')!.text : name.text;
          const alias = name.type === 'aliased_import' ? name.childForFieldName('alias')!.text : dotted.split('.')[0]!;
          const m = this.pyModule(dotted, 0);
          if (m.file) this.importTo(m.file);
          else if (m.vendor) this.importTo(`vendor:${m.vendor}`);
          // `import a.b` binds `a`; resolve the head module so `a.b.f()` can walk down.
          const bound = name.type === 'aliased_import' ? m : this.pyModule(alias, 0);
          this.bindings.set(alias, { kind: 'module', file: bound.file, vendor: bound.vendor ?? m.vendor });
        }
      } else {
        const modNode = n.childForFieldName('module_name');
        const raw = modNode?.text ?? '';
        const level = raw.match(/^\.*/)![0].length;
        const dotted = raw.slice(level);
        const mod = this.pyModule(dotted, level);
        // `from m import a`: `a` is a submodule (import its file) or a name in `m` (import m's file); `*` imports m.
        let needModule = n.childrenForFieldName('name').length === 0;
        for (const name of n.childrenForFieldName('name')) {
          if (!name) continue;
          const orig = name.type === 'aliased_import' ? name.childForFieldName('name')!.text : name.text;
          const alias = name.type === 'aliased_import' ? name.childForFieldName('alias')!.text : orig;
          const sub = this.pyModule(dotted ? `${dotted}.${orig}` : orig, level);
          if (sub.file) { this.importTo(sub.file); this.bindings.set(alias, { kind: 'module', file: sub.file, vendor: null }); continue; }
          needModule = true;
          if (mod.file) this.bindings.set(alias, { kind: 'symbol', to: `${mod.file}#${orig}` });
          else if (mod.vendor) this.bindings.set(alias, { kind: 'symbol', to: `vendor:${mod.vendor}` });
        }
        if (needModule && mod.file) this.importTo(mod.file);
        else if (needModule && mod.vendor) this.importTo(`vendor:${mod.vendor}`);
      }
    }

    // 2. symbols: functions, classes, methods (decorators belong to the definition)
    const defs = (block: Node | null, parent: SymbolFact | null) => {
      for (const child of block?.namedChildren ?? []) {
        if (!child) continue;
        const def = child.type === 'decorated_definition' ? child.childForFieldName('definition') : child;
        if (!def || (def.type !== 'function_definition' && def.type !== 'class_definition')) continue;
        const name = def.childForFieldName('name')!.text;
        const qualified = parent ? `${parent.name}.${name}` : name;
        const body = def.childForFieldName('body');
        const decorators = child.type === 'decorated_definition' ? child.namedChildren.filter((c) => c?.type === 'decorator').map((c) => c!.text).join('\n') : '';
        if (def.type === 'class_definition') {
          const sig = `${decorators} class ${name}${def.childForFieldName('superclasses')?.text ?? ''}`;
          const s = this.symbol(qualified, 'class', child, parent, sig, body?.text ?? '', !name.startsWith('_'));
          this.pyTableName(name, body);
          defs(body, s);
        } else {
          const sig = `${decorators} def ${name}${def.childForFieldName('parameters')?.text ?? ''}->${def.childForFieldName('return_type')?.text ?? ''}`;
          const s = this.symbol(qualified, parent?.kind === 'class' ? 'method' : 'function', child, parent, sig, body?.text ?? '', !name.startsWith('_'));
          if (child.type === 'decorated_definition') this.pyRoutes(child, s);
          if (parent?.kind !== 'function' && parent?.kind !== 'method') defs(body, s); // nested functions one level
        }
      }
    };
    defs(root, null);

    // 3. calls, writes, reads, SQL
    for (const c of root.descendantsOfType('call')) {
      if (!c) continue;
      const from = this.enclosing(c.startIndex);
      const fn = c.childForFieldName('function');
      if (!fn) continue;
      this.call(from, this.pyTarget(fn, from));
      this.pyData(c, fn, from);
    }
    for (const s of root.descendantsOfType('string')) {
      if (!s) continue;
      const text = s.text.replace(/^[rbuf]*("""|'''|"|')/i, '').replace(/("""|'''|"|')$/, '');
      if (/\b(?:INSERT|UPDATE|DELETE|MERGE|SELECT|WITH)\b/i.test(text)) this.sql(text, s.startIndex);
    }

    // 4. `if __name__ == "__main__":`
    for (const n of root.namedChildren) {
      if (n?.type === 'if_statement' && /__name__\s*==\s*['"]__main__['"]/.test(n.childForFieldName('condition')?.text ?? '')) this.entry('main', this.path, null);
    }
  }

  private pyTableName(cls: string, body: Node | null) {
    for (const st of body?.namedChildren ?? []) {
      const m = /^__tablename__\s*=\s*['"]([\w.]+)['"]/.exec(st?.text ?? '');
      if (m) this.tableNames.set(cls, m[1]!);
      if (st?.type === 'class_definition' && st.childForFieldName('name')?.text === 'Meta') {
        const t = /db_table\s*=\s*['"]([\w.]+)['"]/.exec(st.text)?.[1];
        if (t) this.tableNames.set(cls, t);
      }
    }
  }
  /**
   * A model class's table: `__tablename__` / `Meta.db_table` in this file, else in the file the class is imported from
   * (read through the context), else the class name in snake_case.
   */
  private table(cls: string, fromFile: string | null = null): string {
    const here = this.tableNames.get(cls);
    if (here) return here;
    const b = this.bindings.get(cls);
    const file = fromFile ?? (b?.kind === 'symbol' && !b.to.startsWith('vendor:') ? b.to.slice(0, b.to.indexOf('#')) : null);
    const text = file ? this.ctx.read?.(file) : null;
    if (text) {
      const start = text.search(new RegExp(`^class\\s+${cls}\\b`, 'm'));
      if (start >= 0) {
        const rest = text.slice(text.indexOf('\n', start) + 1); // the class body: indented lines after `class X…:`
        const end = rest.search(/^\S/m);
        const block = end >= 0 ? rest.slice(0, end) : rest;
        const t = /__tablename__\s*=\s*['"]([\w.]+)['"]/.exec(block)?.[1] ?? /db_table\s*=\s*['"]([\w.]+)['"]/.exec(block)?.[1];
        if (t) return t;
      }
    }
    return snake(cls);
  }

  /** What a callee expression calls: a symbol id, a module file, or `vendor:<pkg>`. */
  private pyTarget(fn: Node, from: string): string | null {
    if (fn.type === 'identifier') {
      const b = this.bindings.get(fn.text);
      if (b?.kind === 'symbol') return b.to;
      return this.own(fn.text);
    }
    if (fn.type !== 'attribute') return null;
    const chain: string[] = [];
    let cur: Node | null = fn;
    while (cur?.type === 'attribute') { chain.unshift(cur.childForFieldName('attribute')!.text); cur = cur.childForFieldName('object'); }
    if (cur?.type !== 'identifier') return null;
    const head = cur.text;
    if (head === 'self' || head === 'cls') {
      const cls = from.includes('#') ? from.slice(from.indexOf('#') + 1).split('.')[0] : null;
      return cls && chain.length === 1 ? this.own(`${cls}.${chain[0]}`) : null;
    }
    const b = this.bindings.get(head);
    if (!b) {
      // A same-file class: `Model.create(...)`.
      return chain.length === 1 && this.own(head) ? this.own(`${head}.${chain[0]}`) ?? this.own(head) : null;
    }
    if (b.kind === 'symbol') return b.to.startsWith('vendor:') ? b.to : `${b.to}.${chain.join('.')}`; // `Model.create` → file#Model.create
    if (b.vendor && !b.file) return `vendor:${b.vendor}`;
    if (!b.file) return null;
    // `pkg.sub.f()` where pkg is a package: walk down submodules as far as they exist.
    let file = b.file;
    let i = 0;
    for (; i < chain.length - 1; i++) {
      const base = file.endsWith('/__init__.py') ? file.slice(0, -'/__init__.py'.length) : null;
      if (!base) break;
      const next = [`${base}/${chain[i]}.py`, `${base}/${chain[i]}/__init__.py`].find((p) => this.ctx.exists?.(p));
      if (!next) break;
      file = next;
    }
    return `${file}#${chain.slice(i).join('.')}`;
  }

  /** Django ORM, SQLAlchemy session/core writes and reads. */
  private pyData(c: Node, fn: Node, from: string) {
    const sym = from === this.path ? null : from;
    const text = fn.text;
    const objects = /(?:^|\.)([A-Z]\w*)\.objects\b(?:.*\.(\w+))?$/s.exec(text);
    if (objects) {
      const [, model, last] = objects as unknown as [string, string, string | undefined];
      const op = last ?? '';
      // `models.Run.objects…`: the class lives in the module bound to `models`.
      const head = /^(\w+)\.[A-Z]\w*\.objects\b/.exec(text)?.[1];
      const hb = head ? this.bindings.get(head) : undefined;
      const table = this.table(model, hb?.kind === 'module' ? hb.file : null);
      if (/^(create|bulk_create|get_or_create|update_or_create|update|delete|bulk_update)$/.test(op)) this.site(this.writes, table, sym, 'django');
      else if (/^(filter|get|all|exclude|first|last|count|values|values_list|aggregate|annotate|exists|order_by|select_related)$/.test(op)) this.site(this.reads, table, sym, 'django');
      return;
    }
    const attr = fn.type === 'attribute' ? fn.childForFieldName('attribute')!.text : fn.type === 'identifier' ? fn.text : '';
    const args = c.childForFieldName('arguments')?.namedChildren ?? [];
    if ((attr === 'add' || attr === 'add_all' || attr === 'merge') && fn.type === 'attribute' && /session|db/i.test(fn.childForFieldName('object')!.text)) {
      for (const a of args) {
        const models = a?.type === 'call' ? [a] : (a?.descendantsOfType('call') ?? []);
        for (const m of models) {
          const name = m?.childForFieldName('function')?.text;
          if (name && /^[A-Z]\w*$/.test(name)) this.site(this.writes, this.table(name), sym, 'sqlalchemy');
        }
      }
      return;
    }
    if (/^(insert|update|delete|select)$/.test(attr) && args[0] && /^[A-Z]\w*$/.test(args[0].text)) {
      this.site(attr === 'select' ? this.reads : this.writes, this.table(args[0].text), sym, 'sqlalchemy');
    }
  }

  /** FastAPI (`@app.get("/x")`, `@router.api_route(...)`) and Flask (`@app.route("/x", methods=[...])`, `@bp.post`). */
  private pyRoutes(decorated: Node, handler: SymbolFact) {
    for (const d of decorated.namedChildren) {
      if (d?.type !== 'decorator') continue;
      const call = d.namedChildren[0];
      if (call?.type !== 'call') continue;
      const fn = call.childForFieldName('function');
      if (fn?.type !== 'attribute') continue;
      const verb = fn.childForFieldName('attribute')!.text.toLowerCase();
      const args = call.childForFieldName('arguments')?.namedChildren ?? [];
      const first = args[0];
      if (first?.type !== 'string') continue;
      const raw = first.text.replace(/^[rbuf]*("""|'''|"|')/i, '').replace(/("""|'''|"|')$/, '');
      const url = raw.replace(/<(?:[^:>]+:)?([^>]+)>/g, '{$1}'); // Flask <int:id> → {id}
      let methods: string[] = [];
      if (/^(get|post|put|patch|delete|head|options)$/.test(verb)) methods = [verb];
      else if (verb === 'route' || verb === 'api_route') {
        const kw = args.find((a) => a?.type === 'keyword_argument' && a.childForFieldName('name')?.text === 'methods');
        methods = kw ? [...kw.childForFieldName('value')!.text.matchAll(/['"](\w+)['"]/g)].map((m) => m[1]!.toLowerCase()) : ['get'];
      } else if (verb === 'websocket') methods = ['get'];
      else continue;
      for (const m of methods) {
        const r = routeFact(m, url, this.path, handler.id);
        this.routes.set(r.id, r);
      }
    }
  }

  // ---------------------------------------------------------------- Go

  /** An import path → the repo package directory (go.mod module prefix), or null for a dependency / the stdlib. */
  private goDir(importPath: string): string | null {
    const mod = this.ctx.goModule;
    if (!mod) return null;
    if (importPath === mod) return '';
    return importPath.startsWith(`${mod}/`) ? importPath.slice(mod.length + 1) : null;
  }
  private readonly dirFiles = new Map<string, string[]>();
  private readonly defined = new Map<string, string | null>();
  private goFiles(dir: string) {
    let files = this.dirFiles.get(dir);
    if (!files) this.dirFiles.set(dir, (files = (this.ctx.listDir?.(dir) ?? []).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'))));
    return files;
  }
  /** `<file>#name` for the file of package `dir` that defines `name` (a quick text scan of its files), or null. Memoized. */
  private goDefines(dir: string, name: string): string | null {
    const key = `${dir}\u0000${name}`;
    if (this.defined.has(key)) return this.defined.get(key)!;
    const re = new RegExp(`^(?:func\\s+${name}\\s*[(\\[]|type\\s+${name}\\b|(?:var|const)\\s+${name}\\b)`, 'm');
    let hit: string | null = null;
    for (const f of this.goFiles(dir)) if (re.test(f === this.path ? this.source : this.ctx.read?.(f) ?? '')) { hit = `${f}#${name}`; break; }
    this.defined.set(key, hit);
    return hit;
  }
  private get goDir0() { const d = dirname(this.path); return d === '.' ? '' : d; }

  go(root: Node) {
    const pkg = root.namedChildren.find((c) => c?.type === 'package_clause')?.namedChildren[0]?.text ?? '';
    // 1. imports
    for (const spec of root.descendantsOfType('import_spec')) {
      if (!spec) continue;
      const ip = spec.childForFieldName('path')!.text.replace(/^["`]|["`]$/g, '');
      const alias = spec.childForFieldName('name')?.text;
      const dir = this.goDir(ip);
      if (dir !== null) {
        const files = this.goFiles(dir);
        for (const f of files) this.importTo(f);
        if (!files.length) this.importTo(`vendor:${ip}`);
      } else this.importTo(`vendor:${ip}`);
      const segs = ip.split('/');
      const last = /^v\d+$/.test(segs.at(-1)!) && segs.length > 1 ? segs.at(-2)! : segs.at(-1)!;
      const name = alias && alias !== '.' && alias !== '_' ? alias : last.replace(/^go-/, '').replace(/[.-].*$/, '');
      this.bindings.set(name, { kind: 'module', file: null, dir: dir ?? undefined, vendor: dir === null ? ip : null });
    }

    // 2. symbols
    const recvType = (n: Node | null) => n?.descendantsOfType('type_identifier')[0]?.text ?? null;
    for (const d of root.namedChildren) {
      if (!d) continue;
      if (d.type === 'function_declaration') {
        const name = d.childForFieldName('name')!.text;
        const sig = `func ${name}${d.childForFieldName('type_parameters')?.text ?? ''}${d.childForFieldName('parameters')?.text ?? ''} ${d.childForFieldName('result')?.text ?? ''}`;
        this.symbol(name, 'function', d, null, sig, d.childForFieldName('body')?.text ?? '', /^[A-Z]/.test(name));
        if (name === 'main' && pkg === 'main') this.entry('main', this.path, `${this.path}#main`);
      } else if (d.type === 'type_declaration') {
        for (const spec of d.namedChildren) {
          if (spec?.type !== 'type_spec') continue;
          const name = spec.childForFieldName('name')!.text;
          const t = spec.childForFieldName('type');
          const kind: SymbolKind = t?.type === 'struct_type' ? 'class' : 'type';
          this.symbol(name, kind, spec, null, `type ${name} ${kind === 'class' ? 'struct' : t?.text ?? ''}`, t?.text ?? '', /^[A-Z]/.test(name));
        }
      }
    }
    for (const d of root.namedChildren) {
      if (d?.type !== 'method_declaration') continue;
      const recv = recvType(d.childForFieldName('receiver'));
      const name = d.childForFieldName('name')!.text;
      const parent = recv ? this.symbols.find((s) => s.name === recv) ?? null : null;
      const sig = `func (${d.childForFieldName('receiver')?.text ?? ''}) ${name}${d.childForFieldName('parameters')?.text ?? ''} ${d.childForFieldName('result')?.text ?? ''}`;
      this.symbol(recv ? `${recv}.${name}` : name, 'method', d, parent, sig, d.childForFieldName('body')?.text ?? '', /^[A-Z]/.test(name));
    }

    // 3. calls and routes
    /** Same-file or same-package definitions; `pkg.Name` through an import (a repo package: the defining file, else its first file). */
    const target = (fn: Node): string | null => {
      if (fn.type === 'identifier') return this.own(fn.text) ?? this.goDefines(this.goDir0, fn.text);
      if (fn.type !== 'selector_expression') return null;
      const op = fn.childForFieldName('operand');
      const field = fn.childForFieldName('field')!.text;
      if (op?.type !== 'identifier') return null;
      const b = this.bindings.get(op.text);
      if (b?.kind !== 'module') return null;
      if (b.vendor) return `vendor:${b.vendor}`;
      return b.dir === undefined ? null : this.goDefines(b.dir, field) ?? this.goFiles(b.dir)[0] ?? null;
    };
    for (const c of root.descendantsOfType('call_expression')) {
      if (!c) continue;
      const fn = c.childForFieldName('function');
      if (!fn) continue;
      this.call(this.enclosing(c.startIndex), target(fn));
      this.goRoute(c, fn, target);
    }
    for (const s of root.descendantsOfType(['interpreted_string_literal', 'raw_string_literal'])) {
      if (!s) continue;
      const text = s.text.slice(1, -1);
      if (/\b(?:INSERT|UPDATE|DELETE|MERGE|SELECT|WITH)\b/i.test(text)) this.sql(text, s.startIndex);
    }
  }

  /** `http.HandleFunc("GET /x", h)`, `mux.Handle("/x", h)`, chi `r.Get("/x", h)`, gin/echo `r.GET("/x", h)`. */
  private goRoute(c: Node, fn: Node, target: (fn: Node) => string | null) {
    if (fn.type !== 'selector_expression') return;
    const field = fn.childForFieldName('field')!.text;
    const args = c.childForFieldName('arguments')?.namedChildren ?? [];
    const first = args[0];
    if (!first || (first.type !== 'interpreted_string_literal' && first.type !== 'raw_string_literal')) return;
    const lit = first.text.slice(1, -1);
    let method: string;
    let url: string;
    if (field === 'HandleFunc' || field === 'Handle') {
      const m = /^(?:([A-Z]+)\s+)?(\S*?)(\/\S*)$/.exec(lit);
      if (!m) return;
      method = m[1] ?? 'ANY';
      url = m[3]!.replace(/\{\$\}$/, '');
    } else if (/^(Get|Post|Put|Patch|Delete|Head|Options|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any)$/.test(field) && lit.startsWith('/')) {
      method = field === 'Any' ? 'ANY' : field.toUpperCase();
      url = lit;
    } else return;
    const h = args.at(-1);
    const handler = h && h !== first ? (h.type === 'identifier' || h.type === 'selector_expression' ? target(h) : null) : null;
    const r = routeFact(method, url.replace(/\{([^}/]+?)(?:\.\.\.)?\}/g, '{$1}'), this.path, handler && handler.includes('#') ? handler : null);
    this.routes.set(r.id, r);
  }
}
