import { db } from "../shared/db";
export function saveRun(run: { id: string; [k: string]: unknown }) {
  db.insert("runs", run);
  db.update('runs', run.id, { done: true });
}
