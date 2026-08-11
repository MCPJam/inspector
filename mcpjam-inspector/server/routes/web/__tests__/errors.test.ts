import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));
import * as Sentry from "@sentry/node";
const captureException = vi.mocked(Sentry.captureException);
import { originOf } from "@mcpjam/sdk";
import { InsufficientScopeError } from "@modelcontextprotocol/client";

import {
  ErrorCode,
  WebRouteError,
  mapRuntimeError,
  webErrorFromRoute,
} from "../errors.js";
import { isOriginCaptureHandled } from "../../../utils/error-origin-capture.js";

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

  it("frames connection-class 502s as a target-server problem, preserving the raw error", () => {
    // The raw errno text ("read ECONNRESET") in a client toast reads like an
    // MCPJam outage; the mapped message must name the target server as the
    // failing side while keeping the raw error for debugging.
    const mapped = mapRuntimeError(new Error("read ECONNRESET"));
    expect(mapped.status).toBe(502);
    expect(mapped.code).toBe(ErrorCode.SERVER_UNREACHABLE);
    expect(mapped.message).toContain("read ECONNRESET");
    expect(mapped.message).toContain("not an MCPJam outage");
  });

  it("never returns a blank message for a blank-message error", () => {
    // A bare `new Error()` rejection maps to a blank body message, which the
    // client renders as an empty toast.
    const mapped = mapRuntimeError(new Error(""));
    expect(mapped.status).toBe(500);
    expect(mapped.message.trim()).not.toBe("");
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

  it("stamps the ORIGINAL error, not only the WebRouteError it built", () => {
    // The mapper constructs a fresh `WebRouteError` and links the original as
    // its `cause`, but the dedupe walk only goes that direction. Several
    // handlers keep their own reference and call `logger.error(error)` after
    // returning the envelope; without a stamp on the original that is a second
    // Sentry event for one failure.
    const original = new Error("kaboom");
    mapRuntimeError(original);

    expect(isOriginCaptureHandled(original)).toBe(true);
  });

  it("keeps the stamp non-enumerable so it never reaches a JSON body", () => {
    const original = new Error("kaboom");
    mapRuntimeError(original);

    expect(Object.keys(original)).not.toContain("cause");
    expect(
      Object.getOwnPropertySymbols(original).filter(
        (s) => original.propertyIsEnumerable(s),
      ),
    ).toEqual([]);
  });
});

describe("internal-fault boundary", () => {
  beforeEach(() => captureException.mockClear());

  it("captures a genuine TypeError from a hosted web handler", () => {
    // `web.onError` turns a throw into a response without rethrowing, and this
    // mapper stamps the error as decided, so a real bug on the whole
    // `/api/web/*` surface reached Sentry nowhere at all. The catalog cannot
    // help here — it classifies this `ambiguous`, which the strict policy
    // declines — so the boundary declaration is the only thing that captures it.
    const mapped = mapRuntimeError(
      new TypeError("Cannot read properties of undefined (reading 'id')"),
    );

    expect(originOf(mapped.normalized)).toBe("ambiguous");
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0]![1]).toMatchObject({
      tags: expect.objectContaining({ error_origin: "mcpjam" }),
    });
  });

  it("does NOT treat undici's fetch failure as our bug", () => {
    // `TypeError: fetch failed` is how undici reports a dead HTTP server. A
    // constructor-only rule would hand somebody's unreachable server back as
    // an MCPJam page, which is the attribution this work removes.
    const mapped = mapRuntimeError(new TypeError("fetch failed"));

    expect(mapped.normalized?.slug).toBe("transport/fetch_failed");
    expect(captureException).not.toHaveBeenCalled();
  });

  it("leaves an ordinary user-server failure uncaptured", () => {
    // The mapper also handles every timeout and reset from somebody else's
    // server. A blanket internal boundary here would flood the channel, which
    // is why the declaration is narrowed to native programmer-fault types.
    mapRuntimeError(new Error("Request timed out"));

    expect(captureException).not.toHaveBeenCalled();
  });
});

describe("webError origin header", () => {
  function respondWith(error: unknown) {
    const app = new Hono();
    app.get("/boom", (c) => webErrorFromRoute(c, mapRuntimeError(error)));
    return app.request("/boom");
  }

  it("emits the origin as a header, not only in the body", async () => {
    // The chat client's reporter runs AFTER the AI SDK has consumed the
    // Response into `new Error(await response.text())`. Only the status
    // survives to it, and from a bare 5xx it would guess `mcpjam` and page us
    // for a user's own MCP server.
    const res = await respondWith(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), {
        code: "ECONNREFUSED",
      }),
    );

    expect(res.headers.get("x-mcpjam-error-origin")).toBe("user_config");
    expect((await res.json()).origin).toBe("user_config");
  });

  it("agrees with the body on every envelope that carries one", async () => {
    const res = await respondWith(new Error("kaboom"));

    expect(res.headers.get("x-mcpjam-error-origin")).toBe(
      (await res.json()).origin,
    );
  });
});
