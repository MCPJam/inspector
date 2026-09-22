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

const capturedDialogProps: {
  elicitation?: { requestId: string } | null;
  onResponse?: (
    action: "accept" | "decline" | "cancel",
    parameters?: Record<string, unknown>,
  ) => Promise<void> | void;
} = {};

vi.mock("../ElicitationDialog", () => ({
  ElicitationDialog: (props: any) => {
    capturedDialogProps.elicitation = props.elicitationRequest;
    capturedDialogProps.onResponse = props.onResponse;
    return null;
  },
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

  it("shows a retryable error (not 'not supported') when the capabilities probe fails", async () => {
    mockGetTaskCapabilities.mockRejectedValueOnce(new Error("connect refused"));
    mockGetTaskCapabilities.mockResolvedValue({
      wire: "extension",
      toolCalls: true,
      list: false,
      cancel: true,
      update: true,
      inlineResult: true,
    });

    render(
      <TasksTab serverConfig={createServerConfig()} serverName="test-server" />,
    );

    await waitFor(() => {
      expect(
        screen.getByText("Couldn't check tasks support"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Tasks not supported")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() => {
      expect(
        screen.queryByText("Couldn't check tasks support"),
      ).not.toBeInTheDocument();
    });
    expect(mockGetTaskCapabilities).toHaveBeenCalledTimes(2);
  });

  it("re-probes capabilities when the server connection comes up", async () => {
    // While connecting the probe fails closed to wire "none"…
    mockGetTaskCapabilities.mockResolvedValueOnce({
      wire: "none",
      toolCalls: false,
      list: false,
      cancel: false,
      update: false,
      inlineResult: false,
    });
    // …and succeeds once the connection is actually up.
    mockGetTaskCapabilities.mockResolvedValue({
      wire: "extension",
      toolCalls: true,
      list: false,
      cancel: true,
      update: true,
      inlineResult: true,
    });

    // One stable config object across rerenders, so the only effect trigger
    // under test is the connectionStatus flip.
    const config = createServerConfig();
    const { rerender } = render(
      <TasksTab
        serverConfig={config}
        serverName="test-server"
        connectionStatus="connecting"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Tasks not supported")).toBeInTheDocument();
    });

    rerender(
      <TasksTab
        serverConfig={config}
        serverName="test-server"
        connectionStatus="connected"
      />,
    );

    await waitFor(() => {
      expect(
        screen.queryByText("Tasks not supported"),
      ).not.toBeInTheDocument();
    });
    expect(mockGetTaskCapabilities).toHaveBeenCalledTimes(2);
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
    it("submits a BARE input response value to tasks/update", async () => {
      mockGetTask.mockResolvedValue({
        wire: "extension",
        task: {
          ...extensionTask,
          status: "input_required",
          result: undefined,
          inputRequests: {
            k1: {
              method: "elicitation/create",
              params: {
                message: "need a city",
                requestedSchema: { type: "object", properties: {} },
              },
            },
          },
        },
      });
      mockUpdateTask.mockResolvedValue({});

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
        expect(capturedDialogProps.elicitation?.requestId).toBe("k1");
      });
      await capturedDialogProps.onResponse?.("decline");

      await waitFor(() => {
        expect(mockUpdateTask).toHaveBeenCalledWith("test-server", "ext-1", {
          k1: { action: "decline" },
        });
      });
    });

    it("renders an already-expired handle from the tracker without re-polling", async () => {
      const tracker = await import("@/lib/task-tracker");
      vi.mocked(tracker.getTrackedTasksForServer).mockReturnValue([
        {
          taskId: "ext-1",
          serverId: "test-server",
          wire: "extension",
          createdAt: extensionTask.createdAt,
          expired: true,
        },
      ] as never);

      render(
        <TasksTab
          serverConfig={createServerConfig()}
          serverName="test-server"
        />,
      );
      await waitFor(() => {
        expect(screen.getByText("ext-1")).toBeInTheDocument();
      });
      expect(mockGetTask).not.toHaveBeenCalled();
    });

    it("keeps a tracked handle when a read fails transiently", async () => {
      mockGetTask.mockRejectedValue(new Error("connect ECONNREFUSED"));
      const tracker = await import("@/lib/task-tracker");

      render(
        <TasksTab
          serverConfig={createServerConfig()}
          serverName="test-server"
        />,
      );
      await waitFor(() => {
        expect(mockGetTask).toHaveBeenCalled();
      });
      expect(tracker.untrackTask).not.toHaveBeenCalled();
      expect(tracker.markTaskExpired).not.toHaveBeenCalled();
    });

    it("reads nothing when the resolved wire is none", async () => {
      mockGetTaskCapabilities.mockResolvedValue({
        wire: "none",
        toolCalls: false,
        list: false,
        cancel: false,
        update: false,
        inlineResult: false,
      });
      const tracker = await import("@/lib/task-tracker");

      render(
        <TasksTab
          serverConfig={createServerConfig()}
          serverName="test-server"
        />,
      );
      await waitFor(() => {
        expect(mockGetTaskCapabilities).toHaveBeenCalled();
      });
      expect(mockGetTask).not.toHaveBeenCalled();
      expect(mockListTasks).not.toHaveBeenCalled();
      expect(tracker.untrackTask).not.toHaveBeenCalled();
    });
  });
});
