import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMock, MOCK_ERROR_CODES, NO_REAL_SERVER } from "../index.js";
import type { MockCallEvent, MockDefinition } from "../index.js";
import { buildRealHandler, connectRealServer } from "./real-fixture.js";
import type { RealCalls } from "./real-fixture.js";

const closers: Array<() => Promise<void>> = [];
let state: RealCalls;
let events: MockCallEvent[];
beforeEach(() => {
  state = { calls: [], hideTools: new Set(), asked: [] };
  events = [];
});
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const BLOCKED = {
  allowed: false,
  reason: "blocked_by_policy",
  message:
    "Your workspace admin has blocked calls to real servers from mocks. Ask an admin to allow forwarding, or save an answer for this call.",
} as const;

async function connect(definition: MockDefinition, fromNothing = false) {
  let real = NO_REAL_SERVER;
  if (!fromNothing) {
    const connected = await connectRealServer(buildRealHandler(state), state);
    real = connected.real;
    closers.push(connected.close);
  }
  const handler = buildMock(definition, real, {
    observer: (event) => events.push(event),
  });
  const client = new Client({ name: "mock-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://mock.local/mcp"), {
      fetch: (input, init) =>
        handler.fetch(new Request(input as string | URL, init)),
    })
  );
  closers.push(() => client.close());
  return client;
}

const text = (value: string) => ({ content: [{ type: "text", text: value }] });

const savedEcho: MockDefinition = {
  tools: {
    echo: {
      answer: {
        from: "saved",
        cases: [{ when: { message: "hello" }, result: text("saved") }],
      },
    },
  },
};

