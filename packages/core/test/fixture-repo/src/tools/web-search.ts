import type { Tool } from "../shared/types";
import { call as search } from "../../vendor/search/index";
import { complete } from "../gateway/complete";
export const webSearch: Tool = { name: "web-search", tags: ["web"], run: async (q) => complete({ purpose: "summary", messages: [search(q)] }) };
