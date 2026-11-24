import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { LOG_LEVEL_META_KEY } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMock,
  createMockSessionMap,
  NO_REAL_SERVER,
  validateMockDefinition,
} from "../index.js";
import type { JsonObject, MockDefinition, MockSavedCase } from "../index.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

type Era = "legacy" | "modern";
const ERAS: Era[] = ["legacy", "modern"];

function definitionOf(
  cases: MockSavedCase[],
  inputSchema: JsonObject = {
    type: "object",
    properties: { who: { type: "string" } },
  }
): MockDefinition {
  return {
    tools: { work: { inputSchema, answer: { from: "saved", cases } } },
  };
}
const text = (value: string) => ({ content: [{ type: "text", text: value }] });

interface Replies {
  elicit?: (params: Record<string, unknown>) => Record<string, unknown>;
  sample?: (params: Record<string, unknown>) => Record<string, unknown>;
}

/** A client that can be asked questions and model requests, in either era. */
async function connect(
  definition: MockDefinition,
  era: Era,
  replies: Replies = {},
  options: Parameters<typeof buildMock>[2] = {}
) {
  expect(validateMockDefinition(definition)).toMatchObject({ ok: true });
  const sessions = { map: createMockSessionMap(), key: "caller:mock:1" };
  const handler = buildMock(definition, NO_REAL_SERVER, {
    sessions,
    ...options,
  });
  const client = new Client(
    { name: "mock-test", version: "1.0.0" },
    {
      capabilities: {
        elicitation: { form: {}, url: {} },
        sampling: {},
      },
      ...(era === "modern" && {
        supportedProtocolVersions: ["2025-11-25", "2026-07-28"],
        versionNegotiation: { mode: { pin: "2026-07-28" } },
      }),
    }
  );
  const asked: Array<{ method: string; params: unknown }> = [];
  client.setRequestHandler("elicitation/create", async (request) => {
    asked.push({ method: "elicitation/create", params: request.params });
    return (replies.elicit?.(request.params as Record<string, unknown>) ?? {
      action: "decline",
    }) as never;
  });
  client.setRequestHandler("sampling/createMessage", async (request) => {
    asked.push({ method: "sampling/createMessage", params: request.params });
    return (replies.sample?.(request.params as Record<string, unknown>) ?? {
      role: "assistant",
      content: { type: "text", text: "" },
      model: "test-model",
    }) as never;
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://mock.local/mcp"), {
      fetch: (input, init) =>
        handler.fetch(new Request(input as string | URL, init)),
    })
  );
  closers.push(async () => {
    await client.close();
    await sessions.map.closeAll();
  });
  return { client, asked, sessions: sessions.map };
}

