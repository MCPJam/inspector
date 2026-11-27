import { ProtocolError } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { buildMock, NO_REAL_SERVER } from "../index.js";
import type { MockRealServer, MockSavedCase } from "../index.js";
import { MOCK_ERROR_CODES } from "../mock-errors.js";
import { createMemoryTaskStore } from "./memory-task-store.js";
import {
  pollUntil,
  REVISIONS,
  text,
  useProtocolHarness,
  workDefinition,
} from "./protocol-harness.js";
import type { Revision } from "./protocol-harness.js";

const h = useProtocolHarness();

/** What the host's logger would hear; no test expects any unless it says so. */
const errors: unknown[] = [];
const onError = (error: unknown) => void errors.push(error);
afterEach(() => {
  // Emptied before the check, so one failing test leaves nothing for the next.
  expect(errors.splice(0)).toEqual([]);
});
const MODERN: Revision = "2026-07-28";
const TASKS_EXTENSION = { extensions: { "io.modelcontextprotocol/tasks": {} } };
const askSchema = { type: "object", properties: { v: { type: "string" } } };

const taskCase: MockSavedCase = {
  task: true,
  steps: [
    { kind: "progress", progress: 1, total: 2, message: "halfway" },
    { kind: "log", level: "info", data: "all good", delayMs: 30 },
  ],
  result: text("finished"),
};

function mock(
  cases: MockSavedCase[],
  store = createMemoryTaskStore(),
  owner = "me"
) {
  const handler = buildMock(workDefinition(cases), NO_REAL_SERVER, {
    tasks: { store, owner, pollIntervalMs: 10, onError },
  });
  return { handler, store };
}

/** Starts the work tool as a task on the 2026-07-28 extension. */
const startModern = (handler: ReturnType<typeof mock>["handler"]) =>
  h.rpc(
    handler,
    MODERN,
    "tools/call",
    { name: "work", arguments: {} },
    TASKS_EXTENSION
  );
/** Starts it as a 2025-11-25 task. */
const startLegacy = (handler: ReturnType<typeof mock>["handler"]) =>
  h.rpc(handler, "2025-11-25", "tools/call", {
    name: "work",
    arguments: {},
    task: { ttl: 60000 },
  });

describe("what each revision says about tasks", () => {
  it("2025-11-25: adds its task operations to a real server's partial tasks capability", async () => {
    const { client } = await h.connect(workDefinition([taskCase]), {
      revision: "2025-11-25",
      build: {
        tasks: { store: createMemoryTaskStore(), owner: "me", onError },
      },
      realWrap: (real) => ({
        ...real,
        describe: async () => ({ capabilities: { tasks: { list: {} } } }),
      }),
    });
    expect(client.getServerCapabilities()?.tasks).toMatchObject({
      list: {},
      cancel: {},
      requests: { tools: { call: {} } },
    });
  });

  it.each(REVISIONS)(
    "%s: declares the task wire it defines, and no other",
    async (revision) => {
      const { handler } = mock([taskCase]);
      const { client } = await h.connect(workDefinition([taskCase]), {
        revision,
        build: {
          tasks: { store: createMemoryTaskStore(), owner: "me", onError },
        },
      });
      const caps = client.getServerCapabilities();
      expect(handler).toBeDefined();
      expect(caps?.tasks !== undefined).toBe(revision === "2025-11-25");
      expect(
        (caps?.extensions as Record<string, unknown> | undefined)?.[
          "io.modelcontextprotocol/tasks"
        ] !== undefined
      ).toBe(revision === MODERN);
      // The 2025-11-25 utility needs the tool to say it may run as a task.
      const tool = (await client.listTools()).tools.find(
        (t) => t.name === "work"
      );
      expect(tool?.execution?.taskSupport).toBe(
        revision === "2025-11-25" ? "optional" : undefined
      );
    }
  );

  it.each(REVISIONS)(
    "%s: declares nothing without a store, and answers in place",
    async (revision) => {
      const { client } = await h.connect(workDefinition([taskCase]), {
        revision,
      });
      expect(client.getServerCapabilities()?.tasks).toBeUndefined();
      expect(client.getServerCapabilities()?.extensions).toBeUndefined();
      const result = await client.callTool({ name: "work", arguments: {} });
      expect(result.content).toEqual([{ type: "text", text: "finished" }]);
    }
  );

  it.each(["2025-03-26", "2025-06-18"] as const)(
    "%s has no task methods",
    async (revision) => {
      const { handler } = mock([taskCase]);
      for (const method of [
        "tasks/get",
        "tasks/list",
        "tasks/result",
        "tasks/cancel",
      ]) {
        const answered = await h.rpc(handler, revision, method, {
          taskId: "x",
        });
        expect(answered.error?.code, method).toBe(-32601);
      }
    }
  );

  it("2026-07-28 has neither the 2025-11-25 task methods the extension dropped nor a session", async () => {
    const { handler } = mock([taskCase]);
    for (const method of ["tasks/list", "tasks/result"]) {
      const answered = await h.rpc(
        handler,
        MODERN,
        method,
        { taskId: "x" },
        TASKS_EXTENSION
      );
      expect(answered.error?.code, method).toBe(-32601);
    }
  });
});

