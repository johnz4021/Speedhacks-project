import { logCall } from "../_calllog";
export function call(input: string): string {
  logCall("embeddings", "call", input);
  return input;
}
