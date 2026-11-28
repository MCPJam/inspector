import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { LOG_LEVEL_META_KEY } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  modernHeaders,
  modernRequestBody,
} from "../../mcp-conformance/raw-http.js";
import {
  buildMock,
  hashRealToolListing,
  MOCK_ERROR_CODES,
  NO_REAL_SERVER,
} from "../index.js";
import type { MockDefinition } from "../index.js";
import { buildRealHandler, connectRealServer } from "./real-fixture.js";
import type { RealCalls } from "./real-fixture.js";

const closers: Array<() => Promise<void>> = [];
let state: RealCalls;
beforeEach(() => {
  state = { calls: [], hideTools: new Set(), asked: [] };
});
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

type Era = "legacy" | "modern";

async function connectMock(
  definition: MockDefinition,
  era: Era,
  hideOnReal: string[] = []
) {
  for (const name of hideOnReal) state.hideTools.add(name);
  const { real, close } = await connectRealServer(
    buildRealHandler(state),
    state
  );
  const handler = buildMock(definition, real);
  const client = new Client(
    { name: "mock-test", version: "1.0.0" },
    era === "modern"
      ? {
          supportedProtocolVersions: ["2025-11-25", "2026-07-28"],
          versionNegotiation: { mode: { pin: "2026-07-28" } },
        }
      : undefined
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://mock.local/mcp"), {
      fetch: (input, init) =>
        handler.fetch(new Request(input as string | URL, init)),
    })
  );
  closers.push(async () => {
    await client.close();
    await close();
  });
  return { client, handler };
}

