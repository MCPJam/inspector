import { describe, it } from "vitest";

import { expectNoNodeBuiltins } from "./support/node-builtin-guard.js";

// Guard: the browser entry (@mcpjam/sdk/browser) must have NO transitive
// Node-only dependency. The export-shape test (browser-entry.test.ts) only
// checks the source's surface; this bundles the entry the way a browser build
// would — catching a node:crypto/fs/dns leak introduced deep in the import
// graph (e.g. by pulling the XAA mint or the oauth-proxy into browser.ts).
describe("browser entry Node-import guard", () => {
  it("bundles @mcpjam/sdk/browser with no Node builtin in the graph", async () => {
    await expectNoNodeBuiltins(new URL("../src/browser.ts", import.meta.url));
  });
});
