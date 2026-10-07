import { describe, expect, it } from "vitest";
import {
  buildHarnessSessionDataPart,
  harnessBackgroundTaskInfoFromRaw,
  harnessSubagentStepFromRaw,
  isHarnessBackgroundTaskDataPart,
  isHarnessSessionDataPart,
  isHarnessResetDataPart,
  isHarnessSubagentStepDataPart,
} from "../harness-session";

describe("isHarnessSessionDataPart", () => {
  const part = (workdir: unknown) => ({
    type: "data-harness-session",
    data: { workdir },
  });

  it("accepts an absolute workdir", () => {
    expect(
      isHarnessSessionDataPart(part("/home/user/claude-code-abc")),
    ).toBe(true);
  });

  it("rejects relative and whitespace-padded workdirs (cwd would drift)", () => {
    expect(isHarnessSessionDataPart(part(""))).toBe(false);
    expect(isHarnessSessionDataPart(part("./project"))).toBe(false);
    expect(isHarnessSessionDataPart(part("project"))).toBe(false);
    expect(isHarnessSessionDataPart(part(" /home/user "))).toBe(false);
    expect(isHarnessSessionDataPart(part("   "))).toBe(false);
    expect(isHarnessSessionDataPart(part(42))).toBe(false);
  });

  it("rejects wrong type/shape", () => {
    expect(isHarnessSessionDataPart(null)).toBe(false);
    expect(isHarnessSessionDataPart({ type: "data-other", data: {} })).toBe(
      false,
    );
    expect(
      isHarnessSessionDataPart({ type: "data-harness-session" }),
    ).toBe(false);
  });
});

describe("isHarnessResetDataPart", () => {
  it("accepts only the known categorical reasons", () => {
    for (const reason of [
      "sandbox-replaced",
      "legacy-cold-resume",
      "resume-failed",
      "runtime-changed",
    ]) {
      expect(
        isHarnessResetDataPart({ type: "data-harness-reset", data: { reason } }),
      ).toBe(true);
    }
    expect(
      isHarnessResetDataPart({
        type: "data-harness-reset",
        data: { reason: "sandbox-id-e2b-123" },
      }),
    ).toBe(false);
  });
});

describe("background-task parts (the Claude Code background drain)", () => {
  const taskRaw = {
    mcpjam: "background-task",
    taskId: "agent-1",
    toolUseId: "toolu_1",
    status: "running",
    description: "plan 1",
    subagentType: "general-purpose",
    taskType: "local_agent",
  };

  it("reads the bridge's task and notice raws", () => {
    expect(harnessBackgroundTaskInfoFromRaw(taskRaw)).toEqual({
      kind: "task",
      taskId: "agent-1",
      toolUseId: "toolu_1",
      status: "running",
      description: "plan 1",
      subagentType: "general-purpose",
      taskType: "local_agent",
    });
    expect(
      harnessBackgroundTaskInfoFromRaw({
        mcpjam: "drain-notice",
        reason: "draining",
      }),
    ).toEqual({ kind: "notice", reason: "draining" });
  });

  it("drops empty optional fields and rejects incomplete or foreign raws", () => {
    expect(
      harnessBackgroundTaskInfoFromRaw({
        mcpjam: "background-task",
        taskId: "agent-1",
        status: "completed",
        description: "",
      }),
    ).toEqual({ kind: "task", taskId: "agent-1", status: "completed" });
    for (const raw of [
      undefined,
      "background-task",
      { mcpjam: "background-task", taskId: "agent-1" },
      { mcpjam: "background-task", status: "running" },
      { mcpjam: "drain-notice", reason: "" },
      { method: "turn/completed" },
    ]) {
      expect(harnessBackgroundTaskInfoFromRaw(raw)).toBeUndefined();
    }
  });

  it("every part the server writes passes the client's guard", () => {
    // The server wraps `harnessBackgroundTaskInfoFromRaw`'s output (and its
    // own keepalive) as the part's `data`; the guard must accept all of it.
    const infos = [
      harnessBackgroundTaskInfoFromRaw(taskRaw),
      harnessBackgroundTaskInfoFromRaw({
        mcpjam: "background-task",
        taskId: "agent-1",
        status: "completed",
      }),
      harnessBackgroundTaskInfoFromRaw({
        mcpjam: "drain-notice",
        reason: "follow-up",
      }),
      { kind: "keepalive" as const },
    ];
    for (const data of infos) {
      expect(
        isHarnessBackgroundTaskDataPart({
          type: "data-harness-background-task",
          data,
        }),
      ).toBe(true);
    }
  });

  it("the guard rejects other parts and malformed data", () => {
    for (const part of [
      { type: "data-harness-session", data: { kind: "keepalive" } },
      { type: "data-harness-background-task" },
      { type: "data-harness-background-task", data: { kind: "task" } },
      { type: "data-harness-background-task", data: { kind: "notice" } },
      { type: "data-harness-background-task", data: { kind: "other" } },
    ]) {
      expect(isHarnessBackgroundTaskDataPart(part)).toBe(false);
    }
  });
});