describe.each(ERAS)("saved case steps (%s)", (era) => {
  it("sends progress and a log message before the result", async () => {
    const { client } = await connect(
      definitionOf([
        {
          steps: [
            { kind: "progress", progress: 1, total: 2, message: "half" },
            { kind: "log", level: "info", data: "hello {{input.who}}" },
            { kind: "progress", progress: 2, total: 2 },
          ],
          result: text("done"),
        },
      ]),
      era
    );
    const progress: unknown[] = [];
    const logs: unknown[] = [];
    client.setNotificationHandler(
      "notifications/message",
      (n) => void logs.push(n.params)
    );
    if (era === "legacy") await client.setLoggingLevel("info");
    const result = await client.callTool(
      {
        name: "work",
        arguments: { who: "Ada" },
        ...(era === "modern" && { _meta: { [LOG_LEVEL_META_KEY]: "info" } }),
      },
      { onprogress: (p) => progress.push(p) }
    );
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(progress).toEqual([
      expect.objectContaining({ progress: 1, total: 2, message: "half" }),
      expect.objectContaining({ progress: 2, total: 2 }),
    ]);
    expect(logs).toEqual([
      expect.objectContaining({ level: "info", data: "hello Ada" }),
    ]);
  });

  it("asks the person a form question and reads the answer in the result", async () => {
    const { client, asked } = await connect(
      definitionOf([
        {
          steps: [
            {
              kind: "ask",
              id: "confirm",
              message: "Delete {{input.who}}'s files?",
              requestedSchema: {
                type: "object",
                properties: { sure: { type: "boolean" } },
              },
            },
          ],
          result: text(
            "{{steps.confirm.action}}: {{steps.confirm.content.sure}}"
          ),
        },
      ]),
      era,
      { elicit: () => ({ action: "accept", content: { sure: true } }) }
    );
    const result = await client.callTool({
      name: "work",
      arguments: { who: "Ada" },
    });
    expect(result.content).toEqual([{ type: "text", text: "accept: true" }]);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.params).toMatchObject({
      message: "Delete Ada's files?",
    });
  });

  it("asks a question that sends the person to a page", async () => {
    const { client, asked } = await connect(
      definitionOf([
        {
          steps: [
            {
              kind: "askUrl",
              id: "signin",
              message: "Sign in to continue.",
              url: "https://example.com/sign-in",
            },
          ],
          result: text("{{steps.signin.action}}"),
        },
      ]),
      era,
      { elicit: () => ({ action: "accept" }) }
    );
    const result = await client.callTool({ name: "work", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "accept" }]);
    expect(asked[0]!.params).toMatchObject({
      mode: "url",
      url: "https://example.com/sign-in",
    });
  });

  it("asks the client's model and returns what it says", async () => {
    const { client, asked } = await connect(
      definitionOf([
        {
          steps: [
            {
              kind: "sample",
              id: "poem",
              prompt: "Write one line about {{input.who}}.",
              maxTokens: 50,
            },
          ],
          result: text("model said: {{steps.poem.text}}"),
        },
      ]),
      era,
      {
        sample: () => ({
          role: "assistant",
          content: { type: "text", text: "Ada counted." },
          model: "test-model",
        }),
      }
    );
    const result = await client.callTool({
      name: "work",
      arguments: { who: "Ada" },
    });
    expect(result.content).toEqual([
      { type: "text", text: "model said: Ada counted." },
    ]);
    expect(asked[0]!.params).toMatchObject({
      maxTokens: 50,
      messages: [
        {
          role: "user",
          content: { type: "text", text: "Write one line about Ada." },
        },
      ],
    });
  });

  it("asks two rounds in order, a progress message between them", async () => {
    const { client, asked } = await connect(
      definitionOf([
        {
          steps: [
            {
              kind: "ask",
              id: "a",
              message: "first",
              requestedSchema: {
                type: "object",
                properties: { v: { type: "string" } },
              },
            },
            { kind: "progress", progress: 1 },
            {
              kind: "ask",
              id: "b",
              message: "second",
              requestedSchema: {
                type: "object",
                properties: { v: { type: "string" } },
              },
            },
          ],
          result: text("{{steps.a.content.v}}+{{steps.b.content.v}}"),
        },
      ]),
      era,
      {
        elicit: (params) => ({
          action: "accept",
          content: { v: params.message === "first" ? "one" : "two" },
        }),
      }
    );
    const progress: unknown[] = [];
    const result = await client.callTool(
      { name: "work", arguments: {} },
      { onprogress: (p) => progress.push(p) }
    );
    expect(result.content).toEqual([{ type: "text", text: "one+two" }]);
    expect(asked.map((a) => (a.params as { message: string }).message)).toEqual(
      ["first", "second"]
    );
  });

  it("reads a declined question as its action", async () => {
    const { client } = await connect(
      definitionOf([
        {
          steps: [
            {
              kind: "ask",
              id: "q",
              message: "ok?",
              requestedSchema: {
                type: "object",
                properties: { v: { type: "string" } },
              },
            },
          ],
          result: text("{{steps.q.action}}"),
        },
      ]),
      era
    );
    const result = await client.callTool({ name: "work", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "decline" }]);
  });
});

