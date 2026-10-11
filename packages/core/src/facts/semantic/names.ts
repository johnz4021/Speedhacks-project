// Shared by both resolvers: turn a declaration node into a Tier 1 style qualified name, decide whether it is an
// abstract member (calls through it are dispatch), and name the package a path belongs to.

const KIND_NAMES = [
  'SourceFile', 'FunctionDeclaration', 'ClassDeclaration', 'InterfaceDeclaration', 'TypeAliasDeclaration', 'EnumDeclaration',
  'MethodDeclaration', 'MethodSignature', 'PropertyDeclaration', 'PropertySignature', 'PropertyAssignment',
  'ShorthandPropertyAssignment', 'VariableDeclaration', 'GetAccessor', 'SetAccessor', 'Constructor', 'AbstractKeyword',
] as const;
export type KindName = (typeof KIND_NAMES)[number];

/** The parts of a compiler node (TS 6 or TS 7 remote node) the resolvers read. */
export type DeclNode = {
  readonly kind: number;
  readonly parent?: DeclNode | null;
  readonly name?: { readonly kind: number; readonly text?: string } | null;
  readonly modifiers?: ArrayLike<{ readonly kind: number }> | null;
};

/** Number → name for the kinds above, from a `SyntaxKind` enum object (TS 6 and 7 number them differently). */
export function kindTable(syntaxKind: Record<string, unknown>): (kind: number) => KindName | null {
  const map = new Map<number, KindName>();
  for (const k of KIND_NAMES) if (typeof syntaxKind[k] === 'number') map.set(syntaxKind[k] as number, k);
  return (kind) => map.get(kind) ?? null;
}

/** Declarations that contribute a segment to the qualified name; namespaces and expressions don't (Tier 1 has none). */
const NAMED = new Set<KindName>([
  'FunctionDeclaration', 'ClassDeclaration', 'InterfaceDeclaration', 'TypeAliasDeclaration', 'EnumDeclaration',
  'MethodDeclaration', 'MethodSignature', 'PropertyDeclaration', 'PropertySignature', 'PropertyAssignment',
  'ShorthandPropertyAssignment', 'VariableDeclaration', 'GetAccessor', 'SetAccessor',
]);

/**
 * `Tool.run`, `Anthropic.messages.create`, `runAgent`: names of the enclosing named declarations, outermost first.
 * `settleCalls` later trims it to the deepest Tier 1 symbol that exists. Anonymous default exports are `default`.
 */
export function qualifiedName(node: DeclNode, kindOf: (kind: number) => KindName | null): string {
  const parts: string[] = [];
  for (let n: DeclNode | null | undefined = node; n; n = n.parent) {
    const k = kindOf(n.kind);
    if (k === 'SourceFile') break;
    if (k === 'Constructor') parts.unshift('constructor');
    else if (k && NAMED.has(k)) {
      const text = n.name?.text;
      if (text) parts.unshift(text);
    }
  }
  return parts.join('.') || 'default';
}

/** Interface and type-literal members, and abstract class members: a call through one is dispatched at runtime. */
export function isAbstract(node: DeclNode, kindOf: (kind: number) => KindName | null): boolean {
  const k = kindOf(node.kind);
  if (k === 'MethodSignature' || k === 'PropertySignature') return true;
  if (k !== 'MethodDeclaration' && k !== 'PropertyDeclaration') return false;
  const mods = node.modifiers;
  if (!mods) return false;
  for (let i = 0; i < mods.length; i++) if (kindOf(mods[i]!.kind) === 'AbstractKeyword') return true;
  return false;
}

/** Package a file path belongs to (after the last `node_modules/`); `@types/x` → `x`, `@types/a__b` → `@a/b`. */
export function packageOf(path: string): string | null {
  const i = path.lastIndexOf('/node_modules/');
  if (i === -1) return null;
  const parts = path.slice(i + 14).split('/');
  const name = parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1] ?? ''}` : (parts[0] ?? '');
  if (!name) return null;
  if (!name.startsWith('@types/')) return name;
  const t = name.slice(7);
  return t.includes('__') ? `@${t.replace('__', '/')}` : t;
}
