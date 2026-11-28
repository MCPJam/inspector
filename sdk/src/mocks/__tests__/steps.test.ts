import { LOG_LEVEL_META_KEY } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { validateMockDefinition } from "../index.js";
import type { MockSavedCase } from "../index.js";
import {
  isModern,
  openListen,
  REVISIONS,
  text,
  useProtocolHarness,
  workDefinition,
} from "./protocol-harness.js";
import type { Revision } from "./protocol-harness.js";

const h = useProtocolHarness();
const formSchema = { type: "object", properties: { v: { type: "string" } } };
const MODERN: Revision = "2026-07-28";
const LEGACY = REVISIONS.filter((r) => !isModern(r));

describe.each(REVISIONS)("saved case steps (%s)", (revision) => {
  it("sends progress and a log message before the result", async () => {
    const { client } = await h.connect(
      workDefinition([
        {
          steps: [
            { kind: "progress", progress: 1, total: 2, message: "half" },
            { kind: "log", level: "info", data: "hello {{input.who}}" },
            { kind: "progress", progress: 2, total: 2 },
          ],
          result: text("done"),
        },
      ]),
      { revision }
    );
    const progress: unknown[] = [];
    const logs: unknown[] = [];
    client.setNotificationHandler(
      "notifications/message",
      (n) => void logs.push(n.params)
    );
    if (!isModern(revision)) await client.setLoggingLevel("info");
    const result = await client.callTool(
      {
        name: "work",
        arguments: { who: "Ada" },
        ...(isModern(revision) && { _meta: { [LOG_LEVEL_META_KEY]: "info" } }),
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

  it("declares logging only because a case logs", async () => {
    const withLog = await h.connect(
      workDefinition([
        {
          steps: [{ kind: "log", level: "info", data: "x" }],
          result: text("a"),
        },
      ]),
      { revision }
    );
    expect(withLog.client.getServerCapabilities()?.logging).toBeDefined();
    const without = await h.connect(workDefinition([{ result: text("a") }]), {
      revision,
    });
    expect(without.client.getServerCapabilities()?.logging).toBeUndefined();
  });

  it("announces a list change and tells the client the steps ran in order", async () => {
    const { client, handler } = await h.connect(
      workDefinition([
        {
          steps: [
            { kind: "listChanged", list: "tools" },
            { kind: "progress", progress: 1 },
          ],
          result: text("done"),
        },
      ]),
      { revision }
    );
    expect(client.getServerCapabilities()?.tools).toMatchObject({
      listChanged: true,
    });
    const changed: string[] = [];
    client.setNotificationHandler(
      "notifications/tools/list_changed",
      () => void changed.push("tools")
    );
    const listen = isModern(revision)
      ? await openListen(handler, { toolsListChanged: true })
      : undefined;
    await client.callTool({ name: "work", arguments: {} });
    if (listen) {
      // 2026-07-28 sends list changes only on a subscription stream.
      expect(changed).toEqual([]);
      expect((await listen.next())?.method).toBe(
        "notifications/subscriptions/acknowledged"
      );
      expect((await listen.next())?.method).toBe(
        "notifications/tools/list_changed"
      );
      await listen.close();
    } else {
      expect(changed).toEqual(["tools"]);
    }
  });

  it("announces an update to one of its resources", async () => {
    const { client, handler } = await h.connect(
      workDefinition([
        {
          steps: [{ kind: "resourceUpdated", uri: "doc://{{input.who}}" }],
          result: text("done"),
        },
      ]),
      { revision }
    );
    expect(client.getServerCapabilities()?.resources).toMatchObject({
      subscribe: true,
    });
    const updated: unknown[] = [];
    client.setNotificationHandler(
      "notifications/resources/updated",
      (n) => void updated.push(n.params.uri)
    );
    const listen = isModern(revision)
      ? await openListen(handler, { resourceSubscriptions: ["doc://ada"] })
      : undefined;
    await client.callTool({ name: "work", arguments: { who: "ada" } });
    if (listen) {
      await listen.next();
      expect(await listen.next()).toMatchObject({
        method: "notifications/resources/updated",
        params: { uri: "doc://ada" },
      });
      await listen.close();
    } else {
      expect(updated).toEqual(["doc://ada"]);
    }
  });
});

describe("log level on 2026-07-28", () => {
  const logging = workDefinition([
    {
      steps: [
        { kind: "log", level: "info", data: "quiet" },
        { kind: "log", level: "error", data: "loud" },
      ],
      result: text("done"),
    },
  ]);
  it("sends nothing to a request that names no level, and only what meets the level it names", async () => {
    const { client } = await h.connect(logging, { revision: MODERN });
    const logs: unknown[] = [];
    client.setNotificationHandler(
      "notifications/message",
      (n) => void logs.push(n.params.data)
    );
    await client.callTool({ name: "work", arguments: {} });
    expect(logs).toEqual([]);
    await client.callTool({
      name: "work",
      arguments: {},
      _meta: { [LOG_LEVEL_META_KEY]: "warning" },
    });
    expect(logs).toEqual(["loud"]);
  });
});

describe("questions on 2026-07-28", () => {
  it("asks the person a form question and reads the answer in the result", async () => {
    const { client, asked } = await h.connect(
      workDefinition([
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
      {
        revision: MODERN,
        replies: {
          elicit: () => ({ action: "accept", content: { sure: true } }),
        },
      }
    );
    const result = await client.callTool({
      name: "work",
      arguments: { who: "Ada" },
    });
    expect(result.content).toEqual([{ type: "text", text: "accept: true" }]);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.params).toMatchObject({ message: "Delete Ada's files?" });
  });

  it("asks a question that sends the person to a page", async () => {
    const { client, asked } = await h.connect(
      workDefinition([
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
      { revision: MODERN, replies: { elicit: () => ({ action: "accept" }) } }
    );
    const result = await client.callTool({ name: "work", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "accept" }]);
    expect(asked[0]!.params).toMatchObject({
      mode: "url",
      url: "https://example.com/sign-in",
    });
  });

  it("asks the client's model and returns what it says", async () => {
    const { client, asked } = await h.connect(
      workDefinition([
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
      {
        revision: MODERN,
        replies: {
          sample: () => ({
            role: "assistant",
            content: { type: "text", text: "Ada counted." },
            model: "test-model",
          }),
        },
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

  it("asks two rounds in order, a progress message between them, and sends it once", async () => {
    const { client, asked } = await h.connect(
      workDefinition([
        {
          steps: [
            {
              kind: "ask",
              id: "a",
              message: "first",
              requestedSchema: formSchema,
            },
            { kind: "progress", progress: 1 },
            {
              kind: "ask",
              id: "b",
              message: "second",
              requestedSchema: formSchema,
            },
          ],
          result: text("{{steps.a.content.v}}+{{steps.b.content.v}}"),
        },
      ]),
      {
        revision: MODERN,
        replies: {
          elicit: (params) => ({
            action: "accept",
            content: { v: params.message === "first" ? "one" : "two" },
          }),
        },
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
    // The client reports its own progress for each round; the mock's one step went out once.
    expect(
      progress.filter((p) => (p as { message?: string }).message === undefined)
    ).toHaveLength(1);
  });

  it("reads a declined question as its action", async () => {
    const { client } = await h.connect(
      workDefinition([
        {
          steps: [
            {
              kind: "ask",
              id: "q",
              message: "ok?",
              requestedSchema: formSchema,
            },
          ],
          result: text("{{steps.q.action}}"),
        },
      ]),
      { revision: MODERN }
    );
    const result = await client.callTool({ name: "work", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "decline" }]);
  });

  it("does not ask a client that did not declare what the question needs", async () => {
    const { handler } = await h.connect(
      workDefinition([
        {
          steps: [
            {
              kind: "ask",
              id: "q",
              message: "ok?",
              requestedSchema: formSchema,
            },
          ],
          result: text("x"),
        },
      ]),
      { revision: MODERN }
    );
    const answered = await h.rpc(handler, MODERN, "tools/call", {
      name: "work",
      arguments: {},
    });
    // The spec forbids sending inputRequests the client has not declared support for.
    expect(JSON.stringify(answered)).not.toContain("inputRequests");
    expect(answered.error).toMatchObject({
      code: -32021,
      data: { requiredCapabilities: { elicitation: { form: {} } } },
    });
  });
});

describe.each(LEGACY)("questions on %s", (revision) => {
  it("refuses a case that asks, before any step runs, and says which revision can be asked", async () => {
    const observed: unknown[] = [];
    const { client } = await h.connect(
      workDefinition([
        {
          steps: [
            { kind: "progress", progress: 1 },
            {
              kind: "ask",
              id: "q",
              message: "ok?",
              requestedSchema: formSchema,
            },
          ],
          result: text("x"),
        },
      ]),
      { revision, build: { observer: (e) => void observed.push(e) } }
    );
    const progress: unknown[] = [];
    const result = await client.callTool(
      { name: "work", arguments: {} },
      { onprogress: (p) => progress.push(p) }
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("2026-07-28");
    expect(progress).toEqual([]);
    expect(observed).toEqual([
      expect.objectContaining({
        source: "saved",
        refusal: "input_unavailable",
      }),
    ]);
  });
});

describe("validation of steps", () => {
  const check = (savedCase: object) =>
    validateMockDefinition(workDefinition([savedCase as MockSavedCase]));
  const issues = (savedCase: object) => {
    const result = check(savedCase);
    return result.ok ? [] : result.issues.map((i) => i.path);
  };
  const schema = { type: "object", properties: {} };

  it("accepts a case with every kind of step", () => {
    expect(
      check({
        steps: [
          { kind: "progress", progress: 1 },
          { kind: "log", level: "info", data: "x" },
          { kind: "listChanged", list: "prompts" },
          { kind: "resourceUpdated", uri: "doc://a" },
          { kind: "ask", id: "a", message: "m", requestedSchema: schema },
          { kind: "askUrl", id: "b", message: "m", url: "https://example.com" },
          { kind: "sample", id: "c", prompt: "p", maxTokens: 10 },
        ],
        task: true,
        result: text("x"),
      })
    ).toMatchObject({ ok: true });
  });

  it("refuses a repeated id, an unknown kind, a bad url and too long a wait", () => {
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
        steps: Array.from({ length: 5 }, (_, i) => ({
          kind: "progress",
          progress: i,
          delayMs: 5000,
        })),
        result: text("x"),
      })
    ).toContain("tools.work.answer.cases.0.steps");
    expect(issues({ task: false, result: text("x") })).toContain(
      "tools.work.answer.cases.0.task"
    );
  });

  it("refuses a list change for a list that does not exist and a resource update with no uri", () => {
    expect(
      issues({
        steps: [
          { kind: "listChanged", list: "roots" },
          { kind: "resourceUpdated" },
        ],
        result: text("x"),
      })
    ).toEqual([
      "tools.work.answer.cases.0.steps.0.list",
      "tools.work.answer.cases.0.steps.1.uri",
    ]);
  });

  it("accepts no steps field that is empty", () => {
    expect(issues({ steps: [], result: text("x") })).toEqual([
      "tools.work.answer.cases.0.steps",
    ]);
  });
});
