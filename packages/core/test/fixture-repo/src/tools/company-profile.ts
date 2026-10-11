import type { Tool } from "../shared/types";
import { call as enrich } from "../../vendor/enrichment/index";
import { call as filings } from "../../vendor/sec-edgar/index";
import { complete } from "../gateway/complete";
export const companyProfile: Tool = {
  name: "company-profile",
  tags: ["profile"],
  run: async (c) => complete({ purpose: "profile", messages: [enrich(c), filings(c)] }),
};
