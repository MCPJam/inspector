import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { HarnessAgentActivity } from "../harness-agent-activity";
import { useHarnessAgentActivityStore } from "@/stores/harness-agent-activity-store";

const step = (
  toolUseId: string,
  toolName: string,
  input: Record<string, string>,
) => ({
  kind: "tool-call" as const,
  rootToolUseId: "toolu_agent",
  parentToolUseId: "toolu_agent",
  toolUseId,
  toolName,
  input,
});

describe("HarnessAgentActivity", () => {
  beforeEach(() => {
    useHarnessAgentActivityStore.setState({ activities: {}, dropped: {} });
  });

  it("renders nothing for a call with no activity", () => {
    const { container } = render(
      <HarnessAgentActivity
        toolCallId="toolu_agent"
        toolState="output-available"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a running background agent's steps as they arrive, then folds when it is done", () => {
    const store = useHarnessAgentActivityStore.getState();
    // A background agent's call already has its output: the task status,
    // not the call's state, says it is still working.
    store.applyBackgroundTask({
      kind: "task",
      taskId: "t1",
      toolUseId: "toolu_agent",
      status: "running",
    });
    store.applyStep(step("r1", "Read", { file_path: "/work/src/app.ts" }));
    store.applyStep(step("b1", "Bash", { command: "npm test" }));
    render(
      <HarnessAgentActivity
        toolCallId="toolu_agent"
        toolState="output-available"
        description="Plan the feature"
      />,
    );
    expect(screen.getByText("Plan the feature")).toBeInTheDocument();
    expect(screen.getByText("working · 2 steps")).toBeInTheDocument();
    const steps = screen.getAllByTestId("harness-agent-step");
    expect(steps.map((row) => row.textContent)).toEqual([
      "Readapp.ts",
      "Runnpm test",
    ]);
    expect(screen.getByText("app.ts")).toHaveAttribute(
      "title",
      "/work/src/app.ts",
    );

    act(() => {
      store.applyStep({
        kind: "tool-result",
        rootToolUseId: "toolu_agent",
        parentToolUseId: "toolu_agent",
        toolUseId: "b1",
        isError: true,
        error: "exit 1",
      });
      store.applyBackgroundTask({
        kind: "task",
        taskId: "t1",
        toolUseId: "toolu_agent",
        status: "completed",
      });
    });
    expect(screen.getByText("2 steps")).toBeInTheDocument();
    expect(screen.queryAllByTestId("harness-agent-step")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getAllByTestId("harness-agent-step")).toHaveLength(2);
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("a foreground agent works until its call has output", () => {
    useHarnessAgentActivityStore
      .getState()
      .applyStep(step("g1", "Grep", { pattern: "TODO" }));
    const { rerender } = render(
      <HarnessAgentActivity
        toolCallId="toolu_agent"
        toolState="input-available"
      />,
    );
    expect(screen.getByText("Subagent")).toBeInTheDocument();
    expect(screen.getByText("working · 1 step")).toBeInTheDocument();
    expect(screen.getByLabelText("Running")).toBeInTheDocument();
    rerender(
      <HarnessAgentActivity
        toolCallId="toolu_agent"
        toolState="output-error"
      />,
    );
    expect(screen.getByText("1 step · failed")).toBeInTheDocument();
  });

  it("a user's choice to fold it holds while it works", () => {
    useHarnessAgentActivityStore
      .getState()
      .applyStep(step("g1", "Glob", { pattern: "**/*.md" }));
    render(
      <HarnessAgentActivity
        toolCallId="toolu_agent"
        toolState="input-available"
      />,
    );
    expect(screen.getAllByTestId("harness-agent-step")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryAllByTestId("harness-agent-step")).toHaveLength(0);
    act(() => {
      useHarnessAgentActivityStore
        .getState()
        .applyStep(step("g2", "Read", { file_path: "/work/a.md" }));
    });
    expect(screen.queryAllByTestId("harness-agent-step")).toHaveLength(0);
    expect(screen.getByText("working · 2 steps")).toBeInTheDocument();
  });
});
