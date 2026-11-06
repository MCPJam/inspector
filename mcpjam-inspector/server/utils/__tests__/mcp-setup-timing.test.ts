import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import {
  createMcpSetupTiming,
  withNegotiationTiming,
} from "../mcp-setup-timing.js";

vi.mock("../logger.js", () => ({ logger: { info: vi.fn() } }));
describe("MCP setup timing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });
  it("preserves the existing observer when disabled in production", () => {
    vi.stubEnv("ENVIRONMENT", "prod");
    vi.stubEnv("HARN24_BENCHMARK_TIMINGS", "1");
    const existing = vi.fn();
    expect(createMcpSetupTiming("request")).toBeUndefined();
    expect(withNegotiationTiming(existing)).toBe(existing);
  });
  it.each(["connected", "failed"] as const)(
    "records %s only when the connection callback settles",
    (outcome) => {
      vi.stubEnv("ENVIRONMENT", "dev");
      vi.stubEnv("HARN24_BENCHMARK_TIMINGS", "1");
      vi.spyOn(performance, "now")
        .mockReturnValueOnce(10)
        .mockReturnValueOnce(30)
        .mockReturnValueOnce(40)
        .mockReturnValueOnce(90);
      const timing = createMcpSetupTiming("request");
      timing?.("authorization-start");
      timing?.("authorization-end");
      const existing = vi.fn();
      const connected = withNegotiationTiming(existing, timing);
      expect(logger.info).toHaveBeenCalledTimes(2);
      const event = {
        serverId: "server",
        configuredMode: "auto" as const,
        transport: "http" as const,
        outcome,
      };
      connected(event);
      expect(existing).toHaveBeenCalledWith(event);
      connected(event);
      expect(existing).toHaveBeenCalledTimes(2);
      expect(logger.info).toHaveBeenCalledTimes(3);
      expect(logger.info).toHaveBeenNthCalledWith(
        1,
        "[harness][mcp-timing] stage=serverAuthorization durationMs=20 outcome=completed requestId=request",
      );
      expect(logger.info).toHaveBeenNthCalledWith(
        3,
        `[harness][mcp-timing] stage=mcpConnect durationMs=50 outcome=${outcome} requestId=request`,
      );
    },
  );
});
