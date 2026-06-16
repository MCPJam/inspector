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

import { authorizeBatch, callerContextFromHono } from "../auth.js";

const baseContext: RequestLogContext = {
  event: "http.request.completed",
  timestamp: "2024-01-01T00:00:00.000Z",
  environment: "test",
  release: null,
  component: "http",
  requestId: "req-batch-test",
  route: "/api/web/test",
  method: "POST",
  authType: "unknown",
};

function makeContext(): { c: Context; vars: Record<string, unknown> } {
  const vars: Record<string, unknown> = { requestLogContext: { ...baseContext } };
  const c = {
    var: new Proxy(vars, { get: (t, p) => t[p as string] }),
    // Faithful to Hono: `c.get(k)` mirrors `c.var[k]`. The delegated-auth
    // header builder reads context via `c.get(...)`.
    get: (key: string) => vars[key],
    set: (key: string, value: unknown) => {
      vars[key] = value;
    },
  } as unknown as Context;
  return { c, vars };
}

function mockBatchResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const projectCtx = {
  authType: "signedIn" as const,
  userId: "user-1",
  projectId: "ws-1",
  projectRole: "member" as const,
  accessLevel: "project_member" as const,
  orgId: "org-1",
  orgPlan: "team",
  emailDomain: "example.com",
};

describe("authorizeBatch — request log context attribution", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("merges per-server fields into request context for a single-server batch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockBatchResponse({
          results: {
            "srv-alpha": {
              ok: true,
              role: "member",
              accessLevel: "project_member",
              permissions: { chatOnly: false },
              serverConfig: { transportType: "http", url: "https://a" },
              internalLogContext: {
                ...projectCtx,
                serverId: "srv-alpha",
                serverTransport: "http",
                chatboxId: "cb-1",
              },
            },
          },
        }),
      ),
    );

    const { c, vars } = makeContext();
    await authorizeBatch(callerContextFromHono(c), "bearer", "ws-1", ["srv-alpha"]);

    const merged = vars.requestLogContext as RequestLogContext;
    expect(merged.serverId).toBe("srv-alpha");
    expect(merged.serverTransport).toBe("http");
    expect(merged.chatboxId).toBe("cb-1");
    expect(merged.projectId).toBe("ws-1");
    expect(merged.userId).toBe("user-1");
    expect(merged.authType).toBe("signedIn");
  });

  it("nulls per-server fields but keeps project fields for multi-server batch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockBatchResponse({
          results: {
            "srv-alpha": {
              ok: true,
              role: "member",
              accessLevel: "project_member",
              permissions: { chatOnly: false },
              serverConfig: { transportType: "http", url: "https://a" },
              internalLogContext: {
                ...projectCtx,
                serverId: "srv-alpha",
                serverTransport: "http",
                chatboxId: "cb-alpha",
              },
            },
            "srv-beta": {
              ok: true,
              role: "member",
              accessLevel: "project_member",
              permissions: { chatOnly: false },
              serverConfig: { transportType: "stdio" },
              internalLogContext: {
                ...projectCtx,
                serverId: "srv-beta",
                serverTransport: "stdio",
                chatboxId: "cb-beta",
              },
            },
          },
        }),
      ),
    );

    const { c, vars } = makeContext();
    await authorizeBatch(callerContextFromHono(c), "bearer", "ws-1", ["srv-alpha", "srv-beta"]);

    const merged = vars.requestLogContext as RequestLogContext;
    expect(merged.serverId).toBeNull();
    expect(merged.serverTransport).toBeNull();
    expect(merged.chatboxId).toBeNull();
    // Project-level fields still attributed.
    expect(merged.projectId).toBe("ws-1");
    expect(merged.userId).toBe("user-1");
    expect(merged.authType).toBe("signedIn");
    expect(merged.accessLevel).toBe("project_member");
  });

  it("does not call setRequestLogContext when all results are failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockBatchResponse({
          results: {
            "srv-alpha": {
              ok: false,
              status: 403,
              code: "FORBIDDEN",
              message: "denied",
            },
          },
        }),
      ),
    );

    const { c, vars } = makeContext();
    const before = { ...(vars.requestLogContext as RequestLogContext) };
    const result = await authorizeBatch(callerContextFromHono(c), "bearer", "ws-1", ["srv-alpha"]);

    expect(vars.requestLogContext).toEqual(before);
    expect(result.results["srv-alpha"]).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("strips command/args/env from hosted serverConfig even if backend regresses", async () => {
    // Defense-in-depth for hosted: the Convex /web/authorize-batch endpoint
    // is contractually HTTP-only (normalizeAuthorizeResult drops STDIO
    // fields). If a backend regression ever lets command/args/env through,
    // the wrapper must drop them before they can reach the hosted client.
    // Local mode uses /web/authorize-batch-local instead, which is allowed
    // to carry STDIO fields and goes through local-server-resolver.ts.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockBatchResponse({
          results: {
            "srv-stdio-leak": {
              ok: true,
              role: "member",
              accessLevel: "project_member",
              permissions: { chatOnly: false },
              serverConfig: {
                transportType: "stdio",
                command: "node",
                args: ["server.js"],
                env: { OPENAI_API_KEY: "sk-secret" },
              },
              internalLogContext: { ...projectCtx, serverId: "srv-stdio-leak" },
            },
            "srv-http-with-leak": {
              ok: true,
              role: "member",
              accessLevel: "project_member",
              permissions: { chatOnly: false },
              serverConfig: {
                transportType: "http",
                url: "https://example.com/mcp",
                command: "should-not-be-here",
                env: { LEAKED: "1" },
              },
              internalLogContext: { ...projectCtx, serverId: "srv-http-with-leak" },
            },
          },
        }),
      ),
    );

    const { c } = makeContext();
    const result = await authorizeBatch(callerContextFromHono(c), "bearer", "ws-1", [
      "srv-stdio-leak",
      "srv-http-with-leak",
    ]);

    for (const entry of Object.values(result.results)) {
      if (!entry.ok) continue;
      const cfg = entry.serverConfig as Record<string, unknown>;
      expect(cfg.command).toBeUndefined();
      expect(cfg.args).toBeUndefined();
      expect(cfg.env).toBeUndefined();
    }
    // Sanity: HTTP fields that *are* allowed survive the strip.
    const httpEntry = result.results["srv-http-with-leak"];
    if (!httpEntry.ok) throw new Error("expected ok result");
    expect(httpEntry.serverConfig.url).toBe("https://example.com/mcp");
  });

  it("strips internalLogContext from every successful result returned to caller", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockBatchResponse({
          results: {
            "srv-alpha": {
              ok: true,
              role: "member",
              accessLevel: "project_member",
              permissions: { chatOnly: false },
              serverConfig: { transportType: "http", url: "https://a" },
              internalLogContext: { ...projectCtx, serverId: "srv-alpha" },
            },
            "srv-beta": {
              ok: true,
              role: "member",
              accessLevel: "project_member",
              permissions: { chatOnly: false },
              serverConfig: { transportType: "http", url: "https://b" },
              internalLogContext: { ...projectCtx, serverId: "srv-beta" },
            },
          },
        }),
      ),
    );

    const { c } = makeContext();
    const result = await authorizeBatch(callerContextFromHono(c), "bearer", "ws-1", [
      "srv-alpha",
      "srv-beta",
    ]);

    for (const entry of Object.values(result.results)) {
      expect((entry as Record<string, unknown>).internalLogContext).toBeUndefined();
    }
  });
});
