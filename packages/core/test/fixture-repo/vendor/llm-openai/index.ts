import { logCall } from "../_calllog";
export function call(input: string): string {
  logCall("llm-openai", "call", input);
  return input;
}
export const chat = call;
