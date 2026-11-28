/**
 * The hosted conformance routes against a saved mock: the route authorizes the
 * mock as the caller, the suite reaches it through the in-process door, and
 * the report names the rule a bad mock breaks so an agent can edit the mock
 * and run again. The backend is a stub; the base is the ticket fixture. Any
 * request for the mock's placeholder address fails the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockDefinition } from "@mcpjam/sdk/mocks";
import { startTicketHttp, type RunningTicketServer } from "../../mcp/__tests__/helpers/ticket-server.js";
import { stubMockBackend, type MockBackendStub } from "../../mcp/__tests__/helpers/mock-backend-stub.js";

let http: RunningTicketServer & { url: string };
let backend: MockBackendStub;

const good: MockDefinition = {
  tools: {
    lookup_ticket: {
      description: "Reads a ticket (mock).",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      answer: {
        from: "saved",
        cases: [{ when: { id: "123" }, result: { content: [{ type: "text", text: "saved 123" }] } }],
      },
    },
  },
};
/** A tool whose `required` is not a list of names: the protocol suite grades it. */
const broken: MockDefinition = {
  tools: {
    lookup_ticket: {
      ...good.tools!.lookup_ticket,
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: "id" },
    },
  },
};

/** Fresh modules for each mode: `HOSTED_MODE` is read when the config first loads. */
async function loadRoutes(hosted: boolean) {
  vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", hosted ? "true" : "false");
  vi.resetModules();
  if (hosted) {
    // The placeholder host resolves nowhere, as it does in production.
    const guard = await import("../../../utils/hosted-egress-guard.js");
    guard.setEgressHostResolverForTests(async (host) => {
      if (host.endsWith(".invalid")) throw new Error("ENOTFOUND");
      return ["93.184.216.34"];
    });
  }
  const registry = await import("../../../services/mock/registry.js");
  const route = await import("../../../services/mock/route.js");
  registry.registerMockInProcessHandler(route.inProcessMockHandler());
  const { default: conformanceWeb } = await import("../conformance.js");
  const post = (path: string, body: Record<string, unknown> = {}) =>
    conformanceWeb.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer person-bearer" },
      body: JSON.stringify({ projectId: "proj1", serverId: "mock-row", ...body }),
    });
  return { post, registry };
}

type Check = { id: string; status: string; error?: string; message?: string };
const checksOf = (result: { checks?: Check[] }) => result.checks ?? [];

beforeEach(async () => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  http = await startTicketHttp();
  backend = stubMockBackend({ definition: good, base: { transportType: "http", url: http.url } });
});

afterEach(async () => {
  backend.restore();
  vi.unstubAllEnvs();
  vi.resetModules();
  await http.close();
});

describe.each([
  ["a local Inspector", false],
  ["the hosted app", true],
])("conformance against a mock on %s", (_name, hosted) => {
  // The hosted app dials no loopback base, so its mock is made from nothing.
  beforeEach(() => {
    backend.restore();
    backend = stubMockBackend({
      definition: good,
      base: { transportType: "http", url: http.url },
      baseless: hosted,
    });
  });

  it("checks the connection as the caller, through the in-process door", async () => {
    const { post, registry } = await loadRoutes(hosted);
    const response = await post("/connection-check", { protocolVersion: "auto" });
    expect(await response.json()).toMatchObject({ status: "ready" });
    // The door resolved the mock with the grant, for this caller's bearer.
    const resolved = backend.calls.filter((c) => c.path === "/web/mock/resolve");
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved[0].body).toEqual({ grant: "grant-1" });
    expect(resolved[0].headers.authorization).toBe("Bearer person-bearer");
    expect(backend.placeholderRequests).toEqual([]);
    registry.registerMockInProcessHandler(undefined);
  });

  it("reports the failing rule by name, and passes once the mock is edited", async () => {
    const { post, registry } = await loadRoutes(hosted);
    const run = async () => {
      const response = await post("/protocol", {
        checkIds: ["server-initialize", "tools-list", "tools-input-schemas-valid"],
      });
      expect(response.status).toBe(200);
      return checksOf((await response.json()).result);
    };

    backend.definition = broken;
    backend.version = 2;
    const failing = await run();
    const rule = failing.find((check) => check.id === "tools-input-schemas-valid");
    expect(rule?.status).toBe("failed");
    expect(JSON.stringify(rule)).toContain("lookup_ticket");

    // The agent corrects the definition and runs again.
    backend.definition = good;
    backend.version = 3;
    const fixed = await run();
    expect(fixed.map((check) => [check.id, check.status])).toEqual(
      expect.arrayContaining([
        ["tools-list", "passed"],
        ["tools-input-schemas-valid", "passed"],
      ]),
    );
    expect(fixed.filter((check) => check.status === "failed")).toEqual([]);
    expect(backend.placeholderRequests).toEqual([]);
    // The suite never called a tool, so the base saw nothing.
    expect(http.dispatchCount()).toBe(0);
    registry.registerMockInProcessHandler(undefined);
  });

  it("runs the Apps checks against the mock too", async () => {
    const { post, registry } = await loadRoutes(hosted);
    const response = await post("/apps", { checkIds: ["ui-tools-present", "ui-tool-input-schema-valid"] });
    expect(response.status).toBe(200);
    const { result } = await response.json();
    // The mock has no app, so the suite says so by rule; it reached the mock to say it.
    expect(checksOf(result).map((check) => check.id)).toEqual(
      expect.arrayContaining(["ui-tools-present", "ui-tool-input-schema-valid"]),
    );
    expect(checksOf(result).some((check) => check.status === "failed" && /placeholder|mcpjam\.invalid/.test(JSON.stringify(check)))).toBe(false);
    expect(backend.placeholderRequests).toEqual([]);
    registry.registerMockInProcessHandler(undefined);
  });

  it("refuses the sign-in checks and says why: a mock has no sign-in", async () => {
    const { post, registry } = await loadRoutes(hosted);
    const response = await post("/oauth/start", { callbackOrigin: "https://app.example" });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toMatch(/mock server has none.*server the mock is based on/);
    expect(backend.placeholderRequests).toEqual([]);
    registry.registerMockInProcessHandler(undefined);
  });
});