describe("a case that runs as a task on 2026-07-28", () => {
  it("answers in place for a caller that did not declare the extension, and holds no task", async () => {
    const { handler, store } = mock([taskCase]);
    const answered = await h.rpc(handler, MODERN, "tools/call", {
      name: "work",
      arguments: {},
    });
    expect(answered.result?.content).toEqual([
      { type: "text", text: "finished" },
    ]);
    expect(store.records.size).toBe(0);
  });

  it("is a task: a handle, polling, then the result inline", async () => {
    const { handler, store } = mock([taskCase]);
    const created = await startModern(handler);
    expect(created.result).toMatchObject({
      resultType: "task",
      status: "working",
      pollIntervalMs: 10,
    });
    // The handle goes out only once the record is in the store.
    const taskId = created.result!.taskId as string;
    expect(store.records.has(taskId)).toBe(true);
    const seen = new Set<string>();
    await pollUntil(async () => {
      const got = await h.rpc(
        handler,
        MODERN,
        "tasks/get",
        { taskId },
        TASKS_EXTENSION
      );
      expect(got.result?.resultType).toBe("complete");
      if (got.result?.statusMessage) seen.add(got.result.statusMessage);
      return got.result?.status === "completed";
    });
    expect(seen).toContain("halfway");
    const done = await h.rpc(
      handler,
      MODERN,
      "tasks/get",
      { taskId },
      TASKS_EXTENSION
    );
    expect(done.result).toMatchObject({
      status: "completed",
      result: { content: [{ type: "text", text: "finished" }] },
    });
  });

  it("belongs to its owner: another caller's task id is no task", async () => {
    const { handler, store } = mock([taskCase]);
    const taskId = (await startModern(handler)).result!.taskId as string;
    const other = mock([taskCase], store, "someone else").handler;
    const got = await h.rpc(
      other,
      MODERN,
      "tasks/get",
      { taskId },
      TASKS_EXTENSION
    );
    expect(got.error?.code).toBe(-32602);
  });

  it("is polled on another replica: two handlers over one store", async () => {
    const { handler, store } = mock([taskCase]);
    const replicaB = mock([taskCase], store).handler;
    const taskId = (await startModern(handler)).result!.taskId as string;
    await pollUntil(
      async () =>
        (
          await h.rpc(
            replicaB,
            MODERN,
            "tasks/get",
            { taskId },
            TASKS_EXTENSION
          )
        ).result?.status === "completed"
    );
  });

  it("waits for the person's answer, through tasks/update on another replica", async () => {
    const asking: MockSavedCase = {
      task: true,
      steps: [
        { kind: "ask", id: "q", message: "ok?", requestedSchema: askSchema },
      ],
      result: text("{{steps.q.content.v}}"),
    };
    const { handler, store } = mock([asking]);
    const replicaB = mock([asking], store).handler;
    const taskId = (await startModern(handler)).result!.taskId as string;
    let asked: Record<string, any> | undefined;
    await pollUntil(async () => {
      const got = await h.rpc(
        replicaB,
        MODERN,
        "tasks/get",
        { taskId },
        TASKS_EXTENSION
      );
      asked = got.result?.inputRequests;
      return got.result?.status === "input_required";
    });
    expect(asked?.q).toMatchObject({ method: "elicitation/create" });
    // An answer to a question nobody asked is ignored.
    await h.rpc(
      replicaB,
      MODERN,
      "tasks/update",
      { taskId, inputResponses: { nope: {} } },
      TASKS_EXTENSION
    );
    expect(
      (await h.rpc(handler, MODERN, "tasks/get", { taskId }, TASKS_EXTENSION))
        .result?.status
    ).toBe("input_required");
    await h.rpc(
      replicaB,
      MODERN,
      "tasks/update",
      {
        taskId,
        inputResponses: { q: { action: "accept", content: { v: "yes" } } },
      },
      TASKS_EXTENSION
    );
    await pollUntil(async () => {
      const got = await h.rpc(
        handler,
        MODERN,
        "tasks/get",
        { taskId },
        TASKS_EXTENSION
      );
      return (
        got.result?.status === "completed" &&
        got.result.result.content[0].text === "yes"
      );
    });
  });

  it("drops a reply sent before its question, so that question still waits", async () => {
    const twoQuestions: MockSavedCase = {
      task: true,
      steps: [
        {
          kind: "ask",
          id: "q1",
          message: "first?",
          requestedSchema: askSchema,
        },
        // A step between the two, so the second is asked in a batch of its own.
        { kind: "log", level: "info", data: "between" },
        {
          kind: "ask",
          id: "q2",
          message: "second?",
          requestedSchema: askSchema,
        },
      ],
      result: text("{{steps.q2.content.v}}"),
    };
    const { handler } = mock([twoQuestions]);
    const taskId = (await startModern(handler)).result!.taskId as string;
    const get = async () =>
      (await h.rpc(handler, MODERN, "tasks/get", { taskId }, TASKS_EXTENSION))
        .result;
    const asking = (key: string) =>
      pollUntil(async () => {
        const got = await get();
        return (
          got?.status === "input_required" && key in (got.inputRequests ?? {})
        );
      });
    const reply = (key: string, v: string) =>
      h.rpc(
        handler,
        MODERN,
        "tasks/update",
        {
          taskId,
          inputResponses: { [key]: { action: "accept", content: { v } } },
        },
        TASKS_EXTENSION
      );
    await asking("q1");
    // The answer to the second question arrives while the first is asked.
    await reply("q2", "early");
    await reply("q1", "one");
    await asking("q2");
    // Several worker polls: an early reply kept would have answered q2 by now.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await get())?.status).toBe("input_required");
    await reply("q2", "late");
    await pollUntil(async () => {
      const got = await get();
      return (
        got?.status === "completed" && got.result.content[0].text === "late"
      );
    });
  });

  it("cancels a running task and keeps it cancelled", async () => {
    const slow: MockSavedCase = {
      task: true,
      steps: [{ kind: "log", level: "info", data: "x", delayMs: 80 }],
      result: text("late"),
    };
    const { handler } = mock([slow]);
    const taskId = (await startModern(handler)).result!.taskId as string;
    await h.rpc(handler, MODERN, "tasks/cancel", { taskId }, TASKS_EXTENSION);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(
      (await h.rpc(handler, MODERN, "tasks/get", { taskId }, TASKS_EXTENSION))
        .result
    ).toMatchObject({ status: "cancelled" });
  });

  it("keeps a tool error as completed, as the extension says", async () => {
    const failing: MockSavedCase = {
      task: true,
      result: { isError: true, content: [{ type: "text", text: "nope" }] },
    };
    const { handler } = mock([failing]);
    const taskId = (await startModern(handler)).result!.taskId as string;
    await pollUntil(
      async () =>
        (await h.rpc(handler, MODERN, "tasks/get", { taskId }, TASKS_EXTENSION))
          .result?.status === "completed"
    );
  });

  it("fails the task with a saved protocol error", async () => {
    const erroring: MockSavedCase = {
      task: true,
      error: { code: -32050, message: "boom" },
    };
    const { handler } = mock([erroring]);
    const taskId = (await startModern(handler)).result!.taskId as string;
    await pollUntil(
      async () =>
        (await h.rpc(handler, MODERN, "tasks/get", { taskId }, TASKS_EXTENSION))
          .result?.status === "failed"
    );
    expect(
      (await h.rpc(handler, MODERN, "tasks/get", { taskId }, TASKS_EXTENSION))
        .result?.error
    ).toMatchObject({ code: -32050, message: "boom" });
  });

  it("forgets a task past its TTL", async () => {
    let now = 1_000;
    const store = createMemoryTaskStore();
    const handler = buildMock(workDefinition([taskCase]), NO_REAL_SERVER, {
      tasks: {
        store,
        owner: "me",
        onError,
        ttlMs: 100,
        pollIntervalMs: 10,
        now: () => now,
      },
    });
    const taskId = (await startModern(handler)).result!.taskId as string;
    expect(
      (await h.rpc(handler, MODERN, "tasks/get", { taskId }, TASKS_EXTENSION))
        .result
    ).toMatchObject({ ttlMs: 100 });
    now += 101;
    expect(
      (await h.rpc(handler, MODERN, "tasks/get", { taskId }, TASKS_EXTENSION))
        .error?.code
    ).toBe(-32602);
  });
});

