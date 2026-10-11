import YAML, { isMap, isSeq, type Node } from 'yaml';
import type { DomainMap } from './schema';

const flow = (value: unknown) => YAML.stringify(value, { collectionStyle: 'flow', lineWidth: 0 }).trimEnd();

/** End of the source line on which `node`'s value ends (before any trailing comment's newline). */
function lineEndAfter(text: string, node: Node): number {
  let p = node.range![1];
  while (p > 0 && /\s/.test(text[p - 1]!)) p--;
  const nl = text.indexOf('\n', p);
  return nl === -1 ? text.length : nl;
}

function column(text: string, offset: number): number {
  return offset - (text.lastIndexOf('\n', offset - 1) + 1);
}

/**
 * Append `value` to the list at `key` of invariant `invariantId`, creating the key if missing.
 * Splices text into the original so comments, spacing and alignment elsewhere are untouched.
 */
function appendToInvariant(yamlText: string, invariantId: string, key: string, value: unknown): string {
  const doc = YAML.parseDocument(yamlText);
  const list = doc.get('invariants');
  const inv = isSeq(list) ? list.items.find((item) => isMap(item) && item.get('id') === invariantId) : undefined;
  if (!isMap(inv) || inv.items.length === 0) throw new Error(`domains.yaml has no invariant ${invariantId}`);
  const splice = (at: number, insert: string) => yamlText.slice(0, at) + insert + yamlText.slice(at);
  const item = flow(value);
  const seq = inv.get(key, true);

  if (isSeq(seq) && seq.flow) {
    const close = yamlText.lastIndexOf(']', seq.range![1] - 1);
    return splice(close, seq.items.length ? `, ${item}` : item);
  }
  if (isSeq(seq)) {
    const last = seq.items.at(-1) as Node | undefined;
    if (!last) throw new Error(`${invariantId}.${key} is malformed`);
    return splice(lineEndAfter(yamlText, last), `\n${' '.repeat(column(yamlText, seq.range![0]))}- ${item}`);
  }
  if (seq !== undefined && seq !== null) throw new Error(`${invariantId}.${key} is not a list`);
  const firstKey = inv.items[0]!.key as Node;
  const lastPair = inv.items.at(-1)!;
  const end = lineEndAfter(yamlText, (lastPair.value ?? lastPair.key) as Node);
  return splice(end, `\n${' '.repeat(column(yamlText, firstKey.range![0]))}${key}: [${item}]`);
}

/** Link decision `decisionId` to an invariant (the user chose to comply). Only the edited line changes. */
export function linkDecision(yamlText: string, invariantId: string, decisionId: string): string {
  return appendToInvariant(yamlText, invariantId, 'decisions', decisionId);
}

/** Add `{ path, decision }` to an invariant's exceptions (the user chose the exception). Only the edited line changes. */
export function addException(yamlText: string, invariantId: string, path: string, decisionId: string): string {
  return appendToInvariant(yamlText, invariantId, 'exceptions', { path, decision: decisionId });
}

/** Next free `DR-n`, above every id used by invariants, their decisions and exceptions, and `existingIds`. */
export function nextDecisionId(map: DomainMap, existingIds: string[]): string {
  const ids = [
    ...existingIds,
    ...map.invariants.flatMap((inv) => [inv.id, ...(inv.decisions ?? []), ...inv.exceptions.flatMap((e) => (e.decision ? [e.decision] : []))]),
  ];
  const max = Math.max(0, ...ids.map((id) => Number(/^DR-(\d+)$/.exec(id)?.[1] ?? 0)));
  return `DR-${max + 1}`;
}
