import assert from "node:assert/strict";
import test from "node:test";
import {
  serveExtensionTasksFixture,
  TASK_TOOL_NAME,
  type ServedExtensionTasksFixture,
} from "../../sdk/tests/support/extension-tasks-fixture.js";
import {
  LEGACY_TASK_ID,
  LEGACY_TASK_TOOL_NAME,
  serveLegacyTasksFixture,
  type ServedLegacyTasksFixture,
} from "../../sdk/tests/support/legacy-tasks-fixture.js";
import { startMockStreamableHttpServer } from "../../sdk/tests/mock-servers/index.js";
import { errorOf, httpTarget, jsonOf, runCli } from "./support/task-cli-harness.js";

async function withExtensionFixture(
  fn: (fixture: ServedExtensionTasksFixture) => Promise<void>,
  options?: Parameters<typeof serveExtensionTasksFixture>[0],
): Promise<void> {
  const fixture = await serveExtensionTasksFixture(options);
  try {
    await fn(fixture);
  } finally {
    await fixture.close();
  }
}

async function withLegacyFixture(
  fn: (fixture: ServedLegacyTasksFixture) => Promise<void>,
  options?: Parameters<typeof serveLegacyTasksFixture>[0],
): Promise<void> {
  const fixture = await serveLegacyTasksFixture(options);
  try {
    await fn(fixture);
  } finally {
    await fixture.close();
  }
}

/** Creates a task on the extension wire and returns its id. */
async function createExtensionTask(url: string): Promise<string> {
  const run = await runCli([
    "tools",
    "call",
    "--tool-name",
    TASK_TOOL_NAME,
    "--task",
    ...httpTarget(url),
  ]);
  assert.equal(run.exitCode, 0, run.stderr);
  const payload = jsonOf(run) as { task: { taskId: string } };
  return payload.task.taskId;
}

test("tasks capabilities reports the extension wire", async () => {
  await withExtensionFixture(async (fixture) => {
    const run = await runCli(["tasks", "capabilities", ...httpTarget(fixture.url)]);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.deepEqual(jsonOf(run), {
      wire: "extension",
      toolCalls: true,
      list: false,
      cancel: true,
      update: true,
      inlineResult: true,
    });
  });
});

test("tasks capabilities reports the legacy wire", async () => {
  await withLegacyFixture(async (fixture) => {
    const run = await runCli(["tasks", "capabilities", ...httpTarget(fixture.url)]);
    assert.equal(run.exitCode, 0, run.stderr);
    const payload = jsonOf(run);
    assert.equal(payload.wire, "legacy");
    assert.equal(payload.list, true);
    assert.equal(payload.update, false);
    assert.equal(payload.inlineResult, false);
  });
});

/**
 * One CLI run against a fresh no-tasks server.
 *
 * The mock server accepts a single MCP session ("Server already initialized"
 * on a second `initialize`), so a shared instance would make the second run in
 * any test fail as unreachable instead of on the condition under test.
 */
async function runAgainstNoTasksServer(args: string[]) {
  const server = await startMockStreamableHttpServer();
  try {
    return await runCli([...args, ...httpTarget(server.url)]);
  } finally {
    await server.stop();
  }
}

test("tasks capabilities exits 0 on a server with no tasks wire", async () => {
  // Informational by design: a script branches on `.wire`, and "no tasks" is a
  // successful answer to the question this command asks.
  const run = await runAgainstNoTasksServer(["tasks", "capabilities"]);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal(jsonOf(run).wire, "none");
});

test("every other task verb refuses a server with no tasks wire", async () => {
  const run = await runAgainstNoTasksServer([
    "tasks",
    "get",
    "--task-id",
    "whatever",
  ]);
  assert.equal(run.exitCode, 1);
  assert.equal(errorOf(run).code, "TASKS_UNSUPPORTED");
});

test("tools call --task refuses a server with no tasks wire", async () => {
  const run = await runAgainstNoTasksServer([
    "tools",
    "call",
    "--tool-name",
    "echo",
    "--task",
  ]);
  assert.equal(run.exitCode, 1);
  assert.equal(errorOf(run).code, "TASKS_UNSUPPORTED");
});

