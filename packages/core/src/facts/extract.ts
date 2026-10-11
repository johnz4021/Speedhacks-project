// Tier 1 facts for one file (NAVIGATION_PLAN §3.1): one oxc parse, one walk. Node-only.
import { parseSync, visitorKeys } from 'oxc-parser';
import { matchesAny } from '../mapper';
import type { CallFact, EntryFact, FileFacts, RouteFact, SymbolFact, SymbolKind, WriteSite } from '../contracts/facts';
import { maskComments } from './adapters';
import { hashText, squash } from './hash';
import { BULK_MIN, isMinified, parseModule, parseName, remember, type ModuleRecord } from './record';
import { packageName } from './resolver';
import { nextRoutes, routeFact } from './routes';

/** `(from, spec)` → repo path, `vendor:<pkg>`, or null (unresolved). */
export type Resolve = (from: string, spec: string) => string | null;

/** A package.json entry whose target is the file (`bin`, `scripts`, `main`). */
export type PackageEntry = { kind: 'bin' | 'script' | 'main'; label: string };

export type ExtractContext = {
  /** Import/export record of another repo file, so calls link through barrels and default exports. */
  recordOf?: (file: string) => ModuleRecord | null;
  /** package.json entries that run this file. A `script` whose file reads its arguments becomes a `cli` entry. */
  entries?: readonly PackageEntry[];
  /** `cartography.routes` in domains.yaml: `pattern` is a JS regex source with `method` and `path` groups (or groups 1, 2). */
  routes?: readonly { file: string; pattern: string }[];
};

