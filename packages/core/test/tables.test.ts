// Table reads (Scout's db.get/where/all, SQL text in db.query, Prisma/Drizzle/Kysely) and `.sql` schema tables.
import { describe, expect, it } from 'vitest';
import { extractFacts } from '../src/facts/extract';
import { findReads, parseSqlTables } from '../src/facts/tables';

const tables = (code: string) => findReads(code).map((r) => `${r.via}:${r.table}`);

describe('findReads', () => {
  it('finds Scout reads with literal table names, type arguments included', () => {
    expect(tables('const r = await db.get<RunRow>("runs", id);\nreturn db.where<ContactRow>("contacts", { email }, { limit: 1 });\ndb.all(\'cost_log\');')).toEqual(['db:runs', 'db:contacts', 'db:cost_log']);
    expect(tables('db.insert("runs", row); db.update("runs", id, x);')).toEqual([]); // writes are not reads
  });

  it('reads FROM/JOIN tables out of db.query SQL, in any case, across template lines', () => {
    const code = 'await db.query<Pick<ContactRow, "name">>("select name from contacts where name <> \'\'");\n'
      + 'await db.query(`select n.*, 1 - (e.vector <=> $2) as score\n   from embeddings e\n   join notes n on n.id = e.note_id`, [a]);\n'
      + 'await db.query("select * from (select 1) x");';
    expect(tables(code)).toEqual(['sql:contacts', 'sql:embeddings', 'sql:notes']);
  });

  it('reads upper-case SQL literals elsewhere, but not prose', () => {
    expect(tables('const q = `SELECT id FROM public.runs JOIN steps ON true`;')).toEqual(['sql:runs', 'sql:steps']);
    expect(tables('const msg = "select a contact from the list";')).toEqual([]);
  });

  it('finds ORM reads', () => {
    expect(tables('await prisma.user.findMany({}); await tx.post.count();')).toEqual(['prisma:user', 'prisma:post']);
    expect(tables('db.select().from(users).where(eq(users.id, 1)); db.query.posts.findFirst({});')).toEqual(['drizzle:users', 'drizzle:posts']);
    expect(tables('db.selectFrom("pets").selectAll()')).toEqual(['kysely:pets']);
  });

  it('lands in FileFacts.reads with the enclosing symbol', () => {
    const f = extractFacts('src/outreach/crm-sync.ts', 'import { db } from "../shared/db";\nexport async function contactByEmail(email: string) {\n  const [c] = await db.where("contacts", { email });\n  return c;\n}\n', () => null);
    expect(f.reads).toEqual([{ table: 'contacts', symbol: 'src/outreach/crm-sync.ts#contactByEmail', via: 'db' }]);
  });
});

describe('.sql schema files', () => {
  const SQL = `-- Contacts. Owned by outreach.
create sequence if not exists contacts_id_seq;
create table if not exists contacts (
  id         text primary key default 'ct_' || lpad(nextval('contacts_id_seq')::text, 4, '0'),
  email      text not null unique,
  phone      text, -- plain text, see beat 1
  company    text not null,
  updated_at timestamptz not null default now()
);
CREATE TABLE "public"."outreach_log" (
  id text,
  contact_id text not null references contacts (id),
  status text check (status in ('drafted', 'sent')),
  PRIMARY KEY (id),
  CONSTRAINT fk FOREIGN KEY (contact_id) REFERENCES contacts (id)
);
/* create table ignored (x int); */
create index if not exists outreach_log_contact_idx on outreach_log (contact_id);`;

  it('parses CREATE TABLE names and columns, skipping constraints and comments', () => {
    expect(parseSqlTables(SQL)).toEqual([
      { name: 'contacts', columns: ['id', 'email', 'phone', 'company', 'updated_at'] },
      { name: 'outreach_log', columns: ['id', 'contact_id', 'status'] },
    ]);
  });

  it('extract() gives a schema file its tables and nothing else', () => {
    const f = extractFacts('src/outreach/schema.sql', SQL, () => null);
    expect(f.tables!.map((t) => t.name)).toEqual(['contacts', 'outreach_log']);
    expect(f).toMatchObject({ imports: [], symbols: [], calls: [], writes: [], reads: [] });
    expect(f.hash).toMatch(/^[0-9a-f]{16}$/);
  });
});
