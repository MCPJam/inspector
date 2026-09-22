import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NegotiationOutcomeEvent } from "@mcpjam/sdk";

// Capture what `negotiationTelemetryLogger` forwards into the system-event
// pipeline. `getSystemLogger` is called once at module load, so the mock must
// be installed (hoisted) before the module under test is imported.
const { eventMock } = vi.hoisted(() => ({ eventMock: vi.fn() }));
vi.mock("../request-logger.js", () => ({
  getSystemLogger: vi.fn(() => ({ event: eventMock })),
}));

import { negotiationTelemetryLogger } from "../negotiation-telemetry.js";

function event(
  overrides: Partial<NegotiationOutcomeEvent> = {},
): NegotiationOutcomeEvent {
  return {
    serverId: "srv-1",
    transport: "http",
    configuredMode: "auto",
    outcome: "connected",
    ...overrides,
  };
}

describe("negotiationTelemetryLogger", () => {
  beforeEach(() => {
    eventMock.mockReset();
  });

  it("maps required fields and stamps the surface", () => {
    negotiationTelemetryLogger("local-inspector")(
      event({ configuredMode: "modern-pin" }),
    );

    expect(eventMock).toHaveBeenCalledTimes(1);
    const [name, payload] = eventMock.mock.calls[0];
    expect(name).toBe("mcp.connection.negotiated");
    expect(payload).toEqual({
      surface: "local-inspector",
      serverId: "srv-1",
      transport: "http",
      configuredMode: "modern-pin",
      outcome: "connected",
    });
  });

  it("forwards optional era/version on a connected event", () => {
    negotiationTelemetryLogger("hosted-chat")(
      event({
        transport: "stdio",
        negotiatedEra: "modern",
        negotiatedProtocolVersion: "2026-07-28",
      }),
    );

    expect(eventMock.mock.calls[0][1]).toMatchObject({
      surface: "hosted-chat",
      transport: "stdio",
      negotiatedEra: "modern",
      negotiatedProtocolVersion: "2026-07-28",
    });
  });

  it("forwards failureClass on a failed event and omits absent optionals", () => {
    negotiationTelemetryLogger("evals")(
      event({ outcome: "failed", failureClass: "UnauthorizedError" }),
    );

    const payload = eventMock.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.outcome).toBe("failed");
    expect(payload.failureClass).toBe("UnauthorizedError");
    // Absent optionals are omitted, not emitted as `undefined`.
    expect("negotiatedEra" in payload).toBe(false);
    expect("negotiatedProtocolVersion" in payload).toBe(false);
  });

  it("does not throw when the underlying logger throws", () => {
    eventMock.mockImplementationOnce(() => {
      throw new Error("axiom down");
    });

    // A telemetry failure must never disturb the connection control flow.
    expect(() =>
      negotiationTelemetryLogger("hosted-direct")(event()),
    ).not.toThrow();
  });
});
