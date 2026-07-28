import assert from "node:assert/strict";
import test from "node:test";
import type { MCPServerConfig, TaskAwaitOutcome } from "@mcpjam/sdk";
import {
  buildTaskInputDriverOptions,
  detectCreatedTask,
  parseTasksWireOption,
  taskWatchExitCode,
} from "../src/lib/tasks-cli.js";
import { CliError } from "../src/lib/output.js";

const httpConfig = { url: "http://127.0.0.1:1/mcp" } as MCPServerConfig;

test("taskWatchExitCode maps every outcome", () => {
  const expected: Record<TaskAwaitOutcome, number> = {
    completed: 0,
    failed: 1,
    cancelled: 1,
    expired: 1,
    unreachable: 1,
    "input-required": 6,
    timeout: 7,
    aborted: 130,
  };
  for (const [outcome, code] of Object.entries(expected)) {
    assert.equal(taskWatchExitCode(outcome as TaskAwaitOutcome), code, outcome);
  }
});

test("taskWatchExitCode treats a tool-level error as a completed task", () => {
  // A task that ran to completion and reported `isError: true` finished; the
  // caller reads the result out of the envelope rather than the exit code.
  assert.equal(taskWatchExitCode("completed"), 0);
});

test("detectCreatedTask accepts the extension's flat CreateTaskResult", () => {
  const created = detectCreatedTask("extension", {
    resultType: "task",
    taskId: "t-1",
    status: "working",
    ttlMs: 60_000,
  });
  assert.ok(created);
  assert.equal(created.status, "task_created");
  assert.equal(created.wire, "extension");
  assert.equal(created.task.taskId, "t-1");
  assert.equal(created.modelImmediateResponse, undefined);
});

test("detectCreatedTask rejects the legacy nested shape on the extension wire", () => {
  // A nonconforming payload must stay visible rather than be reinterpreted.
  assert.equal(
    detectCreatedTask("extension", { task: { taskId: "t-1", status: "working" } }),
    null,
  );
});

test("detectCreatedTask accepts the legacy nested CreateTaskResult", () => {
  const created = detectCreatedTask("legacy", {
    task: { taskId: "legacy-1", status: "working", ttl: 60_000 },
  });
  assert.ok(created);
  assert.equal(created.wire, "legacy");
  assert.equal(created.task.taskId, "legacy-1");
});

test("detectCreatedTask rejects the flat shape on the legacy wire", () => {
  assert.equal(
    detectCreatedTask("legacy", { resultType: "task", taskId: "t-1" }),
    null,
  );
});

test("detectCreatedTask requires taskId and status on the legacy wire", () => {
  assert.equal(detectCreatedTask("legacy", { task: { taskId: "t-1" } }), null);
  assert.equal(detectCreatedTask("legacy", { task: { status: "working" } }), null);
});

test("detectCreatedTask requires a usable taskId on the extension wire too", () => {
  // Without this the envelope reports a successful creation and --task-watch
  // goes on to poll `tasks/get` with an undefined id, burying the malformed
  // payload under an opaque polling failure.
  assert.equal(
    detectCreatedTask("extension", { resultType: "task", status: "working" }),
    null,
  );
  assert.equal(
    detectCreatedTask("extension", { resultType: "task", taskId: "" }),
    null,
  );
  assert.equal(
    detectCreatedTask("extension", { resultType: "task", taskId: 42 }),
    null,
  );
});

test("detectCreatedTask returns null for a plain tool result and a dead wire", () => {
  const plain = { content: [{ type: "text", text: "hi" }] };
  assert.equal(detectCreatedTask("extension", plain), null);
  assert.equal(detectCreatedTask("legacy", plain), null);
  assert.equal(
    detectCreatedTask("none", { resultType: "task", taskId: "t-1" }),
    null,
  );
  assert.equal(detectCreatedTask("extension", null), null);
  assert.equal(detectCreatedTask("extension", "nope"), null);
});

test("detectCreatedTask lifts modelImmediateResponse off _meta on both wires", () => {
  const immediate = { content: [{ type: "text", text: "working on it" }] };
  const ext = detectCreatedTask("extension", {
    resultType: "task",
    taskId: "t-1",
    status: "working",
    _meta: { "io.modelcontextprotocol/model-immediate-response": immediate },
  });
  assert.deepEqual(ext?.modelImmediateResponse, immediate);

  const legacy = detectCreatedTask("legacy", {
    task: { taskId: "l-1", status: "working" },
    _meta: { "io.modelcontextprotocol/model-immediate-response": immediate },
  });
  assert.deepEqual(legacy?.modelImmediateResponse, immediate);
});

test("parseTasksWireOption accepts both live wires and rejects the rest", () => {
  assert.equal(parseTasksWireOption("legacy"), "legacy");
  assert.equal(parseTasksWireOption("extension"), "extension");
  for (const bad of ["none", "modern", ""]) {
    assert.throws(
      () => parseTasksWireOption(bad),
      (error: unknown) =>
        error instanceof CliError &&
        error.code === "USAGE_ERROR" &&
        error.exitCode === 2,
    );
  }
});

