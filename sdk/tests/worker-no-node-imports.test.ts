import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
const NODE_BUILTIN =
  /^(node:)?(crypto|fs|fs\/promises|dns|dns\/promises|net|tls|http|https|http2|child_process|os|path|stream|zlib|worker_threads|dgram|module|v8|vm|inspector|readline|repl|cluster|perf_hooks)$/;

describe("worker entry Node-import guard", () => {
  it("bundles @mcpjam/sdk/worker with no Node builtin in the graph", async () => {
    const touched = new Set<string>();
    await build({
      entryPoints: [
        fileURLToPath(new URL("../src/worker.ts", import.meta.url)),
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
              // Externalize so the bundle completes and every offender is
              // collected rather than aborting on the first.
              return { path: args.path, external: true };
            });
          },
        },
      ],
    });

    expect([...touched].sort()).toEqual([]);
  });
});
