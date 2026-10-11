import { db } from "../shared/db";
export function logOutreach(to: string) { db.insert("outreach_log", { id: to }); }