/** Sends one JSON-RPC request straight to the handler, bypassing the client's own capability checks. */
async function rawError(
  handler: { fetch: (r: Request) => Promise<Response> },
  era: Era,
  method: string
) {
  const body =
    era === "modern"
      ? modernRequestBody({
          id: 1,
          method,
          params: {},
          protocolVersion: "2026-07-28",
        })
      : { jsonrpc: "2.0", id: 1, method, params: {} };
  const headers =
    era === "modern"
      ? modernHeaders({ protocolVersion: "2026-07-28", method })
      : {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        };
  const response = await handler.fetch(
    new Request("http://mock.local/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
  );
  const text = await response.text();
  const payload =
    text.startsWith("event:") || text.startsWith("data:")
      ? text
          .split("\n")
          .find((l) => l.startsWith("data:"))
          ?.slice(5)
      : text;
  return (
    JSON.parse(payload ?? "{}") as { error?: { code: number; message: string } }
  ).error;
}

describe.each<Era>(["legacy", "modern"])("buildMock (%s era)", (era) => {
  it("lists the real tools with the description edit, and the real server is unchanged", async () => {
    const { client } = await connectMock(
      { tools: { echo: { description: "Say it back." } } },
      era
    );
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "echo")?.description).toBe(
      "Say it back."
    );
    expect(tools.map((t) => t.name).sort()).toEqual(["add", "echo", "working"]);

    const { real, close } = await connectRealServer(
      buildRealHandler(state),
      state
    );
    closers.push(close);
    const direct = await real.listTools();
    expect(direct.find((t) => t.name === "echo")?.description).toBe(
      "Echoes the message."
    );
  });

  it("calls the same real tool with the same input", async () => {
    const { client } = await connectMock(
      { tools: { echo: { description: "Say it back." } } },
      era
    );
    const result = await client.callTool({
      name: "echo",
      arguments: { message: "hi" },
    });
    expect(result.content).toEqual([{ type: "text", text: "echo: hi" }]);
    expect(state.calls).toEqual([{ name: "echo", args: { message: "hi" } }]);
  });

  it("answers the handshake with the definition's name, instructions and capabilities over the real server's", async () => {
    const plain = await connectMock({}, era);
    expect(plain.client.getServerVersion()).toMatchObject({
      name: "real-fixture",
      version: "9.9.9",
    });
    expect(plain.client.getInstructions()).toBe("Real instructions.");
    expect(plain.client.getServerCapabilities()).toMatchObject({
      tools: {},
      resources: {},
      logging: {},
    });

    const edited = await connectMock(
      {
        serverInfo: { name: "clearer-docs" },
        instructions: "Be brief.",
        capabilities: { resources: null, prompts: {} },
      },
      era
    );
    expect(edited.client.getServerVersion()).toMatchObject({
      name: "clearer-docs",
      version: "9.9.9",
    });
    expect(edited.client.getInstructions()).toBe("Be brief.");
    const capabilities = edited.client.getServerCapabilities();
    expect(capabilities?.resources).toBeUndefined();
    expect(capabilities?.prompts).toBeDefined();
    expect(capabilities?.logging).toBeDefined();
  });

  it("lists a renamed tool under its new name and sends the call to the same real tool", async () => {
    const { client } = await connectMock(
      {
        tools: {
          say: { answer: { tool: "echo" }, description: "Say it." },
          echo: { hidden: true },
        },
      },
      era
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("say");
    expect(names).not.toContain("echo");
    const result = await client.callTool({
      name: "say",
      arguments: { message: "yo" },
    });
    expect(result.content).toEqual([{ type: "text", text: "echo: yo" }]);
    expect(state.calls).toEqual([{ name: "echo", args: { message: "yo" } }]);
  });

  it("does not list a hidden tool and refuses a call to it by name", async () => {
    const { client } = await connectMock(
      { tools: { echo: { hidden: true } } },
      era
    );
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain(
      "echo"
    );
    await expect(
      client.callTool({ name: "echo", arguments: { message: "x" } })
    ).rejects.toThrow(/Tool echo not found/);
    expect(state.calls).toEqual([]);
  });

  it("removes a hidden or fixed parameter from the schema, and sends the fixed value whatever the client sends", async () => {
    const { client } = await connectMock(
      {
        tools: {
          add: {
            params: {
              b: { fixed: 40 },
              mode: { hidden: true },
              a: { description: "First number." },
            },
          },
        },
      },
      era
    );
    const add = (await client.listTools()).tools.find((t) => t.name === "add");
    expect(Object.keys(add?.inputSchema.properties ?? {})).toEqual(["a"]);
    expect(add?.inputSchema.required).toEqual(["a"]);
    expect(
      (add?.inputSchema.properties as Record<string, { description?: string }>)
        .a.description
    ).toBe("First number.");
    await client.callTool({
      name: "add",
      arguments: { a: 2, b: 999, mode: "up" },
    });
    expect(state.calls).toEqual([{ name: "add", args: { a: 2, b: 40 } }]);
  });

  it("keeps the real tool's annotations unless the definition states others", async () => {
    const same = await connectMock(
      { tools: { add: { description: "d" } } },
      era
    );
    expect(
      (await same.client.listTools()).tools.find((t) => t.name === "add")
        ?.annotations
    ).toEqual({ readOnlyHint: true });
    const looser = await connectMock(
      {
        tools: {
          add: { annotations: { readOnlyHint: false, destructiveHint: true } },
        },
      },
      era
    );
    expect(
      (await looser.client.listTools()).tools.find((t) => t.name === "add")
        ?.annotations
    ).toEqual({ readOnlyHint: false, destructiveHint: true });
  });

  it("passes a method both sides have to the real server", async () => {
    const { client } = await connectMock({}, era);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(["test://greeting"]);
    const read = await client.readResource({ uri: "test://greeting" });
    expect(read.contents[0]).toMatchObject({ text: "hello" });
  });

  it("refuses by name a method only one side has", async () => {
    // The mock removed resources; the real server has them.
    const mockLacks = await connectMock(
      { capabilities: { resources: null } },
      era
    );
    expect(
      await rawError(mockLacks.handler, era, "resources/list")
    ).toMatchObject({
      code: MOCK_ERROR_CODES.methodUnavailable,
      message: expect.stringContaining(
        "resources/list is not available: this mock does not offer resources"
      ),
    });
    // The mock claims prompts; the real server has none.
    const realLacks = await connectMock({ capabilities: { prompts: {} } }, era);
    expect(
      await rawError(realLacks.handler, era, "prompts/list")
    ).toMatchObject({
      code: MOCK_ERROR_CODES.methodUnavailable,
      message: expect.stringContaining(
        "prompts/list is not available: the real server does not offer prompts"
      ),
    });
  });

  it("relays progress and a list change from the real server during a call", async () => {
    const { client } = await connectMock({}, era);
    const progress: unknown[] = [];
    const changed: string[] = [];
    client.setNotificationHandler(
      "notifications/tools/list_changed",
      () => void changed.push("tools")
    );
    const result = await client.callTool(
      { name: "working", arguments: {} },
      { onprogress: (p) => progress.push(p) }
    );
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(progress).toEqual([
      expect.objectContaining({ progress: 1, total: 2, message: "half" }),
    ]);
    // 2025-era revisions send a list change on the stream of the call; 2026-07-28 sends it on a subscription.
    expect(changed).toEqual(era === "legacy" ? ["tools"] : []);
  });

  it("refuses tools/list and names the tool when the real server no longer has an edited one", async () => {
    const { client } = await connectMock(
      { tools: { echo: { description: "Say it." } } },
      era,
      ["echo"]
    );
    const failure = await client.listTools().then(
      () => undefined,
      (error: { code?: number; message?: string; data?: unknown }) => error
    );
    expect(failure?.code).toBe(MOCK_ERROR_CODES.editedToolMissing);
    expect(failure?.message).toContain('"echo"');
    expect(failure?.data).toMatchObject({
      mockCode: "mock_edited_tool_missing",
      tools: [{ tool: "echo", realTool: "echo" }],
    });
  });

  it("names a renamed entry's real tool when that is the one missing", async () => {
    const { client } = await connectMock(
      { tools: { say: { answer: { tool: "echo" } } } },
      era,
      ["echo"]
    );
    await expect(client.listTools()).rejects.toThrow(
      /"say" \(real tool "echo"\)/
    );
  });

  it("names the override path in the error, and repairs nothing on its own", async () => {
    const { client } = await connectMock(
      { tools: { say: { answer: { tool: "echo" } } } },
      era,
      ["echo"]
    );
    const failure = await client.listTools().then(
      () => undefined,
      (error: { data?: unknown; message?: string }) => error
    );
    expect(failure?.message).toContain("tools.say.answer.tool");
    expect(failure?.data).toMatchObject({
      issues: [{ path: "tools.say.answer.tool", code: "target_missing" }],
    });
  });

  it("refuses a call whose fixed value no longer fits, naming the path, before anything is forwarded", async () => {
    const { client } = await connectMock(
      { tools: { add: { params: { a: { fixed: "one" } } } } },
      era
    );
    const failure = await client
      .callTool({ name: "add", arguments: { b: 2 } })
      .then(
        () => undefined,
        (error: { data?: unknown }) => error
      );
    expect(failure?.data).toMatchObject({
      mockCode: "mock_binding_invalid",
      issues: [{ path: "tools.add.params.a.fixed", code: "value_incompatible" }],
    });
    expect(state.calls).toHaveLength(0);
  });

  it("keeps a saved answer working when the real tool it sits on is gone", async () => {
    const { client } = await connectMock(
      {
        tools: {
          echo: {
            answer: { from: "saved", cases: [{ result: { content: [{ type: "text", text: "saved" }] } }] },
          },
        },
      },
      era,
      ["echo"]
    );
    const result = await client.callTool({ name: "echo", arguments: { message: "x" } });
    expect(result.content).toEqual([{ type: "text", text: "saved" }]);
  });
});

