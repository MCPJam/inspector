/**
 * The desktop app's embedded server must report through the SAME Sentry SDK
 * build that `@sentry/electron` initializes.
 *
 * Sentry keys its global carrier by SDK version. The packaged desktop app
 * bundles this server, so the server's `@sentry/node` is whatever resolves
 * from `server/`; `@sentry/electron` initializes its OWN pinned copy. When the
 * two versions differ (they did: 8.55.1 vs 8.55.0), every server-side capture
 * in the desktop app lands in a carrier with no client and is silently
 * dropped — `server/sentry.ts` assumes the embedded server "inherits that
 * client", which is only true while the versions match.
 *
 * Pin `@sentry/node` and `@sentry/react` to the version `@sentry/electron`
 * pins, and this passes.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

/**
 * The directory of `pkg` as Node resolves it from `fromDir`. Walks up from the
 * resolved entry, because not every Sentry package exports `package.json`.
 */
function packageDir(pkg: string, fromDir: string): string {
  let dir = path.dirname(require.resolve(pkg, { paths: [fromDir] }));
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (
      existsSync(candidate) &&
      JSON.parse(readFileSync(candidate, "utf8")).name === pkg
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`${pkg} not found from ${fromDir}`);
    dir = parent;
  }
}

function versionResolvedFrom(pkg: string, fromDir: string): string {
  return JSON.parse(
    readFileSync(path.join(packageDir(pkg, fromDir), "package.json"), "utf8"),
  ).version;
}

describe("Sentry carrier alignment (desktop)", () => {
  it("resolves the server's @sentry/node to the version @sentry/electron runs", () => {
    const serverDir = path.resolve(__dirname, "..");
    const electronDir = packageDir("@sentry/electron", serverDir);
    const serverNodeDir = packageDir("@sentry/node", serverDir);
    const electronNodeDir = packageDir("@sentry/node", electronDir);

    const serverNode = versionResolvedFrom("@sentry/node", serverDir);
    const electronNode = versionResolvedFrom("@sentry/node", electronDir);
    // The carrier key is `@sentry/core`'s version, as each `@sentry/node` sees it.
    const serverCore = versionResolvedFrom("@sentry/core", serverNodeDir);
    const electronCore = versionResolvedFrom("@sentry/core", electronNodeDir);

    expect(serverNode).toBe(electronNode);
    expect(serverCore).toBe(electronCore);
  });
});
