import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";

/**
 * `__MCPJAM_SDK_VERSION__` must be replaced at build time, and must be TRUE.
 *
 * This is the token that took the app down once. `client/vite.config.ts`
 * aliases `@mcpjam/sdk/browser` to the SDK's SOURCE, so the SDK's own tsup
 * `define` never runs for this bundle — if this config does not mirror it, the
 * token ships as an undeclared global and the client throws a `ReferenceError`
 * before `app-shell` mounts. The SDK reads it through a `typeof` guard now, so
 * the crash is gone; what remains is the quieter failure this test covers, a
 * conformance report stamped `checkerVersion: "unknown"`.
 *
 * Read as SOURCE rather than imported: importing `vite.config.ts` drags esbuild
 * into the jsdom environment these tests run in, where it refuses to load. The
 * two halves are pinned separately instead — the config declares the define,
 * and `sdk/package.json` supplies a usable value for it.
 *
 * The SDK-side companion (`sdk/tests/browser-entry-build-time-globals.test.ts`)
 * proves the guard holds with NO define. This one proves the define is here.
 */

const CLIENT_DIR = resolve(fileURLToPath(import.meta.url), "../../../..");
const VITE_CONFIG = readFileSync(
  resolve(CLIENT_DIR, "vite.config.ts"),
  "utf-8",
);

describe("vite config: __MCPJAM_SDK_VERSION__", () => {
  it("defines the token, so it is never an undeclared global at runtime", () => {
    expect(VITE_CONFIG).toMatch(
      /__MCPJAM_SDK_VERSION__:\s*JSON\.stringify\(sdkVersion\)/,
    );
  });

  it("reads the value from the SDK's package.json, not a literal", () => {
    expect(VITE_CONFIG).toMatch(/\.\.\/sdk\/package\.json/);
    expect(VITE_CONFIG).toMatch(/const sdkVersion = sdkPackageJson\.version/);
  });

  it("stops the build rather than defining a placeholder", () => {
    // `JSON.stringify(undefined)` is the JS value `undefined`, which Vite would
    // turn into a define of the literal `undefined` — the SDK then silently
    // falls back to "unknown" and every report from that build is stamped with
    // a version that identifies nothing.
    expect(VITE_CONFIG).toMatch(
      /typeof sdkVersion !== "string" \|\| sdkVersion\.trim\(\) === ""/,
    );
    expect(VITE_CONFIG).toMatch(/throw new Error\(/);
  });

  it("has a usable version to define, right now", () => {
    const sdkVersion = JSON.parse(
      readFileSync(resolve(CLIENT_DIR, "../../sdk/package.json"), "utf-8"),
    ).version;
    expect(typeof sdkVersion).toBe("string");
    expect(sdkVersion.trim()).not.toBe("");
    expect(sdkVersion).not.toBe("unknown");
  });

  it("mirrors the SDK's own tsup define, so both builds stamp the same value", () => {
    // Divergence here is invisible at runtime and only shows up as two builds
    // of the same commit reporting different `checkerVersion`s.
    const tsup = readFileSync(
      resolve(CLIENT_DIR, "../../sdk/tsup.config.ts"),
      "utf-8",
    );
    expect(tsup).toContain("__MCPJAM_SDK_VERSION__");
  });
});
