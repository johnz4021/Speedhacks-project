import { stripComments } from './imports';

const WRITE = /(?<![\w$])db\s*\.\s*(?:insert|update)\s*\(\s*(?:"([^"\\\n]+)"|'([^'\\\n]+)'|`([^`\\$]+)`)/g;

/** Tables written via `db.insert("t", …)` / `db.update("t", …)` with a literal table name, in source order. */
export function scanWrites(source: string): string[] {
  return [...stripComments(source).matchAll(WRITE)].map((m) => (m[1] ?? m[2] ?? m[3])!);
}
