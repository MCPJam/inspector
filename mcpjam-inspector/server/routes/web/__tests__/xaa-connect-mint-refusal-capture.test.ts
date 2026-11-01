import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Context } from "hono";
import type { RequestLogContext } from "../../../utils/log-events.js";

// The real logger runs: the assertion is on what reaches Sentry. Only the
// transports are stubbed.
const { captureExceptionMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  captureException: captureExceptionMock,
  captureMessage: vi.fn(),
  withScope: (callback: (scope: unknown) => unknown) => callback({}),
}));

vi.mock("@axiomhq/js", () => ({
  Axiom: vi.fn().mockImplementation(function () {
    return {
      ingest: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

const { mintXaaAccessTokenMock, mcpClientManagerMock } = vi.hoisted(() => ({
  mintXaaAccessTokenMock: vi.fn(),
  mcpClientManagerMock: vi.fn(),
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  return {
    ...actual,
    MCPClientManager: mcpClientManagerMock.mockImplementation(function () {
      return {
        disconnectAllServers: vi.fn(),
      };
    }),
  };
});
vi.mock("../../../services/xaa-mint.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../services/xaa-mint.js")>();
  return {
    ...actual,
    mintXaaAccessToken: mintXaaAccessTokenMock,
  };
});

import { rebuildSentryEvent } from "@mcpjam/sdk/internal/telemetry";
import { createAuthorizedManager, callerContextFromHono } from "../auth.js";
import { ErrorCode, WebRouteError } from "../errors.js";

// What Sentry receives: the SDK's strict boundary rebuilds every event from
// allowlists, so the options handed to `captureException` are only half the
// story. Only `level` and `tags` matter here.
function throughSentryBoundary(options: unknown): {
  level?: string;
  tags?: Record<string, string>;
} {
  const { level, tags } = (options ?? {}) as {
    level?: string;
    tags?: Record<string, string>;
  };
  return rebuildSentryEvent({ level, tags });
}

const baseContext: RequestLogContext = {
  event: "http.request.completed",
  timestamp: "2024-01-01T00:00:00.000Z",
  environment: "test",
  release: null,
  component: "http",
  requestId: "req-xaa-mint-refusal",
  route: "/api/web/test",
  method: "POST",
  authType: "unknown",
};

function makeContext(): Context {
  const vars: Record<string, unknown> = {
    requestLogContext: { ...baseContext },
  };
  return {
    var: new Proxy(vars, { get: (t, p) => t[p as string] }),
    get: (key: string) => vars[key],
    set: (key: string, value: unknown) => {
      vars[key] = value;
    },
  } as unknown as Context;
}

function batchWithXaaServer() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: {
          "srv-xaa": {
            ok: true,
            role: "member",
            accessLevel: "project_member",
            permissions: { chatOnly: false },
            serverConfig: {
              transportType: "http",
              url: "https://xaa.example.com/mcp",
              secretsBoundOrigin: "https://xaa.example.com",
              authMethod: "auto",
              authServerMode: "mcpjam",
              clientId: "client-1",
            },
          },
        },
      }),
    } as unknown as Response),
  );
}

async function connectExpectingFailure(): Promise<unknown> {
  try {
    await createAuthorizedManager(
      callerContextFromHono(makeContext()),
      "bearer-token",
      "ws-1",
      ["srv-xaa"],
      30_000,
      undefined,
      undefined,
      {
        serverNames: ["Billing MCP"],
        xaaIssuer: "https://app.mcpjam.com/api/web",
        xaaPolicy: { idp: "mcpjam" },
      },
    );
  } catch (error) {
    return error;
  }
  throw new Error("expected the connect to fail");
}

describe("createAuthorizedManager — Sentry capture of XAA mint failures", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    mintXaaAccessTokenMock.mockReset();
    captureExceptionMock.mockReset();
    batchWithXaaServer();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // The customer's authorization server refused the jwt-bearer grant. Sentry
  // still hears about it, but tagged `routine` so the generic new-issue rule
  // does not page, and with the AS status and RFC 6749 code as tags, because
  // Sentry scrubs the message they used to live in. The assertion runs the
  // captured options through the server's Sentry boundary, which rebuilds
  // tags from an allowlist: a tag that boundary drops never reaches Sentry.
  it("captures an authorization-server rejection as a routine warning with the AS verdict in tags", async () => {
    mintXaaAccessTokenMock.mockRejectedValue(
      new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        "XAA token exchange (jwt-bearer grant) was rejected by the authorization server at https://as.example.com/token (HTTP 400) — invalid_grant: issuer not trusted",
        {
          status: 400,
          authorizationServer: "rejected",
          oauthError: "invalid_grant",
        },
      ),
    );

    const failure = await connectExpectingFailure();

    expect(failure).toMatchObject({ status: 502, code: "SERVER_UNREACHABLE" });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [captured, options] = captureExceptionMock.mock.calls[0]!;
    expect(captured).toBeInstanceOf(WebRouteError);
    expect(options).toMatchObject({
      level: "warning",
      tags: { capture_policy: "always" },
    });
    expect(throughSentryBoundary(options)).toMatchObject({
      level: "warning",
      tags: {
        page_class: "routine",
        xaa_failure: "authorization_rejected",
        xaa_as_status: "400",
        xaa_as_error: "invalid_grant",
      },
    });
  });

  // No authorization server could be discovered for the configured issuer.
  // Same treatment.
  it("captures a failed authorization-server discovery as a routine warning", async () => {
    mintXaaAccessTokenMock.mockRejectedValue(
      new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "Couldn't discover an authorization server. Set the issuer in Configure Server to Test.",
        { authorizationServer: "undiscovered" },
      ),
    );

    await connectExpectingFailure();

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(
      throughSentryBoundary(captureExceptionMock.mock.calls[0]![1]),
    ).toMatchObject({
      level: "warning",
      tags: {
        page_class: "routine",
        xaa_failure: "authorization_server_unknown",
      },
    });
  });

  // One of MCPJam's own mint legs broke. That is still an incident: captured
  // at the default level, without the routine tag, so the paging rule fires.
  it("still pages on a mint failure that is not the authorization server's answer", async () => {
    mintXaaAccessTokenMock.mockRejectedValue(
      new Error("ID-JAG signing key unavailable"),
    );

    await connectExpectingFailure();

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const options = captureExceptionMock.mock.calls[0]![1] as {
      level?: string;
      tags?: Record<string, string>;
    };
    expect(options.level).not.toBe("warning");
    expect(options.tags?.page_class).toBeUndefined();
    expect(options.tags?.error_origin).toBe("mcpjam");
  });

  // Same code and status shape as a refusal, but raised by the secret-reveal
  // leg against MCPJam's own backend: no marker, so it keeps paging.
  it("still pages on a backend 502 that merely shares the refusal's error code", async () => {
    mintXaaAccessTokenMock.mockRejectedValue(
      new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        "Failed to reach the server secrets service: fetch failed",
        { status: 502 },
      ),
    );

    await connectExpectingFailure();

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const options = captureExceptionMock.mock.calls[0]![1] as {
      level?: string;
      tags?: Record<string, string>;
    };
    expect(options.level).not.toBe("warning");
    expect(options.tags?.page_class).toBeUndefined();
    expect(options.tags?.xaa_failure).toBeUndefined();
  });
});
