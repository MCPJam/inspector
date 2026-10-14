import { afterEach, describe, expect, it, vi } from "vitest";
import { strictServerSentryOptions } from "../strict-sentry-options.js";
import { rebuildSentryEvent } from "../../../shared/strict-sentry.js";

afterEach(() => vi.unstubAllEnvs());
describe("server diagnostics during rollout", () => {
  it.each(["prod", "preview", "local", "staging", "test"])(
    "keeps the %s environment",
    (environment) => {
      vi.stubEnv("ENVIRONMENT", environment);
      expect(strictServerSentryOptions().environment).toBe(environment);
    },
  );
  it("reports the baked build surface its maps were uploaded under, and no other", () => {
    const event = { message: "process.uncaught_exception" };
    vi.stubEnv("MCPJAM_BUILD_SURFACE", "npm");
    expect(
      rebuildSentryEvent(event, strictServerSentryOptions()),
    ).toMatchObject({ dist: "npm" });
    vi.stubEnv("MCPJAM_BUILD_SURFACE", "bogus");
    expect(
      rebuildSentryEvent(event, strictServerSentryOptions()),
    ).not.toHaveProperty("dist");
  });
  it("provides the generated event and literal message catalog at the boundary", () => {
    const options = strictServerSentryOptions();
    for (const message of [
      "process.uncaught_exception",
      "[host-runtime-config] network error",
    ]) {
      expect(rebuildSentryEvent({ message }, options)).toMatchObject({
        message,
      });
    }
  });
});
