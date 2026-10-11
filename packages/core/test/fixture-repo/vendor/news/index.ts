import { logCall } from "../_calllog";
export function call(input: string): string {
  logCall("news", "call", input);
  return input;
}
