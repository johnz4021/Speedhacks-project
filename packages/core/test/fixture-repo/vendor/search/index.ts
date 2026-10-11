import { logCall } from "../_calllog";
export function call(input: string): string {
  logCall("search", "call", input);
  return input;
}
