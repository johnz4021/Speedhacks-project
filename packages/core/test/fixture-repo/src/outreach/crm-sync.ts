import { call as crm } from "../../vendor/crm/index";
import { db } from "../shared/db";
export function syncContact(id: string, email: string) {
  crm(email);
  db.insert("contacts", { id, email });
  db.update("contacts", id, { synced: true });
}
