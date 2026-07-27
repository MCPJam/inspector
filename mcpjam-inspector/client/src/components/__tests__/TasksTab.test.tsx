import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TasksTab } from "../TasksTab";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";

const { mockJsonEditor, MockTaskUnknownOrExpiredError } = vi.hoisted(() => ({
  mockJsonEditor: vi.fn((props: any) => (
    <div data-testid="json-editor">{JSON.stringify(props.value)}</div>
  )),
  MockTaskUnknownOrExpiredError: class extends Error {
    readonly code = "task-unknown-or-expired";
  },
}));

const mockListTasks = vi.fn();
const mockGetTask = vi.fn();
const mockGetTaskResult = vi.fn();
const mockCancelTask = vi.fn();
const mockGetLatestProgress = vi.fn();
const mockGetTaskCapabilities = vi.fn();
const mockUpdateTask = vi.fn();

vi.mock("@/lib/apis/mcp-tasks-api", () => ({
  listTasks: (...args: unknown[]) => mockListTasks(...args),
  getTask: (...args: unknown[]) => mockGetTask(...args),
  getTaskResult: (...args: unknown[]) => mockGetTaskResult(...args),
  cancelTask: (...args: unknown[]) => mockCancelTask(...args),
  getLatestProgress: (...args: unknown[]) => mockGetLatestProgress(...args),
  getTaskCapabilities: (...args: unknown[]) => mockGetTaskCapabilities(...args),
  updateTask: (...args: unknown[]) => mockUpdateTask(...args),
  TaskUnknownOrExpiredError: MockTaskUnknownOrExpiredError,
}));

vi.mock("@/lib/task-tracker", () => ({
  getTrackedTasksForServer: vi.fn().mockReturnValue([]),
  getTrackedTaskById: vi.fn().mockReturnValue(null),
  untrackTask: vi.fn(),
  markTaskExpired: vi.fn(),
  clearTrackedTasksForServer: vi.fn(),
  getDismissedTaskIds: vi.fn().mockReturnValue(new Set()),
  dismissTasksForServer: vi.fn(),
}));

vi.mock("@/hooks/use-task-elicitation", () => ({
  useTaskElicitation: () => ({
    elicitation: null,
    isResponding: false,
    respond: vi.fn(),
  }),
}));

vi.mock("../ElicitationDialog", () => ({
  ElicitationDialog: () => null,
}));

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
  JsonEditor: (props: any) => mockJsonEditor(props),
}));

