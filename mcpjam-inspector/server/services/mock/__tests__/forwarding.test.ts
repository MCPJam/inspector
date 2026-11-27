/**
 * Forwarding through the route: what reaches the real server, what never does,
 * and what the trace is told. The real server is the ticket fixture (a counted
 * writable MCP server); the backend's policy answer is a function the test sets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../routes/web/auth.js", () => ({
  buildConvexAuthHeaders: (_caller: unknown, bearer: string) => ({ Authorization: `Bearer ${bearer}` }),
  createAuthorizedManager: vi.fn(),
}));

import { MCPClientManager } from "@mcpjam/sdk";
import type { MockDefinition } from "@mcpjam/sdk/mocks";
import {
  startTicketHttp,
  startTicketStdio,
  type RunningTicketServer,
} from "../../../routes/mcp/__tests__/helpers/ticket-server.js";
import type { PinnedDiscovery } from "../backend.js";
import type { ForwardVerdict } from "../forward-policy.js";
import type { OpenReal } from "../connection.js";
import type { MockCallMark } from "../../../../shared/mock-answer-span.js";
import { MOCK_CALLS_HEADER, parseMockCalls } from "../answer-marks.js";
import { serveMock, type MockDoor } from "../route.js";
import { dialMock, resolvedMock } from "./helpers.js";

let ticket: RunningTicketServer & { url: string };
let verdict: () => Promise<ForwardVerdict>;
let credentials: string[];
let opens: number;

const open: OpenReal = async ({ bearerToken }) => {
  opens += 1;
  return {
    manager: new MCPClientManager({}, { lazyConnect: true }),
    config: {
      url: ticket.url,
      baseFetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        credentials.push(`bearer-${bearerToken}`);
        return fetch(input, init);
      }) as typeof fetch,
    },
  };
};

const httpDoor = (who = "ann"): MockDoor => ({
  kind: "http",
  bearerToken: who,
  caller: { authMethod: "workos_api_key", workosUserId: who },
  profile: { timeoutMs: 5_000 },
});

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

function serve(def: MockDefinition = definition, door: MockDoor = httpDoor(), discovery?: PinnedDiscovery) {
  return (request: Request) =>
    serveMock(request, "mock1", door, {
      resolve: async () =>
        resolvedMock({
          definition: def,
          baseServerId: "real1",
          ...(discovery ? { discovery } : {}),
        }),
      open,
      check: () => verdict(),
    });
}

beforeEach(async () => {
  ticket = await startTicketHttp();
  verdict = async () => ({ allowed: true });
  credentials = [];
  opens = 0;
});
afterEach(async () => {
  await ticket.close();
});

const call = async (serveFn: (r: Request) => Promise<Response>, tool: string, args: Record<string, unknown>) => {
  const client = await dialMock(serveFn);
  try {
    return (await client.executeTool("mock", tool, args)) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
  } finally {
    await client.disconnectAllServers();
  }
};

describe("a call through a mock", () => {
  it("answers a saved match locally, with no dispatch", async () => {
    const result = await call(serve(), "lookup_ticket", { id: "123" });
    expect(result.content[0].text).toBe("saved 123");
    expect(ticket.dispatchCount()).toBe(0);
  });

  it("forwards an allowed miss once, with the caller's own credentials", async () => {
    const result = await call(serve(), "lookup_ticket", { id: "456" });
    expect(result.content[0].text).toContain('"status":"open"');
    expect(ticket.store.dispatches).toEqual([{ tool: "lookup_ticket", arguments: { id: "456" } }]);
    expect(new Set(credentials)).toEqual(new Set(["bearer-ann"]));
  });

  it("sends a renamed tool, with a fixed argument, to the real tool", async () => {
    const renamed: MockDefinition = {
      tools: {
        find: { answer: { tool: "lookup_ticket" }, params: { id: { fixed: "456" } } },
        lookup_ticket: { hidden: true },
      },
    };
    const result = await call(serve(renamed), "find", {});
    expect(result.content[0].text).toContain('"id":"456"');
    expect(ticket.store.dispatches).toEqual([{ tool: "lookup_ticket", arguments: { id: "456" } }]);
  });

  it.each([
    ["a workspace block", async (): Promise<ForwardVerdict> => ({ allowed: false, reason: "blocked_by_policy" })],
    ["revoked access", async (): Promise<ForwardVerdict> => ({ allowed: false, reason: "no_access" })],
    [
      "a policy read that fails",
      async (): Promise<ForwardVerdict> => {
        throw new Error("backend unreachable");
      },
    ],
  ])("is refused without dispatch after %s", async (_name, answer) => {
    verdict = answer;
    const result = await call(serve(), "close_ticket", { id: "123" });
    expect(result.isError).toBe(true);
    expect(ticket.dispatchCount()).toBe(0);
    expect(ticket.store.tickets.get("123")?.status).toBe("open");
  });

  it("asks the policy again before every forward, so a block lands on the next call", async () => {
    const client = await dialMock(serve());
    await client.executeTool("mock", "echo", { message: "one" });
    expect(ticket.dispatchCount()).toBe(1);
    verdict = async () => ({ allowed: false, reason: "blocked_by_policy" });
    const blocked = (await client.executeTool("mock", "echo", { message: "two" })) as { isError?: boolean };
    expect(blocked.isError).toBe(true);
    expect(ticket.dispatchCount()).toBe(1);
    await client.disconnectAllServers();
  });
});

describe("discovery while forwarding is blocked", () => {
  it("lists from the pinned contract and never opens the real server", async () => {
    verdict = async () => ({ allowed: false, reason: "blocked_by_policy" });
    const pinnedTools = [
      { name: "lookup_ticket", description: "Reads a ticket.", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
      { name: "echo", description: "Echoes.", inputSchema: { type: "object" } },
    ];
    const client = await dialMock(
      serve(definition, httpDoor(), { capabilities: { tools: {} }, tools: pinnedTools as never }),
    );
    const listed = await client.listTools("mock");
    expect(listed.tools.map((t) => t.name).sort()).toEqual(["echo", "lookup_ticket"]);
    expect(opens).toBe(0);
    expect(ticket.dispatchCount()).toBe(0);
    await client.disconnectAllServers();
  });
});

describe("the real server is down while forwarding is allowed", () => {
  const pinnedTools = [
    { name: "lookup_ticket", description: "Reads a ticket.", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
    { name: "echo", description: "Echoes.", inputSchema: { type: "object" } },
  ];
  const withPinned = () =>
    serve(definition, httpDoor(), { capabilities: { tools: {} }, tools: pinnedTools as never });

  beforeEach(async () => {
    await ticket.close();
  });
  // `afterEach` closes the fixture again; closing twice is harmless.

  it("lists from the pinned contract, as blocked mode does", async () => {
    const client = await dialMock(withPinned());
    const listed = await client.listTools("mock");
    expect(listed.tools.map((t) => t.name).sort()).toEqual(["echo", "lookup_ticket"]);
    await client.disconnectAllServers();
  });

  it("keeps answering a self-contained saved answer", async () => {
    const result = await call(withPinned(), "lookup_ticket", { id: "123" });
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toBe("saved 123");
  });

  it("refuses a call that needs the base, saying the real server is unreachable", async () => {
    const result = await call(withPinned(), "echo", { message: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/could not reach the real server/i);
  });

  it("lists the saved prompts and resources", async () => {
    const door = serve(definition, httpDoor(), {
      capabilities: { prompts: {}, resources: {}, tools: {} },
      tools: pinnedTools as never,
      prompts: [{ name: "greet" }],
      resources: [{ uri: "note://welcome", name: "note" }],
    });
    const client = await dialMock(door);
    expect((await client.listPrompts("mock")).prompts.map((p) => p.name)).toEqual(["greet"]);
    expect((await client.listResources("mock")).resources.map((r) => r.uri)).toEqual(["note://welcome"]);
    await client.disconnectAllServers();
  });

  it("reports the outage when nothing was pinned, rather than listing nothing", async () => {
    const client = await dialMock(serve());
    await expect(client.listTools("mock")).rejects.toThrow(/could not reach the real server/i);
    await client.disconnectAllServers();
  });
});

describe("provenance", () => {
  const run = async (door: MockDoor) => {
    const headers: Array<string | null> = [];
    const client = await dialMock(async (request) => {
      const response = await serve(definition, door)(request);
      headers.push(response.headers.get(MOCK_CALLS_HEADER));
      return response;
    });
    await client.executeTool("mock", "lookup_ticket", { id: "123" });
    await client.executeTool("mock", "echo", { message: "x" });
    await client.disconnectAllServers();
    return headers;
  };

  it("rides on the response header over HTTP, naming the mock, version, tool, source and real tool", async () => {
    const marks = (await run(httpDoor())).flatMap(parseMockCalls);
    expect(marks).toEqual([
      { mockId: "mock1", version: 2, tool: "lookup_ticket", source: "saved", caseIndex: 0 },
      { mockId: "mock1", version: 2, tool: "echo", source: "forwarded", realServerId: "real1", realTool: "echo" },
    ]);
  });

  it("goes to the in-process caller as each call settles, and adds nothing to the result", async () => {
    const marks: MockCallMark[] = [];
    const door: MockDoor = {
      kind: "in-process",
      grant: "g",
      bearerToken: "ann",
      caller: { authMethod: "workos_api_key", workosUserId: "ann" },
      projectId: "proj1",
      profile: { timeoutMs: 5_000 },
      onCall: (m) => marks.push(m),
    };
    const result = await call(serve(definition, door), "echo", { message: "x" });
    expect(marks).toEqual([
      { mockId: "mock1", version: 2, tool: "echo", source: "forwarded", realServerId: "real1", realTool: "echo" },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/mock1|real1|forwarded/);
  });

  it("records a blocked forward as blocked, with the reason", async () => {
    verdict = async () => ({ allowed: false, reason: "blocked_by_policy" });
    const headers = await run(httpDoor());
    const marks = headers.flatMap(parseMockCalls);
    expect(marks.at(-1)).toMatchObject({ tool: "echo", source: "blocked", refusal: "blocked_by_policy" });
  });
});

describe("a stdio base", () => {
  it("is reached through the caller's own connection, and counted", async () => {
    const stdio = startTicketStdio();
    try {
      const stdioOpen: OpenReal = async () => ({
        manager: new MCPClientManager({}, { lazyConnect: true }),
        config: { command: stdio.command, args: stdio.args },
      });
      const result = await call(
        (request) =>
          serveMock(request, "mock1", httpDoor(), {
            resolve: async () => resolvedMock({ definition, baseServerId: "real1" }),
            open: stdioOpen,
            check: async () => ({ allowed: true }),
          }),
        "echo",
        { message: "over stdio" },
      );
      expect(result.content[0].text).toBe("echo: over stdio");
      expect(stdio.dispatchCount()).toBe(1);
    } finally {
      stdio.cleanup();
    }
  }, 30_000);
});

describe("the pinned listing", () => {
  it("answers every family from the saved contract, with no network read", async () => {
    const { forwardingRealServer } = await import("../forwarding.js");
    const { real } = forwardingRealServer({
      resolved: {
        ...resolvedMock(),
        baseServerId: "real1",
        discovery: { prompts: [{ name: "p1" }], resources: [{ uri: "skill://a/SKILL.md", name: "a" }] },
      },
      caller: {},
      bearerToken: "ann",
      profile: { timeoutMs: 1 },
      signal: new AbortController().signal,
      open,
      check: async () => ({ allowed: false, reason: "blocked_by_policy" }),
    });
    expect(await real.pinnedListing?.("prompts")).toEqual([{ name: "p1" }]);
    expect(await real.pinnedListing?.("resources")).toEqual([{ uri: "skill://a/SKILL.md", name: "a" }]);
    expect(await real.pinnedListing?.("resourceTemplates")).toEqual([]);
    expect(opens).toBe(0);
  });
});
