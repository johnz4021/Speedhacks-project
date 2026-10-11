import { embed } from "../gateway/embed";
import { saveNote } from "./notes-store";
export function index(id: string, text: string) { saveNote(id, text, embed(text)); }
