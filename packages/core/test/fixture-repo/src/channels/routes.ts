import { createServer } from "node:http";
import { runAgent } from "../orchestrator/agent";
import { validate } from "./validate";
export const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/runs" && validate(req.url)) return void runAgent(req.url, "").then(() => res.end());
  res.statusCode = 404;
  res.end();
});