describe("questions in a 2026-07-28 task", () => {
  const answer = (v: string) => ({ action: "accept", content: { v } });

  it("keeps the first answer to a question while the rest of its batch waits", async () => {
    const batch: MockSavedCase = {
      task: true,
      steps: [
        {
          kind: "ask",
          id: "q1",
          message: "first?",
          requestedSchema: askSchema,
        },
        {
          kind: "ask",
          id: "q2",
          message: "second?",
          requestedSchema: askSchema,
        },
      ],
      result: text("{{steps.q1.content.v}}"),
    };
    const { handler } = mock([batch]);
    const taskId = (await startModern(handler)).result!.taskId as string;
    const get = async () =>
      (await h.rpc(handler, MODERN, "tasks/get", { taskId }, TASKS_EXTENSION))
        .result;
    const reply = (inputResponses: Record<string, unknown>) =>
      h.rpc(
        handler,
        MODERN,
        "tasks/update",
        { taskId, inputResponses },
        TASKS_EXTENSION
      );
    await pollUntil(async () => (await get())?.status === "input_required");
    await reply({ q1: answer("first") });
    // Only the question with no answer is still asked.
    expect(Object.keys((await get())?.inputRequests ?? {})).toEqual(["q2"]);
    await reply({ q1: answer("changed"), q2: answer("second") });
    await pollUntil(async () => (await get())?.status === "completed");
    expect((await get())?.result.content[0].text).toBe("first");
  });

  it("waits for a reply to a question named after an Object member", async () => {
    const asking: MockSavedCase = {
      task: true,
      steps: [
        {
          kind: "ask",
          id: "toString",
          message: "ok?",
          requestedSchema: askSchema,
        },
      ],
      result: text("done"),
    };
    const { handler } = mock([asking]);
    const taskId = (await startModern(handler)).result!.taskId as string;
    const status = async () =>
      (await h.rpc(handler, MODERN, "tasks/get", { taskId }, TASKS_EXTENSION))
        .result?.status;
    await pollUntil(async () => (await status()) === "input_required");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await status()).toBe("input_required");
    await h.rpc(
      handler,
      MODERN,
      "tasks/update",
      { taskId, inputResponses: { toString: answer("yes") } },
      TASKS_EXTENSION
    );
    await pollUntil(async () => (await status()) === "completed");
  });
});

