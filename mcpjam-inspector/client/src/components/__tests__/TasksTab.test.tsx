import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TasksTab } from "../TasksTab";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";

const { mockJsonEditor } = vi.hoisted(() => ({
  mockJsonEditor: vi.fn((props: any) => (
    <div data-testid="json-editor">{JSON.stringify(props.value)}</div>
  )),
}));

const mockListTasks = vi.fn();
const mockGetTask = vi.fn();
const mockGetTaskResult = vi.fn();
const mockCancelTask = vi.fn();
const mockGetLatestProgress = vi.fn();
const mockGetTaskCapabilities = vi.fn();

vi.mock("@/lib/apis/mcp-tasks-api", () => ({
  listTasks: (...args: unknown[]) => mockListTasks(...args),
  getTask: (...args: unknown[]) => mockGetTask(...args),
  getTaskResult: (...args: unknown[]) => mockGetTaskResult(...args),
  cancelTask: (...args: unknown[]) => mockCancelTask(...args),
  getLatestProgress: (...args: unknown[]) => mockGetLatestProgress(...args),
  getTaskCapabilities: (...args: unknown[]) => mockGetTaskCapabilities(...args),
}));

vi.mock("@/lib/task-tracker", () => ({
  getTrackedTasksForServer: vi.fn().mockReturnValue([]),
  getTrackedTaskById: vi.fn().mockReturnValue(null),
  untrackTask: vi.fn(),
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
      supportsToolCalls: false,
      supportsList: true,
      supportsCancel: false,
    });
    mockListTasks.mockResolvedValue({ tasks: [completedTask] });
    mockGetTask.mockResolvedValue(completedTask);
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
});
