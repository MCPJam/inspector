import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each(["pending", "off", "masked", "full"] as const)(
  "keeps content independent of replay %s",
  async (recording) => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.resetModules();
    const privacy = await import("../session-privacy");
    const context = await import("../telemetry-context");
    context.setTelemetryActor("actor");
    context.setTelemetryCaptureContext({
      projectIds: ["project"],
      organizationIds: [],
    });
    context.setTelemetryContentPolicy("actor", "full");
    privacy.setSessionPrivacy(recording);
    expect(privacy.shouldMaskAnalytics()).toBe(false);
    context.setTelemetryContentPolicy("actor", "strict");
    expect(privacy.shouldMaskAnalytics()).toBe(true);
    expect(privacy.currentSessionPrivacy()).toBe(recording);
  },
);
