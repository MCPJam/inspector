import { describe, expect, it } from "vitest";

import { expectNoNodeBuiltins } from "./support/node-builtin-guard.js";

// Guard for the guard: browser-no-node-imports and worker-no-node-imports only
// ever assert that the scaffold found NOTHING, so a scaffold that matches nothing
// passes them both. That is what a hand-listed builtin regex eventually becomes —
// the names it omits resolve without reaching the hook. This fixture imports two
// such names and fails if they get through.
describe("Node-import guard scaffold", () => {
  it("reports builtins a hand-listed regex would have missed", async () => {
    await expect(
      expectNoNodeBuiltins(
        new URL("./support/fixtures/imports-node-builtin.ts", import.meta.url)
      )
    ).rejects.toThrow(/events/);
  });
});
