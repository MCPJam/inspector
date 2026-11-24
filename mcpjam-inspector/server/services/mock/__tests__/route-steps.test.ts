import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../routes/web/auth.js", () => ({
  buildConvexAuthHeaders: (_caller: unknown, bearer: string) => ({
    Authorization: `Bearer ${bearer}`,
  }),
  createAuthorizedManager: vi.fn(),
}));

import { MCPClientManager } from "@mcpjam/sdk";
import { createMockSessionMap, createMockTaskStore } from "@mcpjam/sdk/mocks";
import { mockConnectionPool } from "../connection.js";
import { serveMock } from "../route.js";
import { resolvedMock, stubRealServer, type StubReal } from "./helpers.js";
import type { MockDoor } from "../route.js";

const door = (who: string): MockDoor => ({
  kind: "in-process",
  grant: `grant-for-${who}`,
  bearerToken: `bearer-${who}`,
  caller: { authMethod: "authkit_jwt", workosUserId: who },
  projectId: "proj1",
  profile: { timeoutMs: 5_000 },
});

const asking = resolvedMock({
  baseServerId: undefined,
  definition: {
    tools: {
      cleanup: {
        description: "Cleans up after asking.",
        inputSchema: {
          type: "object",
          properties: { dir: { type: "string" } },
        },
        answer: {
          from: "saved",
          cases: [
            {
              steps: [
                { kind: "progress", progress: 1, total: 1, message: "asking" },
                {
                  kind: "ask",
                  id: "sure",
                  message: "Delete {{input.dir}}?",
                  requestedSchema: {
                    type: "object",
                    properties: { sure: { type: "boolean" } },
                  },
                },
              ],
              result: {
                content: [
                  {
                    type: "text",
                    text: "{{steps.sure.action}} {{steps.sure.content.sure}}",
                  },
                ],
              },
            },
          ],
        },
      },
    },
  },
});

let stub: StubReal;
beforeEach(() => {
  stub = stubRealServer();
});
afterEach(async () => {
  await mockConnectionPool.clear();
});

/** A dialer in this process, as MCPJam's own are, answering questions with `reply`. */
async function dial(
  serve: (request: Request) => Promise<Response>,
  version: string,
  reply: () => {
    action: "accept" | "decline";
    content?: Record<string, unknown>;
  },
) {
  const manager = new MCPClientManager();
  manager.setElicitationCallback(async () => reply());
  // The 2026-07-28 revision carries the question in the result: the collector answers it.
  manager.setMrtrInputCollector("mock", async ({ inputRequests }) =>
    Object.fromEntries(Object.keys(inputRequests).map((key) => [key, reply()])),
  );
  await manager.connectToServer("mock", {
    url: "https://mock.mcpjam.invalid/mock1",
    mcpProtocolVersion: version,
    baseFetch: (input, init) => serve(new Request(input as string, init)),
  } as never);
  return manager;
}

describe.each(["2025-06-18", "2026-07-28"])(
  "a question from a mock at the route, revision %s",
  (version) => {
    it("reaches the dialer's callback and its answer reaches the result", async () => {
      const sessions = createMockSessionMap();
      const deps = {
        open: stub.open,
        resolve: vi.fn(async () => asking),
        sessions,
      };
      const manager = await dial(
        (r) => serveMock(r, "mock1", door("ann"), deps),
        version,
        () => ({ action: "accept", content: { sure: true } }),
      );
      const result = (await manager.executeTool("mock", "cleanup", {
        dir: "/tmp/x",
      })) as { content: Array<{ text: string }> };
      expect(result.content).toEqual([{ type: "text", text: "accept true" }]);
      await manager.disconnectAllServers();
      await sessions.closeAll();
    });
  },
);

describe("what the route keeps between requests", () => {
  it("holds a 2025-era session only for a mock that asks, and never for another caller", async () => {
    const sessions = createMockSessionMap();
    const deps = {
      open: stub.open,
      resolve: vi.fn(async () => asking),
      sessions,
    };
    const manager = await dial(
      (r) => serveMock(r, "mock1", door("ann"), deps),
      "2025-06-18",
      () => ({ action: "decline" }),
    );
    expect(sessions.size()).toBe(1);
    await manager.disconnectAllServers();
    await sessions.closeAll();
    // A mock with no questions is served with no session.
    const plain = {
      open: stub.open,
      resolve: vi.fn(async () => resolvedMock()),
      sessions,
    };
    const other = await dial(
      (r) => serveMock(r, "mock1", door("ann"), plain),
      "2025-06-18",
      () => ({ action: "decline" }),
    );
    expect(sessions.size()).toBe(0);
    await other.disconnectAllServers();
  });

  it("keeps tasks in the store the route is given", async () => {
    const tasks = createMockTaskStore();
    const definition = resolvedMock({
      baseServerId: undefined,
      definition: {
        tools: {
          slow: {
            inputSchema: { type: "object" },
            answer: {
              from: "saved",
              cases: [
                {
                  task: true,
                  result: { content: [{ type: "text", text: "ok" }] },
                },
              ],
            },
          },
        },
      },
    });
    const response = await serveMock(
      new Request("https://mock.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "slow", arguments: {}, task: {} },
        }),
      }),
      "mock1",
      door("ann"),
      { open: stub.open, resolve: vi.fn(async () => definition), tasks },
    );
    expect(await response.text()).toContain('"task"');
    expect(tasks.size()).toBe(1);
  });
});
