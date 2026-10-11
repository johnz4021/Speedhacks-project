import { call as embedText } from "../../vendor/embeddings/index";
import { logCost } from "./cost-ledger";
export function embed(text: string) {
  logCost("embed", text.length / 4);
  return embedText(text);
}
