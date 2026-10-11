import { db } from "../shared/db";
import { redact } from "./redact";
import { provider } from "./providers";
import { logCost } from "./cost-ledger";
export async function complete(req: { purpose: string; messages: string[] }): Promise<string> {
  const names = db.all("contacts");
  const text = redact(req.messages.join("\n"), names);
  logCost(req.purpose, text.length / 4);
  return provider()(text);
}
