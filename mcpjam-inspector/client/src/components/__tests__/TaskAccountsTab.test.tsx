import userEvent from "@testing-library/user-event";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskAccountsTab } from "../TaskAccountsTab";
import {
  setTrackedTaskOwner,
  setTrackedTaskScope,
  trackTask,
} from "@/lib/task-tracker";

const state = vi.hoisted(() => ({
  accounts: [
    { connectionId: "a", label: "A", isDefault: true },
    { connectionId: "b", label: "B", isDefault: false },
  ],
  revision: 0,
  listener: (() => {}) as () => void,
}));
vi.mock("@/hooks/use-hosted-oauth-connections", () => ({
  useHostedOAuthConnections: () => ({
    connections: state.accounts,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/lib/apis/web/context", () => ({
  subscribeApiContext: (listener: () => void) => {
    state.listener = listener;
    return () => {};
  },
  getApiContextRevision: () => state.revision,
  tryResolveProjectServer: () => ({ projectId: "project", serverId: "server" }),
}));
vi.mock("../TasksTab", () => ({
  TasksTab: ({ taskTarget }: { taskTarget?: unknown }) => (
    <output data-testid="target">{JSON.stringify(taskTarget ?? null)}</output>
  ),
}));

function target() {
  return JSON.parse(screen.getByTestId("target").textContent!);
}
function renderView() {
  return render(
    <TaskAccountsTab
      serverName="Display"
      serverConfig={{ transportType: "http", url: "https://server.test/mcp" }}
    />,
  );
}

describe("Task account view", () => {
  beforeEach(() => {
    localStorage.clear();
    setTrackedTaskScope("project");
    setTrackedTaskOwner("project", "owner");
    state.revision = 0;
    state.accounts = [
      { connectionId: "a", label: "A", isDefault: true },
      { connectionId: "b", label: "B", isDefault: false },
    ];
  });
  it("opens the saved task's account and does not follow later default changes", () => {
    trackTask({
      serverId: "server",
      taskId: "same",
      connectionId: "b",
      wire: "extension",
      createdAt: new Date().toISOString(),
    });
    const view = renderView();
    expect(target().connectionId).toBe("b");
    state.accounts = [
      { connectionId: "a", label: "A", isDefault: false },
      { connectionId: "b", label: "B", isDefault: true },
    ];
    view.rerender(<TaskAccountsTab serverName="Display" />);
    expect(target().connectionId).toBe("b");
    state.accounts = [{ connectionId: "a", label: "A", isDefault: true }];
    view.rerender(<TaskAccountsTab serverName="Display" />);
    expect(target().connectionId).toBe("b");
  });
  it("lets the user choose a specific account", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole("combobox", { name: "Task account" }));
    await user.click(screen.getByRole("option", { name: "B", exact: true }));
    expect(target().connectionId).toBe("b");
  });
  it("remounts on an owner change without displaying the previous owner's target", () => {
    trackTask({
      serverId: "server",
      taskId: "same",
      connectionId: "b",
      wire: "extension",
      createdAt: new Date().toISOString(),
    });
    renderView();
    expect(target().connectionId).toBe("b");
    act(() => {
      setTrackedTaskOwner("project", "other-owner");
      state.revision++;
      state.listener();
    });
    expect(target()).toBeNull();
  });
});
