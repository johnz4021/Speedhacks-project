// Table reads in code, and tables defined by `.sql` schema files. Text-based like the write adapters; browser-safe.
import type { FileFacts } from '../contracts/facts';
import type { WriteHit } from './adapters';
import { hashText } from './hash';

const each = (re: RegExp, code: string, fn: (m: RegExpMatchArray) => void) => {
  for (const m of code.matchAll(re)) fn(m);
};
const LIT = String.raw`(?:"([^"\\\n]+)"|'([^'\\\n]+)'|\`([^\`\\$]+)\`)`;
/** Type arguments between a method name and its call: `db.get<RunRow>(`, `db.query<Pick<Row, "name">>(`. */
const TARGS = String.raw`(?:<[^()]*?>\s*)?`;

/** Scout: `db.get("t", id)`, `db.where("t", …)`, `db.all("t")`, `db.count("t")`. */
const SCOUT = new RegExp(String.raw`(?<![\w$])db\s*\.\s*(?:get|where|all|count)\s*${TARGS}\(\s*${LIT}`, 'g');
/** `db.query(sql)`, `pool.query(sql)`, `sql.unsafe(sql)`, `knex.raw(sql)`: the first argument is SQL whatever its case. */
const QUERY = new RegExp(String.raw`(?<![\w$])(?:db|pool|client|conn|connection|sql|knex)\s*\.\s*(?:query|execute|raw|unsafe)\s*${TARGS}\(\s*(["'\`])`, 'g');
/** A string or template literal that starts like a read (upper-case keywords, so prose is skipped). */
const SQL_LITERAL = /(["'`])\s*(?:SELECT|WITH)\s/g;
/** Table names after FROM / JOIN in SQL text; `from (subquery)` and functions are skipped. */
const FROM = /\b(?:from|join)\s+(?:only\s+)?["`]?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)["`]?(?!\s*\()/gi;
/** Prisma: `prisma.user.findMany(…)`. */
const PRISMA = /(?<![\w$])(?:prisma|tx)\s*\.\s*([a-z][\w$]*)\s*\.\s*(?:findMany|findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|count|aggregate|groupBy)\s*\(/g;
/** Drizzle: `db.select().from(users)`, `db.query.users.findMany(…)`. */
const DRIZZLE_FROM = /\.\s*from\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
const DRIZZLE_QUERY = /\bquery\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*(?:findMany|findFirst)\s*\(/g;
/** Kysely: `db.selectFrom("t")`. */
const KYSELY = /\.\s*selectFrom\s*\(\s*(['"`])([\w.]+)\1/g;

/** The literal starting at `open` (its quote), up to the matching close quote; templates may span lines. */
function literalAt(code: string, open: number): string {
  const q = code[open]!;
  let i = open + 1;
  while (i < code.length && code[i] !== q) i += code[i] === '\\' ? 2 : 1;
  return code.slice(open + 1, i);
}

const SQL_WORDS = new Set(['select', 'where', 'lateral', 'unnest', 'generate_series', 'jsonb_each', 'json_each']);
function sqlTables(sql: string): string[] {
  const out = new Set<string>();
  each(FROM, sql, (m) => {
    const t = m[1]!.split('.').pop()!;
    if (!SQL_WORDS.has(t.toLowerCase())) out.add(t);
  });
  return [...out];
}

/** Table reads in `code` (comments already blanked), in source order. */
export function findReads(code: string): WriteHit[] {
  const out: WriteHit[] = [];
  const seenSql = new Set<number>();
  if (/\bdb\s*\./.test(code)) each(SCOUT, code, (m) => out.push({ table: (m[1] ?? m[2] ?? m[3])!, via: 'db', at: m.index! }));
  if (/\.\s*(?:query|execute|raw|unsafe)\b/.test(code)) {
    each(QUERY, code, (m) => {
      const open = m.index! + m[0].length - 1;
      seenSql.add(open);
      for (const table of sqlTables(literalAt(code, open))) out.push({ table, via: 'sql', at: m.index! });
    });
  }
  if (/\b(?:SELECT|WITH)\s/.test(code)) {
    each(SQL_LITERAL, code, (m) => {
      if (seenSql.has(m.index!)) return;
      for (const table of sqlTables(literalAt(code, m.index!))) out.push({ table, via: 'sql', at: m.index! });
    });
  }
  if (/\b(?:prisma|tx)\s*\./.test(code)) each(PRISMA, code, (m) => out.push({ table: m[1]!, via: 'prisma', at: m.index! }));
  if (/\.\s*select\s*\(/.test(code)) each(DRIZZLE_FROM, code, (m) => out.push({ table: m[1]!, via: 'drizzle', at: m.index! }));
  if (/\bquery\s*\./.test(code)) each(DRIZZLE_QUERY, code, (m) => out.push({ table: m[1]!, via: 'drizzle', at: m.index! }));
  if (/\.\s*selectFrom\b/.test(code)) each(KYSELY, code, (m) => out.push({ table: m[2]!, via: 'kysely', at: m.index! }));
  return out.sort((x, y) => x.at - y.at);
}

const CONSTRAINT = /^(?:constraint|primary|foreign|unique|check|exclude|like|period)\b/i;
const CREATE = /\bcreate\s+(?:or\s+replace\s+)?(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:[`"[]?\w+[`"\]]?\.)?[`"[]?\w+[`"\]]?)\s*\(/gi;

/** `CREATE TABLE [IF NOT EXISTS] name (cols…)` statements: table names (schema prefix dropped) and column names. */
export function parseSqlTables(sql: string): { name: string; columns: string[] }[] {
  const text = sql.replace(/--[^\n]*/g, (c) => ' '.repeat(c.length)).replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const out: { name: string; columns: string[] }[] = [];
  each(CREATE, text, (m) => {
    const name = m[1]!.replace(/[`"[\]]/g, '').split('.').pop()!;
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    const parts: string[] = [];
    let from = start;
    for (; i < text.length && depth > 0; i++) {
      const c = text[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === "'") { i++; while (i < text.length && text[i] !== "'") i++; }
      if ((c === ',' && depth === 1) || depth === 0) {
        parts.push(text.slice(from, i));
        from = i + 1;
      }
    }
    const columns = parts.map((p) => p.trim()).filter((p) => p && !CONSTRAINT.test(p)).map((p) => /^[`"[]?([\w$]+)/.exec(p)?.[1] ?? '').filter(Boolean);
    out.push({ name, columns });
  });
  return out;
}

/** Facts for a `.sql` schema file: the tables it defines (no symbols, calls or imports). */
export function sqlFacts(path: string, source: string): FileFacts {
  return { path, hash: hashText(source), imports: [], writes: [], reads: [], tables: parseSqlTables(source), symbols: [], calls: [], routes: [], entries: [] };
}
