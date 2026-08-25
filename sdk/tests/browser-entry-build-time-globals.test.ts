import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const sdkRoot = join(here, "..");

/**
 * A module reachable from the browser entry must survive being bundled WITHOUT
 * this package's build-time `define`.
 *
 * WHY THIS EXISTS. `sdk/tsup.config.ts` replaces `__MCPJAM_SDK_VERSION__` when
 * it builds `dist/`, and `sdk/vitest.config.ts` mirrors that so tests resolve
 * it — so both paths this repo normally exercises hide the problem. The
 * inspector's Vite build does not: it aliases `@mcpjam/sdk/browser` straight to
 * `src/browser.ts` and compiles from SOURCE with no define of its own.
 *
 * A module that evaluates such a token at top level therefore ships an
 * undeclared global into the client bundle and throws `ReferenceError` at
 * module init, taking the app down before React mounts. That shipped once, in
 * `conformance-profile.ts`, and every Playwright smoke test failed on a missing
 * app shell — a symptom nowhere near its cause.
 *
 * ASSERTED BY EXECUTION, not by grepping for the token. A `typeof` guard
 * legitimately mentions the identifier twice (once in the guard, once in the
 * branch it protects), so any textual rule either accepts the bug or rejects
 * the fix. Running the module is the only check that measures the thing that
 * actually matters.
 */
describe("browser-reachable modules without the build-time define", () => {
  it("evaluates conformance-profile.ts and degrades to a known-unknown version", async () => {
    const result = await build({
      entryPoints: [join(sdkRoot, "src", "conformance-profile.ts")],
      bundle: true,
      write: false,
      platform: "neutral",
      format: "cjs",
      target: "es2022",
      logLevel: "silent",
      mainFields: ["module", "main"],
      conditions: ["import", "default"],
      // Deliberately NO `define`, mirroring the inspector's Vite build.
    });

    const code = result.outputFiles?.[0]?.text ?? "";
    expect(code.length).toBeGreaterThan(1000);

    const moduleExports: Record<string, unknown> = {};
    const context = createContext({
      module: { exports: moduleExports },
      exports: moduleExports,
      globalThis: {},
      TextEncoder,
      TextDecoder,
    });

    // The assertion: this does not throw. Before the fix it raised
    // `ReferenceError: __MCPJAM_SDK_VERSION__ is not defined`.
    expect(() => runInContext(code, context)).not.toThrow();

    const exported = (context.module as { exports: Record<string, unknown> })
      .exports;
    // …and the fallback is honest rather than a plausible-looking version: a
    // stamp claiming a version nobody injected is worse than one admitting it
    // does not know.
    expect(exported.CONFORMANCE_CHECKER_VERSION).toBe("unknown");
  });
});
