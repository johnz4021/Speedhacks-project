import { call as openai } from "../../vendor/llm-openai/index";
import { call as anthropic } from "../../vendor/llm-anthropic/index";
export const provider = () => (process.env.SCOUT_MODEL_PROVIDER === "anthropic" ? anthropic : openai);
