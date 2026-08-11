/**
 * The client collects its own trace entries — it does not always project an
 * SDK snapshot. The refresh flow in particular produces ONLY the client-side
 * trace, so `projectOAuthTraceSnapshot`'s error redaction never runs over it.
 *
 * These tests pin the redaction the client applies itself, in the hosted
 * configuration where `SANITIZE_OAUTH_TRACES` is on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/config")>(
    "@/lib/config",
  );
  return { ...actual, HOSTED_MODE: true, SANITIZE_OAUTH_TRACES: true };
});

const REFRESH_TOKEN = "rt_supersecretrefreshtokenvalue0987654321";

describe("client-side OAuth trace error redaction (hosted)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("redacts credentials echoed into a failed step's error message", async () => {
    const { createOAuthTrace, failOAuthTraceStep } = await import(
      "../oauth-trace"
    );

    const trace = createOAuthTrace({
      source: "refresh",
      serverName: "notion",
      serverUrl: "https://mcp.notion.com/mcp",
    });

    failOAuthTraceStep(
      trace,
      "token_request",
      new Error(
        `Refresh failed: invalid_grant - refresh_token=${REFRESH_TOKEN} is expired`,
      ),
    );

    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain(REFRESH_TOKEN);
    expect(trace.error).toContain("refresh_token=[redacted]");
    expect(trace.steps[0]?.error).toContain("refresh_token=[redacted]");
  });

  // The redactor must not destroy the diagnostic vocabulary it exists to
  // preserve: "Bearer token is expired" is a description, not a credential.
  it("keeps diagnostic words that merely look credential-adjacent", async () => {
    const { createOAuthTrace, failOAuthTraceStep } = await import(
      "../oauth-trace"
    );

    const trace = createOAuthTrace({ source: "refresh" });
    failOAuthTraceStep(
      trace,
      "token_request",
      new Error("Bearer token is expired"),
    );

    expect(trace.error).toBe("Bearer token is expired");
  });

  it("redacts credentials echoed into a proxy transport failure", async () => {
    const { traceOAuthErrorMessage } = await import("../trace-redaction");

    expect(
      traceOAuthErrorMessage(
        `OAuth proxy failed: upstream rejected access_token=${REFRESH_TOKEN}`,
      ),
    ).not.toContain(REFRESH_TOKEN);
  });
});

describe("client-side OAuth trace error redaction (local)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("leaves error messages intact when sanitization is off", async () => {
    vi.doMock("@/lib/config", async () => {
      const actual = await vi.importActual<typeof import("@/lib/config")>(
        "@/lib/config",
      );
      return { ...actual, HOSTED_MODE: false, SANITIZE_OAUTH_TRACES: false };
    });

    const { createOAuthTrace, failOAuthTraceStep } = await import(
      "../oauth-trace"
    );

    const raw = `Refresh failed: refresh_token=${REFRESH_TOKEN}`;
    const trace = createOAuthTrace({ source: "refresh" });
    failOAuthTraceStep(trace, "token_request", new Error(raw));

    expect(trace.error).toBe(raw);
  });
});
