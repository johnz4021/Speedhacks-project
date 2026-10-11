// Write adapters: table writes found in comment-free code. Text-based so the edit gate needs no AST, and the
// gate, the load scan and extractFacts all see the same writes. Browser-safe.

export type WriteHit = { table: string; via: string; at: number };

type Adapter = { via: string; guard: RegExp; find: (code: string, out: WriteHit[]) => void };

const each = (re: RegExp, code: string, fn: (m: RegExpMatchArray) => void) => {
  for (const m of code.matchAll(re)) fn(m);
};

/** Scout: `db.insert("t", …)` / `db.update("t", …)` with a literal table name. */
const SCOUT = /(?<![\w$])db\s*\.\s*(?:insert|update)\s*\(\s*(?:"([^"\\\n]+)"|'([^'\\\n]+)'|`([^`\\$]+)`)/g;
/** Prisma: `prisma.user.create(…)`, `tx.post.updateMany(…)`. */
const PRISMA = /(?<![\w$])(?:prisma|tx)\s*\.\s*([a-z][\w$]*)\s*\.\s*(?:create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\s*\(/g;
/** Drizzle: `db.insert(users).values(…)`, `.update(users).set(…)`, `.delete(users).where(…)`. */
const DRIZZLE = /\.\s*(?:insert|update|delete)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\.\s*(?:values|set|where|returning|onConflictDoNothing|onConflictDoUpdate)\s*\(/g;
/** Knex: `knex("t")…insert(…)`, `trx("t").update(…)`, `knex.table("t").del()`. */
const KNEX = /(?<![\w$])(?:knex|trx)\s*(?:\.\s*(?:table|into|from)\s*)?\(\s*(['"`])([\w.]+)\1\s*\)/g;
const KNEX_WRITE = /^[^;]{0,400}?\.\s*(?:insert|update|del|delete|upsert|merge|increment|decrement)\s*\(/;
/** Kysely: `db.insertInto("t")`, `.updateTable("t")`, `.deleteFrom("t")`. */
const KYSELY = /\.\s*(?:insertInto|replaceInto|updateTable|deleteFrom|mergeInto)\s*\(\s*(['"`])([\w.]+)\1/g;
/** Raw SQL (upper-case keywords, so prose like "Delete from cart" is skipped) at the start of a string or template literal. */
const SQL = /(['"`])\s*(?:(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO|DELETE\s+FROM|MERGE\s+INTO|UPDATE)\s+[`"[]?([A-Za-z_][\w.]*)[`"\]]?(\s+SET\b)?/g;

const ADAPTERS: Adapter[] = [
  { via: 'db', guard: /\bdb\s*\./, find: (code, out) => each(SCOUT, code, (m) => out.push({ table: (m[1] ?? m[2] ?? m[3])!, via: 'db', at: m.index! })) },
  { via: 'prisma', guard: /\b(?:prisma|tx)\s*\./, find: (code, out) => each(PRISMA, code, (m) => out.push({ table: m[1]!, via: 'prisma', at: m.index! })) },
  { via: 'drizzle', guard: /\.\s*(?:insert|update|delete)\s*\(/, find: (code, out) => each(DRIZZLE, code, (m) => out.push({ table: m[1]!, via: 'drizzle', at: m.index! })) },
  {
    via: 'knex',
    guard: /\b(?:knex|trx)\b/,
    find: (code, out) => each(KNEX, code, (m) => {
      const after = code.slice(m.index! + m[0].length, m.index! + m[0].length + 400);
      if (KNEX_WRITE.test(after)) out.push({ table: m[2]!, via: 'knex', at: m.index! });
    }),
  },
  { via: 'kysely', guard: /\.\s*(?:insertInto|replaceInto|updateTable|deleteFrom|mergeInto)\b/, find: (code, out) => each(KYSELY, code, (m) => out.push({ table: m[2]!, via: 'kysely', at: m.index! })) },
  {
    via: 'sql',
    guard: /\b(?:INSERT|REPLACE|DELETE|MERGE|UPDATE)\s/,
    find: (code, out) => each(SQL, code, (m) => {
      if (/^\s*UPDATE/.test(code.slice(m.index! + 1, m.index! + 12)) && !m[3]) return; // UPDATE needs SET
      out.push({ table: m[2]!, via: 'sql', at: m.index! });
    }),
  },
];

/** Table writes in `code` (comments already blanked), in source order. */
export function findWrites(code: string): WriteHit[] {
  const out: WriteHit[] = [];
  for (const a of ADAPTERS) if (a.guard.test(code)) a.find(code, out);
  return out.sort((x, y) => x.at - y.at);
}

/** `source` with the given comment spans replaced by spaces (offsets kept). */
export function maskComments(source: string, comments: readonly { start: number; end: number }[]): string {
  if (comments.length === 0) return source;
  let out = '';
  let at = 0;
  for (const c of comments) {
    out += source.slice(at, c.start) + source.slice(c.start, c.end).replace(/[^\n]/g, ' ');
    at = c.end;
  }
  return out + source.slice(at);
}
