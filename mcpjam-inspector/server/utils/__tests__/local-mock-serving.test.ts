/**
 * A signed-in local Inspector serving a mock to Playground: the local
 * resolver authorizes the mock's id, the dialer calls the mock route in
 * process, and the route reaches the backing server through the person's own
 * connection manager, an HTTP or a stdio one. The backend is a fetch stub;
 * the backing server is the ticket fixture, counted at its own end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPClientManager, type MCPServerConfig } from "@mcpjam/sdk";
import type { MockDefinition } from "@mcpjam/sdk/mocks";
import {
  startTicketHttp,
  startTicketStdio,
  type RunningTicketServer,
} from "../../routes/mcp/__tests__/helpers/ticket-server.js";
import { withMockAnswerSink } from "../../services/mock/answer-marks.js";
import type { MockCallMark } from "../../../shared/mock-answer-span.js";
import { registerMockInProcessHandler } from "../../services/mock/registry.js";
import { inProcessMockHandler } from "../../services/mock/route.js";
import { resolveLocalServerForConnect } from "../local-server-resolver.js";
import { approveStdioLaunch } from "../stdio-command-approvals.js";

const ctx = { set: () => {}, get: () => undefined } as never;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const definition: MockDefinition = {
  tools: {
    lookup_ticket: {
      description: "Reads a ticket (mock).",
      answer: {
        from: "saved",
        cases: [{ when: { id: "123" }, result: { content: [{ type: "text", text: "saved 123" }] } }],
      },
    },
  },
};

interface Backend {
  base: { transportType: "http"; url: string } | { transportType: "stdio"; command: string; args: string[] };
  verdict: () => Response;
  mockAuthorize: () => Response | undefined;
  forwardChecks: number;
}

let dir: string;
let backend: Backend;
let http: RunningTicketServer & { url: string };
const realFetch = globalThis.fetch;

const entry = (serverConfig: Record<string, unknown>, oauthAccessToken?: string) => ({
  ok: true,
  role: "owner",
  accessLevel: "project_member",
  permissions: { chatOnly: false },
  serverConfig,
  ...(oauthAccessToken ? { oauthAccessToken } : {}),
});

function stubBackend() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://backend.test/")) return realFetch(input, init);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith("/web/authorize-batch-local") || url.endsWith("/web/authorize-batch")) {
        const local = url.endsWith("-local");
        const [id] = body.serverIds as string[];
        if (id === "mock-row") {
          const refused = backend.mockAuthorize();
          if (refused) return refused;
          return json({
            results: {
              "mock-row": entry(
                {
                  transportType: "http",
                  url: "https://mock.mcpjam.invalid/mock1",
                  headers: {},
                  mock: { mockId: "mock1", version: 3, contentHash: "h".repeat(64), grantExpiresAt: Date.now() + 3_600_000 },
                },
                "grant-1",
              ),
            },
          });
        }
        // The hosted batch strips a stdio row to its transport; the local read has the command.
        const config = !local && backend.base.transportType === "stdio" ? { transportType: "stdio" } : backend.base;
        return json({ results: { [id]: entry(config) } });
      }
      if (url.endsWith("/web/mock/resolve")) {
        return json({
          mockId: "mock1",
          projectId: "proj1",
          name: "Tickets",
          version: 3,
          headVersion: 3,
          contentHash: "h".repeat(64),
          baseServerId: "base1",
          definition,
        });
      }
      if (url.endsWith("/web/mock/forward-check")) {
        backend.forwardChecks += 1;
        return backend.verdict();
      }
      throw new Error(`Unexpected backend call ${url}`);
    }),
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "local-mock-"));
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  vi.stubEnv("MCPJAM_STDIO_APPROVALS_FILE", join(dir, "approvals.json"));
  http = await startTicketHttp();
  backend = {
    base: { transportType: "http", url: http.url },
    verdict: () => json({ allowed: true }),
    mockAuthorize: () => undefined,
    forwardChecks: 0,
  };
  stubBackend();
  // As `routes/web/index.ts` does when it is mounted, in every mode.
  registerMockInProcessHandler(inProcessMockHandler());
});

afterEach(async () => {
  registerMockInProcessHandler(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await http.close();
  await rm(dir, { recursive: true, force: true });
});

/** What Playground does: resolve the saved server locally, connect, call. */
async function connectLocally() {
  const { config } = await resolveLocalServerForConnect(ctx, "person-bearer", "proj1", "mock-row", {
    serverDisplayName: "Tickets (mock)",
  });
  const manager = new MCPClientManager();
  await manager.connectToServer("mock", config as MCPServerConfig);
  return manager;
}

type Result = { isError?: boolean; content: Array<{ text: string }> };

