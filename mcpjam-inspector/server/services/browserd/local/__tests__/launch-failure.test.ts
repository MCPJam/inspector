import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeLaunchFailure } from "../launch-failure";

/** Files under the installed playwright-core's `lib` that contain `text`. */
function playwrightFilesContaining(text: string): string[] {
  const require = createRequire(import.meta.url);
  const lib = join(
    dirname(require.resolve("playwright-core/package.json")),
    "lib",
  );
  return readdirSync(lib, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".js"))
    .filter((file) => readFileSync(join(lib, file), "utf8").includes(text));
}

describe("the launch failure wording", () => {
  // Playwright prints this banner when Chromium could not start its sandbox.
  // A Playwright bump that rewords it fails here, rather than quietly sending
  // sandbox failures to `launch_failed`. Chromium's own "No usable sandbox!"
  // needs a restricted host to check; docs/chromium-bump-checklist.md lists it.
  const BANNER = "Chromium sandboxing failed!";

  it("is still what the installed Playwright prints, and what we match", () => {
    expect(playwrightFilesContaining(BANNER)).not.toEqual([]);
    expect(describeLaunchFailure(new Error(BANNER)).code).toBe(
      "chromium_sandbox_unavailable",
    );
  });
});
