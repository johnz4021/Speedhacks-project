import type { Tool } from "../shared/types";
import { call as news } from "../../vendor/news/index";
import { chat } from "../../vendor/llm-openai/index";
export const newsSummarize: Tool = { name: "news-summarize", tags: ["news", "summary"], run: async (c, ctx) => chat(news(c) + ctx.company) };
