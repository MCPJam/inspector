/**
 * electronMainSentryConfig — the environment tag on desktop crash reports.
 *
 * The main process is the one Sentry caller that can't learn its environment
 * from NODE_ENV: the renderer gets it inlined by Vite at build time and the
 * npm flavors get it exported by the `start` script, but a packaged desktop
 * app sets it nowhere. That gap silently tagged every shipped release as
 * "dev", so ~97% of real desktop errors never appeared in a production-scoped
 * view. Pin the mapping so a future refactor can't quietly reintroduce it.
 */
import { describe, expect, it } from "vitest";
import {
  electronMainSentryConfig,
  electronSentryConfig,
} from "../sentry-config";

describe("electronMainSentryConfig", () => {
  it("tags a packaged build as prod regardless of NODE_ENV", () => {
    expect(electronMainSentryConfig(true).environment).toBe("prod");
  });

  it("tags an unpackaged build as dev regardless of NODE_ENV", () => {
    expect(electronMainSentryConfig(false).environment).toBe("dev");
  });

  it("does not depend on NODE_ENV in either direction", () => {
    const original = process.env.NODE_ENV;
    try {
      // The bug was that a packaged app fell through to "dev" because
      // NODE_ENV was unset. Absent NODE_ENV must no longer change the answer.
      delete process.env.NODE_ENV;
      expect(electronMainSentryConfig(true).environment).toBe("prod");

      process.env.NODE_ENV = "development";
      expect(electronMainSentryConfig(true).environment).toBe("prod");

      process.env.NODE_ENV = "production";
      expect(electronMainSentryConfig(false).environment).toBe("dev");
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });

  it("preserves the electron DSN and the shared base config", () => {
    const config = electronMainSentryConfig(true);
    expect(config.dsn).toBe(electronSentryConfig.dsn);
    expect(config.sendDefaultPii).toBe(false);
    expect(config.tracesSampleRate).toBe(electronSentryConfig.tracesSampleRate);
  });
});
