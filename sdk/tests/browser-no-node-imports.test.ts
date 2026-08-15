import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard: the browser entry (@mcpjam/sdk/browser) must have NO transitive
// Node-only dependency. The export-shape test (browser-entry.test.ts) only
// checks the source's surface; this bundles the entry the way a browser build
// would and records any Node builtin that resolution touches — catching a
// node:crypto/fs/dns leak introduced deep in the import graph (e.g. by pulling
// the XAA mint or the oauth-proxy into browser.ts).
const NODE_BUILTIN =
  /^(node:)?(crypto|fs|fs\/promises|dns|dns\/promises|net|tls|http|https|http2|child_process|os|path|stream|zlib|worker_threads|dgram|module|v8|vm|inspector|readline|repl|cluster|perf_hooks)$/;

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
];

describe("browser entry Node-import guard", () => {
  it.each(BROWSER_SAFE_ENTRIES)(
    "bundles $label with no Node builtin in the graph",
    async ({ path }) => {
      const touched = new Set<string>();
      await build({
        entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
        bundle: true,
        write: false,
        platform: "browser",
        format: "esm",
        logLevel: "silent",
        plugins: [
          {
            name: "record-node-builtins",
            setup(pluginBuild) {
              pluginBuild.onResolve({ filter: NODE_BUILTIN }, (args) => {
                touched.add(args.path);
                // Externalize so the bundle still completes and we collect ALL
                // offenders rather than aborting on the first.
                return { path: args.path, external: true };
              });
            },
          },
        ],
      });

      expect([...touched].sort()).toEqual([]);
    }
  );

  // Guards the guard: a typo'd path or a dropped entry would leave this file
  // green while checking nothing, which is exactly how a browser-safety net
  // rots. Assert the roster itself.
  it("covers every entry that claims browser safety", () => {
    expect(BROWSER_SAFE_ENTRIES.map((entry) => entry.label).sort()).toEqual([
      "@mcpjam/sdk/browser",
      "@mcpjam/sdk/contract",
    ]);
  });
});