describe("buildMock without a reachable real server", () => {
  it("answers a request with an error that says the real server could not be reached", async () => {
    const handler = buildMock(
      {},
      {
        ...NO_REAL_SERVER,
        describe: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      }
    );
    expect(await rawError(handler, "legacy", "tools/list")).toMatchObject({
      code: MOCK_ERROR_CODES.realUnreachable,
      message: expect.stringContaining(
        "could not reach the real server: connect ECONNREFUSED"
      ),
    });
  });

  it("advertises no tools when built with no real server and no tool in the definition", async () => {
    const handler = buildMock({});
    expect(await rawError(handler, "legacy", "tools/list")).toMatchObject({
      code: MOCK_ERROR_CODES.methodUnavailable,
      message: expect.stringContaining("this mock does not offer tools"),
    });
  });
});

describe("buildMock log relay", () => {
  it("relays a log message when the caller sends a log level (2026-07-28)", async () => {
    const { client } = await connectMock({}, "modern");
    const logs: unknown[] = [];
    client.setNotificationHandler(
      "notifications/message",
      (n) => void logs.push(n.params)
    );
    await client.callTool({
      name: "working",
      arguments: {},
      _meta: { [LOG_LEVEL_META_KEY]: "info" },
    });
    expect(logs).toEqual([
      expect.objectContaining({ level: "info", data: "step one" }),
    ]);
  });
});

describe("hashRealToolListing", () => {
  const tool = (name: string, extra: object = {}) => ({
    name,
    description: "d",
    inputSchema: { type: "object", properties: { a: { type: "string" } } },
    ...extra,
  });

  it("is the same whatever order the keys and tools arrive in", () => {
    const a = [
      tool("x"),
      tool("y", { annotations: { readOnlyHint: true, title: "Y" } }),
    ];
    const b = [
      {
        inputSchema: { properties: { a: { type: "string" } }, type: "object" },
        description: "d",
        name: "y",
        annotations: { title: "Y", readOnlyHint: true },
      },
      {
        description: "d",
        name: "x",
        inputSchema: { properties: { a: { type: "string" } }, type: "object" },
      },
    ];
    expect(hashRealToolListing(a)).toBe(hashRealToolListing(b));
    expect(hashRealToolListing(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any tool field changes, or a tool is added or removed", () => {
    const base = hashRealToolListing([tool("x")]);
    expect(hashRealToolListing([tool("x", { description: "e" })])).not.toBe(
      base
    );
    expect(hashRealToolListing([tool("x"), tool("y")])).not.toBe(base);
    expect(hashRealToolListing([])).not.toBe(base);
  });
});

describe.each<Era>(["legacy", "modern"])(
  "buildMock JSON-RPC errors (%s era)",
  (era) => {
    it("answers an unknown method with method not found, on a mock of a real server", async () => {
      const { handler } = await connectMock({}, era);
      expect(await rawError(handler, era, "mock/unknown")).toMatchObject({
        code: -32601,
      });
    });

    it("answers an unknown method with method not found, on a mock from nothing", async () => {
      const handler = buildMock({}, NO_REAL_SERVER);
      expect(await rawError(handler, era, "mock/unknown")).toMatchObject({
        code: -32601,
      });
    });

    it("answers a call to a hidden or unlisted tool as the MCP SDK does: invalid params naming the tool", async () => {
      const { client } = await connectMock(
        { tools: { echo: { hidden: true } } },
        era
      );
      for (const name of ["echo", "nothing_like_it"]) {
        await expect(
          client.callTool({ name, arguments: {} })
        ).rejects.toMatchObject({
          code: -32602,
          message: expect.stringContaining(`Tool ${name} not found`),
        });
      }
    });
  }
);
