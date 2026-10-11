import { it, expect } from "vitest";
import { retrieve } from "../../src/memory/retrieve";
it("retrieves", async () => expect(await retrieve("acme")).toHaveLength(1));
