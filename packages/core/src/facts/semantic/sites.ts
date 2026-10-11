// Where Tier 2 asks the checker: every call/new site (oxc gives positions) attributed to the enclosing Tier 1 symbol,
// and every place a class or a typed object literal implements a type (`implements I`, `extends B`, `const x: I = {…}`,
// `{…} satisfies I`). Node-only (oxc-parser).
import { parseSync, visitorKeys } from 'oxc-parser';
import type { SymbolFact } from '../../contracts/facts';
import { parseName } from '../record';

/** A call or `new`: `at` is the callee identifier (or member name) offset; `from` the enclosing symbol id or the file. */
export type CallSite = { at: number; from: string };
/** A type a class/object implements: `at` is its name; `members` maps member names to the implementing symbol ids. */
export type ImplSite = { at: number; members: { name: string; id: string }[] };

type N = { type: string; start: number; end: number; [key: string]: any };
const WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression', 'TSTypeAssertion', 'TSInstantiationExpression', 'ChainExpression']);
const FN = new Set(['ArrowFunctionExpression', 'FunctionExpression']);
const unwrap = (n: N | null | undefined): N | null => {
  let x = n ?? null;
  while (x && WRAPPERS.has(x.type)) x = x.expression;
  return x;
};
const keyName = (key: N, computed: boolean): string | null => {
  if (!computed && key.type === 'Identifier') return key.name;
  if (key.type === 'PrivateIdentifier') return `#${key.name}`;
  return key.type === 'Literal' && typeof key.value === 'string' ? key.value : null;
};
/** Offset of the name a callee or type reference ends in: `f`, `a.b.f`, `new ns.C`, `I<T>`, `ns.I`. */
function namePos(n: N | null | undefined): number | null {
  const x = unwrap(n);
  if (!x) return null;
  if (x.type === 'Identifier') return x.start;
  if (x.type === 'MemberExpression') return !x.computed ? x.property.start : x.property.type === 'Literal' && typeof x.property.value === 'string' ? x.property.start : null;
  if (x.type === 'TSQualifiedName') return x.right.start;
  if (x.type === 'TSTypeReference') return namePos(x.typeName);
  return null;
}

/**
 * Call and implementation sites of `source`. `symbols` are the file's Tier 1 symbols for this exact text: calls are
 * attributed to the innermost one whose span contains them, and implementing members must be one of them.
 */
export function scanSites(path: string, source: string, symbols: readonly SymbolFact[]): { calls: CallSite[]; impls: ImplSite[] } {
  const calls: CallSite[] = [];
  const impls: ImplSite[] = [];
  const r = parseSync(parseName(path), source);
  if (r.errors.length) return { calls, impls };
  const ids = new Set(symbols.map((s) => s.id));
  const enclosing = (at: number): string => {
    let best: SymbolFact | null = null;
    for (const s of symbols) {
      if (s.span.start <= at && at < s.span.end && (!best || s.span.end - s.span.start < best.span.end - best.span.start)) best = s;
    }
    return best?.id ?? path;
  };
  const owned = (owner: string, keys: string[]) =>
    keys.flatMap((name) => (ids.has(`${path}#${owner}.${name}`) ? [{ name, id: `${path}#${owner}.${name}` }] : []));
  const implement = (type: N | null | undefined, owner: string, keys: string[]) => {
    const at = namePos(type);
    const members = owned(owner, keys);
    if (at !== null && members.length) impls.push({ at, members });
  };
  const classKeys = (body: N[]) =>
    body.flatMap((m) => {
      const key = m.key ? keyName(m.key, m.computed) : null;
      if (!key) return [];
      if (m.type === 'MethodDefinition' || m.type === 'TSAbstractMethodDefinition') return [m.kind === 'constructor' ? 'constructor' : key];
      return m.type === 'PropertyDefinition' && FN.has(unwrap(m.value)?.type ?? '') ? [key] : [];
    });
  const objectKeys = (obj: N) =>
    (obj.properties as N[]).flatMap((p) => {
      const key = p.type === 'Property' ? keyName(p.key, p.computed) : null;
      return key && (p.method || FN.has(unwrap(p.value)?.type ?? '')) ? [key] : [];
    });
  const klass = (c: N, name: string) => {
    const keys = classKeys(c.body.body as N[]);
    for (const i of (c.implements ?? []) as N[]) implement(i.expression, name, keys);
    if (c.superClass) implement(c.superClass, name, keys);
  };

  const visit = (node: N | null | undefined, name: string | null): void => {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'CallExpression':
      case 'NewExpression': {
        const at = namePos(node.callee);
        if (at !== null && unwrap(node.callee)?.type !== 'Super') calls.push({ at, from: enclosing(at) });
        break;
      }
      case 'ClassDeclaration':
        klass(node, node.id?.name ?? 'default');
        break;
      case 'ClassExpression':
        klass(node, name ?? node.id?.name ?? 'default'); // `const X = class Y {}` is `X` in Tier 1
        break;
      case 'VariableDeclarator': {
        const init = unwrap(node.init);
        if (node.id.type !== 'Identifier' || init?.type !== 'ObjectExpression') break;
        const keys = objectKeys(init);
        const ann = node.id.typeAnnotation?.typeAnnotation;
        if (ann?.type === 'TSTypeReference') implement(ann, node.id.name, keys);
        for (let x: N | null = node.init; x && x !== init; x = x.expression) if (x.type === 'TSSatisfiesExpression') implement(x.typeAnnotation, node.id.name, keys);
        break;
      }
      case 'ExportDefaultDeclaration': {
        const d = node.declaration as N;
        if (d.type === 'TSSatisfiesExpression' && unwrap(d)?.type === 'ObjectExpression') implement(d.typeAnnotation, 'default', objectKeys(unwrap(d)!));
        break;
      }
    }
    // A declarator's name reaches its (possibly wrapped) initializer, so class expressions are named like Tier 1 names them.
    const pass = node.type === 'VariableDeclarator' && node.id.type === 'Identifier' ? node.id.name : WRAPPERS.has(node.type) ? name : null;
    for (const key of visitorKeys[node.type] ?? []) walk(node[key], key === 'init' || WRAPPERS.has(node.type) ? pass : null);
  };
  const walk = (child: unknown, name: string | null) => {
    if (Array.isArray(child)) for (const c of child) visit(c as N, name);
    else if (child && typeof child === 'object') visit(child as N, name);
  };
  visit(r.program as unknown as N, null);
  return { calls, impls };
}
