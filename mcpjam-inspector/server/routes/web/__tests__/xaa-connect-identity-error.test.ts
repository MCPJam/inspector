import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Context } from "hono";
import type { RequestLogContext } from "../../../utils/log-events.js";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("@axiomhq/js", () => ({
  Axiom: vi.fn().mockImplementation(() => ({
    ingest: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Spy on the mint so the test can prove the identity error blocks the mint
// BEFORE it starts (no ID-JAG issuance, no token-endpoint exchange).
const { mintXaaAccessTokenMock } = vi.hoisted(() => ({
  mintXaaAccessTokenMock: vi.fn(),
}));
vi.mock("../../../services/xaa-mint.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../services/xaa-mint.js")>();
  return {
    ...actual,
    mintXaaAccessToken: mintXaaAccessTokenMock,
  };
});

import { createAuthorizedManager, callerContextFromHono } from "../auth.js";

const baseContext: RequestLogContext = {
  event: "http.request.completed",
  timestamp: "2024-01-01T00:00:00.000Z",
  environment: "test",
  release: null,
  component: "http",
  requestId: "req-xaa-identity-error",
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

describe("createAuthorizedManager — backend-resolved XAA identity error", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    mintXaaAccessTokenMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("fails the connect with the backend's message and never mints", async () => {
    const identityError =
      "Complete or clear the server identity override: this server has a partial legacy override";
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
                useOAuth: false,
                useXaa: true,
                authServerMode: "mcpjam",
                // Backend omitted BOTH identity members and sent the
                // actionable error instead (legacy partial override).
                xaaIdentityError: identityError,
              },
            },
          },
        }),
      } as unknown as Response),
    );

    await expect(
      createAuthorizedManager(
        callerContextFromHono(makeContext()),
        "bearer-token",
        "ws-1",
        ["srv-xaa"],
        30_000,
        undefined,
        undefined,
        { xaaIssuer: "https://app.mcpjam.com/api/web" },
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      message: identityError,
    });

    // The configuration error surfaces as a distinct failure BEFORE any mint
    // work — no silent fallback to the demo identity, no silent XAA→OAuth
    // fallback.
    expect(mintXaaAccessTokenMock).not.toHaveBeenCalled();
  });
});
