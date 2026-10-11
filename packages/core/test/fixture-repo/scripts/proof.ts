import { runAgent } from "../src/orchestrator/agent";
import { chat } from "../vendor/llm-openai/index";
import { calls } from "../vendor/_calllog";
db.insert("runs", { id: "proof" });
console.log(runAgent, chat, calls);
