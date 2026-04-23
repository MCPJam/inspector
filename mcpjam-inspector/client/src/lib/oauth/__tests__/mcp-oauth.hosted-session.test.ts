import { beforeEach, describe, expect, it, vi } from "vitest";

const { authFetchMock, getConvexSiteUrlMock } = vi.hoisted(() => ({
  authFetchMock: vi.fn(),
  getConvexSiteUrlMock: vi.fn(),
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: authFetchMock,
}));

vi.mock("@/lib/convex-site-url", () => ({
  getConvexSiteUrl: getConvexSiteUrlMock,
}));

describe("mcp-oauth hosted callback sessions", () => {
  beforeEach(() => {
    vi.resetModules();
    authFetchMock.mockReset();
    getConvexSiteUrlMock.mockReset();
    getConvexSiteUrlMock.mockReturnValue("https://test.convex.site");
    localStorage.clear();
    sessionStorage.clear();
  });

  it("completes hosted callbacks with a shared session id without local verifier state", async () => {
    authFetchMock.mockImplementation((url: string) => {
      if (url === "https://test.convex.site/web/oauth/session/progress") {
        return Promise.resolve(
          new Response(JSON.stringify({ success: false, error: "not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          })
        );
      }

      if (url === "https://test.convex.site/web/oauth/complete") {
        return Promise.resolve(
          new Response(JSON.stringify({ success: true, expiresAt: 123 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }

      throw new Error(`Unexpected authFetch URL: ${url}`);
    });

    const { completeHostedOAuthCallback } = await import("../mcp-oauth");
    const result = await completeHostedOAuthCallback(
      {
        surface: "workspace",
        workspaceId: "ws_1",
        serverId: "srv_asana",
        serverName: "asana",
        serverUrl: "https://mcp.asana.com/sse",
        sessionId: "hosted-session-1",
        accessScope: "workspace_member",
        shareToken: null,
        chatboxToken: null,
        returnHash: "#servers",
        startedAt: Date.now(),
      },
      "oauth-code"
    );

    expect(result.success).toBe(true);
    expect(result.expiresAt).toBe(123);
    expect(authFetchMock).toHaveBeenCalledWith(
      "https://test.convex.site/web/oauth/complete",
      expect.any(Object)
    );

    const completeCall = authFetchMock.mock.calls.find(
      ([url]) => url === "https://test.convex.site/web/oauth/complete"
    );
    expect(completeCall).toBeDefined();

    const [, requestInit] = completeCall as [string, RequestInit];
    const sentBody = JSON.parse(String(requestInit.body));
    expect(sentBody).toEqual({
      workspaceId: "ws_1",
      serverId: "srv_asana",
      code: "oauth-code",
      sessionId: "hosted-session-1",
      accessScope: "workspace_member",
    });
  });

  it("polls hosted session progress and emits live trace updates while the callback completes", async () => {
    vi.useFakeTimers();
    try {
      const progressTrace = {
        version: 1,
        source: "hosted_callback",
        currentStep: "token_request",
        steps: [
          {
            step: "received_authorization_code",
            title: "Authorization Code Received",
            status: "success",
            startedAt: 1,
            completedAt: 2,
          },
          {
            step: "token_request",
            title: "Exchange Authorization Code",
            status: "pending",
            startedAt: 3,
          },
        ],
        httpHistory: [],
      } as const;

      let resolveCompleteResponse: ((response: Response) => void) | undefined;
      const completeResponsePromise = new Promise<Response>((resolve) => {
        resolveCompleteResponse = resolve;
      });

      authFetchMock.mockImplementation((url: string) => {
        if (url === "https://test.convex.site/web/oauth/session/progress") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                success: true,
                sessionId: "hosted-session-1",
                status: "running",
                updatedAt: 101,
                oauthTrace: progressTrace,
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }
            )
          );
        }

        if (url === "https://test.convex.site/web/oauth/complete") {
          return completeResponsePromise;
        }

        throw new Error(`Unexpected authFetch URL: ${url}`);
      });

      const onTraceUpdate = vi.fn();
      const { completeHostedOAuthCallback } = await import("../mcp-oauth");
      const resultPromise = completeHostedOAuthCallback(
        {
          surface: "workspace",
          workspaceId: "ws_1",
          serverId: "srv_asana",
          serverName: "asana",
          serverUrl: "https://mcp.asana.com/sse",
          sessionId: "hosted-session-1",
          accessScope: "workspace_member",
          shareToken: null,
          chatboxToken: null,
          returnHash: "#servers",
          startedAt: Date.now(),
        },
        "oauth-code",
        { onTraceUpdate }
      );

      await vi.waitFor(() =>
        expect(authFetchMock).toHaveBeenCalledWith(
          "https://test.convex.site/web/oauth/session/progress",
          expect.any(Object)
        )
      );
      await vi.waitFor(() =>
        expect(
          onTraceUpdate.mock.calls.some(([trace]) =>
            trace.steps.some(
              (step) =>
                step.step === "token_request" && step.status === "pending"
            )
          )
        ).toBe(true)
      );

      resolveCompleteResponse?.(
        new Response(JSON.stringify({ success: true, expiresAt: 456 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      await vi.advanceTimersByTimeAsync(300);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.expiresAt).toBe(456);
      expect(authFetchMock).toHaveBeenCalledWith(
        "https://test.convex.site/web/oauth/complete",
        expect.any(Object)
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting for hosted completion once session progress reports a terminal failure", async () => {
    vi.useFakeTimers();
    try {
      const failureTrace = {
        version: 1,
        source: "hosted_callback",
        currentStep: "token_request",
        steps: [
          {
            step: "received_authorization_code",
            title: "Authorization Code Received",
            status: "success",
            startedAt: 1,
            completedAt: 2,
          },
          {
            step: "token_request",
            title: "Exchange Authorization Code",
            status: "error",
            startedAt: 3,
            completedAt: 4,
            error:
              "Requested resource was not included in the authorization request",
          },
        ],
        httpHistory: [],
        error:
          "Requested resource was not included in the authorization request",
      } as const;

      authFetchMock.mockImplementation((url: string) => {
        if (url === "https://test.convex.site/web/oauth/session/progress") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                success: true,
                sessionId: "hosted-session-1",
                status: "failed",
                updatedAt: 201,
                completedAt: 202,
                lastError:
                  "Requested resource was not included in the authorization request",
                oauthTrace: failureTrace,
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }
            )
          );
        }

        if (url === "https://test.convex.site/web/oauth/complete") {
          return new Promise<Response>(() => {
            // Intentionally unresolved: terminal progress should end the callback.
          });
        }

        throw new Error(`Unexpected authFetch URL: ${url}`);
      });

      const onTraceUpdate = vi.fn();
      const { completeHostedOAuthCallback } = await import("../mcp-oauth");
      const resultPromise = completeHostedOAuthCallback(
        {
          surface: "workspace",
          workspaceId: "ws_1",
          serverId: "srv_linear",
          serverName: "linear",
          serverUrl: "https://mcp.linear.app/mcp",
          sessionId: "hosted-session-1",
          accessScope: "workspace_member",
          shareToken: null,
          chatboxToken: null,
          returnHash: "#servers",
          startedAt: Date.now(),
        },
        "oauth-code",
        { onTraceUpdate }
      );

      await vi.waitFor(() =>
        expect(authFetchMock).toHaveBeenCalledWith(
          "https://test.convex.site/web/oauth/session/progress",
          expect.any(Object)
        )
      );
      await vi.advanceTimersByTimeAsync(300);

      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        "Requested resource was not included in the authorization request"
      );
      expect(
        onTraceUpdate.mock.calls.some(([trace]) =>
          trace.steps.some(
            (step) => step.step === "token_request" && step.status === "error"
          )
        )
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
