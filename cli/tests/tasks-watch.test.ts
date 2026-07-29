import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultTaskPhases,
  serveExtensionTasksFixture,
  TASK_TOOL_NAME,
  type ServedExtensionTasksFixture,
  type TaskPhase,
} from "../../sdk/tests/support/extension-tasks-fixture.js";
import {
  LEGACY_TASK_ID,
  LEGACY_TASK_TOOL_NAME,
  serveLegacyTasksFixture,
} from "../../sdk/tests/support/legacy-tasks-fixture.js";
import { errorOf, httpTarget, jsonOf, runCli } from "./support/task-cli-harness.js";

// The driver has never been exercised over a real network stack, so every
// budget here is deliberately loose: these tests pin outcomes and exit codes,
// not latency.
const WATCH_TIMEOUT_MS = 30_000;

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
  return (jsonOf(run) as { task: { taskId: string } }).task.taskId;
}

/** A ladder that finishes without ever asking for input. */
function nonInteractivePhases(): TaskPhase[] {
  return [
    { status: "working", pollIntervalMs: 10, polls: 2 },
    {
      status: "completed",
      result: { content: [{ type: "text", text: "all done" }], isError: false },
    },
  ];
}

test("watch drives an extension task to completed and returns the inline result", async () => {
  await withExtensionFixture(
    async (fixture) => {
      const taskId = await createExtensionTask(fixture.url);
      const run = await runCli([
        "tasks",
        "watch",
        "--task-id",
        taskId,
        "--duration-ms",
        String(WATCH_TIMEOUT_MS),
        ...httpTarget(fixture.url),
      ]);
      assert.equal(run.exitCode, 0, run.stderr);
      const payload = jsonOf(run) as {
        outcome: string;
        wire: string;
        taskId: string;
        task: { status: string; result?: Record<string, unknown> };
      };
      assert.equal(payload.outcome, "completed");
      assert.equal(payload.wire, "extension");
      assert.equal(payload.taskId, taskId);
      assert.equal(payload.task.status, "completed");
      assert.deepEqual(payload.task.result, {
        content: [{ type: "text", text: "all done" }],
        isError: false,
      });
      // Transitions belong on stderr so stdout stays one envelope.
      assert.match(run.stderr, /task: completed/);
    },
    { tools: { [TASK_TOOL_NAME]: { mode: "task", phases: nonInteractivePhases() } } },
  );
});

test("watch drives a legacy task to completed and fetches the result via tasks/result", async () => {
  // The legacy wire has no inline result: without the driver's `getResult`
  // seam a completed watch would carry no payload at all.
  const fixture = await serveLegacyTasksFixture({
    phases: [
      { status: "working", polls: 2 },
      {
        status: "completed",
        result: { content: [{ type: "text", text: "legacy done" }] },
      },
    ],
    pollInterval: 10,
    rejectUnknownTaskIds: true,
  });
  try {
    const created = await runCli([
      "tools",
      "call",
      "--tool-name",
      LEGACY_TASK_TOOL_NAME,
      "--task",
      ...httpTarget(fixture.url),
    ]);
    assert.equal(created.exitCode, 0, created.stderr);

    const run = await runCli([
      "tasks",
      "watch",
      "--task-id",
      LEGACY_TASK_ID,
      "--duration-ms",
      String(WATCH_TIMEOUT_MS),
      ...httpTarget(fixture.url),
    ]);
    assert.equal(run.exitCode, 0, run.stderr);
    const payload = jsonOf(run) as {
      outcome: string;
      wire: string;
      task: { status: string; result?: Record<string, unknown> };
    };
    assert.equal(payload.outcome, "completed");
    assert.equal(payload.wire, "legacy");
    assert.deepEqual(payload.task.result, {
      content: [{ type: "text", text: "legacy done" }],
    });
    assert.ok(
      fixture.received.some((entry) => entry.method === "tasks/result"),
      "the watch never called tasks/result",
    );
  } finally {
    await fixture.close();
  }
});

test("watch exits 6 when a task needs input it cannot answer", async () => {
  await withExtensionFixture(async (fixture) => {
    const taskId = await createExtensionTask(fixture.url);
    const run = await runCli([
      "tasks",
      "watch",
      "--task-id",
      taskId,
      "--yes",
      "--duration-ms",
      String(WATCH_TIMEOUT_MS),
      ...httpTarget(fixture.url),
    ]);
    assert.equal(run.exitCode, 6, run.stderr);
    const payload = jsonOf(run) as { outcome: string; task: { status: string } };
    assert.equal(payload.outcome, "input-required");
    assert.equal(payload.task.status, "input_required");
  });
});

