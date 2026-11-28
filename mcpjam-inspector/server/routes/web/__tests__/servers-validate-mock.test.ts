/**
 * Connecting a mock from Servers and Playground in hosted mode. The mock's row
 * carries a placeholder address that resolves nowhere, so the validate and
 * doctor routes must reach it through the in-process door as the caller and
 * never run the hosted egress check on, or dial, the placeholder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { MockDefinition } from "@mcpjam/sdk/mocks";

vi.mock("../../../utils/export-helpers.js", () => ({
  exportSingleServerForInspection: vi.fn(async () => ({ tools: [] })),
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    async mutation() {
      return null;
    }
  },
}));

const definition: MockDefinition = {
  tools: {
    show_ticket: {
      description: "Shows a ticket (mock).",
      inputSchema: { type: "object", properties: {} },
      answer: { from: "saved", cases: [{ result: { content: [{ type: "text", text: "ticket 123" }] } }] },
    },
  },
};

const PLACEHOLDER_HOST = "mock.mcpjam.invalid";
const UNRESOLVED_HOST = "nowhere.example.test";

/** `HOSTED_MODE` is read when `server/config` first loads, so the modules load fresh in hosted mode. */
async function loadHosted() {
  vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  vi.resetModules();
  const guard = await import("../../../utils/hosted-egress-guard.js");
  // The real guard answers an unresolvable host with "could not be resolved" (a 400).
  const judged: string[] = [];
  guard.setEgressHostResolverForTests(async (host: string) => {
    judged.push(host);
    // Neither the placeholder nor the control host below resolves.
    if (host === PLACEHOLDER_HOST || host === UNRESOLVED_HOST) return [];
    return ["93.184.216.34"];
  });
  const { stubMockBackend } = await import("../../mcp/__tests__/helpers/mock-backend-stub.js");
  const { registerMockInProcessHandler } = await import("../../../services/mock/registry.js");
  const { inProcessMockHandler } = await import("../../../services/mock/route.js");
  const backend = stubMockBackend({
    definition,
    base: { transportType: "http", url: "https://base.example.test/mcp" },
    baseless: true,
  });
  registerMockInProcessHandler(inProcessMockHandler());
  const { default: servers } = await import("../servers.js");
  const { default: tools } = await import("../tools.js");
  const app = new Hono();
  app.route("/servers", servers);
  app.route("/tools", tools);
  const post = (path: string) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer person-bearer" },
      body: JSON.stringify({ projectId: "proj1", serverId: "mock-row", serverIds: ["mock-row"] }),
    });
  return {
    post,
    backend,
    judged,
    cleanup: () => {
      registerMockInProcessHandler(undefined);
      backend.restore();
    },
  };
}

let env: Awaited<ReturnType<typeof loadHosted>>;

beforeEach(async () => {
  env = await loadHosted();
});

afterEach(() => {
  env.cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("hosted validate and connect of a mock", () => {
  it("validates a mock through the in-process door and never judges or dials the placeholder", async () => {
    const response = await env.post("/servers/validate");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success?: boolean };
    expect(body.success).toBe(true);
    expect(env.judged).not.toContain(PLACEHOLDER_HOST);
    expect(env.backend.placeholderRequests).toEqual([]);
  });

  it("runs the doctor on a mock through the door without judging the placeholder", async () => {
    const response = await env.post("/servers/doctor");
    expect(response.status).toBe(200);
    expect(env.judged).not.toContain(PLACEHOLDER_HOST);
    expect(env.backend.placeholderRequests).toEqual([]);
  });

  it("lists the mock's tools in the batch the Playground Tools pane sends", async () => {
    const response = await env.post("/tools/list-multi");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      results: Record<string, { tools: Array<{ name: string }> }>;
      errors?: Record<string, unknown>;
    };
    expect(body.errors ?? {}).toEqual({});
    expect(body.results["mock-row"].tools.map((tool) => tool.name)).toContain("show_ticket");
    expect(env.backend.placeholderRequests).toEqual([]);
  });

  it("leaves the check on for an ordinary server whose address does not resolve", async () => {
    const original = env.backend;
    original.restore();
    const unresolved = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === "/web/authorize-batch" || url.pathname === "/web/authorize-batch-local" || url.pathname === "/web/authorize") {
        const entry = {
          ok: true,
          role: "owner",
          accessLevel: "project_member",
          permissions: { chatOnly: false },
          serverConfig: { transportType: "http", url: `https://${UNRESOLVED_HOST}/mcp` },
        };
        const body = JSON.parse(String(init?.body ?? "{}")) as { serverIds?: string[] };
        const payload = url.pathname.endsWith("authorize")
          ? { authorized: true, ...entry }
          : { results: Object.fromEntries((body.serverIds ?? []).map((id) => [id, entry])) };
        return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected fetch ${url.href}`);
    });
    vi.stubGlobal("fetch", unresolved);
    const response = await env.post("/servers/validate");
    expect(response.status).toBe(400);
    expect(env.judged).toContain(UNRESOLVED_HOST);
  });
});
