import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMock,
  caseMatches,
  fillInputs,
  NO_REAL_SERVER,
  validateMockDefinition,
} from "../index.js";
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

type Era = "legacy" | "modern";

/** A client on the mock; `fromNothing` leaves the real server out. */
async function connect(
  definition: MockDefinition,
  era: Era,
  fromNothing = false
) {
  const checked = validateMockDefinition(definition);
  expect(checked).toMatchObject({ ok: true });
  let real = NO_REAL_SERVER;
  if (!fromNothing) {
    const connected = await connectRealServer(buildRealHandler(state), state);
    real = connected.real;
    closers.push(connected.close);
  }
  const handler = buildMock(definition, real, {
    observer: (event) => events.push(event),
  });
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
  closers.push(() => client.close());
  return client;
}

const text = (value: string) => ({ content: [{ type: "text", text: value }] });

const echoSaved: MockDefinition = {
  tools: {
    echo: {
      answer: {
        from: "saved",
        cases: [
          {
            when: { message: "hello" },
            result: text("saved: {{input.message}}"),
          },
          {
            when: { message: "boom" },
            error: { code: -32001, message: "no {{input.message}}" },
          },
        ],
      },
    },
  },
};

describe.each<Era>(["legacy", "modern"])("saved answers (%s era)", (era) => {
  it("a matching call gets the saved result and the real server hears nothing", async () => {
    const client = await connect(echoSaved, era);
    const result = await client.callTool({
      name: "echo",
      arguments: { message: "hello" },
    });
    expect(result.content).toEqual(text("saved: hello").content);
    expect(state.calls).toEqual([]);
    // The mark is out of band: the only metadata is the protocol's own server info.
    expect(JSON.stringify(result).toLowerCase()).not.toMatch(
      /saved:(?! hello)|"mock|from/
    );
    expect(Object.keys(result._meta ?? {})).not.toContainEqual(
      expect.stringMatching(/mock|answer/i)
    );
    expect(events).toEqual([{ tool: "echo", source: "saved", caseIndex: 0, catchAll: false }]);
  });

  it("a call no case matches goes to the real tool once and is reported as forwarded", async () => {
    const client = await connect(echoSaved, era);
    const result = await client.callTool({
      name: "echo",
      arguments: { message: "other" },
    });
    expect(result.content).toEqual([{ type: "text", text: "echo: other" }]);
    expect(state.calls).toEqual([{ name: "echo", args: { message: "other" } }]);
    expect(events).toEqual([
      { tool: "echo", source: "forwarded", realTool: "echo" },
    ]);
  });

  it("input that breaks the schema gets an error result, and nothing is called", async () => {
    const client = await connect(echoSaved, era);
    const result = await client.callTool({
      name: "echo",
      arguments: { message: 5 },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Input validation error");
    expect(state.calls).toEqual([]);
    expect(events).toEqual([
      { tool: "echo", source: "saved", refusal: "invalid_input" },
    ]);
  });

  it("answers a case that holds a protocol error with that error", async () => {
    const client = await connect(echoSaved, era);
    await expect(
      client.callTool({ name: "echo", arguments: { message: "boom" } })
    ).rejects.toMatchObject({
      code: -32001,
      message: expect.stringContaining("no boom"),
    });
    expect(state.calls).toEqual([]);
  });

  it("takes the first matching case, and a case with no when matches anything", async () => {
    const client = await connect(
      {
        tools: {
          echo: {
            answer: {
              from: "saved",
              cases: [
                { when: { message: "a" }, result: text("first") },
                { when: { message: "a" }, result: text("second") },
                { result: text("catch-all {{input.message}}") },
              ],
            },
          },
        },
      },
      era
    );
    expect(
      (await client.callTool({ name: "echo", arguments: { message: "a" } }))
        .content
    ).toEqual(text("first").content);
    expect(
      (await client.callTool({ name: "echo", arguments: { message: "z" } }))
        .content
    ).toEqual(text("catch-all z").content);
    // The host shows which case answered, and flags the one that matches any input.
    expect(events).toEqual([
      { tool: "echo", source: "saved", caseIndex: 0, catchAll: false },
      { tool: "echo", source: "saved", caseIndex: 2, catchAll: true },
    ]);
  });

  it("an added tool answers beside the real ones, and a real tool is still called", async () => {
    const client = await connect(
      {
        tools: {
          forecast: {
            description: "Forecast for a city.",
            inputSchema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
            answer: {
              from: "saved",
              cases: [{ result: text("{{input.city}}: clear") }],
            },
          },
        },
      },
      era
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "echo",
      "add",
      "working",
      "forecast",
    ]);
    expect(tools.find((t) => t.name === "forecast")?.description).toBe(
      "Forecast for a city."
    );
    expect(
      (
        await client.callTool({
          name: "forecast",
          arguments: { city: "Paris" },
        })
      ).content
    ).toEqual(text("Paris: clear").content);
    expect(
      (await client.callTool({ name: "echo", arguments: { message: "x" } }))
        .content
    ).toEqual([{ type: "text", text: "echo: x" }]);
    expect(state.calls).toEqual([{ name: "echo", args: { message: "x" } }]);
    // An added tool's call with a missing required parameter breaks its own schema.
    const bad = await client.callTool({ name: "forecast", arguments: {} });
    expect(bad.isError).toBe(true);
  });

  it("a mock from nothing lists and answers its own tools, and names the input nothing matched", async () => {
    const client = await connect(
      {
        serverInfo: { name: "counter", version: "1.0.0" },
        tools: {
          add: {
            description: "Add two numbers.",
            inputSchema: {
              type: "object",
              properties: { a: { type: "number" }, b: { type: "number" } },
              required: ["a", "b"],
            },
            answer: {
              from: "saved",
              cases: [
                {
                  when: { a: 1, b: 1 },
                  result: {
                    content: [{ type: "text", text: "2" }],
                    structuredContent: { sum: "{{input.a}}" },
                  },
                },
              ],
            },
          },
          ping: {
            answer: { from: "saved", cases: [{ result: text("pong") }] },
          },
        },
      },
      era,
      true
    );
    expect(client.getServerVersion()?.name).toBe("counter");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["add", "ping"]);
    // An added tool with no schema of its own takes no input.
    expect(tools[1]?.inputSchema).toMatchObject({ type: "object" });
    const sum = await client.callTool({
      name: "add",
      arguments: { a: 1, b: 1 },
    });
    expect(sum.structuredContent).toEqual({ sum: 1 });
    expect(
      (await client.callTool({ name: "ping", arguments: {} })).content
    ).toEqual(text("pong").content);
    const none = await client.callTool({
      name: "add",
      arguments: { a: 2, b: 2 },
    });
    expect(none.isError).toBe(true);
    expect(none.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('{"a":2,"b":2}'),
      }),
    ]);
    expect(events.filter((e) => e.source === "unmatched")).toEqual([
      { tool: "add", source: "unmatched" },
    ]);
  });

  it("lists its own tools in pages of the stated size", async () => {
    const tools = Object.fromEntries(
      ["a", "b", "c", "d", "e"].map((name) => [
        name,
        { answer: { from: "saved" as const, cases: [{ result: text(name) }] } },
      ])
    );
    const client = await connect({ pageSize: 2, tools }, era, true);
    // The client walks every page when given no cursor; the first page alone is a raw request.
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    const first = await client.request({ method: "tools/list", params: {} });
    expect(first.tools.map((t) => t.name)).toEqual(["a", "b"]);
    expect(first.nextCursor).toBeTruthy();
    const second = await client.listTools({ cursor: first.nextCursor });
    expect(second.tools.map((t) => t.name)).toEqual(["c", "d"]);
    const third = await client.listTools({ cursor: second.nextCursor });
    expect(third.tools.map((t) => t.name)).toEqual(["e"]);
    expect(third.nextCursor).toBeUndefined();
    await expect(
      client.listTools({ cursor: "not-ours" })
    ).rejects.toMatchObject({
      message: expect.stringContaining("not valid for this mock"),
    });
  });
});