test("watch with --interactive declines when stdin is not a TTY", async () => {
  // The CLI treats a non-TTY stdin as "nothing to prompt" everywhere
  // (`resolveNonInteractive`), so piping answers in is NOT a supported way to
  // answer an elicitation — the handler declines and the drive ends unanswered.
  // The accepting path is unit-tested through the reader seam in
  // `tasks-cli.test.ts`, which is the only place it can be driven.
  await withExtensionFixture(async (fixture) => {
    const taskId = await createExtensionTask(fixture.url);
    const run = await runCli(
      [
        "tasks",
        "watch",
        "--task-id",
        taskId,
        "--interactive",
        "--duration-ms",
        String(WATCH_TIMEOUT_MS),
        ...httpTarget(fixture.url),
      ],
      "Luca\n",
    );
    assert.equal(run.exitCode, 6, run.stderr);
    assert.equal((jsonOf(run) as { outcome: string }).outcome, "input-required");
    assert.match(run.stderr, /Non-interactive mode/);
  });
});

test("watch reports a failed task as failed and exits 1", async () => {
  await withExtensionFixture(
    async (fixture) => {
      const taskId = await createExtensionTask(fixture.url);
      const run = await runCli([
        "tasks",
        "watch",
        "--task-id",
        taskId,
        "--duration-ms",
        String(WATCH_TIMEOUT_MS),
        ...httpTarget(fixture.url),
      ]);
      assert.equal(run.exitCode, 1, run.stderr);
      assert.equal((jsonOf(run) as { outcome: string }).outcome, "failed");
    },
    {
      tools: {
        [TASK_TOOL_NAME]: {
          mode: "task",
          phases: [
            { status: "working", pollIntervalMs: 10 },
            { status: "failed", error: { code: -1, message: "nope" } },
          ],
        },
      },
    },
  );
});

test("watch reports a cancelled task and exits 1", async () => {
  await withExtensionFixture(
    async (fixture) => {
      const taskId = await createExtensionTask(fixture.url);
      const cancel = await runCli([
        "tasks",
        "cancel",
        "--task-id",
        taskId,
        ...httpTarget(fixture.url),
      ]);
      assert.equal(cancel.exitCode, 0, cancel.stderr);

      const run = await runCli([
        "tasks",
        "watch",
        "--task-id",
        taskId,
        "--duration-ms",
        String(WATCH_TIMEOUT_MS),
        ...httpTarget(fixture.url),
      ]);
      assert.equal(run.exitCode, 1, run.stderr);
      assert.equal((jsonOf(run) as { outcome: string }).outcome, "cancelled");
    },
    {
      tools: {
        [TASK_TOOL_NAME]: {
          mode: "task",
          phases: [
            { status: "working", pollIntervalMs: 10, awaitCancel: true },
            { status: "cancelled" },
          ],
        },
      },
    },
  );
});

test("watch exits 7 when the duration elapses before the task finishes", async () => {
  await withExtensionFixture(
    async (fixture) => {
      const taskId = await createExtensionTask(fixture.url);
      const run = await runCli([
        "tasks",
        "watch",
        "--task-id",
        taskId,
        "--duration-ms",
        "600",
        ...httpTarget(fixture.url),
      ]);
      assert.equal(run.exitCode, 7, run.stderr);
      assert.equal((jsonOf(run) as { outcome: string }).outcome, "timeout");
    },
    {
      tools: {
        [TASK_TOOL_NAME]: {
          mode: "task",
          // Never advances: `polls` outlives any duration this test allows.
          phases: [{ status: "working", pollIntervalMs: 50, polls: 10_000 }],
        },
      },
    },
  );
});

test("watch reports an unknown task id as expired and exits 1", async () => {
  await withExtensionFixture(async (fixture) => {
    const run = await runCli([
      "tasks",
      "watch",
      "--task-id",
      "no-such-task",
      "--duration-ms",
      String(WATCH_TIMEOUT_MS),
      ...httpTarget(fixture.url),
    ]);
    assert.equal(run.exitCode, 1, run.stderr);
    assert.equal((jsonOf(run) as { outcome: string }).outcome, "expired");
  });
});

