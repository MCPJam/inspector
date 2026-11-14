import { afterEach, describe, expect, it, vi } from "vitest";

const event = vi.hoisted(() => vi.fn());
vi.mock("../request-logger.js", () => ({ getSystemLogger: () => ({ event }) }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.resetModules();
  event.mockClear();
});

describe("telemetry canary deployment surface", () => {
  it("does not start a canary for local installs", async () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "false");
    const { startTelemetryCanary } = await import("../telemetry-canary.js");
    startTelemetryCanary()();
    expect(event).not.toHaveBeenCalled();
  });
  it("emits and stops the hosted five-minute canary", async () => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    const { startTelemetryCanary } = await import("../telemetry-canary.js");
    const stop = startTelemetryCanary();
    expect(event).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300000);
    expect(event).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(300000);
    expect(event).toHaveBeenCalledTimes(2);
  });
});
