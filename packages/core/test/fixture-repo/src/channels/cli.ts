import { runAgent } from "../orchestrator/agent.js";
const url = "https://example.com/runs"; // not a comment start inside the string
runAgent(process.argv.slice(2).join(" "), url);
