import { useEffect, useMemo, useState, useCallback } from "react";
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
  Loader2,
  CheckCircle,
  XCircle,
  AlertCircle,
  Slash,
  Square,
  Trash2,
} from "lucide-react";
import { EmptyState } from "./ui/empty-state";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import { MCPServerConfig } from "@/sdk";
import { LoggerView } from "./logging/logger-view";
import {
  Task,
  listTasks,
  getTask,
  getTaskResult,
  cancelTask,
  getLatestProgress,
  type ProgressEvent,
} from "@/lib/apis/mcp-tasks-api";
import {
  getTrackedTasksForServer,
  untrackTask,
  clearTrackedTasksForServer,
} from "@/lib/task-tracker";
import { Switch } from "./ui/switch";
import { Input } from "./ui/input";
import { Progress } from "./ui/progress";

const POLL_INTERVAL_STORAGE_KEY = "mcp-inspector-tasks-poll-interval";
const DEFAULT_POLL_INTERVAL = 3000;

interface TasksTabProps {
  serverConfig?: MCPServerConfig;
  serverName?: string;
}

const STATUS_CONFIG = {
  working: {
    icon: Loader2,
    color: "text-blue-500",
    bgColor: "bg-blue-500/10",
    animate: true,
  },
  input_required: {
    icon: AlertCircle,
    color: "text-yellow-500",
    bgColor: "bg-yellow-500/10",
    animate: false,
  },
  completed: {
    icon: CheckCircle,
    color: "text-green-500",
    bgColor: "bg-green-500/10",
    animate: false,
  },
  failed: {
    icon: XCircle,
    color: "text-red-500",
    bgColor: "bg-red-500/10",
    animate: false,
  },
  cancelled: {
    icon: Slash,
    color: "text-gray-500",
    bgColor: "bg-gray-500/10",
    animate: false,
  },
};

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
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function TasksTab({ serverConfig, serverName }: TasksTabProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const [taskResult, setTaskResult] = useState<unknown>(null);
  const [pendingRequest, setPendingRequest] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [fetchingTasks, setFetchingTasks] = useState(false);
  const [error, setError] = useState<string>("");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [cancelling, setCancelling] = useState(false);
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
  const [progress, setProgress] = useState<ProgressEvent | null>(null);

  const selectedTask = useMemo(() => {
    return tasks.find((t) => t.taskId === selectedTaskId) ?? null;
  }, [tasks, selectedTaskId]);

  // Use user-configured poll interval (persisted in localStorage)
  const pollInterval = userPollInterval;

  const handlePollIntervalChange = useCallback((value: string) => {
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed) && parsed >= 500) {
      setUserPollInterval(parsed);
      localStorage.setItem(POLL_INTERVAL_STORAGE_KEY, String(parsed));
    }
  }, []);

  const handleClearTasks = useCallback(() => {
    if (!serverName) return;
    clearTrackedTasksForServer(serverName);
    setTasks([]);
    setSelectedTaskId("");
    setTaskResult(null);
    setPendingRequest(null);
  }, [serverName]);

  const fetchTasks = useCallback(async () => {
    if (!serverName) return;

    setFetchingTasks(true);
    setError("");

    try {
      // Get tasks from server (may be empty for servers like FastMCP)
      const serverResult = await listTasks(serverName);
      const serverTaskIds = new Set(serverResult.tasks.map((t) => t.taskId));

      // Get locally tracked tasks and fetch their current status
      const trackedTasks = getTrackedTasksForServer(serverName);
      const trackedTaskStatuses = await Promise.all(
        trackedTasks
          .filter((t) => !serverTaskIds.has(t.taskId)) // Skip if already in server list
          .map(async (tracked) => {
            try {
              const status = await getTask(serverName, tracked.taskId);
              return status;
            } catch {
              // Task no longer exists on server, remove from tracking
              untrackTask(tracked.taskId);
              return null;
            }
          })
      );

      // Merge server tasks with tracked tasks (tracked tasks first for recency)
      const allTasks = [
        ...trackedTaskStatuses.filter((t): t is Task => t !== null),
        ...serverResult.tasks,
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
  }, [serverName]);

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

  // Fetch tasks on mount and when server changes
  useEffect(() => {
    if (serverConfig && serverName) {
      setTasks([]);
      setSelectedTaskId("");
      setTaskResult(null);
      fetchTasks();
    }
  }, [serverConfig, serverName, fetchTasks]);

  // Auto-refresh logic - uses user-configured pollInterval (persisted in localStorage)
  useEffect(() => {
    if (!autoRefresh || !serverName) return;

    const interval = setInterval(() => {
      fetchTasks();
    }, pollInterval);

    return () => clearInterval(interval);
  }, [autoRefresh, serverName, fetchTasks, pollInterval]);

  // Fetch result when selecting a completed task, or pending request for input_required
  // Per MCP Tasks spec: when task is input_required, tasks/result returns the pending request
  useEffect(() => {
    if (selectedTask?.status === "completed") {
      setPendingRequest(null);
      fetchTaskResult(selectedTaskId);
    } else if (selectedTask?.status === "input_required") {
      // Per spec: "When the requestor encounters the input_required status,
      // it SHOULD preemptively call tasks/result"
      setTaskResult(null);
      // Fetch the pending request (e.g., elicitation)
      (async () => {
        if (!serverName) return;
        setLoading(true);
        try {
          const result = await getTaskResult(serverName, selectedTaskId);
          setPendingRequest(result);
        } catch (err) {
          // This may block waiting for input, which is expected behavior
          console.debug("tasks/result for input_required:", err);
        } finally {
          setLoading(false);
        }
      })();
    } else {
      setTaskResult(null);
      setPendingRequest(null);
    }
  }, [selectedTaskId, selectedTask?.status, fetchTaskResult, serverName]);

  // Poll for progress when there are working tasks
  useEffect(() => {
    if (!serverName) return;

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
  }, [serverName, tasks]);

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
    <div className="h-[calc(100vh-120px)] flex flex-col">
      <ResizablePanelGroup direction="vertical" className="flex-1">
        {/* Top Section - Tasks and Details */}
        <ResizablePanel defaultSize={70} minSize={30}>
          <ResizablePanelGroup direction="horizontal" className="h-full">
            {/* Left Panel - Tasks List */}
            <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
              <div className="h-full flex flex-col border-r border-border bg-background">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-4 border-b border-border bg-background">
                  <div className="flex items-center gap-3">
                    <ListTodo className="h-3 w-3 text-muted-foreground" />
                    <h2 className="text-xs font-semibold text-foreground">
                      Tasks
                    </h2>
                    <Badge variant="secondary" className="text-xs font-mono">
                      {tasks.length}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5">
                      <Input
                        type="number"
                        min={500}
                        step={500}
                        value={userPollInterval}
                        onChange={(e) => handlePollIntervalChange(e.target.value)}
                        className="h-6 w-16 text-[10px] px-1.5 text-center"
                        title="Poll interval in milliseconds"
                      />
                      <span className="text-[10px] text-muted-foreground">ms</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Switch
                        id="auto-refresh"
                        checked={autoRefresh}
                        onCheckedChange={setAutoRefresh}
                        className="scale-75"
                      />
                      <label
                        htmlFor="auto-refresh"
                        className="text-[10px] text-muted-foreground cursor-pointer"
                      >
                        Auto
                      </label>
                    </div>
                    <Button
                      onClick={fetchTasks}
                      variant="ghost"
                      size="sm"
                      disabled={fetchingTasks}
                      title="Refresh tasks"
                    >
                      <RefreshCw
                        className={`h-3 w-3 ${fetchingTasks ? "animate-spin" : ""} cursor-pointer`}
                      />
                    </Button>
                    <Button
                      onClick={handleClearTasks}
                      variant="ghost"
                      size="sm"
                      disabled={tasks.length === 0}
                      title="Clear tracked tasks"
                    >
                      <Trash2 className="h-3 w-3 cursor-pointer" />
                    </Button>
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
                          {tasks.map((task) => (
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
                                  <div className="flex items-center gap-2 mb-1">
                                    <code className="font-mono text-xs font-medium text-foreground truncate max-w-[150px]">
                                      {task.taskId.substring(0, 12)}...
                                    </code>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <Badge
                                      variant="outline"
                                      className={`text-[10px] ${STATUS_CONFIG[task.status].bgColor} ${STATUS_CONFIG[task.status].color} border-0`}
                                    >
                                      {task.status}
                                    </Badge>
                                  </div>
                                  {task.statusMessage && (
                                    <p className="text-xs mt-2 line-clamp-1 leading-relaxed text-muted-foreground">
                                      {task.statusMessage}
                                    </p>
                                  )}
                                </div>
                                <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0 mt-1" />
                              </div>
                            </div>
                          ))}
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
                    <div className="flex items-center justify-between px-6 py-5 border-b border-border bg-background">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <TaskStatusIcon status={selectedTask.status} />
                          <code className="font-mono font-semibold text-foreground bg-muted px-2 py-1 rounded-md border border-border text-xs">
                            {selectedTask.taskId}
                          </code>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className={`text-xs ${STATUS_CONFIG[selectedTask.status].bgColor} ${STATUS_CONFIG[selectedTask.status].color} border-0`}
                          >
                            {selectedTask.status}
                          </Badge>
                          {selectedTask.ttl !== null && (
                            <Badge variant="outline" className="text-xs">
                              TTL: {selectedTask.ttl}ms
                            </Badge>
                          )}
                          {selectedTask.pollInterval && (
                            <Badge variant="outline" className="text-xs">
                              Poll: {selectedTask.pollInterval}ms
                            </Badge>
                          )}
                        </div>
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
                    <div className="px-6 py-4 bg-muted/50 border-b border-border space-y-2">
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
                      {selectedTask.status === "working" && progress && progress.total && (
                        <div className="space-y-1.5 pt-2">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-muted-foreground">Progress</span>
                            <span className="font-mono text-foreground">
                              {progress.progress} / {progress.total}
                              <span className="ml-2 text-muted-foreground">
                                ({Math.round((progress.progress / progress.total) * 100)}%)
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

        {/* Bottom Panel - JSON-RPC Logger and Result */}
        <ResizablePanel defaultSize={30} minSize={15} maxSize={70}>
          <ResizablePanelGroup direction="horizontal" className="h-full">
            <ResizablePanel defaultSize={40} minSize={10}>
              <LoggerView serverIds={serverName ? [serverName] : undefined} />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={60} minSize={30}>
              <div className="h-full flex flex-col border-t border-border bg-background break-all">
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-border">
                  <h2 className="text-xs font-semibold text-foreground">
                    Task Result
                  </h2>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-hidden">
                  {error ? (
                    <div className="p-4">
                      <div className="p-3 bg-destructive/10 border border-destructive/20 rounded text-destructive text-xs font-medium">
                        {error}
                      </div>
                    </div>
                  ) : (
                    <div className="flex-1 overflow-hidden">
                      <ScrollArea className="h-full">
                        <div className="p-4">
                          {loading ? (
                            <div className="flex flex-col items-center justify-center py-16 text-center">
                              <div className="w-8 h-8 bg-muted rounded-full flex items-center justify-center mb-3">
                                <RefreshCw className="h-4 w-4 text-muted-foreground animate-spin" />
                              </div>
                              <p className="text-xs text-muted-foreground font-semibold">
                                Fetching task result...
                              </p>
                            </div>
                          ) : !selectedTask ? (
                            <div className="flex flex-col items-center justify-center py-16 text-center">
                              <div className="w-10 h-10 bg-muted rounded-full flex items-center justify-center mb-3">
                                <ListTodo className="h-4 w-4 text-muted-foreground" />
                              </div>
                              <p className="text-xs text-muted-foreground font-semibold mb-1">
                                No task selected
                              </p>
                              <p className="text-xs text-muted-foreground/70">
                                Select a task to view its result
                              </p>
                            </div>
                          ) : selectedTask.status === "input_required" ? (
                            // Show pending request for input_required status
                            pendingRequest ? (
                              <div className="space-y-3">
                                <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded text-yellow-700 dark:text-yellow-400 text-xs">
                                  <p className="font-semibold mb-1">Input Required</p>
                                  <p>The server is waiting for input to continue this task.</p>
                                </div>
                                <div className="text-xs text-muted-foreground mb-2">
                                  Pending Request:
                                </div>
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
                              </div>
                            ) : (
                              <div className="flex flex-col items-center justify-center py-16 text-center">
                                <div className="w-10 h-10 bg-yellow-500/10 rounded-full flex items-center justify-center mb-3">
                                  <AlertCircle className="h-4 w-4 text-yellow-500" />
                                </div>
                                <p className="text-xs text-muted-foreground font-semibold mb-1">
                                  Waiting for Input
                                </p>
                                <p className="text-xs text-muted-foreground/70">
                                  {loading
                                    ? "Fetching pending request..."
                                    : "The task is waiting for input from the client"}
                                </p>
                              </div>
                            )
                          ) : selectedTask.status !== "completed" ? (
                            <div className="flex flex-col items-center justify-center py-16 text-center">
                              <div className="w-10 h-10 bg-muted rounded-full flex items-center justify-center mb-3">
                                <TaskStatusIcon status={selectedTask.status} />
                              </div>
                              <p className="text-xs text-muted-foreground font-semibold mb-1">
                                Task {selectedTask.status}
                              </p>
                              <p className="text-xs text-muted-foreground/70">
                                {selectedTask.status === "working"
                                  ? "Result will be available when task completes"
                                  : "No result available for this task status"}
                              </p>
                            </div>
                          ) : taskResult === null ? (
                            <div className="flex flex-col items-center justify-center py-16 text-center">
                              <div className="w-10 h-10 bg-muted rounded-full flex items-center justify-center mb-3">
                                <CheckCircle className="h-4 w-4 text-green-500" />
                              </div>
                              <p className="text-xs text-muted-foreground font-semibold mb-1">
                                Task completed
                              </p>
                              <p className="text-xs text-muted-foreground/70">
                                Loading result...
                              </p>
                            </div>
                          ) : (
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
                          )}
                        </div>
                      </ScrollArea>
                    </div>
                  )}
                </div>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
