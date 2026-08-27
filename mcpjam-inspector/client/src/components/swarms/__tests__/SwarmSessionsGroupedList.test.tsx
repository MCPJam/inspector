import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SwarmSessionsGroupedList } from "../SwarmSessionsGroupedList";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";
import type { SwarmSessionRunGroup } from "@/lib/swarm-api";

vi.mock("@mcpjam/design-system/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function thread(id: string, label: string): SharedChatThread {
  return {
    _id: id,
    sourceType: "swarm",
    chatSessionId: `cs-${id}`,
    messageCount: 3,
    startedAt: 0,
    lastActivityAt: Date.now(),
    visitorDisplayName: label,
  } as SharedChatThread;
}

function group(
  runId: string,
  label: string,
  rowIds: string[],
): SwarmSessionRunGroup {
  return {
    runId,
    latestActivityAt: Date.now(),
    rows: rowIds.map((id) => ({
      id,
      chatSessionId: `cs-${id}`,
      projectId: "p1",
      hostId: "h1",
      journeyRefId: runId,
      startedAt: 0,
      visitorDisplayName: label,
    })),
  };
}

describe("SwarmSessionsGroupedList", () => {
  it("expands only the first group by default", () => {
    const groups = [
      group("goal-a", "Goal A", ["s1"]),
      group("goal-b", "Goal B", ["s2"]),
      group("goal-c", "Goal C", ["s3"]),
    ];
    const threadsById = new Map([
      ["s1", thread("s1", "Persona A")],
      ["s2", thread("s2", "Persona B")],
      ["s3", thread("s3", "Persona C")],
    ]);
    const runLabels = new Map([
      ["goal-a", "Create rollup view for resource allocation"],
      ["goal-b", "Set up blocker escalation automation"],
      ["goal-c", "Set up automated workflow for new project intake"],
    ]);

    render(
      <SwarmSessionsGroupedList
        groups={groups}
        threadsById={threadsById}
        selectedThreadId={null}
        onSelectThread={() => {}}
        runLabels={runLabels}
        groupUnit="goal"
      />,
    );

    expect(
      screen.getByTestId("swarm-goal-group-goal-a-content"),
    ).toHaveAttribute("data-state", "open");
    expect(
      screen.getByTestId("swarm-goal-group-goal-b-content"),
    ).toHaveAttribute("data-state", "closed");
    expect(
      screen.getByTestId("swarm-goal-group-goal-c-content"),
    ).toHaveAttribute("data-state", "closed");

    expect(
      within(screen.getByTestId("swarm-goal-group-goal-a-content")).getByText(
        "Persona A",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Persona B")).toBeNull();
    expect(screen.queryByText("Persona C")).toBeNull();
  });

  it("toggles a collapsed group open on trigger click", async () => {
    const user = userEvent.setup();
    const groups = [
      group("goal-a", "Goal A", ["s1"]),
      group("goal-b", "Goal B", ["s2"]),
    ];
    const threadsById = new Map([
      ["s1", thread("s1", "Persona A")],
      ["s2", thread("s2", "Persona B")],
    ]);

    render(
      <SwarmSessionsGroupedList
        groups={groups}
        threadsById={threadsById}
        selectedThreadId={null}
        onSelectThread={() => {}}
        groupUnit="goal"
      />,
    );

    await user.click(screen.getByTestId("swarm-goal-group-goal-b-trigger"));

    expect(
      screen.getByTestId("swarm-goal-group-goal-b-content"),
    ).toHaveAttribute("data-state", "open");
    expect(screen.getByText("Persona B")).toBeInTheDocument();
  });
});
