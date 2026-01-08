import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import {
  ListTodo,
  RefreshCw,
  ChevronRight,
  Square,
  Trash2,
  AlertCircle,
} from "lucide-react";
import { EmptyState } from "./ui/empty-state";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import { MCPServerConfig } from "@/sdk";
import { LoggerView } from "./logger-view";
import {
  Task,
  listTasks,
  getTask,
  getTaskResult,
  cancelTask,
  getLatestProgress,
  getTaskCapabilities,
  type ProgressEvent,
  type TaskCapabilities,
} from "@/lib/apis/mcp-tasks-api";
import {
  getTrackedTasksForServer,
  getTrackedTaskById,
  untrackTask,
  clearTrackedTasksForServer,
  getDismissedTaskIds,
  dismissTasksForServer,
} from "@/lib/task-tracker";
import { Switch } from "./ui/switch";
import { Input } from "./ui/input";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { Progress } from "./ui/progress";
import { TaskInlineProgress } from "./tasks/TaskInlineProgress";
import { STATUS_CONFIG, formatRelativeTime } from "@/lib/task-utils";
import { useTaskElicitation } from "@/hooks/use-task-elicitation";
import { ElicitationDialog } from "./ElicitationDialog";
import type { DialogElicitation } from "./ToolsTab";

const POLL_INTERVAL_STORAGE_KEY = "mcp-inspector-tasks-poll-interval";
const DEFAULT_POLL_INTERVAL = 3000;

interface TasksTabProps {
  serverConfig?: MCPServerConfig;
  serverName?: string;
  isActive?: boolean;
}

