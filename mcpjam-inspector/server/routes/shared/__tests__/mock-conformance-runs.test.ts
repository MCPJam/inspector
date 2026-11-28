/**
 * Starting a hosted conformance run (`/v1`) against a saved mock. The route
 * hands the start the caller's auth context, so the run dials the mock through
 * the in-process door as that caller, renewing its grant in the background,
 * and never judges or dials the placeholder address. The executor is replaced
 * by a recorder; the recorded server is then connected for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEphemeralClient } from "@mcpjam/sdk";
import type { MockDefinition } from "@mcpjam/sdk/mocks";
import { startTicketHttp, type RunningTicketServer } from "../../mcp/__tests__/helpers/ticket-server.js";
import { stubMockBackend, type MockBackendStub } from "../../mcp/__tests__/helpers/mock-backend-stub.js";

const started = vi.hoisted(() => ({ args: undefined as Record<string, any> | undefined }));

vi.mock("../../../services/conformance-run-executor.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../services/conformance-run-executor.js")>()),
  executePersistedConformanceRun: vi.fn(async (args: Record<string, any>) => {
    started.args = args;
    await args.onRunStarted("run1", { status: "queued" });
    return { runId: "run1" };
  }),
}));

const definition: MockDefinition = {
  tools: {
    lookup_ticket: {
      description: "Reads a ticket (mock).",
      answer: { from: "saved", cases: [{ when: { id: "123" }, result: { content: [{ type: "text", text: "saved 123" }] } }] },
    },
  },
};

let http: RunningTicketServer & { url: string };
let backend: MockBackendStub;

const authorized = {
  serverConfig: {
    transportType: "http",
    url: "https://mock.mcpjam.invalid/mock1",
    headers: {},
    mock: { mockId: "mock1", version: 1, contentHash: "h".repeat(64), grantExpiresAt: Date.now() + 3_600_000 },
  },
  oauthAccessToken: "grant-1",
};

/** Hosted mode, where the egress guard would refuse the placeholder host. */
async function load() {
  vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
  vi.stubEnv("CONVEX_URL", "https://convex.test");
  vi.resetModules();
  const guard = await import("../../../utils/hosted-egress-guard.js");
  guard.setEgressHostResolverForTests(async (host) => {
    if (host.endsWith(".invalid")) throw new Error("ENOTFOUND");
    return ["93.184.216.34"];
  });
  const registry = await import("../../../services/mock/registry.js");
  const route = await import("../../../services/mock/route.js");
  registry.registerMockInProcessHandler(route.inProcessMockHandler());
  const runs = await import("../conformance-runs.js");
  const executor = await import("../../../services/conformance-run-executor.js");
  const connection = await import("../conformance-connection.js");
  return { runs, executor, connection, registry };
}

const dial = () => ({
  caller: {},
  bearerToken: "person-bearer",
  projectId: "proj1",
  reauthorize: async () => ({ ok: true, ...authorized }),
});

const start = (runs: Awaited<ReturnType<typeof load>>["runs"], extra: Record<string, unknown> = {}) =>
  runs.startHostedConformanceRun({
    convexToken: "person-bearer",
    projectId: "proj1",
    serverId: "mock-row",
    authorized: authorized as never,
    settings: "none",
    translateError: (error) => (error instanceof Error ? error : new Error(String(error))),
    ...extra,
  });

beforeEach(async () => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  started.args = undefined;
  http = await startTicketHttp();
  backend = stubMockBackend({ definition, base: { transportType: "http", url: http.url }, baseless: true });
});

afterEach(async () => {
  backend.restore();
  vi.unstubAllEnvs();
  vi.resetModules();
  await http.close();
});

describe("a hosted conformance run of a mock", () => {
  it("dials the mock as the caller, in process, and judges no network target", async () => {
    const { runs, executor, connection, registry } = await load();
    const receipt = await start(runs, { mockDial: dial() });
    expect(receipt).toMatchObject({ runId: "run1", serverId: "mock-row", deduped: false });

    const server = started.args!.server;
    // The placeholder host would fail the hosted guard; the run does not judge it.
    expect(await executor.persistedConformanceTargetRefusal(server)).toBeNull();
    // The settings step and the suites both reach the mock through the door.
    const checked = await connection.checkConformanceConnection(server, "auto");
    expect(checked).toMatchObject({ status: "ready" });
    const guarded = executor.guardPersistedConformanceTransport({ server });
    const listed = await withEphemeralClient(guarded.server, async (manager, id) => manager.listTools(id));
    expect(listed.tools.map((tool) => tool.name)).toEqual(["lookup_ticket"]);

    const resolved = backend.calls.filter((c) => c.path === "/web/mock/resolve");
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved[0].body).toEqual({ grant: "grant-1" });
    expect(resolved[0].headers.authorization).toBe("Bearer person-bearer");
    expect(backend.placeholderRequests).toEqual([]);
    registry.registerMockInProcessHandler(undefined);
  });

  it("refuses to start without the caller's context rather than dialing the placeholder", async () => {
    const { runs } = await load();
    await expect(start(runs)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("cannot open a mock server") });
    expect(started.args).toBeUndefined();
    expect(backend.placeholderRequests).toEqual([]);
  });

  it("still judges a saved server's address as before", async () => {
    const { runs } = await load();
    await expect(
      start(runs, {
        authorized: { serverConfig: { transportType: "http", url: "http://169.254.169.254/mcp" } },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(started.args).toBeUndefined();
  });
});