test("tools call --task creates a task on the extension wire", async () => {
  await withExtensionFixture(async (fixture) => {
    const run = await runCli([
      "tools",
      "call",
      "--tool-name",
      TASK_TOOL_NAME,
      "--task",
      ...httpTarget(fixture.url),
    ]);
    assert.equal(run.exitCode, 0, run.stderr);
    const payload = jsonOf(run) as {
      status: string;
      wire: string;
      task: Record<string, unknown>;
    };
    assert.equal(payload.status, "task_created");
    assert.equal(payload.wire, "extension");
    assert.equal(payload.task.resultType, "task");
    assert.equal(typeof payload.task.taskId, "string");
    assert.equal(fixture.tasks().length, 1);
  });
});

test("tools call --task creates a task on the legacy wire", async () => {
  await withLegacyFixture(async (fixture) => {
    const run = await runCli([
      "tools",
      "call",
      "--tool-name",
      LEGACY_TASK_TOOL_NAME,
      "--task",
      ...httpTarget(fixture.url),
    ]);
    assert.equal(run.exitCode, 0, run.stderr);
    const payload = jsonOf(run) as { wire: string; task: Record<string, unknown> };
    assert.equal(payload.wire, "legacy");
    assert.equal(payload.task.taskId, LEGACY_TASK_ID);

    // The legacy augmentation must reach the wire in `params.task`.
    const call = fixture.received.find((entry) => entry.method === "tools/call");
    assert.ok(call?.params?.task, "tools/call carried no params.task");
  });
});

test("tools call --task-ttl reaches the legacy wire and is refused on the extension", async () => {
  await withLegacyFixture(async (fixture) => {
    const run = await runCli([
      "tools",
      "call",
      "--tool-name",
      LEGACY_TASK_TOOL_NAME,
      "--task",
      "--task-ttl",
      "12345",
      ...httpTarget(fixture.url),
    ]);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.equal((jsonOf(run).task as Record<string, unknown>).ttl, 12345);
  });

  await withExtensionFixture(async (fixture) => {
    // SEP-2663 has no client-set TTL: the server owns it, so this is misuse.
    const run = await runCli([
      "tools",
      "call",
      "--tool-name",
      TASK_TOOL_NAME,
      "--task",
      "--task-ttl",
      "12345",
      ...httpTarget(fixture.url),
    ]);
    assert.equal(run.exitCode, 2);
    assert.equal(errorOf(run).code, "USAGE_ERROR");
  });
});

test("tools call rejects task flags that cannot coexist", async () => {
  const cases: Array<[string[], RegExp]> = [
    [["--task-ttl", "1000"], /--task-ttl requires --task/],
    [["--task-watch"], /--task-watch requires --task/],
    [["--task", "--reporter", "junit-xml"], /--reporter/],
    [["--task", "--validate-response"], /--validate-response/],
    [["--wire", "legacy"], /--wire requires --task/],
    [["--duration-ms", "1000"], /--duration-ms requires --task --task-watch/],
    [["--task", "--poll-interval-ms", "500"], /requires --task-watch/],
  ];
  for (const [extra, pattern] of cases) {
    const run = await runCli([
      "tools",
      "call",
      "--tool-name",
      "whatever",
      "--url",
      "http://127.0.0.1:1/mcp",
      "--transport",
      "http",
      ...extra,
    ]);
    assert.equal(run.exitCode, 2, `${extra.join(" ")}\n${run.stderr}`);
    assert.match(errorOf(run).message, pattern);
  }
});

test("tasks get reads a live extension task inline", async () => {
  await withExtensionFixture(async (fixture) => {
    const taskId = await createExtensionTask(fixture.url);
    const run = await runCli([
      "tasks",
      "get",
      "--task-id",
      taskId,
      ...httpTarget(fixture.url),
    ]);
    assert.equal(run.exitCode, 0, run.stderr);
    const payload = jsonOf(run) as { wire: string; task: Record<string, unknown> };
    assert.equal(payload.wire, "extension");
    assert.equal(payload.task.taskId, taskId);
    assert.equal(typeof payload.task.status, "string");
  });
});

test("tasks get reports an unknown task id as TASK_UNKNOWN_OR_EXPIRED", async () => {
  await withExtensionFixture(async (fixture) => {
    const run = await runCli([
      "tasks",
      "get",
      "--task-id",
      "no-such-task",
      ...httpTarget(fixture.url),
    ]);
    assert.equal(run.exitCode, 1);
    assert.equal(errorOf(run).code, "TASK_UNKNOWN_OR_EXPIRED");
  });
});

