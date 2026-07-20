/**
 * Guard: the plugin-bundle entry (@mcpjam/sdk/plugin-bundle) must have NO
 * transitive Node-only dependency — the acceptance criterion for PR SDK-1 is
 * that the exported pure parser runs identically in the browser, Node, and
 * the Convex isolate. Mirrors tests/browser-no-node-imports.test.ts.
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const NODE_BUILTIN =
  /^(node:)?(crypto|fs|fs\/promises|dns|dns\/promises|net|tls|http|https|http2|child_process|os|path|stream|zlib|worker_threads|dgram|module|v8|vm|inspector|readline|repl|cluster|perf_hooks)$/;

describe("plugin-bundle entry Node-import guard", () => {
  it("bundles @mcpjam/sdk/plugin-bundle with no Node builtin in the graph", async () => {
    const touched = new Set<string>();
    await build({
      entryPoints: [
        fileURLToPath(
          new URL("../../src/plugin-bundle/index.ts", import.meta.url)
        ),
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
              return { path: args.path, external: true };
            });
          },
        },
      ],
    });

    expect([...touched].sort()).toEqual([]);
  });
});
