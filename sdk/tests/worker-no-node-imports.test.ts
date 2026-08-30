import { describe, it } from "vitest";

import { expectNoNodeBuiltins } from "./support/node-builtin-guard.js";

// Guard: the worker entry (@mcpjam/sdk/worker) exists for runtimes that are not
// Node, so it must have NO transitive Node-only dependency. The sibling
// export-shape test (worker-entry.test.ts) runs under Node and would not notice.
//
// This is the constraint that decides how the server probe may guard its
// outbound metadata fetches: `probeMcpServer` is exported from this entry, so
// resolving DNS inside it — the obvious way to catch a hostname that answers
// with a private address — would put `node:dns` in this graph. That check lives
// in the caller's injected fetch instead, and this test is what keeps a future
// change from quietly relocating it back here.
describe("worker entry Node-import guard", () => {
  it("bundles @mcpjam/sdk/worker with no Node builtin in the graph", async () => {
    await expectNoNodeBuiltins(new URL("../src/worker.ts", import.meta.url));
  });
});
