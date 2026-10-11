import { plan } from "./planner";
import { registry } from "./tool-registry";
import { saveRun } from "./run-state";
import { retrieve } from "../memory/retrieve";

export async function runAgent(goal: string, company: string) {
  const steps = await plan(goal);
  const notes = await retrieve(company);
  const { draftEmail } = await import("../outreach/draft-email");
  saveRun({ id: goal, steps, notes, tools: registry.size, email: await draftEmail(company) });
}
