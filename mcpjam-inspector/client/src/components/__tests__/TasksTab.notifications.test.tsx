/**
 * Extension task notifications in the Tasks tab (local persistent connections).
 *
 * The tab owns the `taskIds` member of the desired subscription interests
 * (tracked ∧ extension wire ∧ not dismissed ∧ not terminal) and merges it over
 * the panel-owned members via fetch-merge-post. A delivered
 * `notifications/tasks` is a POLL-NOW HINT only: it triggers exactly one
 * immediate `tasks/get` for that task — `tasks/get` stays the source of truth,
 * the notification params are never written into state. Hosted mode
 * (reconnect-per-op, no persistent stream) posts no `taskIds` and opens no
 * stream; polling remains fully sufficient everywhere.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";

const { MockTaskUnknownOrExpiredError } = vi.hoisted(() => ({
  MockTaskUnknownOrExpiredError: class extends Error {
    readonly code = "task-unknown-or-expired";
  },
}));

const mockGetTask = vi.fn();
const mockGetTasksBatch = vi.fn();
const mockListTasks = vi.fn();
const mockGetTaskCapabilities = vi.fn();
const mockGetTrackedTasksForServer = vi.fn();
const mockGetDismissedTaskIds = vi.fn();
const mockFetchSubscriptionState = vi.fn();
const mockSetDesired = vi.fn();
const mockIsHostedMode = vi.fn(() => false);

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

vi.mock("@/lib/apis/mcp-subscriptions-api", () => ({
  fetchSubscriptionState: (...args: unknown[]) =>
    mockFetchSubscriptionState(...args),
  setDesiredSubscriptionInterests: (...args: unknown[]) =>
    mockSetDesired(...args),
  cancelSubscriptionStream: vi.fn(),
}));

vi.mock("@/lib/apis/mode-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isHostedMode: () => mockIsHostedMode(),
}));

vi.mock("@/lib/task-tracker", () => ({
  getTrackedTasksForServer: (...args: unknown[]) =>
    mockGetTrackedTasksForServer(...args),
  getTrackedTaskById: vi.fn().mockReturnValue(null),
  markTaskExpired: vi.fn(),
  clearTrackedTasksForServer: vi.fn(),
  getDismissedTaskIds: (...args: unknown[]) => mockGetDismissedTaskIds(...args),
  dismissTasksForServer: vi.fn(),
  dismissRegistryTasks: vi.fn(),
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

const trackedWorking = (taskId: string) => ({
  taskId,
  serverId: SERVER,
  wire: "extension" as const,
  createdAt: "2026-07-28T00:00:00.000Z",
  status: "working",
});

const workingTask = (taskId: string) => ({
  taskId,
  status: "working",
  createdAt: "2026-07-28T00:00:00.000Z",
  lastUpdatedAt: "2026-07-28T00:01:00.000Z",
  ttlMs: null,
});

/** jsdom has no EventSource; the tab treats an absent one as "keep polling". */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  closed = false;
  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

function emit(event: unknown) {
  for (const es of FakeEventSource.instances) {
    if (!es.closed) es.onmessage?.({ data: JSON.stringify(event) });
  }
}

const tasksNotification = (taskId: string) => ({
  type: "subscription_notification",
  serverId: SERVER,
  notification: {
    method: "notifications/tasks",
    kind: "tasks",
    taskId,
    localSubscriptionId: "local-1",
    at: Date.now(),
  },
});

const bridgeState = (desired: Record<string, unknown>) => ({
  serverId: SERVER,
  era: "modern",
  supportsListen: true,
  supportsTaskDeclaredListen: true,
  desired,
  streams: [],
  notifications: [],
  rejectedNotifications: [],
});

