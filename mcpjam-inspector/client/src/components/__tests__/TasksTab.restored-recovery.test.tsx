/**
 * Restored terminal handles and their ONE recovery read.
 *
 * On the extension wire a task's result rides INLINE on `tasks/get` — there is
 * no `tasks/result` to fetch it from later — while durable storage keeps only
 * the handle's status. So a handle restored as `completed` is a status with
 * nothing behind it, and the engine keeps owing it one read.
 *
 * The failure these tests pin is that the read is owed but nothing is left
 * running to perform it: the tab decides whether to keep its poll loop armed
 * from the DISPLAYED rows, and the row says `completed`. Two ways in, and the
 * second needs no failure at all — a stored `nextPollAt` in the future is
 * simply not due on the first tick.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";

const { MockTaskUnknownOrExpiredError } = vi.hoisted(() => ({
  MockTaskUnknownOrExpiredError: class extends Error {
    readonly code = "task-unknown-or-expired";
  },
}));

const mockGetTask = vi.fn();
const mockListTasks = vi.fn();
const mockGetTaskCapabilities = vi.fn();
const mockGetLatestProgress = vi.fn();
const mockGetTrackedTasksForServer = vi.fn();
const mockGetTrackedTaskRestoreStates = vi.fn();

vi.mock("@/lib/apis/mcp-tasks-api", () => ({
  listTasks: (...args: unknown[]) => mockListTasks(...args),
  getTask: (...args: unknown[]) => mockGetTask(...args),
  getTasksBatch: vi.fn(),
  getTaskResult: vi.fn(),
  cancelTask: vi.fn(),
  updateTask: vi.fn(),
  getLatestProgress: (...args: unknown[]) => mockGetLatestProgress(...args),
  getTaskCapabilities: (...args: unknown[]) => mockGetTaskCapabilities(...args),
  TaskUnknownOrExpiredError: MockTaskUnknownOrExpiredError,
}));

vi.mock("@/lib/task-tracker", () => ({
  getTrackedTasksForServer: (...args: unknown[]) =>
    mockGetTrackedTasksForServer(...args),
  getTrackedTaskById: vi.fn().mockReturnValue(null),
  untrackTask: vi.fn(),
  markTaskExpired: vi.fn(),
  clearTrackedTasksForServer: vi.fn(),
  getDismissedTaskIds: vi.fn().mockReturnValue(new Set()),
  dismissTasksForServer: vi.fn(),
  dismissRegistryTasks: vi.fn(),
  recordTaskObservation: vi.fn(),
  recordTaskObservations: vi.fn(),
  getTrackedTaskSchedule: vi.fn().mockReturnValue(undefined),
  // The durable schedule the scheduler seeds each newly-seen handle from —
  // this is what makes a restored handle due later rather than immediately.
  getTrackedTaskRestoreStates: (...args: unknown[]) =>
    mockGetTrackedTaskRestoreStates(...args),
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
import { MAX_RECOVERY_READ_ATTEMPTS } from "@/hooks/use-task-scheduler";

const SERVER = "test-server";
const TASK_ID = "ext-1";
const CREATED_AT = "2026-07-27T00:00:00.000Z";

const serverConfig = () =>
  ({
    transportType: "stdio",
    command: "node",
    args: ["server.js"],
  }) as MCPServerConfig;

/** Matches the mocked `taskIdentity` above, for a scope-less identity. */
const restoreKey = (taskId: string) =>
  `\u0000${SERVER}\u0000extension\u0000${taskId}`;

/** The handle as the tracker remembers it after a reload: terminal, no result. */
const trackedTerminal = () => [
  {
    taskId: TASK_ID,
    serverId: SERVER,
    wire: "extension",
    createdAt: CREATED_AT,
    status: "completed",
  },
];

const restoreState = (nextPollAt: number) =>
  new Map([
    [
      restoreKey(TASK_ID),
      {
        nextPollAt,
        lastObservedAt: nextPollAt - 1_000,
        pollIntervalMs: 1_000,
        ttlMs: null,
        status: "completed",
        respondedInputKeys: [],
      },
    ],
  ]);

const completedWithResult = {
  taskId: TASK_ID,
  status: "completed",
  createdAt: CREATED_AT,
  lastUpdatedAt: "2026-07-27T00:01:00.000Z",
  ttlMs: 60_000,
  pollIntervalMs: 1_000,
  result: { content: [{ type: "text", text: "inline done" }] },
};

const autoRefreshOn = () =>
  screen.getByRole("switch").getAttribute("aria-checked") === "true";

