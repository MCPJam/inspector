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

describe("browser entry Node-import guard", () => {
  it("bundles @mcpjam/sdk/browser with no Node builtin in the graph", async () => {
    const touched = new Set<string>();
    await build({
      entryPoints: [
        fileURLToPath(new URL("../src/browser.ts", import.meta.url)),
      ],
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
  });
});
