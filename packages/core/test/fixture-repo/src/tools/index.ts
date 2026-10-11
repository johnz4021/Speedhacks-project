import type { Tool } from "../shared/types";
import { webSearch } from "./web-search";
import { companyProfile } from "./company-profile";
import { newsDigest } from "./news-digest";
import { newsSummarize } from "./news-summarize";
export { webSearch } from "./web-search";
export type { Tool };
export const tools: Tool[] = [webSearch, companyProfile, newsDigest, newsSummarize];