describe("a case that runs as a task on 2025-11-25", () => {
  const rpc = (
    handler: ReturnType<typeof mock>["handler"],
    method: string,
    params: object
  ) => h.rpc(handler, "2025-11-25", method, params as Record<string, unknown>);

  it("answers in place when the caller sends no task", async () => {
    const { handler, store } = mock([taskCase]);
    const answered = await rpc(handler, "tools/call", {
      name: "work",
      arguments: {},
    });
    expect(answered.result?.content).toEqual([
      { type: "text", text: "finished" },
    ]);
    expect(store.records.size).toBe(0);
  });

  it("is a task when asked: get, result, list, and cancel refused once finished", async () => {
    const { handler } = mock([taskCase]);
    const created = await startLegacy(handler);
    expect(created.result?.task).toMatchObject({
      status: "working",
      pollInterval: 10,
      ttl: 60000,
    });
    const taskId = created.result!.task.taskId as string;
    // tasks/result waits for the task to finish.
    const result = await rpc(handler, "tasks/result", { taskId });
    expect(result.result).toMatchObject({
      content: [{ type: "text", text: "finished" }],
      _meta: { "io.modelcontextprotocol/related-task": { taskId } },
    });
    expect((await rpc(handler, "tasks/get", { taskId })).result).toMatchObject({
      status: "completed",
    });
    expect((await rpc(handler, "tasks/list", {})).result?.tasks).toHaveLength(
      1
    );
    expect(
      (await rpc(handler, "tasks/cancel", { taskId })).error
    ).toMatchObject({
      code: -32602,
      message: expect.stringContaining("terminal status 'completed'"),
    });
  });

  it("cancels a running task", async () => {
    const slow: MockSavedCase = {
      task: true,
      steps: [{ kind: "log", level: "info", data: "x", delayMs: 80 }],
      result: text("late"),
    };
    const { handler } = mock([slow]);
    const taskId = (await startLegacy(handler)).result!.task.taskId as string;
    expect(
      (await rpc(handler, "tasks/cancel", { taskId })).result
    ).toMatchObject({
      status: "cancelled",
    });
    expect((await rpc(handler, "tasks/result", { taskId })).error?.code).toBe(
      -32602
    );
  });

  it("reports a tool error as failed, and still returns it from tasks/result", async () => {
    const failing: MockSavedCase = {
      task: true,
      result: { isError: true, content: [{ type: "text", text: "nope" }] },
    };
    const { handler } = mock([failing]);
    const taskId = (await startLegacy(handler)).result!.task.taskId as string;
    const result = await rpc(handler, "tasks/result", { taskId });
    expect(result.result).toMatchObject({ isError: true });
    expect((await rpc(handler, "tasks/get", { taskId })).result?.status).toBe(
      "failed"
    );
  });

  it("returns the saved protocol error from tasks/result", async () => {
    const erroring: MockSavedCase = {
      task: true,
      error: { code: -32050, message: "boom" },
    };
    const { handler } = mock([erroring]);
    const taskId = (await startLegacy(handler)).result!.task.taskId as string;
    expect(
      (await rpc(handler, "tasks/result", { taskId })).error
    ).toMatchObject({
      code: -32050,
      message: "boom",
    });
  });

  it("is polled on another replica, and says no task has an id nobody created", async () => {
    const { handler, store } = mock([taskCase]);
    const replicaB = mock([taskCase], store).handler;
    const taskId = (await startLegacy(handler)).result!.task.taskId as string;
    expect(
      (await rpc(replicaB, "tasks/result", { taskId })).result
    ).toMatchObject({
      content: [{ type: "text", text: "finished" }],
    });
    expect(
      (await rpc(replicaB, "tasks/get", { taskId: "nobody" })).error?.code
    ).toBe(-32602);
    expect(
      (await rpc(replicaB, "tasks/list", { cursor: "x" })).error?.code
    ).toBe(-32602);
  });

  it("refuses a cancel when the task finishes before the cancel is written", async () => {
    const gated: MockSavedCase = {
      task: true,
      steps: [{ kind: "progress", progress: 1, total: 2, message: "half" }],
      result: text("late"),
    };
    const { handler, store } = mock([gated]);
    const update = store.update;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held: Promise<unknown> | undefined;
    let cancelWritten = false;
    store.update = async (owner, id, patch) => {
      // The case waits at its first write until the cancel has run.
      if (patch.statusMessage === "half") {
        held = gate.then(() => update(owner, id, patch));
        return held as ReturnType<typeof update>;
      }
      // The case finishes between the cancel's read and its write.
      if (patch.status === "cancelled") {
        cancelWritten = true;
        await update(owner, id, {
          status: "completed",
          result: { content: [{ type: "text", text: "late" }] },
          lastUpdatedAt: Date.now(),
        });
      }
      return update(owner, id, patch);
    };
    try {
      const taskId = (await startLegacy(handler)).result!.task.taskId as string;
      await pollUntil(async () => held !== undefined);
      expect(
        (await rpc(handler, "tasks/cancel", { taskId })).error
      ).toMatchObject({
        code: -32602,
        message: expect.stringContaining("terminal status 'completed'"),
      });
      // Refused after its write, not by the check before it.
      expect(cancelWritten).toBe(true);
    } finally {
      release();
      await held;
      // The worker's tail after the gate is microtasks only, so one turn of
      // the event loop lets it finish before the test ends.
      await new Promise((resolve) => setImmediate(resolve));
    }
  });

  it("refuses to start a task whose ttl ran out while it was stored", async () => {
    let clock = 1_000;
    const store = createMemoryTaskStore();
    const create = store.create;
    store.create = async (record) => {
      await create(record);
      clock += 5;
    };
    const handler = buildMock(workDefinition([taskCase]), NO_REAL_SERVER, {
      tasks: {
        store,
        owner: "me",
        pollIntervalMs: 10,
        onError,
        now: () => clock,
      },
    });
    const started = await rpc(handler, "tools/call", {
      name: "work",
      arguments: {},
      task: { ttl: 1 },
    });
    expect(started.error).toMatchObject({
      code: -32602,
      message: expect.stringContaining("Ask for a longer ttl"),
    });
  });

  /** A real server holding two tasks of its own, one per page. */
  function realWithTasks(
    answer:
      | "pages"
      | "refused"
      | "list refused"
      | "failing"
      | "unreachable"
      | "no list",
    store = createMemoryTaskStore()
  ) {
    const asked: Array<Record<string, unknown> | undefined> = [];
    const realTask = (taskId: string) => ({
      taskId,
      status: "working",
      createdAt: "2026-11-28T00:00:00.000Z",
      lastUpdatedAt: "2026-11-28T00:00:00.000Z",
      ttl: 60000,
    });
    const real: MockRealServer = {
      ...NO_REAL_SERVER,
      describe: async () => ({
        capabilities: {
          tasks: answer === "no list" ? { cancel: {} } : { list: {} },
        },
      }),
      authorizeForward: async (request) =>
        answer === "refused" ||
        (answer === "list refused" &&
          request.kind === "request" &&
          request.method === "tasks/list")
          ? {
              allowed: false,
              reason: "blocked_by_policy",
              message: "Forwarding is off for this mock.",
            }
          : { allowed: true },
      request: async ({ method, params }) => {
        // What the MCP client throws for a method outside the spec.
        if (!method.match(/^tasks\/(get|result|list|cancel)$/)) {
          throw new TypeError(`Unknown method: ${method}`);
        }
        if (answer === "unreachable") {
          throw new ProtocolError(
            MOCK_ERROR_CODES.realUnreachable,
            "The real server did not answer."
          );
        }
        if (method !== "tasks/list" || answer === "failing") {
          throw new Error(`The real server is down (${method}).`);
        }
        asked.push(params);
        return params?.cursor === "page-2"
          ? { tasks: [realTask("real-2")] }
          : { tasks: [realTask("real-1")], nextCursor: "page-2" };
      },
    };
    const handler = buildMock(workDefinition([taskCase]), real, {
      tasks: { store, owner: "me", pollIntervalMs: 10, onError },
    });
    return { handler, asked };
  }
  const ids = (listed: Awaited<ReturnType<typeof rpc>>) =>
    (listed.result?.tasks as Array<{ taskId: string }>).map((t) => t.taskId);

  it("lists its own tasks, then the real server's, and passes the real server's cursor back", async () => {
    const { handler, asked } = realWithTasks("pages");
    const own = (await startLegacy(handler)).result!.task.taskId as string;
    const first = await rpc(handler, "tasks/list", {});
    expect(ids(first)).toEqual([own, "real-1"]);
    expect(first.result?.nextCursor).toBe("page-2");
    const second = await rpc(handler, "tasks/list", { cursor: "page-2" });
    expect(ids(second)).toEqual(["real-2"]);
    expect(asked.at(-1)).toMatchObject({ cursor: "page-2" });
  });

  it("lists only its own tasks when no read can reach the real server's", async () => {
    for (const answer of ["refused", "unreachable"] as const) {
      const { handler } = realWithTasks(answer);
      const own = (await startLegacy(handler)).result!.task.taskId;
      expect(ids(await rpc(handler, "tasks/list", {}))).toEqual([own]);
    }
  });

  it("fails the list when it might leave out a task tasks/get can read", async () => {
    // The host refuses the list but would let tasks/get through.
    const listRefused = realWithTasks("list refused").handler;
    await startLegacy(listRefused);
    expect((await rpc(listRefused, "tasks/list", {})).error?.code).toBe(
      MOCK_ERROR_CODES.forwardBlocked
    );
    // The real server answers, but not this list.
    const failing = realWithTasks("failing").handler;
    await startLegacy(failing);
    expect((await rpc(failing, "tasks/list", {})).error).toBeDefined();
    // The store cannot list the mock's own tasks.
    const store = createMemoryTaskStore();
    store.list = async () => {
      throw new Error("store down");
    };
    const storeDown = realWithTasks("pages", store).handler;
    expect((await rpc(storeDown, "tasks/list", {})).error).toBeDefined();
  });

  it("offers no list when the real server runs tasks it cannot list", async () => {
    const { client } = await h.connect(workDefinition([taskCase]), {
      revision: "2025-11-25",
      build: {
        tasks: { store: createMemoryTaskStore(), owner: "me", onError },
      },
      realWrap: (real) => ({
        ...real,
        describe: async () => ({ capabilities: { tasks: { cancel: {} } } }),
      }),
    });
    const advertised = client.getServerCapabilities()?.tasks;
    expect(advertised).toMatchObject({
      cancel: {},
      requests: { tools: { call: {} } },
    });
    expect(advertised?.list).toBeUndefined();
    // A caller that lists anyway is told the real server cannot.
    const { handler } = realWithTasks("no list");
    await startLegacy(handler);
    expect((await rpc(handler, "tasks/list", {})).error?.code).toBe(-32601);
  });

  it("says method not found for a task method no server has", async () => {
    const { handler } = realWithTasks("pages");
    expect(
      (await rpc(handler, "tasks/frobnicate", { taskId: "x" })).error?.code
    ).toBe(-32601);
  });

  it("cannot run a question as a task, and says which revision can", async () => {
    const asking: MockSavedCase = {
      task: true,
      steps: [
        { kind: "ask", id: "q", message: "ok?", requestedSchema: askSchema },
      ],
      result: text("x"),
    };
    const { handler, store } = mock([asking]);
    const answered = await startLegacy(handler);
    expect(JSON.stringify(answered.result)).toContain("2026-07-28");
    expect(store.records.size).toBe(0);
  });
});

describe("a store that fails while a task runs", () => {
  it("tells the host, and fails the task when the store allows it", async () => {
    const store = createMemoryTaskStore();
    const update = store.update;
    let writes = 0;
    store.update = async (...args) => {
      writes += 1;
      // The first write (a progress note) fails; the one that records the failure goes through.
      if (writes === 1) throw new Error("store down");
      return update(...args);
    };
    const handler = buildMock(workDefinition([taskCase]), NO_REAL_SERVER, {
      tasks: { store, owner: "me", pollIntervalMs: 10, onError },
    });
    const taskId = (await startModern(handler)).result!.taskId as string;
    await pollUntil(
      async () =>
        (await h.rpc(handler, MODERN, "tasks/get", { taskId }, TASKS_EXTENSION))
          .result?.status === "failed"
    );
    expect(errors.splice(0)).toEqual([new Error("store down")]);
  });
});
