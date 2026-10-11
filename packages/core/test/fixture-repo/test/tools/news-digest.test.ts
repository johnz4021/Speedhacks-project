import { it, expect } from "vitest";
import { newsDigest } from "../../src/tools/news-digest";
it("digests", async () => expect(await newsDigest.run("acme", { company: "acme" })).toBe("acme"));