describe("TasksTab extension task notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    FakeEventSource.instances = [];
    Object.assign(globalThis, { EventSource: FakeEventSource });
    mockIsHostedMode.mockReturnValue(false);
    mockGetTaskCapabilities.mockResolvedValue({
      wire: "extension",
      toolCalls: true,
      list: false,
      cancel: true,
      update: true,
      inlineResult: true,
    });
    mockGetTrackedTasksForServer.mockReturnValue([trackedWorking("t-1")]);
    mockGetDismissedTaskIds.mockReturnValue(new Set());
    mockGetTask.mockImplementation(async (_server: string, taskId: string) => ({
      wire: "extension",
      task: workingTask(taskId),
    }));
    // Panel-owned interests already on the bridge: the tab must MERGE its
    // taskIds over them, never replace them.
    mockFetchSubscriptionState.mockResolvedValue(
      bridgeState({ toolsListChanged: true }),
    );
    mockSetDesired.mockResolvedValue(bridgeState({ toolsListChanged: true }));
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).EventSource;
  });

  it("posts the active tracked set as taskIds, merged over panel-owned interests", async () => {
    render(<TasksTab serverConfig={serverConfig()} serverName={SERVER} />);

    await waitFor(() => expect(mockSetDesired).toHaveBeenCalledTimes(1));
    expect(mockSetDesired).toHaveBeenCalledWith(SERVER, {
      toolsListChanged: true,
      taskIds: ["t-1"],
    });
    // Fetch-merge-post: the current bridge state was read first.
    expect(mockFetchSubscriptionState).toHaveBeenCalledWith(SERVER);
  });

  it("does not re-post an unchanged active set", async () => {
    render(<TasksTab serverConfig={serverConfig()} serverName={SERVER} />);

    await waitFor(() => expect(mockSetDesired).toHaveBeenCalledTimes(1));
    // Give any queued debounce a chance to fire wrongly.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(mockSetDesired).toHaveBeenCalledTimes(1);
  });

  it("a tasks notification triggers exactly one immediate tasks/get for that task", async () => {
    render(<TasksTab serverConfig={serverConfig()} serverName={SERVER} />);
    await waitFor(() => {
      expect(screen.getByText("t-1")).toBeInTheDocument();
    });
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const baseline = mockGetTask.mock.calls.length;

    await act(async () => {
      emit(tasksNotification("t-1"));
    });

    await waitFor(() => {
      expect(mockGetTask.mock.calls.length).toBe(baseline + 1);
    });
    expect(mockGetTask).toHaveBeenLastCalledWith(SERVER, "t-1");
    // One notification, ONE read — nothing else trailing behind it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(mockGetTask.mock.calls.length).toBe(baseline + 1);
  });

  it("ignores a notification for a task this browser does not track", async () => {
    render(<TasksTab serverConfig={serverConfig()} serverName={SERVER} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const baseline = mockGetTask.mock.calls.length;

    await act(async () => {
      emit(tasksNotification("someone-elses-task"));
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    expect(mockGetTask.mock.calls.length).toBe(baseline);
  });

  it("ignores a notification for a dismissed handle (no polling resurrection)", async () => {
    // `getDismissedTaskIds` unions the tracker's dismissals with the
    // dismissed-registry store, so this covers both: a dismissed handle is
    // excluded from the interest set AND a late notification for it must not
    // restart reads the user asked to stop seeing.
    mockGetDismissedTaskIds.mockReturnValue(new Set(["t-1"]));
    render(<TasksTab serverConfig={serverConfig()} serverName={SERVER} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const baseline = mockGetTask.mock.calls.length;

    await act(async () => {
      emit(tasksNotification("t-1"));
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    expect(mockGetTask.mock.calls.length).toBe(baseline);
    // ...and the dismissed id was never posted as an interest either.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    for (const call of mockSetDesired.mock.calls) {
      expect(call[1].taskIds ?? []).not.toContain("t-1");
    }
  });

  it("hosted mode posts no taskIds and opens no notification stream", async () => {
    mockIsHostedMode.mockReturnValue(true);
    mockListTasks.mockResolvedValue({
      tasks: [],
      wire: "extension",
      registryTasks: [],
    });
    mockGetTasksBatch.mockResolvedValue({ wire: "extension", tasks: [] });

    render(<TasksTab serverConfig={serverConfig()} serverName={SERVER} />);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(mockSetDesired).not.toHaveBeenCalled();
    expect(mockFetchSubscriptionState).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
