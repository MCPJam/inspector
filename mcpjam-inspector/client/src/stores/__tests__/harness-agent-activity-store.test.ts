import { beforeEach, describe, expect, it } from "vitest";
import {
  HARNESS_AGENT_STEPS_MAX,
  useHarnessAgentActivityStore,
} from "../harness-agent-activity-store";

const call = (toolUseId: string, parentToolUseId = "toolu_agent") => ({
  kind: "tool-call" as const,
  rootToolUseId: "toolu_agent",
  parentToolUseId,
  toolUseId,
  toolName: "Read",
  input: { file_path: `/work/${toolUseId}.ts` },
});
const result = (toolUseId: string, isError = false) => ({
  kind: "tool-result" as const,
  rootToolUseId: "toolu_agent",
  parentToolUseId: "toolu_agent",
  toolUseId,
  isError,
  ...(isError ? { error: "boom" } : {}),
});
const activity = () =>
  useHarnessAgentActivityStore.getState().activities.toolu_agent;

describe("harness agent activity store", () => {
  beforeEach(() => {
    useHarnessAgentActivityStore.setState({ activities: {}, dropped: {} });
  });

  it("collects steps under the Agent call and settles them by id", () => {
    const { applyStep } = useHarnessAgentActivityStore.getState();
    applyStep(call("a"));
    applyStep(call("b", "toolu_nested"));
    applyStep(result("a"));
    applyStep(result("b", true));
    expect(activity()?.steps).toEqual([
      {
        toolUseId: "a",
        toolName: "Read",
        input: { file_path: "/work/a.ts" },
        nested: false,
        status: "done",
      },
      {
        toolUseId: "b",
        toolName: "Read",
        input: { file_path: "/work/b.ts" },
        nested: true,
        status: "error",
        error: "boom",
      },
    ]);
  });

  it("ignores a repeated call and a result for a step it never saw", () => {
    const { applyStep } = useHarnessAgentActivityStore.getState();
    applyStep(call("a"));
    const before = useHarnessAgentActivityStore.getState();
    applyStep(call("a"));
    applyStep(result("unknown"));
    expect(useHarnessAgentActivityStore.getState()).toBe(before);
  });

  it("caps the list and counts what it dropped", () => {
    const { applyStep } = useHarnessAgentActivityStore.getState();
    for (let i = 0; i < HARNESS_AGENT_STEPS_MAX + 3; i++)
      applyStep(call(`s${i}`));
    expect(activity()?.steps).toHaveLength(HARNESS_AGENT_STEPS_MAX);
    expect(activity()?.steps[0]?.toolUseId).toBe("s3");
    expect(useHarnessAgentActivityStore.getState().dropped.toolu_agent).toBe(3);
  });

  it("records a background agent's status by its tool call; notices are not tasks", () => {
    const { applyBackgroundTask } = useHarnessAgentActivityStore.getState();
    applyBackgroundTask({ kind: "notice", reason: "draining" });
    applyBackgroundTask({ kind: "keepalive" });
    applyBackgroundTask({ kind: "task", taskId: "t1", status: "running" });
    expect(useHarnessAgentActivityStore.getState().activities).toEqual({});
    applyBackgroundTask({
      kind: "task",
      taskId: "t1",
      toolUseId: "toolu_agent",
      status: "running",
    });
    applyBackgroundTask({
      kind: "task",
      taskId: "t1",
      toolUseId: "toolu_agent",
      status: "completed",
    });
    expect(activity()).toEqual({ steps: [], backgroundStatus: "completed" });
  });
});
