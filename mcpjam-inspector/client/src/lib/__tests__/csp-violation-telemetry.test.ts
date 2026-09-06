import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureSentryMessage } from "../sentry";
import {
  CspViolationTelemetryLimiter,
  failedToApplyCsp,
  reportCspViolationToSentry,
  sanitizeCspPolicy,
} from "../csp-violation-telemetry";

vi.mock("../sentry", () => ({ captureSentryMessage: vi.fn() }));

const violation = {
  directive: "frame-src",
  effectiveDirective: "frame-src",
  blockedUri: "https://user:secret@js.stripe.com/v3?token=secret#part",
  mountId: 4,
  originalPolicy:
    "script-src 'nonce-secret' 'sha256-secret'; frame-src https://user:secret@js.stripe.com/v3?token=secret#part",
  disposition: "enforce" as const,
  sourceFile: "https://app.example/widget.js?session=secret#trace",
  lineNumber: 12,
  columnNumber: 8,
  timestamp: 1,
};

describe("CSP violation telemetry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("redacts secrets from policies", () => {
    expect(sanitizeCspPolicy(violation.originalPolicy)?.value).toBe(
      "script-src 'nonce-[redacted]' 'sha256-[redacted]'; frame-src https://js.stripe.com/v3",
    );
  });

  it("deduplicates violations and caps each mount", () => {
    const limiter = new CspViolationTelemetryLimiter(2);
    expect(limiter.shouldReport("t1", "s1", violation)).toBe(true);
    expect(limiter.shouldReport("t1", "s1", violation)).toBe(false);
    expect(
      limiter.shouldReport("t1", "s1", {
        ...violation,
        blockedUri: "https://two.example",
      }),
    ).toBe(true);
    expect(
      limiter.shouldReport("t1", "s1", {
        ...violation,
        blockedUri: "https://three.example",
      }),
    ).toBe(false);
    expect(limiter.shouldReport("t1", "s1", { ...violation, mountId: 5 })).toBe(
      true,
    );
    limiter.clearToolCall("t1");
    expect(limiter.shouldReport("t1", "s1", violation)).toBe(true);
  });

  it("sends sanitized warning details without duplicating user email", () => {
    reportCspViolationToSentry({
      toolCallId: "tool-1",
      serverId: "server-1",
      violation,
      appliedPolicy: "frame-src https://js.stripe.com/v3?key=secret",
      appliedMode: "widget-declared",
      comparison: { status: "different", differingDirectives: ["script-src"] },
    });

    expect(captureSentryMessage).toHaveBeenCalledWith(
      "MCP App CSP violation",
      expect.objectContaining({
        level: "warning",
        fingerprint: ["mcp-app-csp-violation", "frame-src"],
        extra: expect.objectContaining({
          mountId: 4,
          blockedOrigin: "https://js.stripe.com",
          blockedUrl: "https://js.stripe.com/v3",
          sourceFile: "https://app.example/widget.js",
          appliedPolicy: "frame-src https://js.stripe.com/v3",
          originalPolicy: expect.not.stringContaining("secret"),
        }),
      }),
    );
    expect(
      JSON.stringify(vi.mocked(captureSentryMessage).mock.calls),
    ).not.toContain("email");
  });

  it("identifies only a source MCPJam intended to allow but failed to inject", () => {
    const intent = {
      csp: { frameDomains: ["https://js.stripe.com"] },
      permissive: false,
    };
    expect(
      failedToApplyCsp({
        violation,
        appliedPolicy: "default-src 'none'; frame-src 'none'",
        intent,
      }),
    ).toBe(true);
    expect(
      failedToApplyCsp({
        violation,
        appliedPolicy: "frame-src https://js.stripe.com",
        intent,
      }),
    ).toBe(false);
    expect(
      failedToApplyCsp({
        violation,
        appliedPolicy: "frame-src 'none'",
        intent: { csp: { frameDomains: [] }, permissive: false },
      }),
    ).toBe(false);
  });

  it("emits an error named Failed to apply CSP only for an MCPJam failure", () => {
    reportCspViolationToSentry({
      toolCallId: "tool-1",
      serverId: "server-1",
      violation,
      appliedPolicy: "default-src 'none'; frame-src 'none'",
      appliedMode: "widget-declared",
      intent: {
        csp: { frameDomains: ["https://js.stripe.com"] },
        permissive: false,
      },
      comparison: { status: "matching", differingDirectives: [] },
    });

    expect(captureSentryMessage).toHaveBeenCalledWith(
      "Failed to apply CSP",
      expect.objectContaining({
        level: "error",
        fingerprint: ["failed-to-apply-csp", "frame-src"],
        tags: expect.objectContaining({ mcpjam_csp_apply_failed: "true" }),
      }),
    );
  });
});
