import { describe, expect, it } from "vitest";
import {
  HOSTED_REQUEST_TIMEOUT_DETAIL,
  describeHostedConnectFailure,
  projectHostedSuccessLogs,
} from "../hosted-connect-failure.js";
import {
  projectHostedAuthoredFailureDetails,
  projectHostedRouteFailure,
} from "../hosted-route-failure.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

/** MJ-001: the pure halves of the hosted MCP route failure account. */

const MARKER = /UNEXPECTED_MARKER/;

const named = (name: string, fields: Record<string, unknown> = {}) =>
  Object.assign(new Error("UNEXPECTED_MARKER_TEXT"), { name, ...fields });

const answeredLogs = {
  _httpLogs: [
    {
      eventId: "event",
      serverId: "srv_1",
      serverName: "Fixture",
      timestamp: "2026-09-27T00:00:00.000Z",
      exchange: {
        serverId: "srv_1",
        request: { method: "POST", url: "https://mcp.example.test/mcp" },
        response: { status: 200, statusText: "OK" },
        durationMs: 4,
      },
    },
  ],
};

describe("describeHostedConnectFailure", () => {
  it.each([
    ["a JSON-RPC request timeout", named("McpError", { code: -32001 })],
    ["the SDK's timeout", named("SdkError", { code: "REQUEST_TIMEOUT" })],
    ["a platform timeout", named("TimeoutError")],
    [
      "a wrapped timeout",
      new Error("UNEXPECTED_MARKER_WRAPPER", {
        cause: named("McpError", { code: -32001 }),
      }),
    ],
  ])("reports %s with a fixed sentence", (_kind, error) => {
    expect(describeHostedConnectFailure(error, answeredLogs)).toEqual({
      message: HOSTED_REQUEST_TIMEOUT_DETAIL,
      blockedTarget: false,
    });
  });

  it("reports a timeout that follows an HTTP answer by its status line", () => {
    class StreamableHTTPError extends Error {
      constructor(readonly code: number) {
        super("UNEXPECTED_MARKER_TEXT");
      }
    }
    const error = new Error("UNEXPECTED_MARKER_WRAPPER", {
      cause: new StreamableHTTPError(504),
    });
    Object.assign(error, { name: "TimeoutError" });
    expect(describeHostedConnectFailure(error, answeredLogs).message).toBe(
      "The MCP server responded with HTTP 504.",
    );
  });

  it("reports an operation's JSON-RPC error by its code", () => {
    const failure = describeHostedConnectFailure(
      named("McpError", { code: -32602, data: "UNEXPECTED_MARKER_DATA" }),
      answeredLogs,
    );
    expect(failure.message).toBe(
      "The MCP server answered with JSON-RPC error -32602 (Invalid params).",
    );
  });

  it("does not read a JSON-RPC code off a connection failure's cause", () => {
    const failure = describeHostedConnectFailure(
      new Error("UNEXPECTED_MARKER_WRAPPER", {
        cause: named("McpError", { code: -32600 }),
      }),
      answeredLogs,
    );
    expect(failure.message).toBe(
      "The MCP server responded with HTTP 200 OK, but not with a valid MCP response.",
    );
  });

  it("reports a version pin refusal with the versions that parse", () => {
    const failure = describeHostedConnectFailure(
      named("ProtocolVersionPinUnsupported", {
        protocolVersion: "2026-07-28",
        supportedVersions: ["2025-06-18", "<b>UNEXPECTED_MARKER_VERSION</b>"],
      }),
      answeredLogs,
    );
    expect(failure.message).toBe(
      "The MCP server doesn't support MCP protocol version 2026-07-28, which this client is pinned to. It offers 2025-06-18.",
    );
  });
});