function TaskStatusIcon({ status }: { status: Task["status"] }) {
  const config = STATUS_CONFIG[status];
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

function isTerminalStatus(status: Task["status"]): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

export function TasksTab({
  serverConfig,
  serverName,
  isActive = true,
}: TasksTabProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
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
    TaskCapabilities | null | undefined
  >(undefined);
  // Track the task ID for pending input_required requests to avoid race conditions
  const pendingInputRequestTaskIdRef = useRef<string | null>(null);

  const selectedTask = useMemo(() => {
    return tasks.find((t) => t.taskId === selectedTaskId) ?? null;
  }, [tasks, selectedTaskId]);

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
  const dialogElicitation: DialogElicitation | null = taskElicitation
    ? {
        requestId: taskElicitation.requestId,
        message: taskElicitation.message,
        schema: taskElicitation.schema as Record<string, unknown> | undefined,
        timestamp: taskElicitation.timestamp,
      }
    : null;

  // Priority: user override > server suggestion > user default
  // Per MCP Tasks spec: "Requestors SHOULD respect the pollInterval provided in responses"
  // But we allow user to explicitly override if they want
  const pollInterval =
    userOverride ?? serverSuggestedPollInterval ?? userPollInterval;
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

    setFetchingTasks(true);
    setError("");

    try {
      // Get dismissed task IDs to filter them out
      const dismissedIds = getDismissedTaskIds(serverName);

      // Per MCP Tasks spec (2025-11-25): clients SHOULD only call tasks/list
      // if the server declares tasks.list capability
      let serverResult: { tasks: Task[] } = { tasks: [] };
      let serverTaskIds = new Set<string>();

      if (taskCapabilities?.supportsList) {
        // Server supports tasks/list - fetch from server
        serverResult = await listTasks(serverName);
        serverTaskIds = new Set(serverResult.tasks.map((t) => t.taskId));
      }

      // Get locally tracked tasks and fetch their current status
      const trackedTasks = getTrackedTasksForServer(serverName);
      const trackedTaskStatuses = await Promise.all(
        trackedTasks
          .filter((t) => !serverTaskIds.has(t.taskId)) // Skip if already in server list
          .filter((t) => !dismissedIds.has(t.taskId)) // Skip dismissed tasks
          .map(async (tracked) => {
            try {
              return await getTask(serverName, tracked.taskId);
            } catch {
              // Task no longer exists on server, remove from tracking
              untrackTask(tracked.taskId);
              return null;
            }
          }),
      );

      // Merge server tasks with tracked tasks (tracked tasks first for recency)
      // Filter out dismissed tasks from server results
      const allTasks = [
        ...trackedTaskStatuses.filter((t): t is Task => t !== null),
        ...serverResult.tasks.filter((t) => !dismissedIds.has(t.taskId)),
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
  }, [serverName, taskCapabilities]);

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
      // Refresh task list to get updated status
      await fetchTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel task");
    } finally {
      setCancelling(false);
    }
  }, [serverName, selectedTaskId, fetchTasks]);

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
  }, [selectedTaskId, selectedTask?.status, fetchTaskResult, serverName]);

  // Poll for progress when there are working tasks (only when tab is active)
  useEffect(() => {
    if (!serverName || !isActive) return;

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
  }, [serverName, tasks, isActive]);

  if (!serverConfig || !serverName) {
    return (
      <EmptyState
        icon={ListTodo}
        title="No Server Selected"
        description="Connect to an MCP server to browse and manage its tasks."
      />
    );
  }

  return (
    <div className="h-full flex flex-col">
      <ResizablePanelGroup direction="vertical" className="flex-1">
        {/* Top Section - Tasks and Details */}
        <ResizablePanel defaultSize={70} minSize={30}>
          <ResizablePanelGroup direction="horizontal" className="h-full">
            {/* Left Panel - Tasks List */}
            <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
              <div className="h-full flex flex-col border-r border-border bg-background">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-background">
                  <div className="flex items-center gap-2">
                    <ListTodo className="h-3.5 w-3.5 text-muted-foreground" />
                    <h2 className="text-xs font-semibold text-foreground">
                      Tasks
                    </h2>
                    <Badge variant="secondary" className="text-xs font-mono">
                      {tasks.length}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 ml-4">
                    {/* Polling controls - always show input, prefilled with effective interval */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="flex items-center gap-1.5">
                          <Input
                            type="number"
                            min={500}
                            step={500}
                            defaultValue={pollInterval}
                            key={`poll-${pollInterval}`}
                            onBlur={(e) =>
                              handlePollIntervalChange(e.target.value)
                            }
                            className="h-6 w-16 text-[10px] px-1.5 text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                          <span className="text-[10px] text-muted-foreground">
                            ms
                          </span>
                          {usingServerInterval && (
                            <Badge
                              variant="secondary"
                              className="text-[9px] px-1 py-0 h-4 ml-0.5"
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
                        <div className="flex items-center gap-1.5">
                          <Switch
                            id="auto-refresh"
                            checked={autoRefresh}
                            onCheckedChange={(checked) => {
                              setAutoRefresh(checked);
                              // Track if user explicitly disabled to avoid re-enabling
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

                    {/* Divider */}
                    <div className="h-4 w-px bg-border" />

                    {/* Action buttons */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          onClick={fetchTasks}
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          disabled={fetchingTasks}
                        >
                          <RefreshCw
                            className={`h-3.5 w-3.5 ${fetchingTasks ? "animate-spin-pulse text-primary" : ""}`}
                          />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        Refresh tasks
                      </TooltipContent>
                    </Tooltip>

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          onClick={handleClearTasks}
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          disabled={tasks.length === 0}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        Clear all tasks
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>

                {/* Tasks List */}
                <div className="flex-1 overflow-hidden">
                  <ScrollArea className="h-full">
                    <div className="p-2">
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
                                    {/* Inline progress for working tasks */}
                                    {task.status === "working" && (
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
            </ResizablePanel>

            <ResizableHandle withHandle />

            {/* Right Panel - Task Details */}
            <ResizablePanel defaultSize={70} minSize={50}>
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
                            className={`text-xs ${STATUS_CONFIG[selectedTask.status].bgColor} ${STATUS_CONFIG[selectedTask.status].color} border-0`}
                          >
                            {selectedTask.status}
                          </Badge>
                        </div>
                        <code className="font-mono font-semibold text-foreground bg-muted px-2 py-1 rounded-md border border-border text-xs">
                          {selectedTask.taskId}
                        </code>
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
                      <div className="grid grid-cols-2 gap-4 text-xs">
                        <div>
                          <span className="text-muted-foreground">
                            Created:
                          </span>
                          <span className="ml-2 font-mono text-foreground">
                            {formatDate(selectedTask.createdAt)}
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">
                            Updated:
                          </span>
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
                              <span className="text-muted-foreground">
                                Progress
                              </span>
                              <span className="font-mono text-foreground">
                                {progress.progress} / {progress.total}
                                <span className="ml-2 text-muted-foreground">
                                  (
                                  {Math.round(
                                    (progress.progress / progress.total) * 100,
                                  )}
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
                      </div>
                      <ScrollArea className="flex-1">
                        <div className="p-4">
                          {error && (
                            <div className="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded text-destructive text-xs font-medium">
                              {error}
                            </div>
                          )}
                          {loading ? (
                            <div className="flex flex-col items-center justify-center py-8 text-center">
                              <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin mb-2" />
                              <p className="text-xs text-muted-foreground">
                                Fetching result...
                              </p>
                            </div>
                          ) : selectedTask.status === "input_required" ? (
                            pendingRequest ? (
                              <JsonView
                                src={pendingRequest as object}
                                dark={true}
                                theme="atom"
                                enableClipboard={true}
                                displaySize={false}
                                collapseStringsAfterLength={100}
                                style={{
                                  fontSize: "12px",
                                  fontFamily:
                                    "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                                  backgroundColor: "hsl(var(--background))",
                                  padding: "0",
                                  borderRadius: "0",
                                  border: "none",
                                }}
                              />
                            ) : (
                              <div className="flex flex-col items-center justify-center py-8 text-center">
                                <AlertCircle className="h-4 w-4 text-warning mb-2" />
                                <p className="text-xs text-muted-foreground">
                                  Waiting for input from client
                                </p>
                              </div>
                            )
                          ) : selectedTask.status === "completed" ||
                            selectedTask.status === "failed" ? (
                            taskResult !== null ? (
                              <JsonView
                                src={taskResult as object}
                                dark={true}
                                theme="atom"
                                enableClipboard={true}
                                displaySize={false}
                                collapseStringsAfterLength={100}
                                style={{
                                  fontSize: "12px",
                                  fontFamily:
                                    "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                                  backgroundColor: "hsl(var(--background))",
                                  padding: "0",
                                  borderRadius: "0",
                                  border: "none",
                                }}
                              />
                            ) : (
                              <div className="flex flex-col items-center justify-center py-8 text-center">
                                <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin mb-2" />
                                <p className="text-xs text-muted-foreground">
                                  Loading result...
                                </p>
                              </div>
                            )
                          ) : (
                            <div className="flex flex-col items-center justify-center py-8 text-center">
                              <TaskStatusIcon status={selectedTask.status} />
                              <p className="text-xs text-muted-foreground mt-2">
                                {selectedTask.status === "working"
                                  ? "Result available when task completes"
                                  : "No result available"}
                              </p>
                            </div>
                          )}
                        </div>
                      </ScrollArea>
                    </div>
                  </>
                ) : (
                  <div className="h-full flex items-center justify-center">
                    <div className="text-center">
                      <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mx-auto mb-3">
                        <ListTodo className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <p className="text-xs font-semibold text-foreground mb-1">
                        Select a task
                      </p>
                      <p className="text-xs text-muted-foreground font-medium">
                        Choose a task from the left to view its details
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Bottom Panel - JSON-RPC Logger and Task Status */}
        <ResizablePanel defaultSize={30} minSize={15} maxSize={70}>
          <ResizablePanelGroup direction="horizontal" className="h-full">
            <ResizablePanel defaultSize={50} minSize={20}>
              <LoggerView serverIds={serverName ? [serverName] : undefined} />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={50} minSize={20}>
              <div className="h-full flex flex-col border-t border-border bg-background">
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-border">
                  <h2 className="text-xs font-semibold text-foreground">
                    Task Status
                  </h2>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-hidden">
                  <ScrollArea className="h-full">
                    <div className="p-4">
                      {!selectedTask ? (
                        <div className="flex flex-col items-center justify-center py-8 text-center">
                          <ListTodo className="h-4 w-4 text-muted-foreground mb-2" />
                          <p className="text-xs text-muted-foreground">
                            Select a task to view its status
                          </p>
                        </div>
                      ) : (
                        <JsonView
                          src={selectedTask as object}
                          dark={true}
                          theme="atom"
                          enableClipboard={true}
                          displaySize={false}
                          collapseStringsAfterLength={100}
                          style={{
                            fontSize: "12px",
                            fontFamily:
                              "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                            backgroundColor: "hsl(var(--background))",
                            padding: "0",
                            borderRadius: "0",
                            border: "none",
                          }}
                        />
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>

      {/* Elicitation Dialog for tasks in input_required status */}
      {/* Per MCP Tasks spec (2025-11-25): when a task needs input, server sends */}
      {/* elicitation requests with relatedTaskId in the metadata */}
      <ElicitationDialog
        elicitationRequest={dialogElicitation}
        onResponse={handleElicitationResponse}
        loading={elicitationResponding}
      />
    </div>
  );
}