describe("forwarding", () => {
  it("asks the host immediately before a forward and names the real tool and final arguments", async () => {
    const client = await connect({
      tools: {
        say: {
          answer: { tool: "add", arguments: { mode: "up" } },
          params: { b: { fixed: 40 } },
        },
        add: { hidden: true },
      },
    });
    const asked: unknown[] = [];
    state.decide = () => {
      asked.push([...(state.asked ?? [])]);
      return { allowed: true };
    };
    await client.callTool({ name: "say", arguments: { a: 2, b: 999 } });
    expect(state.calls).toEqual([
      { name: "add", args: { a: 2, b: 40, mode: "up" } },
    ]);
    expect(asked).toEqual([[{ kind: "tool", name: "add" }]]);
    expect(events).toEqual([
      { tool: "say", source: "forwarded", realTool: "add" },
    ]);
  });

  it("passes the renamed tool and the final arguments to the host's check", async () => {
    const seen: unknown[] = [];
    const real = {
      ...NO_REAL_SERVER,
      describe: async () => ({ capabilities: { tools: {} } }),
      listTools: async () => [
        { name: "add", inputSchema: { type: "object" as const } },
      ],
      authorizeForward: async (request: unknown) => {
        seen.push(request);
        return { allowed: true } as const;
      },
      callTool: async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }),
    };
    const handler = buildMock(
      {
        tools: {
          say: {
            answer: { tool: "add", arguments: { x: 1 } },
            params: { y: { fixed: 2 } },
          },
          add: { hidden: true },
        },
      },
      real
    );
    const client = new Client({ name: "mock-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://mock.local/mcp"), {
        fetch: (input, init) =>
          handler.fetch(new Request(input as string | URL, init)),
      })
    );
    closers.push(() => client.close());
    await client.callTool({ name: "say", arguments: { y: 9, z: 3 } });
    expect(seen).toEqual([
      {
        kind: "tool",
        tool: "say",
        realTool: "add",
        arguments: { y: 2, z: 3, x: 1 },
      },
    ]);
  });

  it("a blocked forward is a tool error that says why, and the real server hears nothing", async () => {
    const client = await connect(savedEcho);
    state.decide = () => BLOCKED;
    const result = await client.callTool({
      name: "echo",
      arguments: { message: "other" },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(text(BLOCKED.message).content);
    expect(state.calls).toEqual([]);
    expect(events).toEqual([
      {
        tool: "echo",
        source: "blocked",
        realTool: "echo",
        refusal: "blocked_by_policy",
      },
    ]);
  });

  it("a saved answer still works while forwarding is blocked", async () => {
    const client = await connect(savedEcho);
    state.decide = () => BLOCKED;
    const result = await client.callTool({
      name: "echo",
      arguments: { message: "hello" },
    });
    expect(result.content).toEqual(text("saved").content);
    expect(state.asked).toEqual([]);
    expect(events).toEqual([
      { tool: "echo", source: "saved", caseIndex: 0, catchAll: false },
    ]);
  });

  it("refuses without dispatch when the host's check itself fails", async () => {
    const client = await connect({});
    const failure = new Error("policy store down");
    state.decide = () => {
      throw failure;
    };
    const result = await client.callTool({
      name: "echo",
      arguments: { message: "x" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("did not");
    expect(state.calls).toEqual([]);
    expect(events).toEqual([
      {
        tool: "echo",
        source: "blocked",
        realTool: "echo",
        refusal: "policy_unavailable",
        cause: failure,
      },
    ]);
  });

  it("refuses a lost-access forward the same way", async () => {
    const client = await connect({});
    state.decide = () => ({
      allowed: false,
      reason: "no_access",
      message: "You no longer have access to the backing server.",
    });
    const result = await client.callTool({
      name: "echo",
      arguments: { message: "x" },
    });
    expect(result.isError).toBe(true);
    expect(state.calls).toEqual([]);
    expect(events[0]).toMatchObject({
      source: "blocked",
      refusal: "no_access",
    });
  });

  it("reports a failing real call as forwarded, and surfaces the failure", async () => {
    const client = await connect({});
    const result = await client.callTool({
      name: "echo",
      arguments: { message: 5 },
    });
    expect(result.isError).toBe(true);
    expect(events).toEqual([
      { tool: "echo", source: "forwarded", realTool: "echo" },
    ]);
  });

  it("names the unmatched call on a mock with no real tool to call", async () => {
    const client = await connect(
      {
        tools: {
          lookup: {
            answer: {
              from: "saved",
              cases: [{ when: { id: "1" }, result: text("one") }],
            },
          },
        },
      },
      true
    );
    const result = await client.callTool({
      name: "lookup",
      arguments: { id: "2" },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('{"id":"2"}') }),
    ]);
    expect(events).toEqual([{ tool: "lookup", source: "unmatched" }]);
  });

  it("blocks a passed-through method before it reaches the real server", async () => {
    const client = await connect({});
    state.decide = () => BLOCKED;
    await expect(client.listResources()).rejects.toMatchObject({
      code: MOCK_ERROR_CODES.forwardBlocked,
      message: expect.stringContaining("Ask an admin"),
    });
    state.decide = undefined;
    expect((await client.listResources()).resources).toHaveLength(1);
    expect(state.asked).toEqual([
      { kind: "request", name: "resources/list" },
      { kind: "request", name: "resources/list" },
    ]);
  });
});

describe("output schemas", () => {
  const countTool = (cases: unknown[]): MockDefinition =>
    ({
      tools: {
        count: {
          description: "Counts.",
          inputSchema: { type: "object" },
          outputSchema: {
            type: "object",
            properties: { n: { type: "number" } },
            required: ["n"],
          },
          answer: { from: "saved", cases },
        },
      },
    }) as MockDefinition;

  it("returns structured content that fits the declared schema", async () => {
    const client = await connect(
      countTool([
        {
          result: {
            content: [{ type: "text", text: "3" }],
            structuredContent: { n: 3 },
          },
        },
      ]),
      true
    );
    const result = await client.callTool({ name: "count", arguments: {} });
    expect(result.structuredContent).toEqual({ n: 3 });
  });

  it("refuses an invalid structured result with a tool error that says what to fix", async () => {
    const client = await connect(
      countTool([
        {
          when: { bad: true },
          result: { content: [], structuredContent: { n: "three" } },
        },
        { when: { missing: true }, result: { content: [] } },
        {
          when: { late: "x" },
          result: { content: [], structuredContent: { n: "{{input.late}}" } },
        },
      ]),
      true
    );
    for (const args of [{ bad: true }, { missing: true }]) {
      const result = await client.callTool({ name: "count", arguments: args });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result.content)).toContain("output schema");
    }
    // A placeholder is filled before the check, so the filled value is what is judged.
    const late = await client.callTool({
      name: "count",
      arguments: { late: "x" },
    });
    expect(late.isError).toBe(true);
    expect(events.map((e) => e.refusal)).toEqual([
      "invalid_output",
      "invalid_output",
      "invalid_output",
    ]);
  });

  it("does not check the structured output of an error result", async () => {
    const client = await connect(
      countTool([{ result: { isError: true, content: text("down").content } }]),
      true
    );
    const result = await client.callTool({ name: "count", arguments: {} });
    expect(result.isError).toBe(true);
    expect(events).toEqual([
      { tool: "count", source: "saved", caseIndex: 0, catchAll: true },
    ]);
  });
});

describe("a mock of a server with no tools", () => {
  it("advertises no tools, whatever the definition leaves unchanged", async () => {
    state.resourcesOnly = true;
    const client = await connect({ instructions: "Read only." });
    expect(client.getServerCapabilities()?.tools).toBeUndefined();
    expect(client.getServerCapabilities()?.resources).toBeDefined();
    await expect(
      client.request({ method: "tools/list", params: {} })
    ).rejects.toMatchObject({
      code: MOCK_ERROR_CODES.methodUnavailable,
    });
    expect((await client.listResources()).resources).toHaveLength(1);
  });

  it("advertises tools once the definition adds one", async () => {
    state.resourcesOnly = true;
    const client = await connect({
      tools: {
        ping: { answer: { from: "saved", cases: [{ result: text("pong") }] } },
      },
    });
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      "ping",
    ]);
  });
});
