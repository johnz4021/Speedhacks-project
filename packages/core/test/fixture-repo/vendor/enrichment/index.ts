import { logCall } from "../_calllog";
export function call(input: string): string {
  logCall("enrichment", "call", input);
  return input;
}