test("watch honours --poll-interval-ms as a floor", async () => {
  await withExtensionFixture(
    async (fixture) => {
      const taskId = await createExtensionTask(fixture.url);
      const before = fixture.received.filter(
        (entry) => entry.method === "tasks/get",
      ).length;

      const startedAt = Date.now();
      const run = await runCli([
        "tasks",
        "watch",
        "--task-id",
        taskId,
        "--poll-interval-ms",
        "400",
        "--duration-ms",
        String(WATCH_TIMEOUT_MS),
        ...httpTarget(fixture.url),
      ]);
      const elapsed = Date.now() - startedAt;
      assert.equal(run.exitCode, 0, run.stderr);

      const polls =
        fixture.received.filter((entry) => entry.method === "tasks/get").length -
        before;
      // The server advertises a 10ms interval; the user's 400ms floor must win,
      // so four phase steps cannot have been read faster than three gaps.
      assert.ok(polls >= 3, `expected at least 3 polls, saw ${polls}`);
      assert.ok(
        elapsed >= 400 * (polls - 1),
        `${polls} polls in ${elapsed}ms is faster than the 400ms floor`,
      );
    },
    {
      tools: {
        [TASK_TOOL_NAME]: {
          mode: "task",
          pollIntervalMs: 10,
          phases: [
            { status: "working", pollIntervalMs: 10 },
            { status: "working", pollIntervalMs: 10 },
            { status: "working", pollIntervalMs: 10 },
            {
              status: "completed",
              result: { content: [{ type: "text", text: "done" }], isError: false },
            },
          ],
        },
      },
    },
  );
});

test("watch refuses an unknown wire assertion before polling", async () => {
  await withExtensionFixture(async (fixture) => {
    const taskId = await createExtensionTask(fixture.url);
    const run = await runCli([
      "tasks",
      "watch",
      "--task-id",
      taskId,
      "--wire",
      "legacy",
      ...httpTarget(fixture.url),
    ]);
    assert.equal(run.exitCode, 1);
    assert.equal(errorOf(run).code, "TASKS_WIRE_MISMATCH");
  });
});

test("tools call --task --task-watch creates and drives in one invocation", async () => {
  await withExtensionFixture(
    async (fixture) => {
      const run = await runCli([
        "tools",
        "call",
        "--tool-name",
        TASK_TOOL_NAME,
        "--task",
        "--task-watch",
        "--duration-ms",
        String(WATCH_TIMEOUT_MS),
        ...httpTarget(fixture.url),
      ]);
      assert.equal(run.exitCode, 0, run.stderr);
      const payload = jsonOf(run) as {
        created: { status: string; wire: string; task: { taskId: string } };
        watch: { outcome: string; task: { result?: Record<string, unknown> } };
      };
      assert.equal(payload.created.status, "task_created");
      assert.equal(payload.watch.outcome, "completed");
      assert.equal(payload.watch.task.result?.isError, false);
      // Same task, one connection.
      assert.equal(fixture.tasks().length, 1);
    },
    { tools: { [TASK_TOOL_NAME]: { mode: "task", phases: nonInteractivePhases() } } },
  );
});

test("tools call --task --task-watch --interactive reaches the task's input round", async () => {
  // End-to-end proof that a single invocation creates the task, watches it, and
  // hands the embedded elicitation to the terminal collector — which declines
  // here only because the test harness has no TTY (see the watch case above).
  await withExtensionFixture(
    async (fixture) => {
      const run = await runCli(
        [
          "tools",
          "call",
          "--tool-name",
          TASK_TOOL_NAME,
          "--task",
          "--task-watch",
          "--interactive",
          "--duration-ms",
          String(WATCH_TIMEOUT_MS),
          ...httpTarget(fixture.url),
        ],
        "Luca\n",
      );
      assert.equal(run.exitCode, 6, run.stderr);
      const payload = jsonOf(run) as {
        created: { status: string };
        watch: { outcome: string; task: { status: string } };
      };
      assert.equal(payload.created.status, "task_created");
      assert.equal(payload.watch.outcome, "input-required");
      assert.equal(payload.watch.task.status, "input_required");
      assert.match(run.stderr, /Non-interactive mode/);
    },
    { tools: { [TASK_TOOL_NAME]: { mode: "task", phases: defaultTaskPhases() } } },
  );
});

test("tools call --task --task-watch propagates the watch exit code", async () => {
  await withExtensionFixture(async (fixture) => {
    const run = await runCli([
      "tools",
      "call",
      "--tool-name",
      TASK_TOOL_NAME,
      "--task",
      "--task-watch",
      "--yes",
      "--duration-ms",
      String(WATCH_TIMEOUT_MS),
      ...httpTarget(fixture.url),
    ]);
    assert.equal(run.exitCode, 6, run.stderr);
    const payload = jsonOf(run) as { watch: { outcome: string } };
    assert.equal(payload.watch.outcome, "input-required");
  });
});