test("tasks get requires --task-id", async () => {
  await withExtensionFixture(async (fixture) => {
    const run = await runCli(["tasks", "get", ...httpTarget(fixture.url)]);
    assert.equal(run.exitCode, 2);
    assert.match(errorOf(run).message, /--task-id is required/);
  });
});

test("--wire asserts the resolved wire", async () => {
  await withExtensionFixture(async (fixture) => {
    const taskId = await createExtensionTask(fixture.url);

    const matching = await runCli([
      "tasks",
      "get",
      "--task-id",
      taskId,
      "--wire",
      "extension",
      ...httpTarget(fixture.url),
    ]);
    assert.equal(matching.exitCode, 0, matching.stderr);

    const mismatched = await runCli([
      "tasks",
      "get",
      "--task-id",
      taskId,
      "--wire",
      "legacy",
      ...httpTarget(fixture.url),
    ]);
    assert.equal(mismatched.exitCode, 1);
    assert.equal(errorOf(mismatched).code, "TASKS_WIRE_MISMATCH");
  });
});

test("--wire rejects a wire that is not a wire", async () => {
  const run = await runCli([
    "tasks",
    "get",
    "--task-id",
    "x",
    "--wire",
    "none",
    "--url",
    "http://127.0.0.1:1/mcp",
    "--transport",
    "http",
  ]);
  assert.equal(run.exitCode, 2);
});

test("tasks list returns the legacy list and warns on the extension", async () => {
  await withLegacyFixture(
    async (fixture) => {
      const run = await runCli(["tasks", "list", ...httpTarget(fixture.url)]);
      assert.equal(run.exitCode, 0, run.stderr);
      const payload = jsonOf(run) as { wire: string; tasks: unknown[] };
      assert.equal(payload.wire, "legacy");
      assert.ok(Array.isArray(payload.tasks));
    },
    { trackForList: true },
  );

  await withExtensionFixture(async (fixture) => {
    const run = await runCli(["tasks", "list", ...httpTarget(fixture.url)]);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.deepEqual((jsonOf(run) as { tasks: unknown[] }).tasks, []);
    // An empty list with no explanation reads as "nothing is running".
    assert.match(run.stderr, /SEP-2663 removed tasks\/list/);
  });
});

/**
 * A 2025-11-25 server that declares ONLY `tasks.cancel`.
 *
 * It still resolves to `wire: "legacy"`, which is the whole point: the wire
 * alone does not license `tasks/list` or a task-augmented `tools/call`, and
 * both must be refused rather than issued blind.
 */
const CANCEL_ONLY_CAPABILITY = { cancel: {} };

test("tasks list refuses a legacy server that never declared it", async () => {
  await withLegacyFixture(
    async (fixture) => {
      const run = await runCli(["tasks", "list", ...httpTarget(fixture.url)]);
      assert.equal(run.exitCode, 1, run.stderr);
      assert.equal(errorOf(run).code, "TASKS_UNSUPPORTED");
      // The SDK would have answered `{ tasks: [] }` — indistinguishable from a
      // server that genuinely has no tasks.
      assert.ok(
        !fixture.received.some((entry) => entry.method === "tasks/list"),
        "tasks/list was sent to a server that did not declare it",
      );
    },
    { tasksCapability: CANCEL_ONLY_CAPABILITY },
  );
});

test("tools call --task refuses a legacy server that never declared tool calls", async () => {
  await withLegacyFixture(
    async (fixture) => {
      const run = await runCli([
        "tools",
        "call",
        "--tool-name",
        LEGACY_TASK_TOOL_NAME,
        "--task",
        ...httpTarget(fixture.url),
      ]);
      assert.equal(run.exitCode, 1, run.stderr);
      assert.equal(errorOf(run).code, "TASKS_UNSUPPORTED");
      assert.ok(
        !fixture.received.some((entry) => entry.method === "tools/call"),
        "a task-augmented tools/call reached an undeclared server",
      );
    },
    { tasksCapability: CANCEL_ONLY_CAPABILITY },
  );
});

