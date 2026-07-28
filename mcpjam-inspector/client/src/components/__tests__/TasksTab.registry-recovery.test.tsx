/**
 * Registry recovery in the Tasks tab (hosted mode).
 *
 * A cleared profile or a second device has an empty localStorage tracker
 * while the user's tasks keep running server-side. The hosted `/list` reply
 * carries a best-effort `registryTasks` attachment; the tab folds those
 * handles in as placeholders and polls the non-terminal ones — WITHOUT ever
 * writing them into the localStorage tracker, which stays the user's own
 * per-browser store.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";

vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));

const { MockTaskUnknownOrExpiredError } = vi.hoisted(() => ({
  MockTaskUnknownOrExpiredError: class extends Error {
    readonly code = "task-unknown-or-expired";
  },
}));

const mockGetTasksBatch = vi.fn();
const mockGetTask = vi.fn();
const mockListTasks = vi.fn();
const mockGetTaskCapabilities = vi.fn();
const mockGetTrackedTasksForServer = vi.fn();
const mockGetDismissedTaskIds = vi.fn();
const mockMarkTaskExpired = vi.fn();
const mockTrackTask = vi.fn();

vi.mock("@/lib/apis/mcp-tasks-api", () => ({
  listTasks: (...args: unknown[]) => mockListTasks(...args),
  getTask: (...args: unknown[]) => mockGetTask(...args),
  getTasksBatch: (...args: unknown[]) => mockGetTasksBatch(...args),
  getTaskResult: vi.fn(),
  cancelTask: vi.fn(),
  updateTask: vi.fn(),
  getLatestProgress: vi.fn().mockResolvedValue(null),
  getTaskCapabilities: (...args: unknown[]) => mockGetTaskCapabilities(...args),
  TaskUnknownOrExpiredError: MockTaskUnknownOrExpiredError,
}));

vi.mock("@/lib/task-tracker", () => ({
  getTrackedTasksForServer: (...args: unknown[]) =>
    mockGetTrackedTasksForServer(...args),
  getTrackedTaskById: vi.fn().mockReturnValue(null),
  trackTask: (...args: unknown[]) => mockTrackTask(...args),
  markTaskExpired: (...args: unknown[]) => mockMarkTaskExpired(...args),
  clearTrackedTasksForServer: vi.fn(),
  getDismissedTaskIds: (...args: unknown[]) => mockGetDismissedTaskIds(...args),
  dismissTasksForServer: vi.fn(),
  recordTaskObservation: vi.fn(),
  recordTaskObservations: vi.fn(),
  getTrackedTaskSchedule: vi.fn().mockReturnValue(undefined),
  getTrackedTaskRestoreStates: vi.fn().mockReturnValue(new Map()),
  taskIdentity: (t: {
    serverId: string;
    wire: string;
    taskId: string;
    scope?: string;
  }) => `${t.scope ?? ""}\u0000${t.serverId}\u0000${t.wire}\u0000${t.taskId}`,
  recordRespondedInputKeys: vi.fn(),
  getRespondedInputKeys: vi.fn().mockReturnValue([]),
}));

vi.mock("@/hooks/use-task-elicitation", () => ({
  useTaskElicitation: () => ({
    elicitation: null,
    isResponding: false,
    respond: vi.fn(),
  }),
}));

vi.mock("../ElicitationDialog", () => ({ ElicitationDialog: () => null }));

vi.mock("../ui/three-panel-layout", () => ({
  ThreePanelLayout: ({
    sidebar,
    content,
  }: {
    sidebar: React.ReactNode;
    content: React.ReactNode;
  }) => (
    <div>
      <div data-testid="tasks-sidebar">{sidebar}</div>
      <div data-testid="tasks-content">{content}</div>
    </div>
  ),
}));

vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: (props: any) => (
    <div data-testid="json-editor">{JSON.stringify(props.value)}</div>
  ),
}));

import { TasksTab } from "../TasksTab";

const SERVER = "test-server";

const serverConfig = () =>
  ({
    transportType: "stdio",
    command: "node",
    args: ["server.js"],
  }) as MCPServerConfig;

const registryEntry = (
  taskId: string,
  overrides: Partial<{
    wire: "legacy" | "extension";
    lastKnownStatus: string;
  }> = {},
) => ({
  wire: "extension" as const,
  taskId,
  lastKnownStatus: "working" as const,
  createdAt: Date.parse("2026-07-27T00:00:00.000Z"),
  updatedAt: Date.parse("2026-07-27T00:01:00.000Z"),
  lastObservedAt: Date.parse("2026-07-27T00:01:00.000Z"),
  ...overrides,
});

const liveTask = (taskId: string) => ({
  taskId,
  status: "working",
  createdAt: "2026-07-27T00:00:00.000Z",
  lastUpdatedAt: "2026-07-27T00:01:00.000Z",
  ttlMs: null,
});

describe("TasksTab registry recovery (hosted mode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockGetTaskCapabilities.mockResolvedValue({
      wire: "extension",
      toolCalls: true,
      list: false,
      cancel: true,
      update: true,
      inlineResult: true,
    });
    mockGetTrackedTasksForServer.mockReturnValue([]);
    mockGetDismissedTaskIds.mockReturnValue(new Set());
    // Extension wire: the route answers the list locally and the registry
    // attachment rides on it.
    mockListTasks.mockResolvedValue({
      tasks: [],
      wire: "extension",
      registryTasks: [],
    });
    mockGetTasksBatch.mockResolvedValue({ wire: "extension", tasks: [] });
  });

  it("recovers a running task into the poll set when the tracker is empty", async () => {
    mockListTasks.mockResolvedValue({
      tasks: [],
      wire: "extension",
      registryTasks: [registryEntry("recovered-1")],
    });
    mockGetTasksBatch.mockResolvedValue({
      wire: "extension",
      tasks: [{ taskId: "recovered-1", task: liveTask("recovered-1") }],
    });

    render(<TasksTab serverConfig={serverConfig()} serverName={SERVER} />);

    await waitFor(() => {
      expect(screen.getByText("recovered-1")).toBeInTheDocument();
    });
    // On the extension wire the ONE recovery /list call is the only way this
    // handle could have been discovered at all.
    expect(mockListTasks).toHaveBeenCalledTimes(1);
    expect(mockGetTasksBatch).toHaveBeenCalledWith(SERVER, ["recovered-1"]);
    // ...and NOTHING is written into the localStorage tracker for it: the
    // registry entry lives in a mount-local ref only.
    expect(mockTrackTask).not.toHaveBeenCalled();
    expect(localStorage.getItem("mcp-tracked-tasks")).toBeNull();
  });

  it("dedupes against the tracker — a tracked handle is polled once", async () => {
    mockGetTrackedTasksForServer.mockReturnValue([
      { taskId: "task-1", serverId: SERVER, wire: "extension" },
    ]);
    mockListTasks.mockResolvedValue({
      tasks: [],
      wire: "extension",
      registryTasks: [registryEntry("task-1"), registryEntry("recovered-2")],
    });
    mockGetTasksBatch.mockResolvedValue({
      wire: "extension",
      tasks: [
        { taskId: "task-1", task: liveTask("task-1") },
        { taskId: "recovered-2", task: liveTask("recovered-2") },
      ],
    });

    render(<TasksTab serverConfig={serverConfig()} serverName={SERVER} />);

    await waitFor(() => {
      expect(screen.getByText("recovered-2")).toBeInTheDocument();
    });
    // task-1 appears once in the batch (the tracker's copy), not twice.
    expect(mockGetTasksBatch).toHaveBeenCalledWith(SERVER, [
      "task-1",
      "recovered-2",
    ]);
    expect(screen.getAllByText("task-1")).toHaveLength(1);
  });

  it("filters registry entries the user dismissed here", async () => {
    mockGetDismissedTaskIds.mockReturnValue(new Set(["recovered-1"]));
    mockListTasks.mockResolvedValue({
      tasks: [],
      wire: "extension",
      registryTasks: [registryEntry("recovered-1")],
    });

    render(<TasksTab serverConfig={serverConfig()} serverName={SERVER} />);

    await waitFor(() => expect(mockListTasks).toHaveBeenCalled());
    expect(mockGetTasksBatch).not.toHaveBeenCalled();
    expect(screen.queryByText("recovered-1")).not.toBeInTheDocument();
  });

  it("ignores entries recorded under the other wire", async () => {
    // A legacy-wire row on an extension-wire connection is a different task
    // identity; polling it here would ask the wrong wire about it.
    mockListTasks.mockResolvedValue({
      tasks: [],
      wire: "extension",
      registryTasks: [registryEntry("legacy-1", { wire: "legacy" })],
    });

    render(<TasksTab serverConfig={serverConfig()} serverName={SERVER} />);

    await waitFor(() => expect(mockListTasks).toHaveBeenCalled());
    expect(mockGetTasksBatch).not.toHaveBeenCalled();
    expect(screen.queryByText("legacy-1")).not.toBeInTheDocument();
  });

  it("renders terminal registry entries as placeholders and never polls them", async () => {
    mockListTasks.mockResolvedValue({
      tasks: [],
      wire: "extension",
      registryTasks: [
        registryEntry("done-1", { lastKnownStatus: "completed" }),
      ],
    });

    render(<TasksTab serverConfig={serverConfig()} serverName={SERVER} />);

    await waitFor(() => {
      expect(screen.getByText("done-1")).toBeInTheDocument();
    });
    expect(mockGetTasksBatch).not.toHaveBeenCalled();
    expect(mockTrackTask).not.toHaveBeenCalled();
  });

  it("drops a recovered handle the server no longer knows", async () => {
    mockListTasks.mockResolvedValue({
      tasks: [],
      wire: "extension",
      registryTasks: [registryEntry("recovered-1")],
    });
    mockGetTasksBatch.mockResolvedValue({
      wire: "extension",
      tasks: [
        {
          taskId: "recovered-1",
          error: "unknown",
          code: "task-unknown-or-expired",
        },
      ],
    });

    render(<TasksTab serverConfig={serverConfig()} serverName={SERVER} />);

    await waitFor(() => {
      // `markTaskExpired` is a no-op for ids the tracker never held; calling
      // it is harmless and keeps the unknown-task path uniform.
      expect(mockMarkTaskExpired).toHaveBeenCalledWith(
        "recovered-1",
        SERVER,
      );
    });
    // The registry handle is dropped: no row, no further polling of it.
    expect(screen.queryByText("recovered-1")).not.toBeInTheDocument();
  });

  it("re-arms the one recovery read on a manual refresh", async () => {
    render(<TasksTab serverConfig={serverConfig()} serverName={SERVER} />);

    await waitFor(() => expect(mockListTasks).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.click(screen.getByTitle("Refresh tasks"));
    });

    await waitFor(() => expect(mockListTasks).toHaveBeenCalledTimes(2));
  });
});
