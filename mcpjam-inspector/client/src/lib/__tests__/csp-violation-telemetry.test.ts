import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureSentryMessage } from "../sentry";
import {
  CspViolationTelemetryLimiter,
  failedToApplyCsp,
  intentionalClientCspBlocks,
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

  it("sends sanitized support details without making them page-worthy", () => {
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
        level: "info",
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

describe("intentional client CSP limits", () => {
  const origin = "https://api.tommy-local.ngrok.app";
  const policy =
    "default-src 'none'; img-src data: blob:; connect-src https://api.tommy-local.ngrok.app";
  const intent = {
    csp: { resourceDomains: [origin], connectDomains: [origin] },
    permissive: false,
    cspSubtypePolicy: {
      cspResourceDomains: { image: false },
      cspConnectDomains: { fetch: false, xhr: true },
    },
    clientContext: {
      clientName: "Goose",
      declaredCsp: {
        resourceDomains: [origin],
        connectDomains: [origin],
        frameDomains: [origin],
        baseUriDomains: [origin],
      },
      capabilities: {
        cspResourceDomains: { image: false },
        cspFrameDomains: false,
        cspBaseUriDomains: false,
      },
    },
  };
  const imageViolation = {
    directive: "img-src",
    blockedUri: origin + "/icon.svg",
    disposition: "enforce" as const,
    timestamp: 1,
    mountId: "proxy:1",
    originalPolicy: policy,
  };

  it("reproduces Goose's expected image block without paging", () => {
    const args = { violation: imageViolation, appliedPolicy: policy, intent };
    expect(failedToApplyCsp(args)).toBe(false);
    expect(intentionalClientCspBlocks(args)).toEqual([
      {
        capability: "cspResourceDomains.image",
        directive: "img-src",
        rule: "img-src data: blob:",
      },
    ]);
    reportCspViolationToSentry({
      ...args,
      toolCallId: "t1",
      serverId: "s1",
      comparison: { status: "matching", differingDirectives: [] },
    });
    expect(captureSentryMessage).toHaveBeenLastCalledWith(
      "MCP App CSP violation",
      expect.objectContaining({
        level: "info",
        tags: expect.objectContaining({ mcpjam_csp_apply_failed: "false" }),
        extra: expect.objectContaining({
          intentionalClientLimits: ["cspResourceDomains.image"],
        }),
      }),
    );
  });

  it.each([
    ["script-src-elem", "script", "cspResourceDomains.script"],
    ["style-src-elem", "stylesheet", "cspResourceDomains.stylesheet"],
    ["img-src", "image", "cspResourceDomains.image"],
    ["font-src", "font", "cspResourceDomains.font"],
    ["media-src", "media", "cspResourceDomains.media"],
    ["connect-src", "fetch", "cspConnectDomains.fetch"],
    ["connect-src", "xhr", "cspConnectDomains.xhr"],
    ["connect-src", "websocket", "cspConnectDomains.websocket"],
    ["frame-src", undefined, "cspFrameDomains"],
    ["base-uri", undefined, "cspBaseUriDomains"],
  ] as const)("explains %s / %s", (directive, subtype, capability) => {
    const appliedPolicy = "default-src 'none'";
    const args = {
      violation: {
        ...imageViolation,
        directive,
        subtype,
        originalPolicy: appliedPolicy,
      },
      appliedPolicy,
      intent: {
        ...intent,
        cspSubtypePolicy: {
          cspResourceDomains: {
            script: false,
            stylesheet: false,
            image: false,
            font: false,
            media: false,
          },
          cspConnectDomains: { fetch: false, xhr: false, websocket: false },
        },
      },
    };
    expect(
      intentionalClientCspBlocks(args).map((block) => block.capability),
    ).toEqual([capability]);
    expect(failedToApplyCsp(args)).toBe(false);
  });

  it("explains a guarded fetch even when connect-src allows its origin", () => {
    expect(
      intentionalClientCspBlocks({
        violation: {
          ...imageViolation,
          directive: "connect-src",
          subtype: "fetch",
        },
        appliedPolicy: policy,
        intent,
      })[0].capability,
    ).toBe("cspConnectDomains.fetch");
  });

  it("does not guess a connection subtype when only one is unsupported", () => {
    expect(
      intentionalClientCspBlocks({
        violation: { ...imageViolation, directive: "connect-src" },
        appliedPolicy: policy,
        intent,
      }),
    ).toEqual([]);
  });

  it("lists all connection limits when all are explicitly off", () => {
    const appliedPolicy = "connect-src 'none'";
    const args = {
      violation: {
        ...imageViolation,
        directive: "connect-src",
        originalPolicy: appliedPolicy,
      },
      appliedPolicy,
      intent: {
        ...intent,
        cspSubtypePolicy: {
          cspConnectDomains: { fetch: false, xhr: false, websocket: false },
        },
      },
    };
    expect(intentionalClientCspBlocks(args)).toHaveLength(3);
    expect(failedToApplyCsp(args)).toBe(false);
  });

  it("does not claim unsupported capabilities for undeclared sources or report-only events", () => {
    for (const violation of [
      { ...imageViolation, blockedUri: "https://undeclared.example/icon.svg" },
      { ...imageViolation, disposition: "report" as const },
      { ...imageViolation, originalPolicy: "img-src 'none'" },
    ])
      expect(
        intentionalClientCspBlocks({
          violation,
          appliedPolicy: policy,
          intent,
        }),
      ).toEqual([]);
    expect(
      intentionalClientCspBlocks({
        violation: imageViolation,
        appliedPolicy: policy,
        intent: { ...intent, clientContext: undefined },
      }),
    ).toEqual([]);
  });

  it("still pages when an allowed source override was lost", () => {
    const args = {
      violation: imageViolation,
      appliedPolicy: policy,
      intent: { ...intent, cspDirectives: { "img-src": [origin] } },
    };
    expect(failedToApplyCsp(args)).toBe(true);
    expect(intentionalClientCspBlocks(args)).toEqual([]);
  });

  it("uses the mount's actual policy, not advertised limits bypassed in relaxed mode", () => {
    const args = {
      violation: imageViolation,
      appliedPolicy: policy,
      intent: { ...intent, cspSubtypePolicy: undefined },
    };
    expect(failedToApplyCsp(args)).toBe(true);
    expect(intentionalClientCspBlocks(args)).toEqual([]);
  });

  it("still pages if a declared frame source in the mount recipe was lost", () => {
    const appliedPolicy = "frame-src 'none'";
    const args = {
      violation: {
        ...imageViolation,
        directive: "frame-src",
        originalPolicy: appliedPolicy,
      },
      appliedPolicy,
      intent: { ...intent, csp: { frameDomains: [origin] } },
    };
    expect(failedToApplyCsp(args)).toBe(true);
    expect(intentionalClientCspBlocks(args)).toEqual([]);
  });

  it("still identifies real application failures and supports legacy intent", () => {
    const args = {
      violation: imageViolation,
      appliedPolicy: policy,
      intent: { csp: intent.csp, permissive: false },
    };
    expect(failedToApplyCsp(args)).toBe(true);
    expect(intentionalClientCspBlocks(args)).toEqual([]);
    expect(failedToApplyCsp({ ...args, intent: undefined })).toBe(false);
  });
});
