import { build } from "esbuild";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

// Every bare specifier, so Node itself decides what counts as a builtin. A
// hand-listed set is the wrong shape for a guard: the names it omits — `events`,
// `util`, `buffer`, `node:stream/web` — resolve without ever reaching the hook,
// which reads as a clean bundle rather than a missed leak.
const BARE_SPECIFIER = /^[^.\/]/;

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
          pluginBuild.onResolve({ filter: BARE_SPECIFIER }, (args) => {
            if (!isBuiltin(args.path)) {
              // Not ours to answer — hand npm dependencies back to esbuild.
              return null;
            }
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
