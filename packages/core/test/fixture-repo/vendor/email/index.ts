import { logCall } from "../_calllog";
export function call(input: string): string {
  logCall("email", "call", input);
  return input;
}