test("tasks result serves the legacy payload and stamps the related task", async () => {
  await withLegacyFixture(async (fixture) => {
    const run = await runCli([
      "tasks",
      "result",
      "--task-id",
      LEGACY_TASK_ID,
      ...httpTarget(fixture.url),
    ]);
    assert.equal(run.exitCode, 0, run.stderr);
    const payload = jsonOf(run) as {
      content: unknown[];
      _meta: Record<string, unknown>;
    };
    assert.ok(Array.isArray(payload.content));
    assert.deepEqual(payload._meta["io.modelcontextprotocol/related-task"], {
      taskId: LEGACY_TASK_ID,
    });
  });
});

test("tasks result is refused on the extension wire with a pointer to tasks get", async () => {
  await withExtensionFixture(async (fixture) => {
    const taskId = await createExtensionTask(fixture.url);
    const run = await runCli([
      "tasks",
      "result",
      "--task-id",
      taskId,
      ...httpTarget(fixture.url),
    ]);
    assert.equal(run.exitCode, 1);
    const error = errorOf(run);
    assert.equal(error.code, "TASKS_UNSUPPORTED");
    assert.match(error.message, /tasks get/);
  });
});

test("tasks cancel is cooperative on the extension wire", async () => {
  await withExtensionFixture(async (fixture) => {
    const taskId = await createExtensionTask(fixture.url);
    const run = await runCli([
      "tasks",
      "cancel",
      "--task-id",
      taskId,
      ...httpTarget(fixture.url),
    ]);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.deepEqual(jsonOf(run), {
      wire: "extension",
      task: null,
      cooperative: true,
    });
    assert.match(run.stderr, /cooperative/);
    assert.equal(fixture.task(taskId)?.cancelRequested, true);
  });
});

test("tasks cancel returns the updated task on the legacy wire", async () => {
  await withLegacyFixture(async (fixture) => {
    await runCli([
      "tools",
      "call",
      "--tool-name",
      LEGACY_TASK_TOOL_NAME,
      "--task",
      ...httpTarget(fixture.url),
    ]);
    const run = await runCli([
      "tasks",
      "cancel",
      "--task-id",
      LEGACY_TASK_ID,
      ...httpTarget(fixture.url),
    ]);
    assert.equal(run.exitCode, 0, run.stderr);
    const payload = jsonOf(run) as { wire: string; task: Record<string, unknown> };
    assert.equal(payload.wire, "legacy");
    assert.equal(payload.task.status, "cancelled");
  });
});

test("tasks update answers an input_required key on the extension wire", async () => {
  await withExtensionFixture(async (fixture) => {
    const taskId = await createExtensionTask(fixture.url);

    // Walk the task to `input_required` so there is a key to answer. Assert the
    // precondition: without it a fixture change surfaces as an opaque
    // `answeredKeys` mismatch below instead of naming what actually went wrong.
    let reachedInputRequired = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const get = await runCli([
        "tasks",
        "get",
        "--task-id",
        taskId,
        ...httpTarget(fixture.url),
      ]);
      const task = (jsonOf(get) as { task: Record<string, unknown> }).task;
      if (task.status === "input_required") {
        reachedInputRequired = true;
        break;
      }
    }
    assert.ok(
      reachedInputRequired,
      "the task never reached input_required in 6 reads",
    );

    const run = await runCli([
      "tasks",
      "update",
      "--task-id",
      taskId,
      "--input-responses",
      JSON.stringify({ name: { action: "accept", content: { name: "Luca" } } }),
      ...httpTarget(fixture.url),
    ]);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.equal((jsonOf(run) as { wire: string }).wire, "extension");
    assert.deepEqual(fixture.task(taskId)?.answeredKeys, ["name"]);
    // The ack is empty by design; the status only moves on a later tasks/get.
    assert.match(run.stderr, /does not move until a later/);
  });
});

test("tasks update requires --input-responses and is refused on the legacy wire", async () => {
  await withExtensionFixture(async (fixture) => {
    const run = await runCli([
      "tasks",
      "update",
      "--task-id",
      "ext-task-1",
      ...httpTarget(fixture.url),
    ]);
    assert.equal(run.exitCode, 2);
    assert.match(errorOf(run).message, /--input-responses is required/);
  });

  await withLegacyFixture(async (fixture) => {
    const run = await runCli([
      "tasks",
      "update",
      "--task-id",
      LEGACY_TASK_ID,
      "--input-responses",
      "{}",
      ...httpTarget(fixture.url),
    ]);
    assert.equal(run.exitCode, 1);
    assert.equal(errorOf(run).code, "TASKS_UNSUPPORTED");
  });
});
