import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
const mockGetLatestProgress = vi.fn();
const mockGetTaskCapabilities = vi.fn();
const mockMarkTaskExpired = vi.fn();

vi.mock("@/lib/apis/mcp-tasks-api", () => ({
  listTasks: (...args: unknown[]) => mockListTasks(...args),
  getTask: (...args: unknown[]) => mockGetTask(...args),
  getTasksBatch: (...args: unknown[]) => mockGetTasksBatch(...args),
  getTaskResult: vi.fn(),
  cancelTask: vi.fn(),
  updateTask: vi.fn(),
  getLatestProgress: (...args: unknown[]) => mockGetLatestProgress(...args),
  getTaskCapabilities: (...args: unknown[]) => mockGetTaskCapabilities(...args),
  TaskUnknownOrExpiredError: MockTaskUnknownOrExpiredError,
}));

vi.mock("@/lib/task-tracker", () => ({
  getTrackedTasksForServer: vi.fn().mockReturnValue([
    { taskId: "task-1", serverId: "test-server", wire: "extension" },
    { taskId: "task-2", serverId: "test-server", wire: "extension" },
  ]),
  getTrackedTaskById: vi.fn().mockReturnValue(null),
  markTaskExpired: (...args: unknown[]) => mockMarkTaskExpired(...args),
  clearTrackedTasksForServer: vi.fn(),
  getDismissedTaskIds: vi.fn().mockReturnValue(new Set()),
  dismissTasksForServer: vi.fn(),
  dismissRegistryTasks: vi.fn(),
  // v3 durable scheduling state. `useTaskScheduler` reads the persisted
  // schedule when it first sees a handle (so a reload resumes rather than
  // re-polling immediately) and writes the whole tick back in one batch.
  recordTaskObservation: vi.fn(),
  recordTaskObservations: vi.fn(),
  getTrackedTaskSchedule: vi.fn().mockReturnValue(undefined),
  // Batched restore: one store read per tick for every handle the scheduler
  // has not seen yet, instead of two per handle.
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

const serverConfig = () =>
  ({
    transportType: "stdio",
    command: "node",
    args: ["server.js"],
  }) as MCPServerConfig;

const task = (taskId: string) => ({
  taskId,
  status: "working",
  createdAt: "2026-07-20T00:00:00.000Z",
  lastUpdatedAt: "2026-07-20T00:00:00.000Z",
  ttlMs: null,
});

describe("TasksTab (hosted mode)", () => {
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
    mockGetTasksBatch.mockResolvedValue({
      wire: "extension",
      tasks: [
        { taskId: "task-1", task: task("task-1") },
        { taskId: "task-2", task: task("task-2") },
      ],
    });
  });

  it("reads every tracked task in one batched hosted request", async () => {
    render(<TasksTab serverConfig={serverConfig()} serverName="test-server" />);

    await waitFor(() => {
      expect(screen.getByText("task-1")).toBeInTheDocument();
    });
    expect(screen.getByText("task-2")).toBeInTheDocument();

    expect(mockGetTasksBatch).toHaveBeenCalledWith("test-server", [
      "task-1",
      "task-2",
    ]);
    // The per-task read is the local path and must not run hosted.
    expect(mockGetTask).not.toHaveBeenCalled();
  });

  it("marks only the forgotten entries of a batch unavailable", async () => {
    mockGetTasksBatch.mockResolvedValue({
      wire: "extension",
      tasks: [
        { taskId: "task-1", task: task("task-1") },
        {
          taskId: "task-2",
          error: "unknown",
          code: "task-unknown-or-expired",
        },
      ],
    });

    render(<TasksTab serverConfig={serverConfig()} serverName="test-server" />);

    await waitFor(() => {
      expect(mockMarkTaskExpired).toHaveBeenCalledWith("task-2", "test-server");
    });
    expect(mockMarkTaskExpired).not.toHaveBeenCalledWith(
      "task-1",
      "test-server",
    );
    expect(screen.getByText("task-1")).toBeInTheDocument();
  });

  it("keeps handles when a hosted tick fails outright", async () => {
    // Transient connect failure / older replica returning a structureless 404:
    // nothing is marked unavailable, the next tick simply retries.
    mockGetTasksBatch.mockRejectedValue(new Error("connect failed"));

    render(<TasksTab serverConfig={serverConfig()} serverName="test-server" />);

    await waitFor(() => expect(mockGetTasksBatch).toHaveBeenCalled());
    expect(mockMarkTaskExpired).not.toHaveBeenCalled();
  });

  it("never polls hosted progress", async () => {
    render(<TasksTab serverConfig={serverConfig()} serverName="test-server" />);

    await waitFor(() => expect(mockGetTasksBatch).toHaveBeenCalled());
    expect(mockGetLatestProgress).not.toHaveBeenCalled();
  });
});
