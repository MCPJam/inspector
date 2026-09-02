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

  it("opens the group that holds the selected session, wherever it sits", () => {
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
        selectedThreadId="s2"
        onSelectThread={() => {}}
        groupUnit="goal"
      />,
    );

    expect(
      screen.getByTestId("swarm-goal-group-goal-b-content"),
    ).toHaveAttribute("data-state", "open");
    expect(screen.getByText("Persona B")).toBeInTheDocument();
  });

  it("opens the holding group when its row arrives on a later page", () => {
    const threadsById = new Map([
      ["s1", thread("s1", "Persona A")],
      ["s2", thread("s2", "Persona B")],
    ]);
    const props = {
      threadsById,
      selectedThreadId: "s2",
      onSelectThread: () => {},
      groupUnit: "goal" as const,
    };

    const { rerender } = render(
      <SwarmSessionsGroupedList
        groups={[group("goal-a", "Goal A", ["s1"])]}
        {...props}
      />,
    );
    expect(screen.queryByTestId("swarm-goal-group-goal-b-content")).toBeNull();

    rerender(
      <SwarmSessionsGroupedList
        groups={[
          group("goal-a", "Goal A", ["s1"]),
          group("goal-b", "Goal B", ["s2"]),
        ]}
        {...props}
      />,
    );

    expect(
      screen.getByTestId("swarm-goal-group-goal-b-content"),
    ).toHaveAttribute("data-state", "open");
  });

  it("labels a null runId as ungrouped and tolerates empty rows", () => {
    const ungrouped: SwarmSessionRunGroup = {
      runId: null,
      latestActivityAt: Date.now(),
      rows: [],
    };

    render(
      <SwarmSessionsGroupedList
        groups={[ungrouped]}
        threadsById={new Map()}
        selectedThreadId={null}
        onSelectThread={() => {}}
        groupUnit="goal"
      />,
    );

    const section = screen.getByTestId("swarm-goal-group-ungrouped");
    expect(within(section).getByText("Ungrouped sessions")).toBeInTheDocument();
    expect(within(section).getByText("0 sessions")).toBeInTheDocument();
  });

  it("skips a row with no loaded thread, and selects the ones it has", async () => {
    const user = userEvent.setup();
    const onSelectThread = vi.fn();

    render(
      <SwarmSessionsGroupedList
        groups={[group("goal-a", "Goal A", ["s1", "missing"])]}
        // `missing` has no entry — a row whose thread page has not landed.
        threadsById={new Map([["s1", thread("s1", "Persona A")]])}
        selectedThreadId={null}
        onSelectThread={onSelectThread}
        groupUnit="goal"
      />,
    );

    const content = screen.getByTestId("swarm-goal-group-goal-a-content");
    expect(within(content).getByText("Persona A")).toBeInTheDocument();
    // The label is shared by both rows; only the loaded one renders.
    expect(within(content).getAllByText("Persona A")).toHaveLength(1);

    await user.click(within(content).getByText("Persona A"));
    expect(onSelectThread).toHaveBeenCalledWith("s1");
  });

  it("falls back to a short id when no label is known for the run", () => {
    render(
      <SwarmSessionsGroupedList
        groups={[group("run-abcdef123456", "Goal A", ["s1"])]}
        threadsById={new Map([["s1", thread("s1", "Persona A")]])}
        selectedThreadId={null}
        onSelectThread={() => {}}
      />,
    );
    expect(screen.getByText("Run 123456")).toBeInTheDocument();
  });

  it("tints group headers so they sit above session rows", () => {
    render(
      <SwarmSessionsGroupedList
        groups={[
          group("goal-a", "Goal A", ["s1"]),
          group("goal-b", "Goal B", ["s2"]),
        ]}
        threadsById={
          new Map([
            ["s1", thread("s1", "Persona A")],
            ["s2", thread("s2", "Persona B")],
          ])
        }
        selectedThreadId={null}
        onSelectThread={() => {}}
        groupUnit="goal"
      />,
    );

    const openTrigger = screen.getByTestId("swarm-goal-group-goal-a-trigger");
    const closedTrigger = screen.getByTestId("swarm-goal-group-goal-b-trigger");
    expect(openTrigger).toHaveClass("bg-muted", "py-1.5");
    expect(closedTrigger).toHaveClass("bg-muted", "py-1.5");
    expect(openTrigger).toHaveAttribute("data-state", "open");
    expect(closedTrigger).toHaveAttribute("data-state", "closed");
    // Paper shows through between muted bars so collapsed groups don't fuse.
    expect(screen.getByTestId("swarm-sessions-grouped-list")).toHaveClass(
      "gap-1",
    );
  });
});
