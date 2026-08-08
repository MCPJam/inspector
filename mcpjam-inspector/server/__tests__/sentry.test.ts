import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { init } = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock("@sentry/node", () => ({ init }));

import { initServerSentry } from "../sentry.js";

function lastConfig() {
  return init.mock.calls.at(-1)![0] as Record<string, any>;
}

describe("initServerSentry", () => {
  beforeEach(() => {
    init.mockClear();
    // resolveEnvironment() reads these; pin them so the assertions don't
    // depend on the ambient CI shell.
    vi.stubEnv("ENVIRONMENT", "prod");
    vi.stubEnv("DO_NOT_TRACK", "");
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "");
    vi.stubEnv("SENTRY_ERROR_SAMPLE_RATE", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("initializes enabled by default", () => {
    initServerSentry();
    expect(lastConfig().enabled).toBe(true);
  });

  it("honors DO_NOT_TRACK=1", () => {
    vi.stubEnv("DO_NOT_TRACK", "1");
    initServerSentry();
    expect(lastConfig().enabled).toBe(false);
  });

  it("honors DO_NOT_TRACK=true", () => {
    vi.stubEnv("DO_NOT_TRACK", "true");
    initServerSentry();
    expect(lastConfig().enabled).toBe(false);
  });

  it("does not disable on other DO_NOT_TRACK values", () => {
    vi.stubEnv("DO_NOT_TRACK", "0");
    initServerSentry();
    expect(lastConfig().enabled).toBe(true);
  });

  it("takes environment from ENVIRONMENT", () => {
    vi.stubEnv("ENVIRONMENT", "staging");
    initServerSentry();
    expect(lastConfig().environment).toBe("staging");
  });

  it("tags deployment from the hosted-mode flag", () => {
    initServerSentry();
    expect(lastConfig().initialScope.tags.deployment).toBe("self_hosted");

    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    initServerSentry();
    expect(lastConfig().initialScope.tags.deployment).toBe("hosted");
  });

  it("keeps performance tracing off", () => {
    // This init lands on every self-hosted install at once; spans would
    // multiply the quota exposure of a change whose point is to see errors.
    initServerSentry();
    expect(lastConfig().tracesSampleRate).toBe(0);
  });

  it("defaults sampleRate to 1 and honors the env override", () => {
    initServerSentry();
    expect(lastConfig().sampleRate).toBe(1);

    vi.stubEnv("SENTRY_ERROR_SAMPLE_RATE", "0.25");
    initServerSentry();
    expect(lastConfig().sampleRate).toBe(0.25);
  });

  it("falls back to full sampling when the rate is unparseable or out of range", () => {
    // A typo in an env var must not silently turn reporting off.
    for (const bad of ["abc", "-1", "2", ""]) {
      vi.stubEnv("SENTRY_ERROR_SAMPLE_RATE", bad);
      initServerSentry();
      expect(lastConfig().sampleRate).toBe(1);
    }
  });

  it("filters out the default OnUnhandledRejection integration", () => {
    initServerSentry();
    const integrations = lastConfig().integrations as (
      defaults: { name: string }[],
    ) => { name: string }[];

    const result = integrations([
      { name: "OnUncaughtException" },
      { name: "OnUnhandledRejection" },
      { name: "Http" },
    ]);

    // index.ts owns unhandledRejection and deliberately swallows the MCP
    // SDK's routine "Connection closed" rejections.
    expect(result.map((i) => i.name)).toEqual(["OnUncaughtException", "Http"]);
  });

  it("never opts into default PII", () => {
    initServerSentry();
    expect(lastConfig().sendDefaultPii).toBe(false);
  });

  // The baked version is captured at module load (it has to stay a literal
  // `process.env.X` so esbuild's `define` can substitute it), so these two
  // re-import the module rather than stubbing after the fact.
  it("uses the release baked in at build time", async () => {
    vi.stubEnv("MCPJAM_INSPECTOR_VERSION", "2.34.0");
    vi.resetModules();
    const fresh = await import("../sentry.js");

    fresh.initServerSentry();
    expect(lastConfig().release).toBe("2.34.0");
  });

  it("falls back to npm_package_version when the define is absent (dev/tsx)", async () => {
    vi.stubEnv("MCPJAM_INSPECTOR_VERSION", "");
    vi.stubEnv("npm_package_version", "2.35.0-dev");
    vi.resetModules();
    const fresh = await import("../sentry.js");

    fresh.initServerSentry();
    expect(lastConfig().release).toBe("2.35.0-dev");
  });
});
