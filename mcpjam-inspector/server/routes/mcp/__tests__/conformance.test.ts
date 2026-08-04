import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import conformance from "../conformance.js";

// ── Mock MCPClientManager ───────────────────────────────────────────────

function createMockManager(overrides: Record<string, any> = {}) {
  return {
    getServerConfig: vi.fn().mockReturnValue(undefined),
    getConnectionStatus: vi.fn().mockReturnValue("connected"),
    ...overrides,
  };
}

function createTestApp(manager: ReturnType<typeof createMockManager>) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as any).mcpClientManager = manager;
    await next();
  });
  app.route("/api/mcp/conformance", conformance);
  return app;
}

async function postJson(
  app: Hono,
  path: string,
  body: Record<string, unknown>,
) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("POST /api/mcp/conformance/protocol", () => {
  it("returns 400 when serverId is missing", async () => {
    const app = createTestApp(createMockManager());
    const res = await postJson(app, "/api/mcp/conformance/protocol", {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns notConnected when server is not connected", async () => {
    const manager = createMockManager({
      getServerConfig: vi.fn().mockReturnValue(undefined),
    });
    const app = createTestApp(manager);
    const res = await postJson(app, "/api/mcp/conformance/protocol", {
      serverId: "test-server",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("notConnected");
  });

  it("returns unsupportedTransport for stdio servers", async () => {
    const manager = createMockManager({
      getServerConfig: vi.fn().mockReturnValue({
        command: "node",
        args: ["server.js"],
      }),
    });
    const app = createTestApp(manager);
    const res = await postJson(app, "/api/mcp/conformance/protocol", {
      serverId: "test-server",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("unsupportedTransport");
  });

  it("rejects an unknown protocolVersion pin", async () => {
    const manager = createMockManager({
      getServerConfig: vi
        .fn()
        .mockReturnValue({ url: new URL("https://example.test/mcp") }),
    });
    const app = createTestApp(manager);
    const res = await postJson(app, "/api/mcp/conformance/protocol", {
      serverId: "test-server",
      protocolVersion: "DRAFT-2027-zzz",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});

describe("POST /api/mcp/conformance/apps", () => {
  it("returns 400 when serverId is missing", async () => {
    const app = createTestApp(createMockManager());
    const res = await postJson(app, "/api/mcp/conformance/apps", {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns notConnected when server is not connected", async () => {
    const manager = createMockManager({
      getServerConfig: vi.fn().mockReturnValue(undefined),
    });
    const app = createTestApp(manager);
    const res = await postJson(app, "/api/mcp/conformance/apps", {
      serverId: "test-server",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("notConnected");
  });
});

describe("POST /api/mcp/conformance/tasks", () => {
  it("returns 400 when serverId is missing", async () => {
    const app = createTestApp(createMockManager());
    const res = await postJson(app, "/api/mcp/conformance/tasks", {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns notConnected when server is not connected", async () => {
    const app = createTestApp(createMockManager());
    const res = await postJson(app, "/api/mcp/conformance/tasks", {
      serverId: "test-server",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("notConnected");
  });

  it("rejects a non-positive poll timeout", async () => {
    const manager = createMockManager({
      getServerConfig: vi
        .fn()
        .mockReturnValue({ url: "https://example.test/mcp" }),
    });
    const app = createTestApp(manager);
    const res = await postJson(app, "/api/mcp/conformance/tasks", {
      serverId: "test-server",
      pollTimeoutMs: 0,
    });
    expect(res.status).toBe(400);
  });

  it("runs the suite against the connected server config", async () => {
    const manager = createMockManager({
      getServerConfig: vi
        .fn()
        .mockReturnValue({ url: new URL("https://example.test/mcp") }),
    });
    const app = createTestApp(manager);
    const res = await postJson(app, "/api/mcp/conformance/tasks", {
      serverId: "test-server",
      toolName: "long_job",
    });

    // The fake target is unreachable, so the suite reports a connection
    // failure rather than throwing: the route still answers 200 with a result.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.result.passed).toBe(false);
    expect(body.result.checks[0].id).toBe("tasks-wire-resolvable");
  });
});

describe("POST /api/mcp/conformance/oauth/start", () => {
  it("returns 400 when serverId is missing", async () => {
    const app = createTestApp(createMockManager());
    const res = await postJson(app, "/api/mcp/conformance/oauth/start", {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns unsupportedTransport for stdio servers", async () => {
    const manager = createMockManager({
      getServerConfig: vi.fn().mockReturnValue({
        command: "node",
        args: ["server.js"],
      }),
    });
    const app = createTestApp(manager);
    const res = await postJson(app, "/api/mcp/conformance/oauth/start", {
      serverId: "test-server",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("unsupportedTransport");
  });
});

describe("POST /api/mcp/conformance/oauth/authorize", () => {
  it("returns 400 when sessionId is missing", async () => {
    const app = createTestApp(createMockManager());
    const res = await postJson(app, "/api/mcp/conformance/oauth/authorize", {
      code: "test-code",
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown session", async () => {
    const app = createTestApp(createMockManager());
    const res = await postJson(app, "/api/mcp/conformance/oauth/authorize", {
      sessionId: "nonexistent",
      code: "test-code",
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/mcp/conformance/oauth/complete", () => {
  it("returns 400 when sessionId is missing", async () => {
    const app = createTestApp(createMockManager());
    const res = await postJson(app, "/api/mcp/conformance/oauth/complete", {});
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown session", async () => {
    const app = createTestApp(createMockManager());
    const res = await postJson(app, "/api/mcp/conformance/oauth/complete", {
      sessionId: "nonexistent",
    });
    expect(res.status).toBe(404);
  });
});