test("buildTaskInputDriverOptions is undefined without --interactive", () => {
  assert.equal(
    buildTaskInputDriverOptions({ config: httpConfig, stdinIsTTY: true, env: {} }),
    undefined,
  );
});

test("buildTaskInputDriverOptions still wires a handler when it cannot prompt", () => {
  // Whether the terminal can prompt is the collector's business, not this
  // function's: disarming here would break answering over a pipe, which is how
  // a script drives `--interactive`. The handler declines instead.
  const cannotPrompt = [
    { yes: true, stdinIsTTY: true, env: {} },
    { stdinIsTTY: false, env: {} },
    { stdinIsTTY: true, env: { CI: "1" } },
    { stdinIsTTY: true, env: { MCPJAM_NON_INTERACTIVE: "1" } },
  ];
  for (const scenario of cannotPrompt) {
    const options = buildTaskInputDriverOptions({
      config: httpConfig,
      interactive: true,
      ...scenario,
    });
    assert.ok(options, JSON.stringify(scenario));
    assert.equal(typeof options.handlers.elicitation, "function");
  }
});

test("a non-promptable elicitation handler declines rather than hanging", async () => {
  const options = buildTaskInputDriverOptions({
    config: httpConfig,
    interactive: true,
    yes: true,
    stdinIsTTY: false,
    env: {},
  });
  assert.ok(options);
  const answer = await options.handlers.elicitation!(
    {
      mode: "form",
      message: "Your name?",
      requestedSchema: {
        type: "object",
        properties: { name: { type: "string" } },
      },
    },
    { taskId: "t-1", serverId: "__cli__", inputKey: "name" },
  );
  assert.equal(answer.action, "decline");
});

test("the elicitation handler bridges the task driver onto the terminal collector", async () => {
  // The real answering path. It cannot be driven from an integration test: the
  // CLI treats a non-TTY stdin as "nothing to prompt" everywhere (see
  // `resolveNonInteractive`), so a piped answer always declines. `stdinIsTTY`
  // and `collectorOptions.reader` are the seams that make it testable. The
  // collector itself is covered in `mrtr-input.test.ts`; what is new here is
  // that the driver's `(params, ctx)` shape reaches it and a bare
  // `InputResponse` comes back — the exact object `tasks/update` wants.
  const prompts: string[] = [];
  // The collector asks for the action first, then for each field.
  const queue = ["a", "Luca"];
  const options = buildTaskInputDriverOptions({
    config: httpConfig,
    interactive: true,
    stdinIsTTY: true,
    env: {},
    collectorOptions: {
      reader: {
        async question(prompt: string) {
          prompts.push(prompt);
          if (queue.length === 0) throw new Error(`Reader exhausted: ${prompt}`);
          return queue.shift()!;
        },
      },
      write: () => {},
    },
  });
  assert.ok(options);

  const answer = await options.handlers.elicitation!(
    {
      message: "What is your name?",
      requestedSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    { taskId: "t-1", serverId: "__cli__", inputKey: "name" },
  );

  assert.deepEqual(JSON.parse(JSON.stringify(answer)), {
    action: "accept",
    content: { name: "Luca" },
  });
  assert.ok(prompts.length > 0, "the collector never prompted");
});

test("buildTaskInputDriverOptions wires an elicitation handler and declares it", () => {
  const options = buildTaskInputDriverOptions({
    config: httpConfig,
    interactive: true,
    stdinIsTTY: true,
    env: {},
  });
  assert.ok(options);
  assert.equal(typeof options.handlers.elicitation, "function");
  // roots/sampling stay unanswerable — the driver reports them as rejections
  // rather than the CLI pretending it can satisfy them.
  assert.equal(options.handlers.roots, undefined);
  assert.equal(options.handlers.sampling, undefined);
  const declared = options.declaredCapabilities as Record<string, unknown>;
  assert.deepEqual(declared.elicitation, { form: {}, url: {} });
});

test("buildTaskInputDriverOptions refuses a pinned capability it cannot answer", () => {
  // Declaring `sampling` with no handler would strand any task that asks for
  // it; the user sees the reason instead of a hang.
  const config = {
    url: "http://127.0.0.1:1/mcp",
    clientCapabilities: { elicitation: { form: {} }, sampling: {} },
  } as unknown as MCPServerConfig;

  assert.throws(
    () =>
      buildTaskInputDriverOptions({
        config,
        interactive: true,
        stdinIsTTY: true,
        env: {},
      }),
    (error: unknown) =>
      error instanceof CliError &&
      error.code === "USAGE_ERROR" &&
      /sampling\/createMessage/.test(error.message),
  );
});

test("buildTaskInputDriverOptions surfaces the pinned-set error from --interactive", () => {
  const config = {
    url: "http://127.0.0.1:1/mcp",
    clientCapabilities: { tools: {} },
  } as unknown as MCPServerConfig;

  assert.throws(
    () =>
      buildTaskInputDriverOptions({
        config,
        interactive: true,
        stdinIsTTY: true,
        env: {},
      }),
    (error: unknown) =>
      error instanceof CliError && error.code === "USAGE_ERROR",
  );
});
