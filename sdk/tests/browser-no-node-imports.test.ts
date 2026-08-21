import { describe, expect, it } from "vitest";

import { expectNoNodeBuiltins } from "./support/node-builtin-guard.js";

// Guard: the browser entry (@mcpjam/sdk/browser) must have NO transitive
// Node-only dependency. The export-shape test (browser-entry.test.ts) only
// checks the source's surface; this bundles the entry the way a browser build
// would — catching a node:crypto/fs/dns leak introduced deep in the import
// graph (e.g. by pulling the XAA mint or the oauth-proxy into browser.ts).

/**
 * Every entry that advertises itself as browser-safe. Each is bundled
 * independently so a failure names the offending entry rather than "one of
 * these pulled in node:crypto".
 */
const BROWSER_SAFE_ENTRIES: Array<{ label: string; path: string }> = [
  { label: "@mcpjam/sdk/browser", path: "../src/browser.ts" },
  // The evaluation contract is imported by the inspector client bundle to
  // render scores, and its SHA-256 comes from `@noble/hashes` precisely so it
  // does not reach for node:crypto (and does not need async Web Crypto).
  { label: "@mcpjam/sdk/contract", path: "../src/contract/index.ts" },
  // Not a published entry: pure comparison arithmetic reachable from the
  // compare gates, which the CLI evaluates today and the dashboard will.
  // Bundled here so a future `node:crypto` import in it is caught AT the
  // module rather than after something pulls it into a browser build.
  { label: "sdk/src/compare-stats.ts", path: "../src/compare-stats.ts" },
];

describe("browser entry Node-import guard", () => {
  it.each(BROWSER_SAFE_ENTRIES)(
    "bundles $label with no Node builtin in the graph",
    async ({ path }) => {
      await expectNoNodeBuiltins(new URL(path, import.meta.url));
    },
  );

  // Guards the guard: a typo'd path or a dropped entry would leave this file
  // green while checking nothing, which is exactly how a browser-safety net
  // rots. Assert the roster itself.
  it("covers every entry that claims browser safety", () => {
    expect(BROWSER_SAFE_ENTRIES.map((entry) => entry.label).sort()).toEqual([
      "@mcpjam/sdk/browser",
      "@mcpjam/sdk/contract",
      "sdk/src/compare-stats.ts",
    ]);
  });
});