describe("TasksTab", () => {
  const createServerConfig = (): MCPServerConfig =>
    ({
      transportType: "stdio",
      command: "node",
      args: ["server.js"],
    }) as MCPServerConfig;

  const completedTask = {
    taskId: "task-1",
    status: "completed",
    createdAt: "2026-03-19T00:00:00.000Z",
    lastUpdatedAt: "2026-03-19T00:01:00.000Z",
    ttl: null,
    statusMessage: null,
    pollInterval: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockJsonEditor.mockClear();
    mockGetTaskCapabilities.mockResolvedValue({
      wire: "legacy",
      toolCalls: false,
      list: true,
      cancel: false,
      update: false,
      inlineResult: false,
    });
    mockListTasks.mockResolvedValue({ tasks: [completedTask] });
    mockGetTask.mockResolvedValue({ wire: "legacy", task: completedTask });
    mockCancelTask.mockResolvedValue(completedTask);
    mockGetLatestProgress.mockResolvedValue(null);
  });

  it("renders task tool-result envelopes as structured JSON", async () => {
    mockGetTaskResult.mockResolvedValue({
      content: [
        {
          type: "text",
          text: '{"users":[{"id":"1"}],"hasNextPage":false}',
        },
      ],
    });

    render(
      <TasksTab serverConfig={createServerConfig()} serverName="test-server" />,
    );

    await waitFor(() => {
      expect(screen.getByText("task-1")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("task-1"));

    await waitFor(() => {
      expect(mockGetTaskResult).toHaveBeenCalledWith("test-server", "task-1");
    });

    await waitFor(() => {
      expect(mockJsonEditor).toHaveBeenCalled();
    });

    expect(mockJsonEditor.mock.calls.at(-1)?.[0]).toMatchObject({
      value: { users: [{ id: "1" }], hasNextPage: false },
    });
  });

  it("keeps plain text task results as text", async () => {
    mockGetTaskResult.mockResolvedValue("Task complete");

    render(
      <TasksTab serverConfig={createServerConfig()} serverName="test-server" />,
    );

    await waitFor(() => {
      expect(screen.getByText("task-1")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("task-1"));

    await waitFor(() => {
      expect(screen.getByText("Task complete")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("json-editor")).not.toBeInTheDocument();
  });

  it("preserves empty-string pending requests as text", async () => {
    const inputRequiredTask = {
      ...completedTask,
      status: "input_required",
    };

    mockListTasks.mockResolvedValue({ tasks: [inputRequiredTask] });
    mockGetTask.mockResolvedValue(inputRequiredTask);
    mockGetTaskResult.mockResolvedValue("");

    const { container } = render(
      <TasksTab serverConfig={createServerConfig()} serverName="test-server" />,
    );

    await waitFor(() => {
      expect(screen.getByText("task-1")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("task-1"));

    await waitFor(() => {
      const pre = container.querySelector("pre");
      expect(pre).not.toBeNull();
      expect(pre?.textContent).toBe("");
    });

    expect(screen.queryByTestId("json-editor")).not.toBeInTheDocument();
  });

  it("hides the tasks surface when the negotiated wire is none", async () => {
    mockGetTaskCapabilities.mockResolvedValue({
      wire: "none",
      toolCalls: false,
      list: false,
      cancel: false,
      update: false,
      inlineResult: false,
    });

    render(
      <TasksTab serverConfig={createServerConfig()} serverName="test-server" />,
    );

    await waitFor(() => {
      expect(screen.getByText("Tasks not supported")).toBeInTheDocument();
    });
    expect(mockListTasks).not.toHaveBeenCalled();
  });

  describe("extension wire", () => {
    const extensionSupport = {
      wire: "extension",
      toolCalls: true,
      list: false,
      cancel: true,
      update: true,
      inlineResult: true,
    };

    const extensionTask = {
      taskId: "ext-1",
      status: "completed",
      createdAt: "2026-07-27T00:00:00.000Z",
      lastUpdatedAt: "2026-07-27T00:01:00.000Z",
      ttlMs: 60000,
      pollIntervalMs: 1000,
      result: { content: [{ type: "text", text: "inline done" }] },
    };

    beforeEach(async () => {
      mockGetTaskCapabilities.mockResolvedValue(extensionSupport);
      const tracker = await import("@/lib/task-tracker");
      vi.mocked(tracker.getTrackedTasksForServer).mockReturnValue([
        {
          taskId: "ext-1",
          serverId: "test-server",
          wire: "extension",
          createdAt: extensionTask.createdAt,
        },
      ] as never);
      mockGetTask.mockResolvedValue({
        wire: "extension",
        task: extensionTask,
      });
    });

    it("hydrates tracked tasks and renders the inline result without tasks/result", async () => {
      render(
        <TasksTab
          serverConfig={createServerConfig()}
          serverName="test-server"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("ext-1")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText("ext-1"));

      await waitFor(() => {
        expect(screen.getByText("inline done")).toBeInTheDocument();
      });
      expect(mockListTasks).not.toHaveBeenCalled();
      expect(mockGetTaskResult).not.toHaveBeenCalled();
    });

    it("marks a task expired instead of untracking it on -32602", async () => {
      mockGetTask.mockRejectedValue(
        new MockTaskUnknownOrExpiredError("unknown task"),
      );
      const tracker = await import("@/lib/task-tracker");

      render(
        <TasksTab
          serverConfig={createServerConfig()}
          serverName="test-server"
        />,
      );

      await waitFor(() => {
        expect(tracker.markTaskExpired).toHaveBeenCalledWith(
          "ext-1",
          "test-server",
        );
      });
      expect(tracker.untrackTask).not.toHaveBeenCalled();
    });

    it("shows cancellation as cooperative after the empty ack", async () => {
      mockGetTask.mockResolvedValue({
        wire: "extension",
        task: { ...extensionTask, status: "working" },
      });
      mockCancelTask.mockResolvedValue({ wire: "extension", task: null });

      render(
        <TasksTab
          serverConfig={createServerConfig()}
          serverName="test-server"
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("ext-1")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText("ext-1"));

      const cancelButton = await screen.findByRole("button", {
        name: /cancel/i,
      });
      fireEvent.click(cancelButton);

      await waitFor(() => {
        expect(screen.getByText(/Cancellation requested/i)).toBeInTheDocument();
      });
    });
  });
});