describe("subagent-step parts (a Claude Code subagent's work)", () => {
  const ids = {
    rootToolUseId: "toolu_agent",
    parentToolUseId: "toolu_nested",
    toolUseId: "toolu_read",
  };

  it("reads the bridge's tool-call and tool-result raws", () => {
    expect(
      harnessSubagentStepFromRaw({
        mcpjam: "subagent-step",
        kind: "tool-call",
        ...ids,
        toolName: "Read",
        input: { file_path: "/work/a.ts", limit: 20 },
      }),
    ).toEqual({
      kind: "tool-call",
      ...ids,
      toolName: "Read",
      input: { file_path: "/work/a.ts", limit: 20 },
    });
    expect(
      harnessSubagentStepFromRaw({
        mcpjam: "subagent-step",
        kind: "tool-result",
        ...ids,
        isError: true,
        error: "File does not exist.",
      }),
    ).toEqual({
      kind: "tool-result",
      ...ids,
      isError: true,
      error: "File does not exist.",
    });
  });

  it("re-bounds what crossed the process boundary", () => {
    const step = harnessSubagentStepFromRaw({
      mcpjam: "subagent-step",
      kind: "tool-call",
      ...ids,
      toolName: "Write",
      input: {
        file_path: "/work/a.ts",
        content: "x".repeat(10_000),
        nested: { deep: true },
        ...Object.fromEntries(
          Array.from({ length: 20 }, (_, i) => [`k${i}`, i]),
        ),
      },
    });
    expect(step?.kind).toBe("tool-call");
    const input = (step as { input: Record<string, unknown> }).input;
    expect(Object.keys(input)).toHaveLength(8);
    expect(input).not.toHaveProperty("nested");
    expect(String(input.content).length).toBeLessThanOrEqual(301);
  });

  it("rejects incomplete or foreign raws", () => {
    for (const raw of [
      undefined,
      { mcpjam: "subagent-step", kind: "tool-call", ...ids },
      { mcpjam: "subagent-step", kind: "text", ...ids, text: "hi" },
      { mcpjam: "subagent-step", kind: "tool-result", toolUseId: "t" },
      { mcpjam: "background-task", taskId: "a", status: "running" },
      { method: "item/started" },
    ]) {
      expect(harnessSubagentStepFromRaw(raw)).toBeUndefined();
    }
  });

  it("every part the server writes passes the client's guard, and nothing else does", () => {
    for (const data of [
      harnessSubagentStepFromRaw({
        mcpjam: "subagent-step",
        kind: "tool-call",
        ...ids,
        toolName: "Glob",
      }),
      harnessSubagentStepFromRaw({
        mcpjam: "subagent-step",
        kind: "tool-result",
        ...ids,
      }),
    ]) {
      expect(
        isHarnessSubagentStepDataPart({
          type: "data-harness-subagent-step",
          data,
        }),
      ).toBe(true);
    }
    for (const part of [
      { type: "data-harness-background-task", data: { kind: "keepalive" } },
      { type: "data-harness-subagent-step" },
      {
        type: "data-harness-subagent-step",
        data: { kind: "tool-call", ...ids },
      },
      { type: "data-harness-subagent-step", data: { kind: "other", ...ids } },
    ]) {
      expect(isHarnessSubagentStepDataPart(part)).toBe(false);
    }
  });
});

describe("which machine a harness turn ran on", () => {
  it("is `personal` unless the turn ran on the conversation's box", () => {
    expect(
      buildHarnessSessionDataPart({
        workdir: "/home/user/w",
        disposable: false,
      }).data.machine,
    ).toBe("personal");
    expect(
      buildHarnessSessionDataPart({ workdir: "/home/user/w", disposable: true })
        .data.machine,
    ).toBe("disposable");
  });

  it("builds a part the client's own guard accepts", () => {
    for (const disposable of [false, true]) {
      expect(
        isHarnessSessionDataPart(
          buildHarnessSessionDataPart({ workdir: "/home/user/w", disposable }),
        ),
      ).toBe(true);
    }
  });

  it("accepts a part with no machine (a server that predates the field)", () => {
    expect(
      isHarnessSessionDataPart({
        type: "data-harness-session",
        data: { workdir: "/home/user/w" },
      }),
    ).toBe(true);
  });

  it("rejects a machine it does not know", () => {
    expect(
      isHarnessSessionDataPart({
        type: "data-harness-session",
        data: { workdir: "/home/user/w", machine: "somewhere-else" },
      }),
    ).toBe(false);
  });
});
