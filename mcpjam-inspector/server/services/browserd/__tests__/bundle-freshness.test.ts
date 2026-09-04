/**
 * The checked-in daemon bundle must be REGENERATED whenever daemon sources
 * change. Nothing in `build`, `pretest`, CI, or the Dockerfile runs
 * `bundle:browserd` (the #4485 wiring was deliberately reverted in #4486), so
 * without this test a daemon edit that forgets `npm run bundle:browserd`
 * ships a silently stale daemon: the server uploads the OLD embedded bytes
 * into every sandbox while the repo shows the new code.
 *
 * Three assertions:
 *   1. the source hash stamped into the generated file at bundle time equals
 *      a hash freshly derived from the files esbuild actually bundled
 *      (algorithm duplicated from scripts/bundle-browserd.mjs — keep in
 *      lockstep);
 *   2. the embedded base64 decodes byte-identical to the checked-in `.mjs`,
 *      so the artifact the server uploads is the artifact in review;
 *   3. the recorded input list still COVERS the daemon directory and the
 *      protocol, so a file dropped from the import graph by accident is a
 *      failure rather than a quietly smaller hash.
 *
 * (1) hashes the bundler's own input list rather than a directory walk. The
 * walk was a guess about the import graph, and it was already wrong: the
 * daemon's launch args import the WebMCP inspector's, so Chromium's feature
 * flags shipped in every bundle while an edit to them changed no hash.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MCPJAM_BROWSERD_BUNDLE_BASE64,
  MCPJAM_BROWSERD_SOURCE_FILES,
  MCPJAM_BROWSERD_SOURCE_HASH,
} from "../dist/mcpjam-browserd-bundle.generated";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const daemonDir = resolve(root, "server/services/browserd/daemon");
const bundleFile = resolve(
  root,
  "server/services/browserd/dist/mcpjam-browserd.mjs",
);

/** Mirror of `computeSourceHash` in scripts/bundle-browserd.mjs. */
function computeSourceHash(files: readonly string[]): string {
  const sorted = [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash("sha256");
  for (const file of sorted) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(resolve(root, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Every non-test `.ts` under `daemon/`, as repo-relative paths.
 *
 * Used only for the COVERAGE assertion, not the hash: a type-only module
 * (`browser-page.ts`) is erased at build time and contributes no bytes, so it
 * legitimately never appears in esbuild's inputs.
 */
function daemonSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walk(full);
        continue;
      }
      if (entry.name.endsWith(".ts")) files.push(full);
    }
  };
  walk(daemonDir);
  return files.map((f) => relative(root, f).replaceAll("\\", "/"));
}

/** Modules that carry only types, and so are erased before the artifact. */
const TYPE_ONLY_DAEMON_MODULES = new Set([
  "server/services/browserd/daemon/browser-page.ts",
]);

/**
 * Modules OUTSIDE `daemon/` that the bundle nevertheless ships.
 *
 * The daemon walk cannot find these, so without naming them the coverage
 * assertion would keep passing while the graph quietly stopped reaching them —
 * and an edit to the launch flags or the JPEG geometry reader would ship
 * unguarded. Adding a new one here is the deliberate act it should be.
 */
const REQUIRED_NON_DAEMON_INPUTS = [
  "server/services/browserd/protocol.ts",
  "server/services/webmcp-inspector/launch-args.ts",
  "server/services/webmcp-inspector/frame-throttle.ts",
  "shared/jpeg-dimensions.ts",
];

describe("browserd bundle freshness", () => {
  it("the checked-in bundle was generated from the current daemon sources", () => {
    expect(
      MCPJAM_BROWSERD_SOURCE_HASH,
      "bundled sources changed after the last `npm run bundle:browserd` — " +
        "regenerate and commit BOTH dist files in the same commit",
    ).toBe(computeSourceHash(MCPJAM_BROWSERD_SOURCE_FILES));
  });

  it("the recorded inputs cover the daemon and the protocol", () => {
    // The hash follows the import graph, which is the honest thing to hash and
    // also a thing that can silently SHRINK: a module that stops being
    // imported drops out of the list, and its edits stop being guarded. This
    // asserts the graph still reaches everything that is supposed to ship.
    const recorded = new Set(MCPJAM_BROWSERD_SOURCE_FILES);
    const missing = [
      ...daemonSourceFiles(),
      ...REQUIRED_NON_DAEMON_INPUTS,
    ].filter(
      (file) => !recorded.has(file) && !TYPE_ONLY_DAEMON_MODULES.has(file),
    );
    expect(
      missing,
      "these modules are no longer reached by the bundle's import graph, so " +
        "changes to them would no longer be guarded",
    ).toEqual([]);
  });

  it("the bundle never reaches the Electron engine", () => {
    // `browserd/electron/**` drives hidden `BrowserWindow`s through
    // `webContents.debugger`. This bundle is UPLOADED TO AN E2B BOX, which has
    // no Electron: one import edge from the daemon into that directory and
    // every hosted session fails to boot, with a module-resolution error
    // hundreds of megabytes and one upload away from where it was introduced.
    //
    // The edge would be easy to add by accident — the two engines share the
    // CDP adapter, the viewport and the driver — so the graph is asserted
    // rather than trusted.
    const leaked = MCPJAM_BROWSERD_SOURCE_FILES.filter((file) =>
      file.includes("services/browserd/electron/"),
    );
    expect(
      leaked,
      "the daemon bundle now imports the Electron engine; it is uploaded to a " +
        "box with no Electron, so every hosted session would fail to boot",
    ).toEqual([]);
    // Belt and braces on the artifact itself, because the input list above
    // cannot see everything: esbuild keeps an EXTERNAL specifier as a literal
    // import rather than following it, so a stray `import("electron")` would
    // leave no trace in the graph and fail only at runtime, on the box.
    //
    // Matched as an import edge rather than as the bare word: the daemon may
    // one day legitimately mention "electron" in a user-agent string, an
    // engine name or a flag, and a test that trips on prose is a test people
    // learn to edit rather than to read.
    const artifact = readFileSync(bundleFile, "utf8");
    // Every specifier form, each behind the same non-word guard so a
    // legitimate mention in prose ("switched from \"electron\" runtime") does
    // not trip it: `import("electron")`, `require("electron")`,
    // `from "electron"`, and the side-effect `import "electron"` — which has
    // neither parentheses nor a `from` and slipped past the first version.
    const importEdge =
      /(?:^|[^\w$])(?:(?:import|require)\s*\(\s*["']electron["']\s*\)|from\s*["']electron["']|import\s+["']electron["'])/;
    expect(
      importEdge.test(artifact),
      "the daemon bundle imports `electron` directly",
    ).toBe(false);
  });

  it("the embedded base64 is byte-identical to the checked-in .mjs", () => {
    const embedded = Buffer.from(MCPJAM_BROWSERD_BUNDLE_BASE64, "base64");
    const artifact = readFileSync(bundleFile);
    expect(embedded.equals(artifact)).toBe(true);
  });
});
