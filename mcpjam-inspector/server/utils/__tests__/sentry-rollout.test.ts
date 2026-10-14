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
