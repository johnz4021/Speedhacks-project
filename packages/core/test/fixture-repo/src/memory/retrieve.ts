import { index } from "./vector-index";
import { db } from "../shared/db";
export async function retrieve(company: string) { index(company, company); return db.all("notes").slice(0, 3); }
