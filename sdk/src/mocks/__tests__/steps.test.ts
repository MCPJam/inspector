import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { LOG_LEVEL_META_KEY } from "@modelcontextprotocol/server";
import {
  modernHeaders,
  modernRequestBody,
} from "../../mcp-conformance/raw-http.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMock,
  createMockSessionMap,
  createMockTaskStore,
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
        task: true,
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
    expect(issues({ task: false, result: text("x") })).toContain(
      "tools.work.answer.cases.0.task"
    );
  });
});

/** One raw request on the 2026-07-28 wire; `tasks` declares that the caller can take a task. */
async function modernRpc(
  handler: { fetch: (r: Request) => Promise<Response> },
  method: string,
  params: Record<string, unknown>,
  tasks = true
) {
  const response = await handler.fetch(
    new Request("http://mock.local/mcp", {
      method: "POST",
      headers: modernHeaders({
        protocolVersion: "2026-07-28",
        method,
        ...((typeof params.name === "string" ||
          typeof params.taskId === "string") && {
          name: String(params.name ?? params.taskId),
        }),
      }),
      body: JSON.stringify(
        modernRequestBody({
          id: 1,
          method,
          params,
          protocolVersion: "2026-07-28",
          clientCapabilities: tasks
            ? { extensions: { "io.modelcontextprotocol/tasks": {} } }
            : {},
        })
      ),
    })
  );
  const body = await response.text();
  const data = /^data:/m.test(body)
    ? body
        .split("\n")
        .find((l) => l.startsWith("data:"))!
        .slice(5)
    : body;
  return JSON.parse(data) as {
    result?: Record<string, any>;
    error?: { code: number; message: string };
  };
}

const pollUntil = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the condition never held");
};