describe("a 2025-era session", () => {
  it("is not shared with another caller and is closed when idle", async () => {
    let clock = 0;
    const map = createMockSessionMap({ idleMs: 1000, now: () => clock });
    const definition = definitionOf([
      {
        steps: [
          {
            kind: "ask",
            id: "q",
            message: "ok?",
            requestedSchema: {
              type: "object",
              properties: { v: { type: "string" } },
            },
          },
        ],
        result: text("x"),
      },
    ]);
    const request = (key: string, sessionId?: string) =>
      buildMock(definition, NO_REAL_SERVER, { sessions: { map, key } }).fetch(
        new Request("http://mock.local/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(sessionId && { "mcp-session-id": sessionId }),
          },
          body: JSON.stringify(
            sessionId
              ? { jsonrpc: "2.0", id: 2, method: "ping" }
              : {
                  jsonrpc: "2.0",
                  id: 1,
                  method: "initialize",
                  params: {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    clientInfo: { name: "t", version: "1" },
                  },
                }
          ),
        })
      );
    const opened = await request("alice:m:1");
    const id = opened.headers.get("mcp-session-id")!;
    expect(id).toBeTruthy();
    await opened.text();
    expect(map.size()).toBe(1);
    expect((await request("bob:m:1", id)).status).toBe(404);
    expect((await request("alice:m:1", id)).status).toBe(200);
    clock = 5000;
    await map.sweep();
    expect(map.size()).toBe(0);
    expect((await request("alice:m:1", id)).status).toBe(404);
  });

  it("holds a bounded number per key and over all keys, closing the idlest", async () => {
    let clock = 0;
    const map = createMockSessionMap({
      maxPerKey: 2,
      maxSessions: 3,
      now: () => clock,
    });
    const definition = definitionOf([
      {
        steps: [
          {
            kind: "ask",
            id: "q",
            message: "ok?",
            requestedSchema: {
              type: "object",
              properties: { v: { type: "string" } },
            },
          },
        ],
        result: text("x"),
      },
    ]);
    const open = async (key: string) => {
      clock += 1;
      const response = await buildMock(definition, NO_REAL_SERVER, {
        sessions: { map, key },
      }).fetch(
        new Request("http://mock.local/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "t", version: "1" },
            },
          }),
        })
      );
      await response.text();
      return response.headers.get("mcp-session-id");
    };
    await open("a");
    await open("a");
    await open("a");
    expect(map.size()).toBe(2);
    await open("b");
    expect(map.size()).toBe(3);
    await open("c");
    expect(map.size()).toBe(3);
    await map.closeAll();
  });
});

describe("validation of steps", () => {
  const check = (savedCase: object) =>
    validateMockDefinition(definitionOf([savedCase as MockSavedCase]));
  it("accepts a case with every kind of step", () => {
    expect(
      check({
        steps: [
          { kind: "progress", progress: 1 },
          { kind: "log", level: "info", data: "x" },
          {
            kind: "ask",
            id: "a",
            message: "m",
            requestedSchema: { type: "object", properties: {} },
          },
          { kind: "askUrl", id: "b", message: "m", url: "https://example.com" },
          { kind: "sample", id: "c", prompt: "p", maxTokens: 10 },
        ],
        result: text("x"),
      })
    ).toMatchObject({ ok: true });
  });
  it("refuses a repeated id, an unknown kind, a bad url and too long a wait", () => {
    const issues = (savedCase: object) => {
      const result = check(savedCase);
      return result.ok ? [] : result.issues.map((i) => i.path);
    };
    const schema = { type: "object", properties: {} };
    expect(
      issues({
        steps: [
          { kind: "ask", id: "a", message: "m", requestedSchema: schema },
          { kind: "ask", id: "a", message: "m", requestedSchema: schema },
        ],
        result: text("x"),
      })
    ).toContain("tools.work.answer.cases.0.steps.1.id");
    expect(issues({ steps: [{ kind: "dance" }], result: text("x") })).toContain(
      "tools.work.answer.cases.0.steps.0.kind"
    );
    expect(
      issues({
        steps: [{ kind: "askUrl", id: "a", message: "m", url: "ftp://x" }],
        result: text("x"),
      })
    ).toContain("tools.work.answer.cases.0.steps.0.url");
    expect(
      issues({
        steps: [
          { kind: "progress", progress: 1, delayMs: 5000 },
          { kind: "progress", progress: 2, delayMs: 5000 },
          { kind: "progress", progress: 3, delayMs: 5000 },
          { kind: "progress", progress: 4, delayMs: 5000 },
          { kind: "progress", progress: 5, delayMs: 5000 },
        ],
        result: text("x"),
      })
    ).toContain("tools.work.answer.cases.0.steps");
  });
});
