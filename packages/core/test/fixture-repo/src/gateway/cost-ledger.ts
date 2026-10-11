import { db } from "../shared/db";
export function logCost(purpose: string, tokens: number) {
  db.insert(`cost_log`, { id: purpose, tokens });
}