describe("a case that runs as a task", () => {
  const taskCase: MockSavedCase = {
    task: true,
    steps: [
      { kind: "progress", progress: 1, total: 2, message: "halfway" },
      { kind: "log", level: "info", data: "all good", delayMs: 30 },
    ],
    result: text("finished"),
  };

  it("answers in place for a caller that cannot take a task", async () => {
    const store = createMockTaskStore();
    const { client } = await connect(
      definitionOf([taskCase]),
      "legacy",
      {},
      {
        tasks: { store, owner: "me" },
      }
    );
    const result = await client.callTool({ name: "work", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "finished" }]);
    expect(store.size()).toBe(0);
  });

  it("is a task on the 2026-07-28 extension: a handle, polling, then the result inline", async () => {
    const store = createMockTaskStore({ pollIntervalMs: 10 });
    const handler = buildMock(definitionOf([taskCase]), NO_REAL_SERVER, {
      tasks: { store, owner: "me" },
    });
    const created = await modernRpc(handler, "tools/call", {
      name: "work",
      arguments: {},
    });
    expect(created.result).toMatchObject({
      resultType: "task",
      status: "working",
      pollIntervalMs: 10,
    });
    const taskId = created.result!.taskId as string;
    const seen = new Set<string>();
    await pollUntil(async () => {
      const got = await modernRpc(handler, "tasks/get", { taskId });
      if (got.result?.statusMessage) seen.add(got.result.statusMessage);
      return got.result?.status === "completed";
    });
    expect(seen).toContain("halfway");
    const done = await modernRpc(handler, "tasks/get", { taskId });
    expect(done.result).toMatchObject({
      status: "completed",
      result: { content: [{ type: "text", text: "finished" }] },
    });
    // Another caller's task id is no task.
    const other = buildMock(definitionOf([taskCase]), NO_REAL_SERVER, {
      tasks: { store, owner: "someone else" },
    });
    expect(
      (await modernRpc(other, "tasks/get", { taskId })).error
    ).toBeDefined();
  });

  it("waits for the person's answer on the extension, through tasks/update", async () => {
    const store = createMockTaskStore({ pollIntervalMs: 10 });
    const handler = buildMock(
      definitionOf([
        {
          task: true,
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
          result: text("{{steps.q.content.v}}"),
        },
      ]),
      NO_REAL_SERVER,
      { tasks: { store, owner: "me" } }
    );
    const created = await modernRpc(handler, "tools/call", {
      name: "work",
      arguments: {},
    });
    const taskId = created.result!.taskId as string;
    let asked: Record<string, any> | undefined;
    await pollUntil(async () => {
      const got = await modernRpc(handler, "tasks/get", { taskId });
      asked = got.result?.inputRequests;
      return got.result?.status === "input_required";
    });
    expect(asked?.q).toMatchObject({ method: "elicitation/create" });
    await modernRpc(handler, "tasks/update", {
      taskId,
      inputResponses: { q: { action: "accept", content: { v: "yes" } } },
    });
    await pollUntil(async () => {
      const got = await modernRpc(handler, "tasks/get", { taskId });
      return (
        got.result?.status === "completed" &&
        got.result.result.content[0].text === "yes"
      );
    });
  });

  it("cancels a running task", async () => {
    const store = createMockTaskStore({ pollIntervalMs: 10 });
    const handler = buildMock(
      definitionOf([
        {
          task: true,
          steps: [{ kind: "log", level: "info", data: "x", delayMs: 5000 }],
          result: text("late"),
        },
      ]),
      NO_REAL_SERVER,
      { tasks: { store, owner: "me" } }
    );
    const created = await modernRpc(handler, "tools/call", {
      name: "work",
      arguments: {},
    });
    const taskId = created.result!.taskId as string;
    await modernRpc(handler, "tasks/cancel", { taskId });
    expect(
      (await modernRpc(handler, "tasks/get", { taskId })).result?.status
    ).toBe("cancelled");
  });

  it("is a task on 2025-11-25 when the caller asks for one: get, result, list, cancel", async () => {
    const store = createMockTaskStore({ pollIntervalMs: 10 });
    const handler = buildMock(definitionOf([taskCase]), NO_REAL_SERVER, {
      tasks: { store, owner: "me" },
    });
    const rpc = async (
      id: number,
      method: string,
      params: object,
      session?: string
    ) => {
      const response = await handler.fetch(
        new Request("http://mock.local/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(session && { "mcp-session-id": session }),
            ...(session && { "mcp-protocol-version": "2025-11-25" }),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        })
      );
      const body = await response.text();
      const data = /^data:/m.test(body)
        ? body
            .split("\n")
            .find((l) => l.startsWith("data:"))!
            .slice(5)
        : body;
      return JSON.parse(data) as {
        result?: Record<string, any>;
        error?: { message: string };
      };
    };
    // Stateless 2025 serving: each request stands alone, so no handshake is needed.
    const created = await rpc(1, "tools/call", {
      name: "work",
      arguments: {},
      task: { ttl: 60000 },
    });
    expect(created.result?.task).toMatchObject({
      status: "working",
      pollInterval: 10,
    });
    const taskId = created.result!.task.taskId as string;
    const result = await rpc(2, "tasks/result", { taskId });
    expect(result.result).toMatchObject({
      content: [{ type: "text", text: "finished" }],
      _meta: { "io.modelcontextprotocol/related-task": { taskId } },
    });
    expect((await rpc(3, "tasks/get", { taskId })).result).toMatchObject({
      status: "completed",
    });
    expect((await rpc(4, "tasks/list", {})).result?.tasks).toHaveLength(1);
    expect((await rpc(5, "tasks/cancel", { taskId })).result).toMatchObject({
      status: "completed",
    });
  });

  it("says a 2025-11-25 task cannot ask a question", async () => {
    const store = createMockTaskStore();
    const handler = buildMock(
      definitionOf([
        {
          task: true,
          steps: [
            {
              kind: "ask",
              id: "q",
              message: "ok?",
              requestedSchema: { type: "object", properties: {} },
            },
          ],
          result: text("x"),
        },
      ]),
      NO_REAL_SERVER,
      { tasks: { store, owner: "me" } }
    );
    const response = await handler.fetch(
      new Request("http://mock.local/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "work", arguments: {}, task: {} },
        }),
      })
    );
    expect(await response.text()).toContain("2026-07-28");
    expect(store.size()).toBe(0);
  });

  it("bounds the tasks it holds", async () => {
    const store = createMockTaskStore({ maxTasks: 1 });
    store.create(
      "me",
      {
        task: true,
        steps: [{ kind: "log", level: "info", data: "x", delayMs: 5000 }],
        result: text("x"),
      },
      {}
    );
    expect(() => store.create("me", { result: text("y") }, {})).toThrow(
      /as many tasks/
    );
    store.cancel("me", [...[store.list("me")[0]!.taskId]][0]!);
    expect(store.create("me", { result: text("y") }, {}).taskId).toBeTruthy();
  });
});
