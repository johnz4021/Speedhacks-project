const tables = new Map<string, Map<string, unknown>>();
export const db = {
  insert(table: string, row: { id: string }) { tables.set(table, (tables.get(table) ?? new Map()).set(row.id, row)); },
  update(table: string, id: string, patch: object) { tables.get(table)?.set(id, patch); },
  all(table: string) { return [...(tables.get(table)?.values() ?? [])]; },
};