describe("projectHostedSuccessLogs", () => {
  const exchange = (headers: Record<string, string>, method: string) => ({
    eventId: "event",
    serverId: "srv_1",
    serverName: "Fixture",
    timestamp: "2026-09-27T00:00:00.000Z",
    exchange: {
      serverId: "srv_1",
      request: {
        method: "POST",
        url: "https://mcp.example.test/mcp",
        headers,
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: {
          "content-type": "application/json",
          "x-upstream": "UNEXPECTED_MARKER_RESPONSE",
        },
      },
      durationMs: 3,
      bodyValues: { method },
    },
  });

  it("reduces exchanges and returns frames as they are", () => {
    const frame = {
      eventId: "frame",
      serverId: "srv_1",
      serverName: "Fixture",
      direction: "receive",
      timestamp: "2026-09-27T00:00:00.000Z",
      message: { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "a" }] } },
    };
    const projected = projectHostedSuccessLogs({
      _rpcLogs: [frame],
      _httpLogs: [
        exchange(
          {
            "content-type": "application/json",
            "mcp-method": "tools/list",
            "x-api-token": "UNEXPECTED_MARKER_REQUEST",
          },
          "tools/list",
        ),
      ],
    }) as any;
    expect(JSON.stringify(projected)).not.toMatch(MARKER);
    expect(projected._rpcLogs).toEqual([frame]);
    const [event] = projected._httpLogs;
    expect(event.exchange.request.headers).toEqual({
      "content-type": "application/json",
      "mcp-method": "tools/list",
      "x-api-token": "<redacted>",
    });
    expect(event.exchange.response.headers).toEqual({
      "content-type": "application/json",
    });
  });

  it("keeps Mcp-Method only when it is the request's own method", () => {
    const projected = projectHostedSuccessLogs({
      _httpLogs: [
        exchange({ "mcp-method": "UNEXPECTED_MARKER_METHOD" }, "tools/list"),
      ],
    }) as any;
    expect(projected._httpLogs[0].exchange.request.headers).toEqual({
      "mcp-method": "<redacted>",
    });
  });
});

describe("projectHostedRouteFailure", () => {
  it("keeps an authored failure's wording and reduces what it quotes", () => {
    const error = new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      "Scope required.",
      {
        serverId: "srv_1",
        insufficientScope: {
          requiredScope: "tools:read",
          resourceMetadataUrl: "https://mcp.example.test/prm",
          description: "UNEXPECTED_MARKER_SCOPE",
        },
        failure: {
          url: "https://as.example.test/token",
          status: 500,
          body: "UNEXPECTED_MARKER_BODY",
        },
      },
    );
    const { routeError } = projectHostedRouteFailure(error, error, undefined);
    expect(routeError.message).toBe("Scope required.");
    expect(routeError.status).toBe(403);
    expect(routeError.details).toEqual({
      serverId: "srv_1",
      insufficientScope: {
        requiredScope: "tools:read",
        resourceMetadataUrl: "https://mcp.example.test/prm",
      },
      failure: { url: "https://as.example.test/token", status: 500 },
    });
  });

  it("drops a recorded failure without a usable URL and status", () => {
    expect(
      projectHostedAuthoredFailureDetails({
        failure: { url: "javascript:UNEXPECTED_MARKER", status: 500 },
      }),
    ).toEqual({ failure: null });
  });

  it("answers a refused target as a 400", async () => {
    const { BlockedEgressTargetError } =
      await import("../hosted-egress-guard.js");
    const refusal = new BlockedEgressTargetError(
      'Server URL points at a private or internal address ("10.0.0.5") that the hosted inspector will not dial.',
    );
    const error = new Error("UNEXPECTED_MARKER_WRAPPER", { cause: refusal });
    const routeError = new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      error.message,
      { raw: "UNEXPECTED_MARKER_DETAIL" },
    );
    const projected = projectHostedRouteFailure(routeError, error, undefined);
    expect(projected.routeError.status).toBe(400);
    expect(projected.routeError.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(projected.routeError.details).toBeUndefined();
    expect(JSON.stringify(projected.routeError.message)).not.toMatch(MARKER);
  });
});
