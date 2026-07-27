import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { isHostedMode } from "@/lib/apis/mode-client";
import {
  HOSTED_TASK_BATCH_LIMIT,
  hostedPollIntervalMs,
} from "@/shared/hosted-tasks";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import { ThreePanelLayout } from "./ui/three-panel-layout";
import {
  ListTodo,
  RefreshCw,
  ChevronRight,
  Square,
  Trash2,
  AlertCircle,
  PanelLeftClose,
} from "lucide-react";
import { EmptyState } from "./ui/empty-state";
import { JsonEditor } from "@/components/ui/json-editor";
import { extractDisplayFromToolResult } from "@/components/chat-v2/shared/tool-result-text";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import {
  Task,
  listTasks,
  getTask,
  getTaskResult,
  updateTask,
  cancelTask,
  getLatestProgress,
  getTasksBatch,
  getTaskCapabilities,
  TaskUnknownOrExpiredError,
  type ProgressEvent,
  type TasksSupport,
} from "@/lib/apis/mcp-tasks-api";
import {
  getTrackedTasksForServer,
  getTrackedTaskById,
  markTaskExpired,
  clearTrackedTasksForServer,
  getDismissedTaskIds,
  dismissTasksForServer,
} from "@/lib/task-tracker";
import { Switch } from "@mcpjam/design-system/switch";
import { Input } from "@mcpjam/design-system/input";
import { Tooltip, TooltipTrigger, TooltipContent } from "@mcpjam/design-system/tooltip";
import { Progress } from "@mcpjam/design-system/progress";
import { TaskInlineProgress } from "./tasks/TaskInlineProgress";
import {
  STATUS_CONFIG,
  expiredPlaceholderTask,
  formatRelativeTime,
  isTerminalStatus,
  normalizeTask,
  type NormalizedTask,
  type TaskDisplayStatus,
} from "@/lib/task-utils";
import { useTaskElicitation } from "@/hooks/use-task-elicitation";
import { ElicitationDialog } from "./ElicitationDialog";
import type { DialogElicitation } from "./ToolsTab";
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";
import { buildTasksSnapshot } from "@/lib/webmcp/review-surface-snapshots";

const POLL_INTERVAL_STORAGE_KEY = "mcp-inspector-tasks-poll-interval";
const DEFAULT_POLL_INTERVAL = 3000;

interface TasksTabProps {
  serverConfig?: MCPServerConfig;
  serverName?: string;
  isActive?: boolean;
}

/** Unknown statuses should never reach the UI, but must not crash it. */
function statusConfigFor(status: TaskDisplayStatus) {
  return STATUS_CONFIG[status] ?? STATUS_CONFIG.working;
}

function TaskStatusIcon({ status }: { status: TaskDisplayStatus }) {
  const config = statusConfigFor(status);
  const Icon = config.icon;
  return (
    <Icon
      className={`h-4 w-4 ${config.color} ${config.animate ? "animate-spin" : ""}`}
    />
  );
}

function formatDate(isoString: string): string {
  try {
    return new Date(isoString).toLocaleString();
  } catch {
    return isoString;
  }
}

