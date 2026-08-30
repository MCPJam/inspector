import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";

/**
 * Two dev servers started from this package must not share one Vite dep cache.
 *
 * Vite derives `cacheDir` from the nearest package.json, so the OAuth debugger
 * e2e — which runs a plain and a hosted dev server at the same time — had both
 * optimizing into `node_modules/.vite`. The second one's re-optimization
 * answers the first one's in-flight chunk request with `504 (Outdated Optimize
 * Dep)` and the page never mounts. `CLIENT_CACHE_DIR` separates them.
 *
 * Read as SOURCE rather than imported, for the reason given in
 * `vite-sdk-version-define.test.ts`: importing `vite.config.ts` drags esbuild
 * into the jsdom environment these tests run in. The playwright config is read
 * the same way so the two halves are pinned by the same mechanism.
 */

const CLIENT_DIR = resolve(fileURLToPath(import.meta.url), "../../../..");
const VITE_CONFIG = readFileSync(
  resolve(CLIENT_DIR, "vite.config.ts"),
  "utf-8",
);
const OAUTH_DEBUGGER_CONFIG = readFileSync(
  resolve(CLIENT_DIR, "../playwright.oauth-debugger.config.ts"),
  "utf-8",
);

describe("vite config: cacheDir", () => {
  it("sets cacheDir at all, rather than letting Vite derive one per package", () => {
    expect(VITE_CONFIG).toMatch(/cacheDir: path\.resolve\(/);
  });

  it("takes the directory from CLIENT_CACHE_DIR, resolved against the package root", () => {
    expect(VITE_CONFIG).toMatch(
      /cacheDir: path\.resolve\(\s*rootDir,\s*env\.CLIENT_CACHE_DIR \|\| "node_modules\/\.vite",?\s*\)/,
    );
  });
});

describe("oauth-debugger e2e: one cache per dev server", () => {
  const cacheDirs = [
    ...OAUTH_DEBUGGER_CONFIG.matchAll(/CLIENT_CACHE_DIR: "([^"]+)"/g),
  ].map((match) => match[1]);

  it("gives every webServer a CLIENT_CACHE_DIR", () => {
    // Both `webServer` entries run `dev:client`; a third would need one too.
    const webServerCount = [
      ...OAUTH_DEBUGGER_CONFIG.matchAll(/SERVER_PORT: "/g),
    ].length;
    expect(cacheDirs).toHaveLength(webServerCount);
  });

  it("never lets two of them name the same directory", () => {
    expect(new Set(cacheDirs).size).toBe(cacheDirs.length);
  });
});
