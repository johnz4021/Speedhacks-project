import { logCall } from "../_calllog";
export function call(input: string): string {
  logCall("sec-edgar", "call", input);
  return input;
}