describe("a mock served by a local Inspector", () => {
  it("answers a saved case without touching the base", async () => {
    const manager = await connectLocally();
    const result = (await manager.executeTool("mock", "lookup_ticket", { id: "123" })) as Result;
    expect(result.content[0].text).toBe("saved 123");
    expect(http.dispatchCount()).toBe(0);
    await manager.disconnectAllServers();
  });

  it("forwards an uncovered call to an HTTP base once, and the trace names the real tool", async () => {
    const manager = await connectLocally();
    const marks: MockCallMark[] = [];
    const result = (await withMockAnswerSink(
      (batch) => marks.push(...batch),
      () => manager.executeTool("mock", "lookup_ticket", { id: "456" }),
    )) as Result;
    expect(marks).toEqual([
      expect.objectContaining({ mockId: "mock1", tool: "lookup_ticket", source: "forwarded", realServerId: "base1", realTool: "lookup_ticket" }),
    ]);
    expect(result.content[0].text).toContain('"status":"open"');
    expect(http.store.dispatches).toEqual([{ tool: "lookup_ticket", arguments: { id: "456" } }]);
    await manager.disconnectAllServers();
  });

  describe("with a stdio base", () => {
    let stdio: ReturnType<typeof startTicketStdio>;
    beforeEach(() => {
      stdio = startTicketStdio();
      backend.base = { transportType: "stdio", command: stdio.command, args: stdio.args };
    });
    afterEach(() => stdio.cleanup());

    it("forwards once, through the command this device approved", async () => {
      await approveStdioLaunch("base1", { command: stdio.command, args: stdio.args, env: {} });
      const manager = await connectLocally();
      const result = (await manager.executeTool("mock", "lookup_ticket", { id: "456" })) as Result;
      expect(result.content[0].text).toContain('"status":"open"');
      expect(stdio.dispatchCount()).toBe(1);
      await manager.disconnectAllServers();
    });

    it("does not spawn or dispatch while this device has not approved the command, and says where to approve", async () => {
      const manager = await connectLocally();
      await expect(
        manager.executeTool("mock", "lookup_ticket", { id: "456" }),
      ).rejects.toThrow(/has not approved.*Connect the real server from Servers to review and approve it\. Check that the server is up, then try again\.$/);
      expect(stdio.dispatchCount()).toBe(0);
      await manager.disconnectAllServers();
    });

    it("refuses a command that changed since it was approved", async () => {
      await approveStdioLaunch("base1", { command: stdio.command, args: ["old.js"], env: {} });
      const manager = await connectLocally();
      await expect(
        manager.executeTool("mock", "lookup_ticket", { id: "456" }),
      ).rejects.toThrow(/has not approved/);
      expect(stdio.dispatchCount()).toBe(0);
      await manager.disconnectAllServers();
    });
  });

  it.each([
    ["a workspace block", () => json({ allowed: false, reason: "blocked_by_policy" })],
    ["revoked access", () => json({ code: "MOCK_FORBIDDEN" }, 403)],
  ])("refuses a forward after %s, and the base sees nothing", async (_name, verdict) => {
    backend.verdict = verdict;
    const manager = await connectLocally();
    const result = (await manager.executeTool("mock", "lookup_ticket", { id: "456" })) as Result;
    expect(result.isError).toBe(true);
    expect(http.dispatchCount()).toBe(0);
    // A saved answer still serves while forwarding is refused.
    const saved = (await manager.executeTool("mock", "lookup_ticket", { id: "123" })) as Result;
    expect(saved.content[0].text).toBe("saved 123");
    await manager.disconnectAllServers();
  });

  it("checks the policy again before every forward", async () => {
    const manager = await connectLocally();
    await manager.executeTool("mock", "lookup_ticket", { id: "456" });
    const before = backend.forwardChecks;
    backend.verdict = () => json({ allowed: false, reason: "blocked_by_policy" });
    const result = (await manager.executeTool("mock", "lookup_ticket", { id: "456" })) as Result;
    expect(result.isError).toBe(true);
    expect(backend.forwardChecks).toBeGreaterThan(before);
    expect(http.dispatchCount()).toBe(1);
    await manager.disconnectAllServers();
  });

  describe("signed out", () => {
    it("is refused at the local resolver with the backend's reason", async () => {
      backend.mockAuthorize = () =>
        json({
          results: {
            "mock-row": {
              ok: false,
              status: 403,
              code: "FORBIDDEN",
              message: "Mock servers are not available to guest sessions. Sign in and use the mock from your project.",
            },
          },
        });
      await expect(
        resolveLocalServerForConnect(ctx, "guest-bearer", "proj1", "mock-row", { serverDisplayName: "Tickets" }),
      ).rejects.toMatchObject({ status: 403, message: expect.stringContaining("Sign in") });
    });

    it("tells a person in the app to sign in again when the backend stops accepting them", async () => {
      const { config } = await resolveLocalServerForConnect(ctx, "person-bearer", "proj1", "mock-row", {
        serverDisplayName: "Tickets",
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => json({ code: "MOCK_UNAUTHORIZED" }, 401)),
      );
      const response = await (config as { baseFetch: typeof fetch }).baseFetch("https://mock.mcpjam.invalid/mock1", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(response.status).toBe(401);
      expect((await response.json()).error.message).toMatch(/Sign in again/);
    });
  });
});