describe("saved-answer helpers", () => {
  it("matches a subset of the input, deeply and in any key order", () => {
    expect(caseMatches({ a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(
      caseMatches({ a: { x: [1, 2], y: 1 } }, { a: { y: 1, x: [1, 2] } })
    ).toBe(true);
    expect(caseMatches({ a: 1 }, { a: "1" })).toBe(false);
    expect(caseMatches({ a: undefined as never }, {})).toBe(false);
    expect(caseMatches(undefined, {})).toBe(true);
    expect(caseMatches({ toString: 1 }, {})).toBe(false);
  });

  it("fills {{input.x}}: a lone placeholder keeps its type, an embedded one becomes text, unknown ones stay", () => {
    const input = { n: 3, who: "Ada", nested: { deep: [1, 2] } };
    expect(
      fillInputs(
        {
          whole: "{{input.n}}",
          text: "hi {{input.who}}, {{input.n}} and {{input.nested.deep}}",
          list: ["{{input.who}}"],
          missing: "{{input.nope}} {{input.nested.nope}}",
          again: "{{input.who}}",
        },
        input
      )
    ).toEqual({
      whole: 3,
      text: "hi Ada, 3 and [1,2]",
      list: ["Ada"],
      missing: "{{input.nope}} {{input.nested.nope}}",
      again: "Ada",
    });
    // A filled value is not read as a placeholder.
    expect(fillInputs("{{input.x}}", { x: "{{input.y}}", y: "no" })).toBe(
      "{{input.y}}"
    );
  });
});
