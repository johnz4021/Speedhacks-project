// Syntactic stand-ins for dispatch that Tier 1 call facts can't see, so journeys can pass through registries and
// module-level clients (NAVIGATION_PLAN §3.1 "Tier 2" will produce typed `implements` and calls; when its edges are in the
// graph they are used as they are). Pure and browser-safe; used only for journeys, never by the gate or the map.
import type { FileFacts, SymbolFact } from '../contracts/facts';
import type { SourceFile } from './fetches';

/** An edge journeys add on a copy of the graph: interface dispatch (`calls` to a member, `implements` from each implementation) or a call through a module-level instance. */
export type InferredEdge = { kind: 'calls' | 'implements'; from: string; to: string; confidence: 'dispatch' | 'inferred' };

const last = (name: string) => name.slice(name.lastIndexOf('.') + 1);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function innermost(symbols: readonly SymbolFact[], at: number): SymbolFact | null {
  let best: SymbolFact | null = null;
  for (const s of symbols) {
    if (s.kind === 'type' || s.span.end <= s.span.start || at < s.span.start || at >= s.span.end) continue;
    if (!best || s.span.end - s.span.start < best.span.end - best.span.start) best = s;
  }
  return best;
}

/**
 * 1. **Interface dispatch.** A method member `I.m` of an interface/type with at least two implementations — methods named
 *    `m` on a const or class in a file that is I's file or imports it — becomes a hub: each implementation `implements`
 *    it, and every symbol whose own code calls `.m(` from a file that imports I's file (directly or through one file)
 *    `calls` it (confidence `dispatch`). Scout: `runAgent` → `Tool.run` → each tool's `run`; `complete` → `ChatProvider.chat`.
 * 2. **Module-level instances.** `const client = new Anthropic()` at the top of a file: a symbol in that file that uses
 *    `client.` calls what the instance was made from (confidence `inferred`). Scout: `newsSummarize.run` → `Anthropic`.
 * Deterministic: edges sorted and deduplicated.
 */
export function inferDispatch(files: readonly SourceFile[], facts: Readonly<Record<string, FileFacts>>): InferredEdge[] {
  const out = new Map<string, InferredEdge>();
  const add = (e: InferredEdge) => { if (e.from !== e.to) out.set(`${e.kind}|${e.from}|${e.to}`, e); };
  const byId = new Map(Object.values(facts).flatMap((f) => f.symbols.map((s) => [s.id, s] as const)));
  const imports = (path: string) => new Set((facts[path]?.imports ?? []).map((i) => i.to));
  const sees = (path: string, target: string) => {
    if (path === target) return true;
    const direct = imports(path);
    return direct.has(target) || [...direct].some((d) => imports(d).has(target));
  };

  const source = new Map(files.map((f) => [f.path, f.source]));
  /** The owner is declared as the interface: `const x: I = {` or `class X implements I`. */
  const declaredAs = (owner: SymbolFact, iface: string) => {
    const text = source.get(owner.file);
    if (!text || owner.span.end <= owner.span.start) return false;
    const lineStart = text.lastIndexOf('\n', owner.span.start) + 1;
    const open = text.slice(lineStart, owner.span.end).search(/[={]/);
    const header = text.slice(lineStart, open < 0 ? owner.span.end : lineStart + open + 1);
    return new RegExp(`(?::\\s*(?:[\\w$]+\\.)?${esc(iface)}\\b|\\bimplements\\s+[^{]*\\b${esc(iface)}\\b)`).test(header);
  };
  /** `receiver` is bound by an import in `text` (a module object such as `api`, not an instance). */
  const imported = (text: string, receiver: string) => new RegExp(`\\bimport\\b[^;]*\\b${esc(receiver)}\\b[^;]*\\bfrom\\b`).test(text);

  // 1. interface members with ≥ 2 implementations
  const members = Object.values(facts).flatMap((f) => f.symbols.filter((s) => s.kind === 'method' && s.parent && byId.get(s.parent)?.kind === 'type'));
  for (const member of members.sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const m = last(member.name);
    const iface = byId.get(member.parent!)!.name;
    const impls = Object.values(facts).filter((f) => f.path === member.file || imports(f.path).has(member.file)).flatMap((f) => f.symbols.filter((s) => {
      const owner = s.parent ? byId.get(s.parent) : undefined;
      return s.kind === 'method' && last(s.name) === m && s.id !== member.id && !!owner && (owner.kind === 'const' || owner.kind === 'class') && declaredAs(owner, iface);
    }));
    if (impls.length < 2) continue;
    for (const s of impls) add({ kind: 'implements', from: s.id, to: member.id, confidence: 'dispatch' });
    const call = new RegExp(`([A-Za-z_$][\\w$]*)?\\s*\\??\\.\\s*${esc(m)}\\s*\\(`, 'g');
    for (const file of files) {
      if (!sees(file.path, member.file)) continue;
      for (const hit of file.source.matchAll(call)) {
        if (hit[1] && imported(file.source, hit[1])) continue;
        const at = innermost(file.symbols, hit.index);
        if (at && !impls.some((s) => s.id === at.id) && at.id !== member.id) add({ kind: 'calls', from: at.id, to: member.id, confidence: 'dispatch' });
      }
    }
  }

  // 2. module-level instances
  for (const file of files) {
    const f = facts[file.path];
    if (!f) continue;
    for (const d of file.source.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*new\s+([A-Za-z_$][\w$]*)/gm)) {
      const [, v, ctor] = d as unknown as [string, string, string];
      const inside = innermost(file.symbols, d.index);
      if (inside && inside.name !== v) continue; // only top-level declarations
      const target = f.calls.find((c) => c.from === file.path && (c.to.endsWith(`#${ctor}`) || c.to.endsWith(`.${ctor}`)))?.to;
      if (!target) continue;
      for (const use of file.source.matchAll(new RegExp(`(?<![\\w$.])${esc(v)}\\s*\\??\\.`, 'g'))) {
        const at = innermost(file.symbols, use.index);
        if (at) add({ kind: 'calls', from: at.id, to: target, confidence: 'inferred' });
      }
    }
  }
  return [...out.values()].sort((a, b) => (`${a.kind}|${a.from}|${a.to}` < `${b.kind}|${b.from}|${b.to}` ? -1 : 1));
}
