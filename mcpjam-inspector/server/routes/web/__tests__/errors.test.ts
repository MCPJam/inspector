import { describe, expect, it } from "vitest";
import { InsufficientScopeError } from "@modelcontextprotocol/client";

import { ErrorCode, WebRouteError, mapRuntimeError } from "../errors.js";

describe("mapRuntimeError", () => {
  it("passes WebRouteError through unchanged", () => {
    const original = new WebRouteError(404, ErrorCode.NOT_FOUND, "missing");
    expect(mapRuntimeError(original)).toBe(original);
  });

  it("maps timeout messages to 504", () => {
    expect(mapRuntimeError(new Error("Request timed out")).status).toBe(504);
    expect(mapRuntimeError(new Error("Timeout exceeded")).status).toBe(504);
  });

  it("maps a raw 401 from the target server to 401 UNAUTHORIZED without oauthRequired", () => {
    const mapped = mapRuntimeError(
      Object.assign(new Error("Error POSTing to endpoint (HTTP 401)"), {
        statusCode: 401,
      }),
    );
    expect(mapped.status).toBe(401);
    expect(mapped.code).toBe(ErrorCode.UNAUTHORIZED);
    // No per-server auth context here — the escalation tag is applied only
    // where the effective auth method is known.
    expect(mapped.details?.oauthRequired).toBeUndefined();
  });

  it("maps ECONN* errno messages to 502", () => {
    expect(
      mapRuntimeError(new Error("connect ECONNREFUSED 127.0.0.1:8080")).status,
    ).toBe(502);
    expect(mapRuntimeError(new Error("read ECONNRESET")).status).toBe(502);
    expect(mapRuntimeError(new Error("ECONNABORTED")).status).toBe(502);
  });

  it("maps standard connection-failure phrases to 502", () => {
    expect(
      mapRuntimeError(new Error("Connection refused by peer")).status,
    ).toBe(502);
    expect(mapRuntimeError(new Error("Connection reset")).status).toBe(502);
    expect(
      mapRuntimeError(new Error("Failed to connect to upstream")).status,
    ).toBe(502);
    expect(mapRuntimeError(new Error("fetch failed")).status).toBe(502);
    expect(
      mapRuntimeError(new Error("getaddrinfo ENOTFOUND example.com")).status,
    ).toBe(502);
    expect(mapRuntimeError(new Error("socket hang up")).status).toBe(502);
  });

  it("does NOT misclassify words that merely start with 'econ' as 502", () => {
    // Regression for code-review feedback: the errno branch was originally
    // `\becon[a-z]*` (one `n`), which matches server/tool/case names like
    // "Economics" and re-introduces the same kind of false 502 mapping the
    // fix was meant to eliminate. Require the full `econn` prefix.
    expect(
      mapRuntimeError(new Error("Economics server returned an error")).status,
    ).toBe(500);
    expect(mapRuntimeError(new Error("econometric pipeline")).status).toBe(500);
  });

  it("does NOT misclassify 'Reconnect' as 502", () => {
    // Regression: the previous implementation matched the bare substring
    // "connect", which caught the word "Reconnect" inside upstream errors
    // like the eval-generation attachment guard and surfaced them as 502
    // SERVER_UNREACHABLE.
    const error = new Error(
      "Tool snapshot is missing servers required by the attachment: " +
        "Excalidraw (App). Reconnect the missing server(s) in the inspector " +
        "and try again.",
    );
    const mapped = mapRuntimeError(error);
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBe(ErrorCode.INTERNAL_ERROR);
  });

  it("falls back to 500 for unrecognized errors", () => {
    const mapped = mapRuntimeError(new Error("Something else went wrong"));
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBe(ErrorCode.INTERNAL_ERROR);
  });

  it("maps a SEP-2350 insufficient_scope challenge to 403 FORBIDDEN with details.insufficientScope", () => {
    // A live hosted MCP request that 403s `insufficient_scope` surfaces as an
    // `InsufficientScopeError`. It carries no numeric status, so without the
    // dedicated branch it would fall through to the generic 500 and the
    // client would never see the challenge fields.
    const mapped = mapRuntimeError(
      new InsufficientScopeError({
        requiredScope: "read write admin",
        resourceMetadataUrl:
          "https://rs.example/.well-known/oauth-protected-resource",
      }),
    );
    expect(mapped.status).toBe(403);
    expect(mapped.code).toBe(ErrorCode.FORBIDDEN);
    expect(mapped.details?.insufficientScope).toEqual({
      requiredScope: "read write admin",
      resourceMetadataUrl:
        "https://rs.example/.well-known/oauth-protected-resource",
      errorDescription: undefined,
    });
  });

  it("recognizes a wrapped insufficient_scope challenge (cause chain) as 403", () => {
    const inner = new InsufficientScopeError({ requiredScope: "read:tickets" });
    const outer = new Error("tool call failed");
    (outer as any).cause = inner;
    const mapped = mapRuntimeError(outer);
    expect(mapped.status).toBe(403);
    expect(mapped.code).toBe(ErrorCode.FORBIDDEN);
    expect((mapped.details?.insufficientScope as any)?.requiredScope).toBe(
      "read:tickets",
    );
  });
});