/** Reads CLI arguments (`process.argv.slice(2)`, `argv[2]`, `parseArgs(…)`), not just the `argv[1]` is-main check. */
const READS_ARGS = /\bprocess\s*\.\s*argv\s*(?:\.\s*(?:slice|includes|indexOf|filter|find)\b|\[\s*[2-9])|\bparseArgs\s*\(/;

/** Tier 1 facts for `path`. Large (> ~500 KB) or minified files get imports, writes and file routes only. */
export function extractFacts(path: string, source: string, resolve: Resolve, ctx: ExtractContext = {}): FileFacts {
  return extract(path, source, resolve, ctx).facts;
}

/** `extractFacts`, plus whether the source parsed (when it didn't, symbols and calls are empty, not "all removed"). */
export function extract(path: string, source: string, resolve: Resolve, ctx: ExtractContext = {}): { facts: FileFacts; parsed: boolean } {
  const { record, parsed } = parseModule(path, source);
  remember(path, source, record);
  const facts: FileFacts = { path, hash: hashText(source), imports: [], writes: [], symbols: [], calls: [], routes: [], entries: [] };

  const imports = new Map<string, boolean>();
  for (const s of record.specs) {
    const to = resolve(path, s.spec);
    if (to && to !== path) imports.set(to, (imports.get(to) ?? true) && s.typeOnly);
  }
  facts.imports = [...imports].map(([to, typeOnly]) => ({ to, typeOnly }));

  let result = parsed;
  if (!result && record.mode === 'lexer' && source.length <= BULK_MIN && !isMinified(source)) {
    const r = parseSync(parseName(path), source);
    if (r.errors.length === 0) result = r;
  }
  const code = result ? maskComments(source, result.comments) : source;
  const w = new Walker(path, source, resolve, ctx, record);
  if (result && source.length <= BULK_MIN && !isMinified(source)) w.run(result.program as unknown as N);
  w.finish();

  facts.symbols = w.symbols;
  facts.calls = [...w.calls.values()];
  const routes = new Map<string, RouteFact>();
  for (const r of w.routes()) if (!routes.has(r.id)) routes.set(r.id, r);

  const next = nextRoutes(path, [...record.exports.keys()]);
  const exportedSymbol = (name: string) => {
    const t = record.exports.get(name);
    const local = t && 'local' in t ? t.local : name;
    return w.symbols.find((s) => s.parent === null && s.name === local)?.id ?? null;
  };
  for (const r of next.routes) {
    const f = routeFact(r.method, r.path, path, exportedSymbol(r.symbol));
    if (!routes.has(f.id)) routes.set(f.id, f);
  }
  for (const r of customRoutes(path, code, ctx.routes ?? [], w)) if (!routes.has(r.id)) routes.set(r.id, r);
  facts.routes = [...routes.values()];

  const writes = new Map<string, WriteSite>();
  for (const hit of record.writes) {
    const site = { table: hit.table, symbol: w.innermost(hit.at), via: hit.via };
    writes.set(`${site.table}\u0000${site.symbol}\u0000${site.via}`, site);
  }
  facts.writes = [...writes.values()];

  const entries = new Map<string, EntryFact>();
  const entry = (kind: EntryFact['kind'], label: string, symbol: string | null) =>
    entries.set(`entry:${kind}:${label}`, { id: `entry:${kind}:${label}`, kind, file: path, symbol, label });
  for (const e of ctx.entries ?? []) entry(e.kind === 'script' && READS_ARGS.test(code) ? 'cli' : e.kind, e.label, null);
  for (const r of facts.routes) entry('route', `${r.method} ${r.path}`, r.handler);
  if (next.page) entry('page', next.page, exportedSymbol('default'));
  facts.entries = [...entries.values()];

  return { facts, parsed: record.mode !== 'regex' };
}

/** Routes from user-confirmed patterns (`cartography.routes`). The handler is the first symbol defined after the match. */
function customRoutes(path: string, code: string, patterns: readonly { file: string; pattern: string }[], w: Walker): RouteFact[] {
  const out: RouteFact[] = [];
  for (const p of patterns) {
    if (!matchesAny([p.file], path)) continue;
    let re: RegExp;
    try {
      re = new RegExp(p.pattern, 'g');
    } catch {
      continue;
    }
    const matches = [...code.matchAll(re)];
    matches.forEach((m, i) => {
      const g = m.groups ?? {};
      const method = g.method ?? (m.length > 2 ? m[1] : undefined) ?? 'ANY';
      const raw = g.path ?? (m.length > 2 ? m[2] : m[1]);
      if (raw === undefined) return;
      const end = m.index + m[0].length;
      const stop = matches[i + 1]?.index ?? code.length;
      out.push(routeFact(method, raw, path, w.firstSymbolIn(end, stop) ?? w.innermost(m.index)));
    });
  }
  return out;
}

type N = { type: string; start: number; end: number; [key: string]: any };

const FN = new Set(['ArrowFunctionExpression', 'FunctionExpression']);
const SKIP_KEYS = new Set(['typeAnnotation', 'returnType', 'typeParameters', 'typeArguments', 'superTypeArguments', 'implements']);
const WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression', 'TSTypeAssertion', 'TSInstantiationExpression', 'ChainExpression']);
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);
const FRAMEWORKS = new Set(['express', 'hono', 'fastify', '@koa/router', 'koa-router', '@hono/zod-openapi']);

const unwrap = (n: N | null | undefined): N | null => {
  let x = n ?? null;
  while (x && WRAPPERS.has(x.type)) x = x.expression;
  return x;
};
const strValue = (n: N | null | undefined): string | null => {
  const x = unwrap(n);
  if (!x) return null;
  if (x.type === 'Literal' && typeof x.value === 'string') return x.value;
  if (x.type === 'TemplateLiteral' && x.expressions.length === 0) return x.quasis[0]?.value?.cooked ?? null;
  return null;
};
const keyName = (key: N, computed: boolean): string | null => {
  if (!computed && key.type === 'Identifier') return key.name;
  if (key.type === 'PrivateIdentifier') return `#${key.name}`;
  return strValue(key);
};

type Binding = { spec: string; name: string }; // name: imported name, 'default', or '*' (namespace / CommonJS module)
type PendingRoute = { method: string; path: string; handler: N | null; enclosing: string | null };

class Walker {
  symbols: SymbolFact[] = [];
  calls = new Map<string, CallFact>();
  private sigText = new Map<string, string>();
  private used = new Map<string, number>();
  private cbCount = 0;
  private bindings = new Map<string, Binding>();
  private topNames = new Set<string>();
  private receivers = new Map<string, string>(); // router local → route prefix
  private pending: PendingRoute[] = [];
  private nodeSym = new WeakMap<object, string>();
  private current: SymbolFact | null = null;
  private cls: SymbolFact | null = null;
  private resolved = new Map<string, string | null>();
  private jsx: boolean;

  constructor(private path: string, private source: string, private resolve: Resolve, private ctx: ExtractContext, private record: ModuleRecord) {
    this.jsx = /\.[jt]sx$/.test(path);
  }

  run(program: N) {
    this.prepass(program.body as N[]);
    for (const stmt of program.body as N[]) this.statement(stmt);
  }

  /** Mark symbols exported through `export { a, b as c }`, then hash signatures (which include the export flag). */
  finish() {
    for (const t of this.record.exports.values()) {
      if (!('local' in t)) continue;
      const s = this.symbols.find((x) => x.parent === null && x.name === t.local);
      if (s) s.exported = true;
    }
    for (const s of this.symbols) s.sigHash = hashText(`${this.sigText.get(s.id) ?? ''}|${s.exported ? 'export' : ''}`);
  }

  /** Id of the innermost symbol whose span contains `at`. */
  innermost(at: number): string | null {
    let best: SymbolFact | null = null;
    for (const s of this.symbols) {
      if (s.span.start <= at && at < s.span.end && (!best || s.span.end - s.span.start < best.span.end - best.span.start)) best = s;
    }
    return best?.id ?? null;
  }

  /** First symbol starting in [from, to) at the same nesting as `from`. */
  firstSymbolIn(from: number, to: number): string | null {
    const parent = this.innermost(from);
    return this.symbols.find((s) => s.span.start >= from && s.span.start < to && s.parent === parent)?.id ?? null;
  }

  routes(): RouteFact[] {
    return this.pending.map((r) => {
      const h = unwrap(r.handler);
      let id = h ? this.nodeSym.get(h) ?? null : null;
      if (!id && h?.type === 'Identifier') id = this.target(h);
      return routeFact(r.method, r.path, this.path, id ?? r.enclosing);
    });
  }

  // ---- declarations

  private prepass(body: N[]) {
    const frameworkLocals = new Set<string>();
    for (const s of body) {
      if (s.type !== 'ImportDeclaration' || s.importKind === 'type') continue;
      const spec = s.source.value as string;
      for (const sp of s.specifiers as N[]) {
        if (sp.importKind === 'type') continue;
        const name = sp.type === 'ImportNamespaceSpecifier' ? '*' : sp.type === 'ImportDefaultSpecifier' ? 'default' : keyName(sp.imported, false) ?? 'default';
        this.bindings.set(sp.local.name, { spec, name });
        if (FRAMEWORKS.has(packageName(spec) ?? '')) frameworkLocals.add(sp.local.name);
      }
    }
    for (const s0 of body) {
      const exported = s0.type === 'ExportNamedDeclaration' || s0.type === 'ExportDefaultDeclaration';
      const s = exported ? s0.declaration : s0;
      if (!s) continue;
      if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id) this.topNames.add(s.id.name);
      if (s.type !== 'VariableDeclaration') continue;
      for (const d of s.declarations as N[]) {
        if (d.id.type !== 'Identifier') continue;
        if (this.isSymbolDeclarator(d, exported)) this.topNames.add(d.id.name);
        const prefix = this.frameworkPrefix(d.init, frameworkLocals);
        if (prefix !== null) this.receivers.set(d.id.name, prefix);
      }
    }
    for (const t of this.record.exports.values()) if ('local' in t) this.topNames.add(t.local);
  }

  private isSymbolDeclarator(d: N, exported: boolean): boolean {
    const init = unwrap(d.init);
    if (init && (FN.has(init.type) || init.type === 'ClassExpression')) return true;
    if (exported) return true;
    // Object literals that are typed, or hold functions (a module-like namespace), name their members.
    return init?.type === 'ObjectExpression' && (!!d.id.typeAnnotation || init.properties.some((p: N) => p.type === 'Property' && (p.method || FN.has(unwrap(p.value)?.type ?? ''))));
  }

  /**
   * Route prefix if `init` creates a router from an imported framework: `express()`, `express.Router()`, `new Hono()`,
   * `new Hono().basePath('/api')` (prefix `/api`), `Fastify()`, `new Router({ prefix: '/x' })`; null otherwise.
   */
  private frameworkPrefix(init: N | null | undefined, locals: Set<string>): string | null {
    let x = unwrap(init);
    let prefix = '';
    while (x?.type === 'CallExpression' && x.callee.type === 'MemberExpression' && unwrap(x.callee.object)?.type !== 'Identifier') {
      if (!x.callee.computed && x.callee.property.name === 'basePath') prefix = (strValue(x.arguments[0]) ?? '') + prefix;
      x = unwrap(x.callee.object);
    }
    if (!x || (x.type !== 'CallExpression' && x.type !== 'NewExpression')) return null;
    const c = unwrap(x.callee);
    const ok = c?.type === 'Identifier' ? locals.has(c.name) : c?.type === 'MemberExpression' && c.object.type === 'Identifier' && locals.has(c.object.name);
    if (!ok) return null;
    const opts = unwrap(x.arguments[0]);
    const p = opts?.type === 'ObjectExpression' ? opts.properties.find((q: N) => q.type === 'Property' && keyName(q.key, q.computed) === 'prefix') : null;
    return (p ? strValue(p.value) ?? '' : '') + prefix;
  }

  private statement(s: N) {
    switch (s.type) {
      case 'ImportDeclaration':
        return;
      case 'ExportNamedDeclaration':
        if (s.declaration) this.declaration(s.declaration, true, s);
        return;
      case 'ExportDefaultDeclaration':
        return this.exportDefault(s);
      case 'FunctionDeclaration':
      case 'ClassDeclaration':
      case 'VariableDeclaration':
      case 'TSInterfaceDeclaration':
      case 'TSTypeAliasDeclaration':
      case 'TSEnumDeclaration':
        return this.declaration(s, false, s);
      default:
        this.visit(s);
    }
  }

  private declaration(d: N, exported: boolean, outer: N) {
    switch (d.type) {
      case 'FunctionDeclaration':
        if (d.id && d.body) this.fn(d.id.name, d, exported, null, outer);
        return;
      case 'ClassDeclaration':
        return this.klass(d.id?.name ?? 'default', d, exported, outer);
      case 'VariableDeclaration':
        for (const v of d.declarations as N[]) this.declarator(v, exported, d.declarations.length === 1 ? outer : v);
        return;
      case 'TSInterfaceDeclaration':
      case 'TSTypeAliasDeclaration':
      case 'TSEnumDeclaration':
        if (exported) this.typeDecl(d, outer);
        return;
      default:
        this.visit(d);
    }
  }

  private exportDefault(s: N) {
    const d = s.declaration as N;
    if (d.type === 'FunctionDeclaration' || FN.has(d.type)) return this.fn(d.id?.name ?? 'default', d, true, null, s);
    if (d.type === 'ClassDeclaration' || d.type === 'ClassExpression') return this.klass(d.id?.name ?? 'default', d, true, s);
    if (d.type === 'TSInterfaceDeclaration') return this.typeDecl(d, s);
    if (d.type === 'Identifier') return;
    const sym = this.define('default', 'const', true, null, s, 'const', this.text(d));
    this.inside(sym, () => (unwrap(d)?.type === 'ObjectExpression' ? this.members(unwrap(d)!, sym, '') : this.visit(d)));
  }

  private declarator(d: N, exported: boolean, span: N) {
    this.capture(d);
    if (d.id.type !== 'Identifier') return this.visit(d.init);
    const name = d.id.name as string;
    const init = unwrap(d.init);
    if (init && FN.has(init.type)) return this.fn(name, init, exported, null, span);
    if (init?.type === 'ClassExpression') return this.klass(name, init, exported, span);
    if (!this.isSymbolDeclarator(d, exported)) return this.visit(d.init);
    // `export const chat = call;` aliases a local function: it is one.
    const alias = init?.type === 'Identifier' ? this.symbols.find((s) => s.parent === null && s.name === init.name)?.kind : undefined;
    const kind: SymbolKind = alias && alias !== 'const' && alias !== 'type' ? alias : 'const';
    const sym = this.define(name, kind, exported, null, span, `const ${this.text(d.id.typeAnnotation)}`, this.text(d.init));
    this.inside(sym, () => (init?.type === 'ObjectExpression' ? this.members(init, sym, '') : this.visit(d.init)));
  }

  /** Methods of an object literal held by a symbol: `newsSummarize.run`, nested `api.runs.list`. */
  private members(obj: N, parent: SymbolFact, prefix: string) {
    for (const p of obj.properties as N[]) {
      if (p.type !== 'Property') {
        this.visit(p);
        continue;
      }
      const key = keyName(p.key, p.computed);
      const v = unwrap(p.value);
      if (p.computed) this.visit(p.key);
      if (key && v && (p.method || FN.has(v.type))) this.fn(prefix + key, v, false, parent, p, 'method');
      else if (key && v?.type === 'ObjectExpression') this.members(v, parent, `${prefix}${key}.`);
      else this.visit(p.value);
    }
  }

  private fn(name: string, node: N, exported: boolean, parent: SymbolFact | null, span: N, kind?: SymbolKind) {
    const k = kind ?? (this.jsx && /^[A-Z]/.test(name) ? 'component' : 'function');
    const sym = this.define(name, k, exported, parent, span, this.fnSig(node), this.text(node.body));
    this.nodeSym.set(node, sym.id);
    this.inside(sym, () => this.fnBody(node));
  }

  private klass(name: string, node: N, exported: boolean, span: N) {
    const sig = `class ${this.text(node.typeParameters)} ${this.text(node.superClass)} ${(node.implements ?? []).map((i: N) => this.text(i)).join(',')}`;
    const sym = this.define(name, 'class', exported, null, span, sig, this.text(node.body));
    this.nodeSym.set(node, sym.id);
    const prev = this.cls;
    this.cls = sym;
    this.inside(sym, () => {
      for (const dec of node.decorators ?? []) this.visit(dec);
      this.visit(node.superClass);
      for (const m of node.body.body as N[]) {
        const key = m.key ? keyName(m.key, m.computed) : null;
        const value = unwrap(m.value);
        if ((m.type === 'MethodDefinition' || m.type === 'TSAbstractMethodDefinition') && key && value?.body) {
          for (const dec of m.decorators ?? []) this.visit(dec);
          this.fn(m.kind === 'constructor' ? 'constructor' : key, value, false, sym, m, 'method');
        } else if (m.type === 'PropertyDefinition' && key && value && FN.has(value.type)) {
          this.fn(key, value, false, sym, m, 'method');
        } else this.visit(m);
      }
    });
    this.cls = prev;
  }

  private typeDecl(d: N, span: N) {
    const sym = this.define(d.id.name, 'type', true, null, span, this.text(d), this.text(d));
    const body: N[] = d.type === 'TSInterfaceDeclaration' ? d.body.body : d.typeAnnotation?.type === 'TSTypeLiteral' ? d.typeAnnotation.members : [];
    for (const m of body) {
      const key = m.key ? keyName(m.key, m.computed) : null;
      if (!key || (m.type !== 'TSPropertySignature' && m.type !== 'TSMethodSignature')) continue;
      const fnType = m.type === 'TSMethodSignature' || m.typeAnnotation?.typeAnnotation?.type === 'TSFunctionType';
      this.define(key, fnType ? 'method' : 'property', false, sym, m, this.text(m), this.text(m));
    }
  }

  private define(name: string, kind: SymbolKind, exported: boolean, parent: SymbolFact | null, span: N, sig: string, body: string): SymbolFact {
    const qual = parent ? `${parent.name}.${name}` : name;
    const n = (this.used.get(qual) ?? 0) + 1;
    this.used.set(qual, n);
    const full = n === 1 ? qual : `${qual}~${n}`;
    const sym: SymbolFact = {
      id: `${this.path}#${full}`, file: this.path, name: full, kind, exported, parent: parent?.id ?? null,
      span: { start: span.start, end: span.end }, sigHash: '', bodyHash: hashText(squash(body)),
    };
    this.sigText.set(sym.id, `${kind}|${squash(sig)}`);
    this.symbols.push(sym);
    return sym;
  }

  private fnSig(f: N): string {
    const params = f.params?.length ? this.source.slice(f.params[0].start, f.params[f.params.length - 1].end) : '';
    return `${f.async ? 'async ' : ''}${f.generator ? '*' : ''}${this.text(f.typeParameters)}(${params}):${this.text(f.returnType)}`;
  }

  private text(n: N | null | undefined): string {
    return n ? this.source.slice(n.start, n.end) : '';
  }

  private inside(sym: SymbolFact, fn: () => void) {
    const prev = this.current;
    this.current = sym;
    fn();
    this.current = prev;
  }

  private fnBody(f: N) {
    for (const p of f.params ?? []) this.visit(p);
    this.visit(f.body);
  }

  // ---- expressions

  private visit(node: N | null | undefined): void {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'CallExpression':
      case 'NewExpression':
        this.call(node);
        break;
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        // Top-level anonymous callbacks (route handlers, `createServer(…)`, `describe(…)`) get their own symbol.
        if (!this.current) {
          this.cbCount++;
          return this.fn(`<cb${this.cbCount}>`, node, false, null, node, 'function');
        }
        break;
      case 'VariableDeclarator':
        this.capture(node);
        break;
      case 'ImportDeclaration':
      case 'TSInterfaceDeclaration':
      case 'TSTypeAliasDeclaration':
      case 'TSDeclareFunction':
        return;
    }
    for (const key of visitorKeys[node.type] ?? []) {
      if (SKIP_KEYS.has(key)) continue;
      const child = node[key];
      if (Array.isArray(child)) for (const c of child) this.visit(c);
      else if (child && typeof child === 'object') this.visit(child);
    }
  }

  /** Bindings from `const { a } = await import('x')`, `const m = require('x')`. */
  private capture(d: N) {
    let init = unwrap(d.init);
    if (init?.type === 'AwaitExpression') init = unwrap(init.argument);
    let spec: string | null = null;
    if (init?.type === 'ImportExpression') spec = strValue(init.source);
    else if (init?.type === 'CallExpression' && init.callee.type === 'Identifier' && init.callee.name === 'require' && init.arguments.length === 1) spec = strValue(init.arguments[0]);
    if (spec === null) return;
    if (d.id.type === 'Identifier') this.bindings.set(d.id.name, { spec, name: '*' });
    else if (d.id.type === 'ObjectPattern') {
      for (const p of d.id.properties as N[]) {
        const key = p.type === 'Property' ? keyName(p.key, p.computed) : null;
        const local = p.value?.type === 'AssignmentPattern' ? p.value.left : p.value;
        if (key && local?.type === 'Identifier') this.bindings.set(local.name, { spec, name: key });
      }
    }
  }

  private call(node: N) {
    const callee = unwrap(node.callee);
    if (!callee) return;
    const to = this.target(callee);
    const from = this.current?.id ?? this.path;
    if (to && to !== from) {
      const key = `${from}\u0000${to}`;
      const c = this.calls.get(key);
      if (c) c.count++;
      else this.calls.set(key, { from, to, confidence: 'syntactic', count: 1 });
    }
    if (node.type === 'CallExpression') this.frameworkRoute(node, callee);
  }

  /** Callee → symbol id (`file#name.member`), `vendor:<pkg>`, or null when it isn't an import or a top-level symbol. */
  private target(callee: N): string | null {
    const chain: string[] = [];
    let root: N | null = callee;
    while (root?.type === 'MemberExpression') {
      const prop = root.computed ? strValue(root.property) : root.property.type === 'Identifier' ? root.property.name : null;
      if (prop === null) return null;
      chain.unshift(prop);
      root = unwrap(root.object);
    }
    if (!root) return null;
    if (root.type === 'ThisExpression') return this.cls && chain.length ? `${this.path}#${[this.cls.name, ...chain].join('.')}` : null;
    if (root.type !== 'Identifier') return null;
    const b = this.bindings.get(root.name);
    if (b) return this.linkImport(b, chain);
    return this.topNames.has(root.name) ? `${this.path}#${[root.name, ...chain].join('.')}` : null;
  }

  private res(from: string, spec: string): string | null {
    const key = `${from}\u0000${spec}`;
    let hit = this.resolved.get(key);
    if (hit === undefined) this.resolved.set(key, (hit = this.resolve(from, spec)));
    return hit;
  }

  private linkImport(b: Binding, chain: string[]): string | null {
    let file = this.res(this.path, b.spec);
    if (!file || file.startsWith('vendor:')) return file;
    let name = b.name;
    const rest = [...chain];
    for (let hops = 0; hops < 4; hops++) {
      if (name === '*') {
        const next = rest.shift();
        if (next === undefined) return file;
        name = next;
      }
      const t = this.follow(file, name, 0);
      if (t.file.startsWith('vendor:')) return t.file;
      file = t.file;
      name = t.name;
      if (name !== '*') break;
    }
    return `${file}#${[name, ...rest].join('.')}`;
  }

  /** Follow `name` exported by `file` through re-exports and `export *` to where it is defined. */
  private follow(file: string, name: string, depth: number): { file: string; name: string; found: boolean } {
    const rec = depth > 8 ? null : this.ctx.recordOf?.(file);
    if (!rec) return { file, name, found: false };
    const e = rec.exports.get(name);
    if (e) {
      if ('local' in e) return { file, name: e.local, found: true };
      const to = this.res(file, e.spec);
      if (!to) return { file, name, found: true };
      if (to.startsWith('vendor:') || e.name === '*') return { file: to, name: e.name, found: true };
      return this.follow(to, e.name, depth + 1);
    }
    for (const star of rec.stars) {
      const to = this.res(file, star);
      if (!to || to.startsWith('vendor:')) continue;
      const t = this.follow(to, name, depth + 1);
      if (t.found) return t;
    }
    return { file, name, found: false };
  }

  /** `app.get('/x', h)` on an Express/Hono/Fastify/Koa-router instance; Fastify's `app.route({ method, url, handler })`. */
  private frameworkRoute(node: N, callee: N) {
    if (callee.type !== 'MemberExpression' || callee.computed || callee.object.type !== 'Identifier' || !this.receivers.has(callee.object.name)) return;
    const method = callee.property.name as string;
    const args = node.arguments as N[];
    const enclosing = this.current?.id ?? null;
    const prefix = this.receivers.get(callee.object.name)!;
    if (ROUTE_METHODS.has(method) && args.length >= 2) {
      const path = strValue(args[0]);
      if (path !== null) this.pending.push({ method, path: prefix + path, handler: args[args.length - 1] ?? null, enclosing });
    } else if (method === 'route' && unwrap(args[0])?.type === 'ObjectExpression') {
      const props = new Map<string, N>();
      for (const p of unwrap(args[0])!.properties as N[]) {
        const k = p.type === 'Property' ? keyName(p.key, p.computed) : null;
        if (k) props.set(k, p.value);
      }
      const url = strValue(props.get('url') ?? props.get('path'));
      const m = props.get('method');
      const methods = unwrap(m)?.type === 'ArrayExpression' ? (unwrap(m)!.elements as N[]).map(strValue) : [strValue(m)];
      if (url !== null) for (const x of methods) if (x) this.pending.push({ method: x, path: prefix + url, handler: props.get('handler') ?? null, enclosing });
    }
  }
}

