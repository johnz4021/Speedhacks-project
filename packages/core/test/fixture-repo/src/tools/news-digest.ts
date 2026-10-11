import type { Tool } from "../shared/types";
import { call as news } from "../../vendor/news/index";
// import { chat } from "../../vendor/llm-openai/index";
/* import { complete } from "../gateway/complete"; */
const divider = /\/\/ ---/g;
export const newsDigest: Tool = { name: "news-digest", tags: ["news"], run: async (c) => news(c).replace(divider, "") };
