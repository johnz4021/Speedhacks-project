import { createServer } from "node:http";
import { runAgent } from "../orchestrator/agent";
import { validate } from "./validate";
export const server = createServer((req, res) => res.end(String(validate(req.url) && runAgent)));
