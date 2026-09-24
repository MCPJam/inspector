import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";

/**
 * PostHog and Sentry both need the build's source maps, and Sentry deletes them.
 *
 * Rollup runs `@posthog/rollup-plugin`'s sequential `writeBundle` to completion
 * before any later plugin's parallel `writeBundle`, so PostHog only sees the
 * maps if it is listed before `sentryVitePlugin`. Reorder them, or let PostHog
 * delete, and one of the two uploads nothing while the build stays green.
 *
 * Read as SOURCE for the reason given in `vite-sdk-version-define.test.ts`.
 */

const CLIENT_DIR = resolve(fileURLToPath(import.meta.url), "../../../..");
const VITE_CONFIG = readFileSync(
  resolve(CLIENT_DIR, "vite.config.ts"),
  "utf-8",
);

describe("vite config: PostHog source map upload", () => {
  it("registers the PostHog plugin before the Sentry plugin", () => {
    const posthogAt = VITE_CONFIG.indexOf("posthogSourcemaps({");
    const sentryAt = VITE_CONFIG.indexOf("sentryVitePlugin({");
    expect(posthogAt).toBeGreaterThan(-1);
    expect(sentryAt).toBeGreaterThan(posthogAt);
  });

  it("leaves deleting the maps to Sentry", () => {
    expect(VITE_CONFIG).toMatch(/deleteAfterUpload: false/);
    expect(VITE_CONFIG).toMatch(/filesToDeleteAfterUpload: \[/);
  });

  it("stays disabled when no personal API key is present", () => {
    expect(VITE_CONFIG).toMatch(
      /enabled: Boolean\(env\.POSTHOG_PERSONAL_API_KEY\)/,
    );
  });
});
