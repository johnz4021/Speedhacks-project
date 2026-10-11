import type { Tool } from "../tools";
import { complete } from "../gateway/complete";
export async function plan(goal: string): Promise<Tool["name"][]> {
  return [await complete({ purpose: "plan", messages: [goal] })];
}