/**
 * Point each call at the deepest symbol that exists: `db.ts#db.all` stays if `db.all` is a symbol, `registry.get` on a Map
 * becomes `#registry`, and a member nothing defines becomes the file path. `symbolsOf` gives a file's symbol names
 * (null = unknown, leave as is). Calls that collapse onto the same target are merged; self-calls drop.
 */
export function settleCalls(calls: readonly CallFact[], symbolsOf: (file: string) => ReadonlySet<string> | null): CallFact[] {
  const out = new Map<string, CallFact>();
  for (const c of calls) {
    let to = c.to;
    const hash = to.indexOf('#');
    if (!to.startsWith('vendor:') && hash !== -1) {
      const file = to.slice(0, hash);
      const names = symbolsOf(file);
      if (names) {
        const parts = to.slice(hash + 1).split('.');
        while (parts.length && !names.has(parts.join('.'))) parts.pop();
        to = parts.length ? `${file}#${parts.join('.')}` : file;
      }
    }
    if (to === c.from || (!to.includes('#') && c.from.startsWith(`${to}#`))) continue;
    const key = `${c.from}\u0000${to}`;
    const prev = out.get(key);
    if (prev) prev.count += c.count;
    else out.set(key, { ...c, to });
  }
  return [...out.values()];
}
