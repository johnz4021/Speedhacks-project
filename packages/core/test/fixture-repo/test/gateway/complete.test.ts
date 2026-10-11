import { describe, it, expect } from "vitest";
import { chat } from "../../vendor/llm-openai/index";
import { complete } from "../../src/gateway/complete";
describe("complete", () => it("redacts", async () => expect(await complete({ purpose: "brief", messages: ["555 123 4567"] })).toBe(chat("[PHONE]"))));
