/**
 * Group D, the Claude Code background drain (`claude-code-background-drain.ts`).
 *
 * The reducer and controller under test are lifted out of the INSTALLED,
 * patched bridge (like `registry.test.ts` does with the model overrides), so a
 * patch that compiles but drifts from what ships cannot pass here. Message
 * shapes are the ones SDK 0.3.245 / CLI 2.1.245 emitted in the spike.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createHostedClaudeCodeHarness } from "../claude-code-typed-errors.js";
import {
  CLAUDE_CODE_BACKGROUND_DRAIN_MARKER,
  extractClaudeCodeBackgroundDrainHelpers,
  patchClaudeCodeBackgroundDrain,
} from "../claude-code-background-drain.js";

type Step = {
  keepReading: boolean;
  closeInput: boolean;
  abort: boolean;
  ignoreResult: boolean;
  mainThread: boolean;
  wantsIdle: boolean;
};
type DrainState = Record<string, any>;
type Controller = {
  state: DrainState;
  readonly stopped: boolean;
  readonly touched: boolean;
  readonly draining: boolean;
  observe(msg: unknown): Step;
  answer(): Step;
  isBackgroundAgentRequest(agentID: unknown): Promise<boolean>;
  deniedBackgroundApproval(toolName: string): void;
  approvalStarted(): void;
  approvalEnded(): void;
  stop(reason?: string): void;
  clear(): void;
};
type Helpers = {
  createState(input: { promptUuid: string; turnStartedAt: number }): DrainState;
  reduce(state: DrainState, event: unknown): Step;
  createController(deps: Record<string, unknown>): Controller;
  denial: string;
};

const AUTH = {
  AI_GATEWAY_API_KEY: "test",
  AI_GATEWAY_BASE_URL: "https://ai-gateway.vercel.sh/v1",
};

async function installedBridge(): Promise<string> {
  const bootstrap = await createHostedClaudeCodeHarness({
    auth: AUTH,
  } as any).getBootstrap?.();
  return (
    bootstrap?.files.find((file) => file.path.endsWith("/bridge.mjs"))
      ?.content ?? ""
  );
}

let helpers: Helpers;

beforeEach(async () => {
  helpers ??= await (async () => {
    const block = extractClaudeCodeBackgroundDrainHelpers(
      await installedBridge(),
    );
    if (!block) throw new Error("the installed bridge has no drain helpers");
    return new Function(
      `${block}
      return {
        createState: mcpjamCreateBackgroundDrainState,
        reduce: mcpjamBackgroundDrainReducer,
        createController: mcpjamCreateBackgroundDrainController,
        denial: MCPJAM_BACKGROUND_APPROVAL_DENIAL,
      };`,
    )() as Helpers;
  })();
});

const PROMPT = "prompt-uuid";
const lifecycle = (state: string, command_uuid = PROMPT) => ({
  type: "command_lifecycle",
  command_uuid,
  state,
});
const init = () => ({ type: "system", subtype: "init" });
const assistant = (text = "ok") => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { content: [{ type: "text", text }] },
});
const subagentAssistant = () => ({
  type: "assistant",
  parent_tool_use_id: "toolu_1",
  message: { content: [{ type: "text", text: "PLAN" }] },
});
const result = (text = "done") => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: text,
});
const tasksChanged = (...tasks: Array<[id: string, type: string]>) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: tasks.map(([task_id, task_type]) => ({
    task_id,
    task_type,
    description: `task ${task_id}`,
  })),
});
const taskStarted = (
  task_id: string,
  task_type: string,
  is_backgrounded: boolean | undefined = true,
) => ({
  type: "system",
  subtype: "task_started",
  task_id,
  task_type,
  tool_use_id: `toolu_${task_id}`,
  description: `task ${task_id}`,
  subagent_type: task_type === "local_agent" ? "general-purpose" : undefined,
  ...(is_backgrounded === undefined ? {} : { is_backgrounded }),
  spawn_depth: task_type === "local_agent" ? 1 : undefined,
});
const notification = (task_id: string, status = "completed") => ({
  type: "system",
  subtype: "task_notification",
  task_id,
  tool_use_id: `toolu_${task_id}`,
  status,
  summary: "PLAN",
});

function run(events: unknown[]) {
  const state = helpers.createState({ promptUuid: PROMPT, turnStartedAt: 0 });
  const steps = events.map((event) =>
    event === "answer"
      ? helpers.reduce(state, { type: "mcpjam-answer", at: 1 })
      : helpers.reduce(state, event),
  );
  return { state, steps, last: steps.at(-1)! };
}

describe("background drain reducer", () => {
  it("no background work: the first answer ends the turn, as today", () => {
    const { last } = run([
      lifecycle("queued"),
      lifecycle("started"),
      init(),
      assistant(),
      result(),
      "answer",
    ]);
    expect(last).toMatchObject({ keepReading: false, closeInput: true });
  });

  it("an agent pending at the answer keeps the turn open until its follow-up's answer", () => {
    const { state, steps } = run([
      lifecycle("started"),
      init(),
      assistant(),
      tasksChanged(["a1", "local_agent"]),
      taskStarted("a1", "local_agent"),
      assistant("I'll let you know"),
      result(),
      "answer",
      subagentAssistant(),
      tasksChanged(),
      notification("a1"),
      init(),
      assistant("Here is the plan"),
      result(),
      "answer",
    ]);
    expect(steps[7]).toMatchObject({ keepReading: true, closeInput: false });
    // Settled, follow-up not started: still open (the level precedes the edge).
    expect(steps[9]!.keepReading).toBe(true);
    expect(steps[10]!.keepReading).toBe(true);
    expect(steps[12]!.keepReading).toBe(true);
    expect(steps.at(-1)).toMatchObject({
      keepReading: false,
      closeInput: true,
    });
    expect(state.drainStartedAt).toBe(1);
  });

  it("an agent that finishes BEFORE the first answer still gets its follow-up", () => {
    const { steps } = run([
      init(),
      assistant(),
      tasksChanged(["a1", "local_agent"]),
      taskStarted("a1", "local_agent"),
      tasksChanged(),
      notification("a1"),
      assistant("I'll let you know"),
      result(),
      "answer",
      init(),
      assistant("Here is the plan"),
      result(),
      "answer",
    ]);
    expect(steps[8]!.keepReading).toBe(true);
    expect(steps.at(-1)!.keepReading).toBe(false);
  });

  it("two agents finishing at different times hold the turn for both", () => {
    const { steps } = run([
      init(),
      assistant(),
      tasksChanged(["a1", "local_agent"], ["a2", "local_agent"]),
      result(),
      "answer",
      tasksChanged(["a2", "local_agent"]),
      notification("a1"),
      init(),
      assistant("plan 1"),
      result(),
      "answer",
      tasksChanged(),
      notification("a2"),
      init(),
      assistant("plan 2"),
      result(),
      "answer",
    ]);
    expect(steps[4]!.keepReading).toBe(true);
    expect(steps[10]!.keepReading).toBe(true);
    expect(steps.at(-1)!.keepReading).toBe(false);
  });

  it("only a background shell pending: the answer ends the turn at once", () => {
    const { last } = run([
      init(),
      assistant(),
      tasksChanged(["b1", "local_bash"]),
      taskStarted("b1", "local_bash"),
      result(),
      "answer",
    ]);
    expect(last.keepReading).toBe(false);
  });

  it("waits for a workflow like an agent", () => {
    const { last } = run([
      init(),
      assistant(),
      tasksChanged(["w1", "local_workflow"]),
      taskStarted("w1", "local_workflow", undefined),
      result(),
      "answer",
    ]);
    expect(last.keepReading).toBe(true);
  });

  it("a FOREGROUND agent's notification never holds the turn", () => {
    // CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1: the agent blocks its tool call
    // and reports a notification inside the turn.
    const { last } = run([
      init(),
      assistant(),
      taskStarted("a1", "local_agent", false),
      notification("a1"),
      assistant("done"),
      result(),
      "answer",
    ]);
    expect(last.keepReading).toBe(false);
  });

  it("ignores the stale empty result a killed task leaves ahead of this turn's prompt", () => {
    // Turn N+1's leading messages, verbatim order from the spike.
    const { steps } = run([
      notification("b1", "stopped"),
      lifecycle("queued"),
      { ...result(""), num_turns: 0 },
      lifecycle("started"),
      assistant("TURN2 ANSWER"),
      result("TURN2 ANSWER"),
      "answer",
    ]);
    expect(steps[2]!.ignoreResult).toBe(true);
    expect(steps[5]!.ignoreResult).toBe(false);
    expect(steps.at(-1)!.keepReading).toBe(false);
  });

  it("an empty result before any main-thread message is stale even without lifecycle messages", () => {
    const { steps } = run([result(""), assistant("answer"), result("answer")]);
    expect(steps[0]!.ignoreResult).toBe(true);
    expect(steps[2]!.ignoreResult).toBe(false);
  });

  it("never ignores a non-empty or failed result", () => {
    const { steps } = run([
      result("an answer with no streamed message"),
      { type: "result", subtype: "error_during_execution", is_error: true },
    ]);
    expect(steps.map((step) => step.ignoreResult)).toEqual([false, false]);
  });

  it("a prompt the CLI completes without a model call still ends the turn", () => {
    const { last } = run([
      lifecycle("queued"),
      result(""),
      lifecycle("started"),
      lifecycle("completed"),
    ]);
    expect(last.keepReading).toBe(false);
  });

  it("wants the idle timer only while a settled task's follow-up has not started", () => {
    const { steps } = run([
      init(),
      tasksChanged(["a1", "local_agent"]),
      result(),
      "answer",
      tasksChanged(),
      init(),
      result(),
      "answer",
    ]);
    expect(steps[3]!.wantsIdle).toBe(false); // an agent is pending
    expect(steps[4]!.wantsIdle).toBe(true); // settled, nothing started
    expect(steps[5]!.wantsIdle).toBe(false); // the follow-up started
    expect(steps.at(-1)!.wantsIdle).toBe(false);
  });

  it("the idle event releases a settled task whose follow-up never came", () => {
    const state = helpers.createState({ promptUuid: PROMPT, turnStartedAt: 0 });
    for (const event of [tasksChanged(["a1", "local_agent"]), result()]) {
      helpers.reduce(state, event);
    }
    helpers.reduce(state, { type: "mcpjam-answer", at: 1 });
    helpers.reduce(state, tasksChanged());
    expect(helpers.reduce(state, { type: "mcpjam-idle" }).keepReading).toBe(
      false,
    );
  });
});

describe("background drain controller", () => {
  let events: Array<Record<string, any>>;
  let calls: string[];
  let deps: Record<string, any>;
  let controller: Controller;

  const raws = () =>
    events
      .filter((event) => event.type === "raw")
      .map((event) => event.rawValue);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    events = [];
    calls = [];
    deps = {
      state: helpers.createState({
        promptUuid: PROMPT,
        turnStartedAt: Date.now(),
      }),
      emit: (event: Record<string, unknown>) => events.push(event),
      stopTask: vi.fn(async (taskId: string) => {
        calls.push(`stopTask:${taskId}`);
      }),
      closeInput: vi.fn(() => calls.push("closeInput")),
      abort: vi.fn(() => calls.push("abort")),
      closeOpenStep: vi.fn(() => calls.push("closeOpenStep")),
      hasActiveUserMessages: () => false,
    };
    controller = helpers.createController(deps);
  });

  afterEach(() => {
    controller.clear();
    vi.useRealTimers();
  });

  const startDrain = (...taskIds: string[]) => {
    controller.observe(init());
    controller.observe(
      tasksChanged(
        ...taskIds.map((id) => [id, "local_agent"] as [string, string]),
      ),
    );
    for (const id of taskIds)
      controller.observe(taskStarted(id, "local_agent"));
    controller.observe(result());
    return controller.answer();
  };

  it("narrates background tasks as raw parts, each start once", () => {
    startDrain("a1");
    controller.observe(tasksChanged(["a1", "local_agent"]));
    controller.observe(tasksChanged());
    controller.observe(notification("a1"));
    expect(raws()).toEqual([
      {
        mcpjam: "background-task",
        taskId: "a1",
        toolUseId: "toolu_a1",
        status: "running",
        description: "task a1",
        subagentType: "general-purpose",
        taskType: "local_agent",
      },
      { mcpjam: "drain-notice", reason: "draining" },
      expect.objectContaining({
        mcpjam: "background-task",
        taskId: "a1",
        status: "completed",
      }),
    ]);
    expect(controller.touched).toBe(true);
  });

  it("says nothing on a turn without background work", () => {
    controller.observe(init());
    controller.observe(assistant());
    controller.observe(result());
    expect(controller.answer().keepReading).toBe(false);
    expect(events).toEqual([]);
    expect(controller.touched).toBe(false);
    expect(controller.draining).toBe(false);
  });

  it("idle grace: closes input 15 s after a settled task's follow-up failed to start", async () => {
    startDrain("a1");
    controller.observe(tasksChanged());
    await vi.advanceTimersByTimeAsync(14_999);
    expect(deps.closeInput).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.closeInput).toHaveBeenCalledTimes(1);
    expect(deps.abort).not.toHaveBeenCalled();
    expect(raws().at(-1)).toEqual({ mcpjam: "drain-notice", reason: "idle" });
  });

  it("main-thread messages reset the idle timer; background ones do not", async () => {
    startDrain("a1");
    controller.observe(tasksChanged());
    await vi.advanceTimersByTimeAsync(10_000);
    controller.observe(result());
    await vi.advanceTimersByTimeAsync(10_000);
    controller.observe({
      type: "system",
      subtype: "task_progress",
      task_id: "b1",
    });
    expect(deps.closeInput).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.closeInput).toHaveBeenCalledTimes(1);
  });

  it("no idle close while a follow-up turn is running", async () => {
    startDrain("a1");
    controller.observe(tasksChanged());
    controller.observe(init());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.closeInput).not.toHaveBeenCalled();
  });

  it("cap: stops the pending agents, closes input, then aborts with the step closed first", async () => {
    startDrain("a1", "a2");
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(deps.stopTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(["stopTask:a1", "stopTask:a2", "closeInput"]);
    expect(raws().at(-1)).toEqual({ mcpjam: "drain-notice", reason: "cap" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toEqual([
      "stopTask:a1",
      "stopTask:a2",
      "closeInput",
      "closeOpenStep",
      "closeInput",
      "abort",
    ]);
    expect(controller.stopped).toBe(true);
    expect(controller.state.capped).toBe(true);
  });

  it("cap: a stopTask that never answers still closes input", async () => {
    deps.stopTask.mockImplementation(() => new Promise(() => {}));
    startDrain("a1");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(deps.closeInput).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(deps.closeInput).toHaveBeenCalledTimes(1);
  });

  it("cap: never later than 25 min after the turn started (the lease is 30)", async () => {
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    startDrain("a1");
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(deps.stopTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.stopTask).toHaveBeenCalledTimes(1);
  });

  it("a main-thread approval pauses the cap", async () => {
    startDrain("a1");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    controller.approvalStarted();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(deps.stopTask).not.toHaveBeenCalled();
    controller.approvalEnded();
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 2);
    expect(deps.stopTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(deps.stopTask).toHaveBeenCalledTimes(1);
  });

  it("stop(): notice, step and blocks closed, input closed, CLI aborted, in that order", () => {
    startDrain("a1");
    expect(controller.draining).toBe(true);
    controller.stop("stopped");
    expect(calls).toEqual(["closeOpenStep", "closeInput", "abort"]);
    expect(raws().at(-1)).toEqual({
      mcpjam: "drain-notice",
      reason: "stopped",
    });
    expect(controller.draining).toBe(false);
    controller.stop("again");
    expect(calls).toHaveLength(3);
  });

  it("a background task's failure is a notice", () => {
    startDrain("a1");
    controller.observe({
      type: "system",
      subtype: "task_updated",
      task_id: "a1",
      patch: { status: "failed", error: "boom" },
    });
    expect(raws().at(-1)).toEqual({
      mcpjam: "drain-notice",
      reason: "background task failed: boom",
    });
  });

  describe("approvals", () => {
    it("a background agent's request is classified as background", async () => {
      startDrain("a1");
      await expect(controller.isBackgroundAgentRequest("a1")).resolves.toBe(
        true,
      );
    });

    it("a foreground agent's request is not", async () => {
      controller.observe(taskStarted("f1", "local_agent", false));
      await expect(controller.isBackgroundAgentRequest("f1")).resolves.toBe(
        false,
      );
    });

    it("the main thread's request (no agentID) is not", async () => {
      await expect(
        controller.isBackgroundAgentRequest(undefined),
      ).resolves.toBe(false);
    });

    it("an agent that is backgrounded later becomes background", async () => {
      controller.observe(taskStarted("f1", "local_agent", false));
      controller.observe({
        type: "system",
        subtype: "task_updated",
        task_id: "f1",
        patch: { is_backgrounded: true },
      });
      await expect(controller.isBackgroundAgentRequest("f1")).resolves.toBe(
        true,
      );
    });

    it("waits for a request that outran its task_started", async () => {
      const pending = controller.isBackgroundAgentRequest("a9");
      await vi.advanceTimersByTimeAsync(100);
      controller.observe(taskStarted("a9", "local_agent"));
      await vi.advanceTimersByTimeAsync(20);
      await expect(pending).resolves.toBe(true);
    });

    it("an unknown agent is background only while an agent or workflow is pending (a workflow's agents)", async () => {
      const idle = controller.isBackgroundAgentRequest("x1");
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(idle).resolves.toBe(false);
      // A background shell alone: a nested FOREGROUND subagent (spawn_depth 2,
      // never recorded as foreground) must keep its approval prompt.
      controller.observe(tasksChanged(["b1", "local_bash"]));
      const shellOnly = controller.isBackgroundAgentRequest("x3");
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(shellOnly).resolves.toBe(false);
      controller.observe(
        tasksChanged(["b1", "local_bash"], ["w1", "local_workflow"]),
      );
      const live = controller.isBackgroundAgentRequest("x2");
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(live).resolves.toBe(true);
    });

    const spawnedBy = (parentToolUseId: string, toolUseId: string) => ({
      type: "assistant",
      parent_tool_use_id: parentToolUseId,
      message: {
        content: [
          { type: "tool_use", id: toolUseId, name: "Agent", input: {} },
        ],
      },
    });
    const nestedStarted = (taskId: string, toolUseId: string) => ({
      type: "system",
      subtype: "task_started",
      task_id: taskId,
      task_type: "local_agent",
      tool_use_id: toolUseId,
      is_backgrounded: false,
      spawn_depth: 2,
    });

    it("a nested agent of a FOREGROUND agent keeps its prompt while an unrelated workflow is pending", async () => {
      controller.observe(taskStarted("f1", "local_agent", false));
      controller.observe(spawnedBy("toolu_f1", "toolu_n1"));
      controller.observe(nestedStarted("n1", "toolu_n1"));
      controller.observe(tasksChanged(["w1", "local_workflow"]));
      await expect(controller.isBackgroundAgentRequest("n1")).resolves.toBe(
        false,
      );
    });

    it("a nested agent of a BACKGROUND agent is background, though it reports is_backgrounded: false", async () => {
      startDrain("a1");
      controller.observe(spawnedBy("toolu_a1", "toolu_n2"));
      controller.observe(nestedStarted("n2", "toolu_n2"));
      await expect(controller.isBackgroundAgentRequest("n2")).resolves.toBe(
        true,
      );
      // ...and two levels down.
      controller.observe(spawnedBy("toolu_n2", "toolu_n3"));
      controller.observe({
        ...nestedStarted("n3", "toolu_n3"),
        spawn_depth: 3,
      });
      await expect(controller.isBackgroundAgentRequest("n3")).resolves.toBe(
        true,
      );
    });

    it("a nested agent follows its parent into the background", async () => {
      controller.observe(taskStarted("f1", "local_agent", false));
      controller.observe(spawnedBy("toolu_f1", "toolu_n1"));
      controller.observe(nestedStarted("n1", "toolu_n1"));
      controller.observe({
        type: "system",
        subtype: "task_updated",
        task_id: "f1",
        patch: { is_backgrounded: true },
      });
      await expect(controller.isBackgroundAgentRequest("n1")).resolves.toBe(
        true,
      );
    });

    it("denials carry a message the model can act on", () => {
      expect(helpers.denial).toMatch(/run this in the foreground/);
    });
  });
});

describe("background drain patch", () => {
  it("is idempotent and quotes the vendored bridge", async () => {
    const vendor = await createClaudeCode({ auth: AUTH }).getBootstrap!();
    const source = vendor!.files.find((file) =>
      file.path.endsWith("/bridge.mjs"),
    )!.content;
    // Group D runs after Group B in the real patcher; here the Group B anchor
    // is supplied so the drain applies to the vendor bridge on its own.
    const withGroupB = source.replace(
      `    if (msg.parent_tool_use_id != null) {
      return;
    }`,
      `    if (msg.parent_tool_use_id != null) {
      return;
    }
    if (type === "result" && msg.subtype === "success") {
      emitAssistantTextFallback(msg.result);
    }`,
    );
    const once = patchClaudeCodeBackgroundDrain(withGroupB);
    expect(once).toContain(CLAUDE_CODE_BACKGROUND_DRAIN_MARKER);
    expect(patchClaudeCodeBackgroundDrain(once)).toBe(once);
  });
});

describe("HarnessAgent and the drain's event order", () => {
  it("finish-step → raw → text → finish-step → raw → finish is one successful turn", async () => {
    // What the patched bridge emits for an answer, a background agent's
    // follow-up, and a notice after the last result. No step is opened for a
    // raw part: the agent tolerates it, and its final text stays the answer.
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1 },
    };
    const finishStep = {
      type: "finish-step",
      finishReason: { unified: "stop", raw: "stop" },
      usage,
    };
    const bridgeEvents = [
      { type: "stream-start" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "I started the plan." },
      { type: "text-end", id: "t1" },
      finishStep,
      { type: "raw", rawValue: { mcpjam: "drain-notice", reason: "draining" } },
      {
        type: "raw",
        rawValue: {
          mcpjam: "background-task",
          taskId: "a1",
          status: "completed",
        },
      },
      { type: "text-start", id: "t2" },
      { type: "text-delta", id: "t2", delta: "Here is the plan." },
      { type: "text-end", id: "t2" },
      finishStep,
      { type: "raw", rawValue: { mcpjam: "drain-notice", reason: "idle" } },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        totalUsage: usage,
      },
    ];
    const harness = {
      specificationVersion: "harness-v1",
      harnessId: "fake-claude-code",
      builtinTools: {},
      doStart: async () => ({
        sessionId: "s1",
        isResume: false,
        doPromptTurn: async ({ emit }: { emit: (event: unknown) => void }) => {
          let finish!: () => void;
          const done = new Promise<void>((resolve) => (finish = resolve));
          queueMicrotask(() => {
            for (const event of bridgeEvents) emit(event);
            finish();
          });
          return {
            submitToolResult: async () => {},
            submitToolApproval: async () => {},
            done,
          };
        },
        doDetach: async () => ({}),
        doStop: async () => ({}),
        doDestroy: async () => {},
      }),
    };
    const sandboxSession = {
      defaultWorkingDirectory: "/work",
      restricted() {
        return this;
      },
      run: async () => ({ exitCode: 0, stdout: "/work\n", stderr: "" }),
      readTextFile: async () => null,
      writeTextFile: async () => {},
    };
    const agent = new HarnessAgent({
      harness,
      permissionMode: "allow-all",
    } as any);
    const session = await agent.createSession({ sandboxSession } as any);
    const res = await agent.stream({ session, prompt: "plan it" } as any);
    const parts: Array<{ type: string }> = [];
    for await (const part of res.fullStream as AsyncIterable<{
      type: string;
    }>) {
      parts.push(part);
    }
    expect(parts.some((part) => part.type === "error")).toBe(false);
    expect(parts.at(-1)?.type).toBe("finish");
    expect(parts.filter((part) => part.type === "raw")).toHaveLength(3);
    await expect(res.text).resolves.toContain("Here is the plan.");
  });
});
