import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ingest: vi.fn(),
  capture: vi.fn(),
  event: vi.fn(),
  hosted: false,
}));
vi.mock("@axiomhq/js", () => ({
  Axiom: class {
    ingest = mocks.ingest;
    flush = async () => undefined;
  },
}));
vi.mock("@sentry/node", () => ({ captureException: mocks.capture }));
vi.mock("../../config.js", () => ({
  get HOSTED_MODE() { return mocks.hosted; },
}));
vi.mock("../request-logger.js", () => ({
  getSystemLogger: () => ({ event: mocks.event }),
}));

describe("logger rollout boundaries", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENVIRONMENT", "test");
    vi.stubEnv("AXIOM_TOKEN", "test-token");
    vi.stubEnv("DO_NOT_TRACK", "");
    mocks.hosted = false;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    [undefined, undefined, "inspector-logs"],
    [undefined, "legacy", "legacy"],
    ["", "legacy", "legacy"],
    ["clean", "legacy", "clean"],
  ])("routes %s / %s to %s", async (clean, legacy, expected) => {
    vi.stubEnv("AXIOM_CLEAN_DATASET", clean);
    vi.stubEnv("AXIOM_DATASET", legacy);
    const { logger } = await import("../logger.js");
    logger.info("probe");
    expect(mocks.ingest.mock.calls[0][0]).toBe(expected);
  });

  it("starts canaries only in hosted mode", async () => {
    const timer = vi.spyOn(globalThis, "setInterval");
    const { startTelemetryCanary } = await import("../telemetry-canary.js");
    startTelemetryCanary()();
    expect(mocks.event).not.toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
    mocks.hosted = true;
    const stop = startTelemetryCanary();
    expect(mocks.event).toHaveBeenCalledWith("telemetry_canary", {});
    expect(timer).toHaveBeenCalledOnce();
    stop();
  });

  it("does not print canary rows in self-hosted installs", async () => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const { logger } = await import("../logger.js");
    logger.systemEvent("telemetry_canary", {
      event: "telemetry_canary", component: "process", environment: "test",
      timestamp: new Date().toISOString(), release: null, requestId: null,
      route: null, method: null, authType: "system",
    }, {});
    expect(output).not.toHaveBeenCalled();
  });
});
