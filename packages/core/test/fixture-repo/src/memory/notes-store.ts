import { db } from "../shared/db";
export function saveNote(id: string, text: string, vector: string) {
  db.insert("notes", { id, text });
  db.insert( "embeddings" , { id, vector });
}