export function TasksTab({
  serverConfig,
  serverName,
  isActive = true,
}: TasksTabProps) {
  const [tasks, setTasks] = useState<NormalizedTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const [taskResult, setTaskResult] = useState<unknown>(null);
  const [pendingRequest, setPendingRequest] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [fetchingTasks, setFetchingTasks] = useState(false);
  const [error, setError] = useState<string>("");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // Track if user explicitly disabled auto-refresh (to avoid re-enabling)
  const userDisabledAutoRefresh = useRef(false);
  const [userPollInterval, setUserPollInterval] = useState<number>(() => {
    const stored = localStorage.getItem(POLL_INTERVAL_STORAGE_KEY);
    if (stored) {
      const parsed = parseInt(stored, 10);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return DEFAULT_POLL_INTERVAL;
  });
  // Track if user has explicitly overridden the server suggestion
  const [userOverride, setUserOverride] = useState<number | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  // Task capabilities from server (MCP Tasks spec 2025-11-25)
  // undefined = not yet fetched, null = server doesn't support, object = loaded
  const [taskCapabilities, setTaskCapabilities] = useState<
    TasksSupport | null | undefined
  >(undefined);
  // Extension cancellation is cooperative: after the empty ack the task may
  // keep working, complete, or be purged. Stop auto-polling and say so.
  const [cancellationRequested, setCancellationRequested] = useState<
    Set<string>
  >(new Set());
  const [submittingInput, setSubmittingInput] = useState(false);
  // `inputRequests` is a re-sent snapshot and `tasks/update` is eventually
  // consistent, so an answered key can come back on the next poll. Remember
  // what was answered per task and never re-prompt for it.
  const [answeredInputKeys, setAnsweredInputKeys] = useState<
    Map<string, Set<string>>
  >(new Map());
  // Track the task ID for pending input_required requests to avoid race conditions
  const pendingInputRequestTaskIdRef = useRef<string | null>(null);

  // Collapsible sidebar state
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);

  const wire = taskCapabilities?.wire ?? "none";
  const isExtensionWire = wire === "extension";
  // Hosted reads go through ephemeral per-request connections: batch them and
  // never poll faster than the floor, because each tick is a full connect.
  const hosted = isHostedMode();

  const selectedTask = useMemo(() => {
    return tasks.find((t) => t.taskId === selectedTaskId) ?? null;
  }, [tasks, selectedTaskId]);
  const pendingRequestDisplay = extractDisplayFromToolResult(pendingRequest);
  const taskResultDisplay = extractDisplayFromToolResult(taskResult);

  // Check if any task is in a non-terminal state (working, input_required, pending)
  const hasActiveTasks = useMemo(() => {
    return tasks.some((t) => !isTerminalStatus(t.status));
  }, [tasks]);

  // Auto-enable polling when there are active tasks, unless user explicitly disabled
  useEffect(() => {
    if (hasActiveTasks && !userDisabledAutoRefresh.current) {
      setAutoRefresh(true);
    } else if (!hasActiveTasks) {
      setAutoRefresh(false);
      // Reset user preference when all tasks complete
      userDisabledAutoRefresh.current = false;
    }
  }, [hasActiveTasks]);

  // Per MCP Tasks spec: "Requestors SHOULD respect the pollInterval provided in responses"
  // Calculate server-suggested poll interval from non-terminal tasks
  // Use the minimum pollInterval from active tasks to not miss updates
  const serverSuggestedPollInterval = useMemo(() => {
    const activeTasksWithPollInterval = tasks
      .filter((t) => !isTerminalStatus(t.status) && t.pollInterval)
      .map((t) => t.pollInterval!);

    if (activeTasksWithPollInterval.length === 0) return null;
    return Math.min(...activeTasksWithPollInterval);
  }, [tasks]);

  // Subscribe to task-related elicitations via SSE
  // Per MCP Tasks spec (2025-11-25): when a task is in input_required status,
  // the server sends elicitations with relatedTaskId in the metadata
  const {
    elicitation: taskElicitation,
    isResponding: elicitationResponding,
    respond: respondToElicitation,
  } = useTaskElicitation(isActive);

  // Convert hook elicitation to DialogElicitation format for the dialog
  const legacyDialogElicitation: DialogElicitation | null = taskElicitation
    ? {
        requestId: taskElicitation.requestId,
        message: taskElicitation.message,
        schema: taskElicitation.schema as Record<string, unknown> | undefined,
        timestamp: taskElicitation.timestamp,
      }
    : null;

  // Extension wire: `inputRequests` is a keyed snapshot re-sent on every poll.
  // Only elicitation entries are answerable here (sampling/roots are rejected,
  // matching the MRTR collector's Decision-8 rule).
  const extensionInputRequest = useMemo(() => {
    if (!isExtensionWire || selectedTask?.status !== "input_required") {
      return null;
    }
    const answered = answeredInputKeys.get(selectedTask.taskId);
    const entries = Object.entries(selectedTask.inputRequests ?? {});
    for (const [key, value] of entries) {
      if (answered?.has(key)) continue;
      const request = value as {
        method?: string;
        params?: { message?: string; requestedSchema?: unknown };
      };
      if (request?.method === "elicitation/create") {
        return { key, request };
      }
    }
    return null;
  }, [isExtensionWire, selectedTask, answeredInputKeys]);

  /** Keys in the current snapshot this UI cannot answer (sampling/roots). */
  const unanswerableInputCount = useMemo(() => {
    if (!isExtensionWire || selectedTask?.status !== "input_required") return 0;
    return Object.values(selectedTask.inputRequests ?? {}).filter(
      (value) =>
        (value as { method?: string })?.method !== "elicitation/create",
    ).length;
  }, [isExtensionWire, selectedTask]);

  const extensionDialogElicitation: DialogElicitation | null =
    extensionInputRequest
      ? {
          requestId: extensionInputRequest.key,
          message: extensionInputRequest.request.params?.message ?? "",
          schema: extensionInputRequest.request.params?.requestedSchema as
            | Record<string, unknown>
            | undefined,
          timestamp: selectedTask?.lastUpdatedAt ?? "",
          origin: "mrtr",
          serverId: serverName,
        }
      : null;

  // Priority: user override > server suggestion > user default
  // Per MCP Tasks spec: "Requestors SHOULD respect the pollInterval provided in responses"
  // But we allow user to explicitly override if they want
  const requestedPollInterval =
    userOverride ?? serverSuggestedPollInterval ?? userPollInterval;
  const pollInterval = hosted
    ? hostedPollIntervalMs(
        requestedPollInterval,
        serverSuggestedPollInterval ?? undefined,
      )
    : requestedPollInterval;
  const usingServerInterval =
    serverSuggestedPollInterval !== null && userOverride === null;

  const handlePollIntervalChange = useCallback(
    (value: string) => {
      const parsed = parseInt(value, 10);
      if (!isNaN(parsed) && parsed >= 500) {
        // Set override if server is suggesting an interval
        if (serverSuggestedPollInterval !== null) {
          setUserOverride(parsed);
        }
        // Always save to localStorage as the user's preferred fallback
        setUserPollInterval(parsed);
        localStorage.setItem(POLL_INTERVAL_STORAGE_KEY, String(parsed));
      }
    },
    [serverSuggestedPollInterval],
  );

  // Clear override when server suggestion goes away (tasks complete)
  // so next time server suggests, we use that value again
  useEffect(() => {
    if (serverSuggestedPollInterval === null) {
      setUserOverride(null);
    }
  }, [serverSuggestedPollInterval]);

  const handleClearTasks = useCallback(() => {
    if (!serverName) return;
    // Dismiss all current tasks so they won't show after refresh
    const taskIds = tasks.map((t) => t.taskId);
    dismissTasksForServer(serverName, taskIds);
    clearTrackedTasksForServer(serverName);
    setTasks([]);
    setSelectedTaskId("");
    setTaskResult(null);
    setPendingRequest(null);
  }, [serverName, tasks]);

  const fetchTasks = useCallback(async () => {
    if (!serverName) return;
    // No tasks wire (older version pinned, or no capability): every request
    // would 400. Keep the tracked handles — they become valid again when the
    // user pins back to a tasks-capable version.
    if (taskCapabilities && taskCapabilities.wire === "none") {
      setTasks([]);
      return;
    }

    setFetchingTasks(true);
    setError("");

    try {
      // Get dismissed task IDs to filter them out
      const dismissedIds = getDismissedTaskIds(serverName);

      // Per MCP Tasks spec (2025-11-25): clients SHOULD only call tasks/list
      // if the server declares tasks.list capability
      let serverResult: { tasks: Task[] } = { tasks: [] };
      let serverTaskIds = new Set<string>();

      // The extension has no tasks/list: the tracker is the list.
      if (taskCapabilities?.list) {
        // Server supports tasks/list - fetch from server
        serverResult = await listTasks(serverName);
        serverTaskIds = new Set(serverResult.tasks.map((t) => t.taskId));
      }

      // Get locally tracked tasks and fetch their current status
      const trackedTasks = getTrackedTasksForServer(serverName);
      const pending = trackedTasks
        .filter((t) => !serverTaskIds.has(t.taskId))
        .filter((t) => !dismissedIds.has(t.taskId));
      // An expired handle is never re-polled: the server has forgotten it, so
      // it renders from tracker data until the user dismisses it.
      const expiredEntries = pending
        .filter((t) => t.expired)
        .map((t) => expiredPlaceholderTask(t));
      const livePending = pending.filter((t) => !t.expired);
      const byId = new Map(livePending.map((t) => [t.taskId, t]));
      const pendingIds = livePending.map((t) => t.taskId);

      const onUnknownTask = (taskId: string) => {
        // Unknown/expired is not an error: flag it and keep the handle so the
        // user sees what happened instead of a silent removal. Any other
        // failure (transient connect, structureless 404 from an older hosted
        // replica) keeps the handle untouched and retries on the next tick.
        markTaskExpired(taskId, serverName);
      };

      let trackedTaskStatuses: (NormalizedTask | null)[];
      if (hosted && pendingIds.length > 0) {
        // One ephemeral connection per server per tick instead of one per task.
        const batches: string[][] = [];
        for (let i = 0; i < pendingIds.length; i += HOSTED_TASK_BATCH_LIMIT) {
          batches.push(pendingIds.slice(i, i + HOSTED_TASK_BATCH_LIMIT));
        }
        const entries = (
          await Promise.all(
            batches.map(async (ids) => {
              try {
                return (await getTasksBatch(serverName, ids)).tasks;
              } catch {
                return [];
              }
            }),
          )
        ).flat();
        trackedTaskStatuses = entries.map((entry) => {
          const tracked = byId.get(entry.taskId);
          if (entry.code === "task-unknown-or-expired") {
            onUnknownTask(entry.taskId);
            return tracked ? expiredPlaceholderTask(tracked) : null;
          }
          if (!entry.task) return null;
          return normalizeTask(wire, entry.task);
        });
      } else {
        trackedTaskStatuses = await Promise.all(
          livePending.map(async (tracked) => {
            try {
              const envelope = await getTask(serverName, tracked.taskId);
              return normalizeTask(envelope.wire, envelope.task);
            } catch (err) {
              if (err instanceof TaskUnknownOrExpiredError) {
                onUnknownTask(tracked.taskId);
                return expiredPlaceholderTask(tracked);
              }
              // Anything else is transient (connect failure, 5xx, a version
              // flip). Handles are NEVER dropped for it — on the extension
              // wire there is no `tasks/list` to recover them from.
              return null;
            }
          }),
        );
      }
      trackedTaskStatuses = [...trackedTaskStatuses, ...expiredEntries];

      // Merge server tasks with tracked tasks (tracked tasks first for recency)
      // Filter out dismissed tasks from server results
      const allTasks: NormalizedTask[] = [
        ...trackedTaskStatuses.filter((t): t is NormalizedTask => t !== null),
        ...serverResult.tasks
          .filter((t) => !dismissedIds.has(t.taskId))
          .map((t) =>
            normalizeTask("legacy", t as unknown as Record<string, unknown>),
          ),
      ];

      // Sort by createdAt descending (most recent first)
      allTasks.sort((a, b) => {
        const aTime = new Date(a.createdAt).getTime();
        const bTime = new Date(b.createdAt).getTime();
        return bTime - aTime;
      });

      setTasks(allTasks);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch tasks");
    } finally {
      setFetchingTasks(false);
    }
  }, [serverName, taskCapabilities, hosted, wire]);

  // Handle elicitation response from the dialog
  const handleElicitationResponse = useCallback(
    async (
      action: "accept" | "decline" | "cancel",
      parameters?: Record<string, unknown>,
    ) => {
      try {
        await respondToElicitation(action, parameters);
        // Refresh tasks to get updated status after responding
        await fetchTasks();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to respond to elicitation",
        );
      }
    },
    [respondToElicitation, fetchTasks],
  );

  const fetchTaskResult = useCallback(
    async (taskId: string) => {
      if (!serverName) return;

      setLoading(true);
      setError("");

      try {
        const result = await getTaskResult(serverName, taskId);
        setTaskResult(result);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to fetch task result",
        );
      } finally {
        setLoading(false);
      }
    },
    [serverName],
  );

  const handleCancelTask = useCallback(async () => {
    if (!serverName || !selectedTaskId) return;

    setCancelling(true);
    setError("");

    try {
      await cancelTask(serverName, selectedTaskId);
      if (isExtensionWire) {
        // Cooperative cancel: the ack is empty, so record the request and
        // stop polling by default rather than waiting for a `cancelled` that
        // may never arrive.
        setCancellationRequested((prev) =>
          new Set(prev).add(selectedTaskId),
        );
        setAutoRefresh(false);
        userDisabledAutoRefresh.current = true;
      }
      // Refresh task list to get updated status
      await fetchTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel task");
    } finally {
      setCancelling(false);
    }
  }, [serverName, selectedTaskId, fetchTasks, isExtensionWire]);

  // Extension input_required: submit responses to the keyed inputRequests
  // snapshot via tasks/update. Partial responses are allowed.
  const handleSubmitInputResponses = useCallback(
    async (inputResponses: Record<string, unknown>) => {
      if (!serverName || !selectedTaskId) return;
      setSubmittingInput(true);
      setError("");
      try {
        await updateTask(serverName, selectedTaskId, inputResponses);
        await fetchTasks();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to submit task input",
        );
      } finally {
        setSubmittingInput(false);
      }
    },
    [serverName, selectedTaskId, fetchTasks],
  );

  const handleExtensionInputResponse = useCallback(
    async (
      action: "accept" | "decline" | "cancel",
      parameters?: Record<string, unknown>,
    ) => {
      if (!extensionInputRequest) return;
      // Partial responses are allowed: answer the key the user just handled.
      // SEP-2663 `InputResponse` is the BARE result object — never wrapped in a
      // `{method, result}` envelope, which a conforming server would ignore
      // (leaving the task stuck in `input_required`).
      const key = extensionInputRequest.key;
      setAnsweredInputKeys((prev) => {
        const next = new Map(prev);
        const keys = new Set(next.get(selectedTaskId) ?? []);
        keys.add(key);
        next.set(selectedTaskId, keys);
        return next;
      });
      await handleSubmitInputResponses({
        [key]: {
          action,
          ...(action === "accept" && parameters ? { content: parameters } : {}),
        },
      });
    },
    [extensionInputRequest, handleSubmitInputResponses, selectedTaskId],
  );

  // The "cancellation requested" banner is transient: once the task reaches a
  // terminal state (or disappears) it has served its purpose.
  useEffect(() => {
    setCancellationRequested((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      for (const id of prev) {
        const task = tasks.find((t) => t.taskId === id);
        if (!task || isTerminalStatus(task.status)) next.delete(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [tasks]);

  // Fetch task capabilities when server changes
  // Per MCP Tasks spec (2025-11-25): clients SHOULD check capabilities before using task features
  useEffect(() => {
    if (!serverConfig || !serverName) {
      setTaskCapabilities(undefined);
      return;
    }

    // Reset to undefined while fetching
    setTaskCapabilities(undefined);

    const fetchCapabilities = async () => {
      try {
        const capabilities = await getTaskCapabilities(serverName);
        setTaskCapabilities(capabilities);
      } catch {
        // Server may not support tasks - set to null (vs undefined = loading)
        setTaskCapabilities(null);
      }
    };

    fetchCapabilities();
  }, [serverConfig, serverName]);

  // Fetch tasks on mount and when server changes (only when tab is active)
  // Wait for capabilities to be fetched first (undefined = still loading)
  useEffect(() => {
    if (
      serverConfig &&
      serverName &&
      isActive &&
      taskCapabilities !== undefined
    ) {
      setTasks([]);
      setSelectedTaskId("");
      setTaskResult(null);
      fetchTasks();
    }
  }, [serverConfig, serverName, fetchTasks, isActive, taskCapabilities]);

  // Auto-refresh logic - uses user-configured pollInterval (persisted in localStorage)
  // Only poll when tab is active
  useEffect(() => {
    if (!autoRefresh || !serverName || !isActive) return;

    const interval = setInterval(() => {
      fetchTasks();
    }, pollInterval);

    return () => clearInterval(interval);
  }, [autoRefresh, serverName, fetchTasks, pollInterval, isActive]);

  // Fetch result when selecting a completed or failed task, or pending request for input_required
  // Per MCP Tasks spec: when task is input_required, tasks/result returns the pending request
  // Per MCP Tasks spec: for failed tasks, tasks/result returns the JSON-RPC error
  useEffect(() => {
    // Extension wire: tasks/get already carried the result (or the JSON-RPC
    // error, or the inputRequests snapshot) inline — never fetch a result.
    if (isExtensionWire) {
      setTaskResult(selectedTask?.result ?? selectedTask?.error ?? null);
      setPendingRequest(selectedTask?.inputRequests ?? null);
      return;
    }
    if (
      selectedTask?.status === "completed" ||
      selectedTask?.status === "failed"
    ) {
      setPendingRequest(null);
      pendingInputRequestTaskIdRef.current = null;
      fetchTaskResult(selectedTaskId);
    } else if (selectedTask?.status === "input_required") {
      // Per spec: "When the requestor encounters the input_required status,
      // it SHOULD preemptively call tasks/result"
      setTaskResult(null);
      // Track which task ID we're fetching for to avoid race conditions
      const currentTaskId = selectedTaskId;
      pendingInputRequestTaskIdRef.current = currentTaskId;
      // Fetch the pending request (e.g., elicitation)
      (async () => {
        if (!serverName) return;
        setLoading(true);
        try {
          const result = await getTaskResult(serverName, currentTaskId);
          // Only update state if this is still the active request (avoid race condition)
          if (pendingInputRequestTaskIdRef.current === currentTaskId) {
            setPendingRequest(result);
          }
        } catch {
          // May block waiting for input - expected behavior per MCP Tasks spec
        } finally {
          // Only clear loading if this is still the active request
          if (pendingInputRequestTaskIdRef.current === currentTaskId) {
            setLoading(false);
          }
        }
      })();
    } else {
      setTaskResult(null);
      setPendingRequest(null);
      pendingInputRequestTaskIdRef.current = null;
    }
  }, [
    selectedTaskId,
    selectedTask,
    isExtensionWire,
    fetchTaskResult,
    serverName,
  ]);

  // Poll for progress when there are working tasks (only when tab is active)
  useEffect(() => {
    if (!serverName || !isActive) return;
    // Progress notifications are a legacy in-core affordance, and hosted
    // connections are ephemeral so there is no notification stream at all.
    if (isExtensionWire || hosted) return;

    // Check if any task is currently working
    const hasWorkingTasks = tasks.some((t) => t.status === "working");
    if (!hasWorkingTasks) {
      setProgress(null);
      return;
    }

    // Fetch progress immediately
    const fetchProgress = async () => {
      try {
        const latestProgress = await getLatestProgress(serverName);
        setProgress(latestProgress);
      } catch (err) {
        console.debug("Failed to fetch progress:", err);
      }
    };

    fetchProgress();

    // Poll for progress more frequently than task status (every 500ms)
    const interval = setInterval(fetchProgress, 500);

    return () => clearInterval(interval);
  }, [serverName, tasks, isActive, isExtensionWire, hosted]);

  // Agent bridge: SNAPSHOT-ONLY (no tools). Tasks is a read-only view of a
  // server's long-running tasks (agentTools kind "none") the agent may OBSERVE.
  // Must run before the early return below (rules of hooks). Redacted STATE
  // only: the selected server and task rows by id/status/created-time — NEVER a
  // task's input, result, or status message, and NOT the server-wide progress
  // (it can't be attributed to the selected task). `hostedBlocked`, so this only
  // registers where the screen mounts.
  useSurfaceAgentBridge({
    surfaceId: "tasks",
    snapshot: () =>
      buildTasksSnapshot({
        selectedServer: serverName ?? null,
        tasks: tasks.map((task) => ({
          taskId: task.taskId,
          status: task.status,
          createdAt: task.createdAt,
        })),
        selectedTaskId: selectedTaskId || null,
        hasActiveTasks,
        autoRefresh,
      }),
  });

  if (!serverConfig || !serverName) {
    return (
      <EmptyState
        icon={ListTodo}
        title="No Server Selected"
        description="Connect to an MCP server to browse and manage its tasks."
      />
    );
  }

  // No tasks wire at all (pre-2025-11-25, or a server that declares neither
  // the in-core utility nor the extension): there is nothing to show and no
  // task request may be sent.
  if (taskCapabilities !== undefined && wire === "none") {
    return (
      <EmptyState
        icon={ListTodo}
        title="Tasks not supported"
        description="This server does not offer tasks on the negotiated protocol version."
      />
    );
  }

  const sidebarContent = (
    <div className="h-full flex flex-col border-r border-border bg-background">
      {/* App Builder-style Header */}
      <div className="border-b border-border flex-shrink-0">
        <div className="px-2 py-1.5 flex items-center gap-2">
          {/* Tabs area - just Tasks for now */}
          <div className="flex items-center gap-1.5">
            <button className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary/10 text-primary cursor-default">
              Tasks
              <span className="ml-1 text-[10px] font-mono opacity-70">
                {tasks.length}
              </span>
            </button>
          </div>

          {/* Polling controls */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  min={500}
                  step={500}
                  defaultValue={pollInterval}
                  key={`poll-${pollInterval}`}
                  onBlur={(e) => handlePollIntervalChange(e.target.value)}
                  className="h-6 w-14 text-[10px] px-1.5 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                <span className="text-[10px] text-muted-foreground">ms</span>
                {usingServerInterval && (
                  <Badge
                    variant="secondary"
                    className="text-[9px] px-1 py-0 h-4"
                  >
                    server
                  </Badge>
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              {usingServerInterval ? (
                <span>
                  Prefilled with server-suggested interval.
                  <br />
                  Edit to override.
                </span>
              ) : (
                <span>Poll interval (min 500ms)</span>
              )}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1">
                <Switch
                  id="auto-refresh"
                  checked={autoRefresh}
                  onCheckedChange={(checked) => {
                    setAutoRefresh(checked);
                    if (!checked) {
                      userDisabledAutoRefresh.current = true;
                    }
                  }}
                  className="scale-75"
                />
                <label
                  htmlFor="auto-refresh"
                  className="text-[10px] text-muted-foreground cursor-pointer"
                >
                  Auto
                </label>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Automatically poll for task status updates
            </TooltipContent>
          </Tooltip>

          {/* Secondary actions */}
          <div className="flex items-center gap-0.5 text-muted-foreground/80">
            <Button
              onClick={fetchTasks}
              variant="ghost"
              size="sm"
              disabled={fetchingTasks}
              className="h-7 w-7 p-0"
              title="Refresh tasks"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${fetchingTasks ? "animate-spin" : ""}`}
              />
            </Button>
            <Button
              onClick={handleClearTasks}
              variant="ghost"
              size="sm"
              disabled={tasks.length === 0}
              className="h-7 w-7 p-0"
              title="Clear all tasks"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              onClick={() => setIsSidebarVisible(false)}
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title="Hide sidebar"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Tasks List */}
      <div className="flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-2 pb-16">
            {fetchingTasks && tasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="w-8 h-8 bg-muted rounded-full flex items-center justify-center mb-3">
                  <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin" />
                </div>
                <p className="text-xs text-muted-foreground font-semibold mb-1">
                  Loading tasks...
                </p>
                <p className="text-xs text-muted-foreground/70">
                  Fetching active tasks from server
                </p>
              </div>
            ) : tasks.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-sm text-muted-foreground">
                  No tasks available
                </p>
                <p className="text-xs text-muted-foreground/70 mt-1">
                  Tasks will appear here when created by tool calls
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                {tasks.map((task) => {
                  const trackedTask = getTrackedTaskById(task.taskId);
                  const primitiveName =
                    trackedTask?.primitiveName ||
                    trackedTask?.toolName ||
                    task.taskId.substring(0, 12);

                  return (
                    <div
                      key={task.taskId}
                      className={`cursor-pointer transition-all duration-200 hover:bg-muted/30 dark:hover:bg-muted/50 p-3 rounded-md mx-2 ${
                        selectedTaskId === task.taskId
                          ? "bg-muted/50 dark:bg-muted/50 shadow-sm border border-border ring-1 ring-ring/20"
                          : "hover:shadow-sm"
                      }`}
                      onClick={() => setSelectedTaskId(task.taskId)}
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5">
                          <TaskStatusIcon status={task.status} />
                        </div>
                        <div className="flex-1 min-w-0">
                          {/* Primary: Name */}
                          <span className="font-medium text-xs text-foreground truncate block mb-1">
                            {primitiveName}
                          </span>
                          {/* Secondary: Relative time */}
                          <span className="text-[10px] text-muted-foreground">
                            {formatRelativeTime(task.createdAt)}
                          </span>
                          {/* Inline progress for working tasks. Hosted polls
                              through ephemeral connections, so no progress
                              notifications ever arrive. */}
                          {task.status === "working" && !hosted && (
                            <TaskInlineProgress
                              serverId={serverName}
                              startedAt={task.createdAt}
                            />
                          )}
                        </div>
                        <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0 mt-1" />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );

  const centerContent = (
    <div className="h-full flex flex-col bg-background">
      {selectedTask ? (
        <>
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-background">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <TaskStatusIcon status={selectedTask.status} />
                <Badge
                  variant="outline"
                  className={`text-xs ${statusConfigFor(selectedTask.status).bgColor} ${statusConfigFor(selectedTask.status).color} border-0`}
                >
                  {selectedTask.status}
                </Badge>
              </div>
              <code className="font-mono font-semibold text-foreground bg-muted px-2 py-1 rounded-md border border-border text-xs">
                {selectedTask.taskId}
              </code>
              <Badge variant="outline" className="text-xs">
                {selectedTask.wire}
              </Badge>
              {selectedTask.ttl !== null && (
                <Badge variant="outline" className="text-xs">
                  TTL: {selectedTask.ttl}ms
                </Badge>
              )}
              {selectedTask.pollInterval && (
                <Badge variant="outline" className="text-xs">
                  Poll interval: {selectedTask.pollInterval}ms
                </Badge>
              )}
            </div>
            {!isTerminalStatus(selectedTask.status) && (
              <Button
                onClick={handleCancelTask}
                disabled={cancelling}
                variant="destructive"
                size="sm"
              >
                {cancelling ? (
                  <>
                    <RefreshCw className="h-3 w-3 animate-spin" />
                    Cancelling
                  </>
                ) : (
                  <>
                    <Square className="h-3 w-3" />
                    Cancel Task
                  </>
                )}
              </Button>
            )}
          </div>

          {/* Task Details */}
          <div className="px-6 py-4 bg-muted/50 border-b border-border space-y-3">
            {cancellationRequested.has(selectedTask.taskId) && (
              <p className="text-xs text-warning">
                Cancellation requested. Cancellation is cooperative: the task
                may still complete or be removed. Automatic polling is paused —
                refresh manually to check.
              </p>
            )}
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <span className="text-muted-foreground">Created:</span>
                <span className="ml-2 font-mono text-foreground">
                  {formatDate(selectedTask.createdAt)}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Updated:</span>
                <span className="ml-2 font-mono text-foreground">
                  {formatDate(selectedTask.lastUpdatedAt)}
                </span>
              </div>
            </div>
            {selectedTask.statusMessage && (
              <p className="text-xs text-muted-foreground leading-relaxed">
                {selectedTask.statusMessage}
              </p>
            )}
            {/* Progress bar for working tasks */}
            {selectedTask.status === "working" &&
              progress &&
              progress.total && (
                <div className="space-y-1.5 pt-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Progress</span>
                    <span className="font-mono text-foreground">
                      {progress.progress} / {progress.total}
                      <span className="ml-2 text-muted-foreground">
                        (
                        {Math.round((progress.progress / progress.total) * 100)}
                        %)
                      </span>
                    </span>
                  </div>
                  <Progress
                    value={(progress.progress / progress.total) * 100}
                    className="h-2"
                  />
                  {progress.message && (
                    <p className="text-xs text-muted-foreground/80 italic">
                      {progress.message}
                    </p>
                  )}
                </div>
              )}
          </div>

          {/* Task Result in Details Panel */}
          <div className="flex-1 overflow-hidden flex flex-col">
            <div className="px-6 py-3 border-b border-border bg-background">
              <h3 className="text-xs font-semibold text-foreground">
                {selectedTask.status === "input_required"
                  ? "Pending Request"
                  : "Task Result"}
              </h3>
              {unanswerableInputCount > 0 && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {unanswerableInputCount} pending request
                  {unanswerableInputCount === 1 ? "" : "s"} this UI cannot
                  answer (sampling/roots) — visible in the raw request JSON
                  below.
                </p>
              )}
            </div>
            <div className="flex-1 min-h-0 p-4 flex flex-col">
              {error && (
                <div className="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded text-destructive text-xs font-medium">
                  {error}
                </div>
              )}
              {loading ? (
                <div className="h-full flex flex-col items-center justify-center text-center">
                  <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin mb-2" />
                  <p className="text-xs text-muted-foreground">
                    Fetching result...
                  </p>
                </div>
              ) : selectedTask.status === "input_required" &&
                hosted &&
                !isExtensionWire ? (
                <div className="h-full flex flex-col items-center justify-center text-center">
                  <AlertCircle className="h-4 w-4 text-warning mb-2" />
                  <p className="text-xs text-muted-foreground">
                    This task requires an interactive session (use the local
                    inspector)
                  </p>
                </div>
              ) : selectedTask.status === "input_required" ? (
                pendingRequest !== null && pendingRequest !== undefined ? (
                  <div className="flex-1 min-h-0 border border-border rounded-md overflow-hidden">
                    {pendingRequestDisplay?.kind === "text" ? (
                      <pre className="h-full overflow-auto whitespace-pre-wrap p-4 text-xs font-mono bg-muted/30">
                        {pendingRequestDisplay.text}
                      </pre>
                    ) : (
                      <JsonEditor
                        value={
                          pendingRequestDisplay?.kind === "json"
                            ? pendingRequestDisplay.value
                            : (pendingRequest as object)
                        }
                        readOnly
                        showToolbar={false}
                        collapsible
                        defaultExpandDepth={2}
                        collapseStringsAfterLength={100}
                        height="100%"
                      />
                    )}
                  </div>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-center">
                    <AlertCircle className="h-4 w-4 text-warning mb-2" />
                    <p className="text-xs text-muted-foreground">
                      Waiting for input from client
                    </p>
                  </div>
                )
              ) : selectedTask.status === "completed" ||
                selectedTask.status === "failed" ? (
                taskResult !== null ? (
                  <div className="flex-1 min-h-0 border border-border rounded-md overflow-hidden">
                    {taskResultDisplay?.kind === "text" ? (
                      <pre className="h-full overflow-auto whitespace-pre-wrap p-4 text-xs font-mono bg-muted/30">
                        {taskResultDisplay.text}
                      </pre>
                    ) : (
                      <JsonEditor
                        value={
                          taskResultDisplay?.kind === "json"
                            ? taskResultDisplay.value
                            : (taskResult as object)
                        }
                        readOnly
                        showToolbar={false}
                        collapsible
                        defaultExpandDepth={2}
                        collapseStringsAfterLength={100}
                        height="100%"
                      />
                    )}
                  </div>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-center">
                    <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin mb-2" />
                    <p className="text-xs text-muted-foreground">
                      Loading result...
                    </p>
                  </div>
                )
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-center">
                  <TaskStatusIcon status={selectedTask.status} />
                  <p className="text-xs text-muted-foreground mt-2">
                    {selectedTask.status === "working"
                      ? "Result available when task completes"
                      : "No result available"}
                  </p>
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="h-full flex items-center justify-center">
          <div className="text-center">
            <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mx-auto mb-3">
              <ListTodo className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-xs font-semibold text-foreground mb-1">
              No selection
            </p>
            <p className="text-xs text-muted-foreground font-medium">
              Choose a task from the left to view its details
            </p>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <>
      <ThreePanelLayout
        id="tasks"
        sidebar={sidebarContent}
        content={centerContent}
        sidebarVisible={isSidebarVisible}
        onSidebarVisibilityChange={setIsSidebarVisible}
        sidebarTooltip="Show tasks sidebar"
        serverName={serverName}
      />
      {/* Elicitation Dialog for tasks in input_required status */}
      {/* Per MCP Tasks spec (2025-11-25): when a task needs input, server sends */}
      {/* elicitation requests with relatedTaskId in the metadata */}
      <ElicitationDialog
        elicitationRequest={extensionDialogElicitation ?? legacyDialogElicitation}
        onResponse={
          extensionDialogElicitation
            ? handleExtensionInputResponse
            : handleElicitationResponse
        }
        loading={elicitationResponding || submittingInput}
      />
    </>
  );
}
