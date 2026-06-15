/**
 * Contract test for {@link ManagerCallerContext}: an EMPTY caller context
 * must behave exactly like a plain-JWT route caller — bearer forwarded
 * verbatim, no acting-as headers, no log-context machinery required. The
 * scheduled-evals worker depends on this (it calls createAuthorizedManager
 * with explicit inputs and no Hono request); if buildConvexAuthHeaders or
 * authorizeBatch ever grow a hard dependency on route state, this test is
 * the tripwire.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeBatch,
  buildConvexAuthHeaders,
  callerContextFromHono,
  type ManagerCallerContext,
} from "../auth.js";
import type { Context } from "hono";

function mockBatchResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("ManagerCallerContext — empty context behaves as a plain-JWT caller", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("buildConvexAuthHeaders forwards the bearer verbatim with no acting-as headers", () => {
    const headers = buildConvexAuthHeaders({}, "jwt-token");
    expect(headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer jwt-token",
    });
    expect(headers).not.toHaveProperty("x-mcpjam-acting-as");
    expect(headers).not.toHaveProperty("x-mcpjam-acting-in-org");
  });

  it("authorizeBatch succeeds with an empty context (no log sink, no auth vars)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockBatchResponse({
        results: {
          "srv-1": {
            ok: true,
            role: "member",
            accessLevel: "project_member",
            permissions: { chatOnly: false },
            serverConfig: { transportType: "http", url: "https://a" },
            internalLogContext: {
              authType: "signedIn",
              userId: "user-1",
              projectId: "p-1",
            },
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const caller: ManagerCallerContext = {};
    const result = await authorizeBatch(caller, "jwt-token", "p-1", ["srv-1"]);
    expect(result.results["srv-1"]?.ok).toBe(true);

    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    const sentHeaders = init.headers as Record<string, string>;
    expect(sentHeaders.Authorization).toBe("Bearer jwt-token");
    expect(sentHeaders).not.toHaveProperty("x-mcpjam-acting-as");
  });

  it("matches the behavior of a Hono context without WorkOS API key auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockBatchResponse({ results: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const vars: Record<string, unknown> = {};
    const honoLike = {
      var: new Proxy(vars, { get: (t, p) => t[p as string] }),
      get: (key: string) => vars[key],
      set: (key: string, value: unknown) => {
        vars[key] = value;
      },
    } as unknown as Context;

    await authorizeBatch(callerContextFromHono(honoLike), "jwt", "p-1", []);
    await authorizeBatch({}, "jwt", "p-1", []);

    const honoHeaders = (fetchMock.mock.calls[0][1] as RequestInit)
      .headers as Record<string, string>;
    const emptyHeaders = (fetchMock.mock.calls[1][1] as RequestInit)
      .headers as Record<string, string>;
    expect(emptyHeaders).toEqual(honoHeaders);
  });
});
