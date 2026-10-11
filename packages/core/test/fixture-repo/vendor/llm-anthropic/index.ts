import { logCall } from "../_calllog";
export function call(input: string): string {
  logCall("llm-anthropic", "call", input);
  return input;
}
