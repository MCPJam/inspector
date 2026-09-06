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

// ── Directory readiness (local, deterministic, free) ────────────────────

describe("POST /api/mcp/conformance/readiness/:publisher", () => {
  it("refuses a publisher outside the two vocabulary words", async () => {
    const app = createTestApp(createMockManager());
    const res = await postJson(app, "/api/mcp/conformance/readiness/gemini", {
      serverId: "s1",
    });
    expect(res.status).toBe(400);
  });

  it("refuses an OpenAI run that declares no submission mode", async () => {
    // Never inferred: inference reads a forgotten package as "MCP-only", which
    // reports the package lane `not-applicable` — a missing input becoming a
    // clean bill of health.
    const app = createTestApp(createMockManager());
    const res = await postJson(app, "/api/mcp/conformance/readiness/openai", {
      serverId: "s1",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("submissionModeRequired");
  });

  it("reports a server that is not connected", async () => {
    const app = createTestApp(createMockManager());
    const res = await postJson(app, "/api/mcp/conformance/readiness/claude", {
      serverId: "s1",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("notConnected");
  });

  it("refuses a stdio server, which no directory can list", async () => {
    const manager = createMockManager({
      getServerConfig: vi.fn().mockReturnValue({ command: "node" }),
    });
    const app = createTestApp(manager);
    const res = await postJson(app, "/api/mcp/conformance/readiness/claude", {
      serverId: "s1",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("unsupportedTransport");
  });

  // `null` and `""` are the two shapes a hand-written client actually sends
  // when it means "unset": a JSON serializer that emits nulls for absent
  // fields, and a form control whose empty state is the empty string. Both
  // must lose at the door with a code, because both are indistinguishable
  // from a real value once past it — an empty `serverId` would resolve to
  // nothing, and an empty `submissionMode` would satisfy the OpenAI
  // required-mode check while grading against no declared shape at all.
  const malformedBodies: Array<[string, Record<string, unknown>]> = [
    ["serverId is null", { serverId: null }],
    ["serverId is empty", { serverId: "" }],
    ["submissionMode is null", { serverId: "s1", submissionMode: null }],
    ["submissionMode is empty", { serverId: "s1", submissionMode: "" }],
  ];

  for (const [name, payload] of malformedBodies) {
    it(`refuses a claude run whose ${name}`, async () => {
      const app = createTestApp(createMockManager());
      const res = await postJson(
        app,
        "/api/mcp/conformance/readiness/claude",
        payload,
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.code).toBe("invalidRequest");
    });

    it(`refuses an openai run whose ${name}`, async () => {
      // The schema runs BEFORE the required-mode check, so an empty or null
      // mode reports as a malformed body rather than as a missing one — the
      // distinction matters, because `submissionModeRequired` tells a caller
      // to add a field it may believe it already sent.
      const app = createTestApp(createMockManager());
      const res = await postJson(
        app,
        "/api/mcp/conformance/readiness/openai",
        payload,
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.code).toBe("invalidRequest");
    });
  }

  it("has no way to ask for model observations", async () => {
    // The flag is ABSENT from the schema rather than accepted and refused: a
    // local run has no lease, no payer and no broker, so the honest surface is
    // one that cannot ask. A flag here would suggest the capability exists on
    // this path and is merely switched off.
    const manager = createMockManager({
      getServerConfig: vi.fn().mockReturnValue({ command: "node" }),
    });
    const app = createTestApp(manager);
    const res = await postJson(app, "/api/mcp/conformance/readiness/claude", {
      serverId: "s1",
      includeLlmObservations: true,
    });
    // Rejected on the transport, NOT on the unknown key — the schema drops it
    // silently, which is the point: there is nothing for it to switch on.
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("unsupportedTransport");
  });

  it("grades a connected HTTP server and answers 200", async () => {
    // The target is unreachable on purpose, so the run stays deterministic and
    // offline: readiness grades what it CAN observe and reports the rest as
    // findings, so an unreachable server still produces a result rather than
    // an error. Without this case a route that 500'd on every valid request
    // would still pass this file.
    const manager = createMockManager({
      getServerConfig: vi
        .fn()
        .mockReturnValue({ url: new URL("https://unreachable.invalid/mcp") }),
    });
    const app = createTestApp(manager);
    const res = await postJson(app, "/api/mcp/conformance/readiness/claude", {
      serverId: "s1",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.result.lanes.length).toBeGreaterThan(0);
    // Free by construction: a local run has no requester, so nothing could
    // have been charged.
    expect(body.result.llmObservations.status).toBe("not-requested");
  });
});