/** Runs the fake clock forward, flushing the promises each tick starts. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("TasksTab restored-terminal recovery", () => {
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
    mockGetTrackedTasksForServer.mockReturnValue(trackedTerminal());
    mockGetTrackedTaskRestoreStates.mockReturnValue(new Map());
    mockGetLatestProgress.mockResolvedValue(null);
    mockGetTask.mockResolvedValue({
      wire: "extension",
      task: completedWithResult,
    });
  });

  it("keeps auto-refresh armed for a recovery read that is not due until later", async () => {
    // No failure anywhere: the stored floor simply has not elapsed. The row
    // renders terminal on the first tick, so a decision made from the rows
    // alone stops the loop before the read it is waiting for can happen.
    mockGetTrackedTaskRestoreStates.mockReturnValue(
      restoreState(Date.now() + 30_000)
    );

    render(<TasksTab serverConfig={serverConfig()} serverName={SERVER} />);

    await waitFor(() => {
      expect(screen.getByText(TASK_ID)).toBeInTheDocument();
    });
    // Not due, so nothing was read — which is exactly the state the old
    // decision mistook for "finished".
    expect(mockGetTask).not.toHaveBeenCalled();
    await waitFor(() => expect(autoRefreshOn()).toBe(true));
  });

  it("stays armed after a failed recovery read and retries on a later tick", async () => {
    vi.useFakeTimers();
    mockGetTrackedTaskRestoreStates.mockReturnValue(
      restoreState(Date.now() - 1)
    );
    mockGetTask.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    render(<TasksTab serverConfig={serverConfig()} serverName={SERVER} />);

    await advance(0);
    expect(mockGetTask).toHaveBeenCalledTimes(1);
    // The read failed and the handle backed off — the loop has to survive the
    // failure or the backoff it just recorded is never honored.
    expect(autoRefreshOn()).toBe(true);
    expect(screen.queryByText("inline done")).not.toBeInTheDocument();

    // The loop the failure did not stop performs the retry on a later tick.
    for (let i = 0; i < 8 && mockGetTask.mock.calls.length < 2; i += 1) {
      await advance(1_000);
    }
    await advance(1_000);
    expect(mockGetTask).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByText(TASK_ID));
    await advance(0);
    expect(screen.getByText("inline done")).toBeInTheDocument();
    // ...and with nothing left owed, the loop settles.
    expect(autoRefreshOn()).toBe(false);
  });

  it("stops after the attempt bound, says so, and still retries on demand", async () => {
    vi.useFakeTimers();
    mockGetTrackedTaskRestoreStates.mockReturnValue(
      restoreState(Date.now() - 1)
    );
    mockGetTask.mockRejectedValue(new Error("connect ECONNREFUSED"));

    render(<TasksTab serverConfig={serverConfig()} serverName={SERVER} />);
    await advance(0);

    // Run well past the bound: the loop must stop itself, not be stopped by
    // the test running out of ticks.
    for (let i = 0; i < 40; i += 1) await advance(2_000);

    expect(mockGetTask).toHaveBeenCalledTimes(MAX_RECOVERY_READ_ATTEMPTS);
    expect(autoRefreshOn()).toBe(false);
    expect(
      screen.getByText(/Stopped retrying automatically/)
    ).toBeInTheDocument();

    // Going idle is only acceptable because the user can still get it back.
    mockGetTask.mockResolvedValue({
      wire: "extension",
      task: completedWithResult,
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle("Refresh tasks"));
    });
    await advance(0);

    expect(mockGetTask).toHaveBeenCalledTimes(MAX_RECOVERY_READ_ATTEMPTS + 1);
    fireEvent.click(screen.getByText(TASK_ID));
    await advance(0);
    expect(screen.getByText("inline done")).toBeInTheDocument();
  });

  it("does not keep auto-refresh on once the result has been recovered", async () => {
    mockGetTrackedTaskRestoreStates.mockReturnValue(
      restoreState(Date.now() - 1)
    );

    render(<TasksTab serverConfig={serverConfig()} serverName={SERVER} />);

    await waitFor(() => expect(mockGetTask).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByText(TASK_ID));
    await screen.findByText("inline done");

    // The read is spent: a genuinely finished handle owes nothing, so it must
    // not hold the timer open.
    await waitFor(() => expect(autoRefreshOn()).toBe(false));
    expect(
      screen.queryByText(/Could not read back/)
    ).not.toBeInTheDocument();
  });
});
