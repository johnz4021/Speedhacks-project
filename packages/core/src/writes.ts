import { moduleRecord } from './facts/record';

export { findWrites, type WriteHit } from './facts/adapters';

/**
 * Tables written by `source`, in source order: Scout's `db.insert/update("t", …)` with a literal name, plus the
 * Prisma, Drizzle, Knex, Kysely and raw-SQL adapters (see `facts/adapters.ts`). Comments are ignored.
 */
export function scanWrites(source: string, path = 'source.ts'): string[] {
  return moduleRecord(path, source).writes.map((w) => w.table);
}
