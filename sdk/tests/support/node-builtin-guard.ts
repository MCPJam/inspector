import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const NODE_BUILTIN =
  /^(node:)?(crypto|fs|fs\/promises|dns|dns\/promises|net|tls|http|https|http2|child_process|os|path|stream|zlib|worker_threads|dgram|module|v8|vm|inspector|readline|repl|cluster|perf_hooks)$/;

/**
 * Bundles `entry` the way a non-Node runtime would and fails if resolution
 * touches any Node builtin. The per-entry export-shape tests run under Node, so
 * they would not notice a `node:crypto`/`fs`/`dns` leak introduced deep in the
 * import graph; this walks the graph instead.
 */
export async function expectNoNodeBuiltins(entry: URL): Promise<void> {
  const touched = new Set<string>();
  await build({
    entryPoints: [fileURLToPath(entry)],
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
