import { describe, expect, it } from 'vitest';
import { scanWrites } from '../src/writes';

describe('scanWrites', () => {
  it('finds insert/update tables in any quote style and spacing', () => {
    const src = [
      `db.insert("runs", row);`,
      `db.update('contacts', id, patch);`,
      'db.insert(`cost_log`, row);',
      `db . insert (  "notes" , row);`,
      `db.update(`,
      `  "outreach_log",`,
      `  id, patch);`,
      `ctx.db.insert("embeddings", row);`,
    ].join('\n');
    expect(scanWrites(src)).toEqual(['runs', 'contacts', 'cost_log', 'notes', 'outreach_log', 'embeddings']);
  });

  it('ignores comments, interpolated templates, non-literals and reads', () => {
    const src = [
      `// db.insert("contacts", row);`,
      `/* db.update("runs", id, patch); */`,
      'db.insert(`${prefix}_log`, row);',
      `db.insert(table, row);`,
      `db.all("contacts"); db.get("runs", id);`,
      `mydb.insert("runs", row);`,
    ].join('\n');
    expect(scanWrites(src)).toEqual([]);
  });
});
