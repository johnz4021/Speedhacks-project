import { logCall } from "../_calllog";
export function call(input: string): string {
  logCall("crm", "call", input);
  return input;
}
