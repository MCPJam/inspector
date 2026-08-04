import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { isHostedMode } from "@/lib/apis/mode-client";
import {
  HOSTED_TASK_BATCH_LIMIT,
  HOSTED_TASK_POLL_FLOOR_MS,
  hostedPollIntervalMs,
  isTerminalRegistryStatus,
  type RegistryTaskEntry,
} from "@/shared/hosted-tasks";
import {
  MAX_RECOVERY_READ_ATTEMPTS,
  useTaskScheduler,
} from "@/hooks/use-task-scheduler";
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
  dismissRegistryTasks,
} from "@/lib/task-tracker";
import { Switch } from "@mcpjam/design-system/switch";
import { Input } from "@mcpjam/design-system/input";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@mcpjam/design-system/tooltip";
import { Progress } from "@mcpjam/design-system/progress";
import { TaskInlineProgress } from "./tasks/TaskInlineProgress";
import {
  STATUS_CONFIG,
  expiredPlaceholderTask,
  registryPlaceholderTask,
  restoredPlaceholderTask,
  formatRelativeTime,
  isTerminalStatus,
  normalizeTask,
  type NormalizedTask,
  type TaskDisplayStatus,
} from "@/lib/task-utils";
import {
  fetchSubscriptionState,
  setDesiredSubscriptionInterests,
} from "@/lib/apis/mcp-subscriptions-api";
import { addTokenToUrl } from "@/lib/session-token";
import type { SubscriptionBridgeEvent } from "@/shared/subscription-bridge.js";
import { useTaskElicitation } from "@/hooks/use-task-elicitation";
import { ElicitationDialog } from "./ElicitationDialog";
import type { DialogElicitation } from "./ToolsTab";
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";
import { buildTasksSnapshot } from "@/lib/webmcp/review-surface-snapshots";

const POLL_INTERVAL_STORAGE_KEY = "mcp-inspector-tasks-poll-interval";
const DEFAULT_POLL_INTERVAL = 3000;
/**
 * Debounce for re-posting the task-notification interest set. A listen filter
 * is immutable, so every change is a close+reopen on the wire — worth batching
 * a burst of status flips into one revision.
 */
const TASK_INTEREST_DEBOUNCE_MS = 300;

interface TasksTabProps {
  serverConfig?: MCPServerConfig;
  serverName?: string;
  isActive?: boolean;
  /**
   * Connection status of the selected server. The capabilities probe fails
   * closed to `wire: "none"` while the connection is still coming up, so the
   * tab must refetch when this reaches "connected" — otherwise a fetch that
   * raced the connect leaves a sticky "Tasks not supported".
   */
  connectionStatus?: string;
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
      className={`h-4 w-4 ${config.color} ${
        config.animate ? "animate-spin" : ""
      }`}
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
  connectionStatus,
}: TasksTabProps) {
  const [tasks, setTasks] = useState<NormalizedTask[]>([]);
  // Read inside `fetchTasks` to carry not-yet-due handles forward without
  // making the callback depend on `tasks` — that would rebuild it on every
  // render and restart the poll timer each tick.
  const tasksRef = useRef<NormalizedTask[]>([]);
  tasksRef.current = tasks;
  // Last `tasks/list` snapshot (legacy wire only), so a tick that is not due
  // can carry it forward instead of re-issuing the call or blanking the list.
  const listedTasksRef = useRef<NormalizedTask[]>([]);
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
  // undefined = not yet fetched, null = the probe itself FAILED (transient:
  // network, auth, connect race — NOT "server doesn't support"), object = loaded
  const [taskCapabilities, setTaskCapabilities] = useState<
    TasksSupport | null | undefined
  >(undefined);
  // Bumped by the "Retry" button on the probe-failed state to re-run the
  // capabilities fetch without switching servers.
  const [capabilitiesFetchAttempt, setCapabilitiesFetchAttempt] = useState(0);
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

  // Handles recovered from the hosted registry (`registryTasks` on `/list`),
  // keyed by taskId. A REF, never the localStorage tracker: registry entries
  // are another device's (or a cleared profile's) handles, and writing them
  // into the tracker would resurrect entries the user cleared and duplicate
  // the registry's own persistence. They render as placeholders and join the
  // poll set until a live read (or a -32602) settles them.
  const registryHandlesRef = useRef<
    Map<string, RegistryTaskEntry & { terminalReadDone?: boolean }>
  >(new Map());
  // The server the one recovery read of this mount has been done for. Reset on
  // server change and on manual refresh; a failed read leaves it unset so the
  // next tick retries.
  const registryReadDoneRef = useRef<string | null>(null);

  // Signature of the last `taskIds` interest set POSTED to the subscription
  // bridge, so an unchanged active set never re-posts (each post can be a
  // close+reopen of the listen stream). `null` = nothing posted yet this
  // server: an initially-empty set then leaves the panel-owned desired filter
  // completely untouched.
  const postedTaskInterestsRef = useRef<string | null>(null);
  // Task ids with a notification-triggered `tasks/get` already in flight —
  // one notification burst, ONE immediate read.
  const notifiedRefreshInFlightRef = useRef<Set<string>>(new Set());

  // Collapsible sidebar state
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);

  const wire = taskCapabilities?.wire ?? "none";
  const isExtensionWire = wire === "extension";
  // Hosted reads go through ephemeral per-request connections: batch them and
  // never poll faster than the floor, because each tick is a full connect.
  const hosted = isHostedMode();

  // Two DIFFERENT numbers, and conflating them starves fast tasks.
  //
  // `tickFloorMs` is how often the shared timer may wake at all. It carries
  // only the GLOBAL floors — the user's preferred minimum, plus the hosted
  // connection-cost floor — and deliberately NOT the per-server task floors:
  // those are enforced per task by the scheduler, which decides which handles
  // a given tick is allowed to read. Folding the slowest task's floor in here
  // would make a 60s task delay a 2s task by 58 seconds, potentially past its
  // TTL.
  const userPreferredMinimum = userOverride ?? userPollInterval;
  const tickFloorMs = Math.max(
    userPreferredMinimum,
    // Each hosted tick is a full authorize → connect → request → disconnect
    // round trip, so the hosted surface carries its own connection-cost floor.
    hosted ? hostedPollIntervalMs(userPreferredMinimum) : 0
  );

  // Per-task due-time scheduling. The shared tick fires at `tickFloorMs`; the
  // scheduler decides which handles that tick is actually allowed to read, so
  // a 30s task is not read every time a 1s task is.
  const scheduler = useTaskScheduler({
    serverId: serverName,
    wire,
    userMinimumIntervalMs: userPreferredMinimum,
    surfaceFloorMs: hosted ? HOSTED_TASK_POLL_FLOOR_MS : 0,
  });

  const selectedTask = useMemo(() => {
    return tasks.find((t) => t.taskId === selectedTaskId) ?? null;
  }, [tasks, selectedTaskId]);
  const pendingRequestDisplay = extractDisplayFromToolResult(pendingRequest);
  const taskResultDisplay = extractDisplayFromToolResult(taskResult);

  // Restored handles that still owe the one `tasks/get` carrying their inline
  // result. Read from the scheduler rather than from the rows, because the rows
  // cannot show it: such a handle renders as `completed` and reads as finished
  // while its result has never actually been fetched.
  const recoveryReads = useMemo(
    () => scheduler.recoveryReadState(tasks.map((t) => t.taskId)),
    [tasks, scheduler]
  );

  // Check if any task is in a non-terminal state (working, input_required, pending)
  const hasActiveTasks = useMemo(() => {
    return (
      tasks.some((t) => !isTerminalStatus(t.status)) ||
      // ...or a restored terminal still owes its recovery read. Without this
      // term the loop stops on the DISPLAYED status and the read never
      // happens: not when it was scheduled for later (a stored `nextPollAt`
      // in the future is not due on the first tick, so the timer never arms
      // at all), and not after it failed (the backoff is recorded, then
      // nothing is left running to honor it).
      recoveryReads.pendingTaskIds.length > 0
    );
  }, [tasks, recoveryReads]);

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

  // The slowest floor among the active tasks — NOT the fastest.
  //
  // A tick reads every due task, so honoring the fastest task's floor would
  // breach every slower task's. This value is what the shared tick must
  // respect and what the UI reports; the per-task decision of *which* tasks
  // are actually due is the scheduler's, not this number's.
  const serverSuggestedPollInterval = useMemo(() => {
    const activeFloors = tasks
      .filter((t) => !isTerminalStatus(t.status) && t.pollInterval)
      .map((t) => t.pollInterval!);

    if (activeFloors.length === 0) return null;
    return Math.max(...activeFloors);
  }, [tasks]);

  // The number the UI reports and the poll-interval box edits: the pace a
  // caller would observe, including the slowest active task's floor.
  const pollInterval = Math.max(tickFloorMs, serverSuggestedPollInterval ?? 0);
  // The server is setting the pace whenever its floor is the binding term.
  const usingServerInterval =
    serverSuggestedPollInterval !== null &&
    // Against the TICK floor, not the user's preference: on the hosted surface
    // a 1500ms suggestion under a 1000ms user minimum would otherwise light the
    // badge while the 2000ms hosted floor is what actually sets the pace.
    serverSuggestedPollInterval >= tickFloorMs;

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
    // Union of this session's answers and the keys persisted from earlier
    // sessions — a reload must not re-prompt for something the server already
    // acknowledged.
    const answered = new Set([
      ...(answeredInputKeys.get(selectedTask.taskId) ?? []),
      ...scheduler.respondedInputKeys(selectedTask.taskId),
    ]);
    const entries = Object.entries(selectedTask.inputRequests ?? {});
    for (const [key, value] of entries) {
      if (answered.has(key)) continue;
      const request = value as {
        method?: string;
        params?: { message?: string; requestedSchema?: unknown };
      };
      if (request?.method === "elicitation/create") {
        return { key, request };
      }
    }
    return null;
  }, [isExtensionWire, selectedTask, answeredInputKeys, scheduler]);

  /** Keys in the current snapshot this UI cannot answer (sampling/roots). */
  const unanswerableInputCount = useMemo(() => {
    if (!isExtensionWire || selectedTask?.status !== "input_required") return 0;
    return Object.values(selectedTask.inputRequests ?? {}).filter(
      (value) => (value as { method?: string })?.method !== "elicitation/create"
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
    [serverSuggestedPollInterval]
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
    scheduler.forget(taskIds);
    // Registry-recovered handles have no tracker entry for the dismissal to
    // stick to, so their ids go into the durable per-server dismissed set —
    // the merge filter consults getDismissedTaskIds, which unions it in, so
    // they stay hidden across refetches on THIS browser. A local view
    // preference only: the registry row itself survives (global removal is
    // the delete route's job, deferred in v1).
    dismissRegistryTasks(serverName, [...registryHandlesRef.current.keys()]);
    registryHandlesRef.current = new Map();
    setTasks([]);
    setSelectedTaskId("");
    setTaskResult(null);
    setPendingRequest(null);
  }, [serverName, tasks, scheduler]);

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
      let serverResult: { tasks: Task[]; registryTasks?: RegistryTaskEntry[] } =
        { tasks: [] };
      let serverTaskIds = new Set<string>();

      // Folds a `/list` response's registry attachment in. An ABSENT
      // `registryTasks` is "no recovery source this tick" (local mode, chatbox
      // scope, registry off/unreachable): it leaves whatever we already
      // recovered untouched AND leaves the recovery read armed, so the next
      // tick retries — only a PRESENT array (possibly `[]`, a verified empty
      // registry) completes the once-per-mount read.
      const captureRegistry = (registryTasks?: RegistryTaskEntry[]) => {
        if (!registryTasks) return;
        registryReadDoneRef.current = serverName;
        const previous = registryHandlesRef.current;
        registryHandlesRef.current = new Map(
          registryTasks.map((entry) => [
            entry.taskId,
            {
              ...entry,
              // A terminal handle's one recovery read (see below) stays spent
              // across re-reads: a manual refresh must not re-fetch a result
              // we already read (or already gave up on).
              ...(previous.get(entry.taskId)?.terminalReadDone
                ? { terminalReadDone: true }
                : {}),
            },
          ])
        );
      };

      // The extension has no tasks/list: the tracker is the list.
      //
      // On the legacy wire the call returns EVERY task at once, so "is this
      // due" is a question about the list as a whole: issue it when we have
      // never listed, or when at least one previously-listed active task has
      // reached its own floor. Calling it on every tick would read a 30s task
      // at the tab's pace just because a 1s task shares the connection — the
      // same floor breach the per-task scheduler exists to prevent, one level
      // up.
      // Ids a live read CONFIRMED gone this tick. They answered — retired,
      // not unreachable — so they must not be classified as failed reads
      // below: a tracked handle gets its expired placeholder instead, and a
      // registry-recovered one (which has no tracker entry to hang a
      // placeholder on) simply leaves the list.
      const confirmedGoneIds = new Set<string>();
      const onUnknownTask = (taskId: string) => {
        // Stop scheduling it too. Without this the engine's map grows for the
        // life of the session, and a record that stays due-but-never-polled
        // pins `msUntilNextDue()` at zero, collapsing every re-arm to the
        // floor.
        scheduler.forget([taskId]);
        // Unknown/expired is not an error: flag it and keep the handle so the
        // user sees what happened instead of a silent removal. Any other
        // failure (transient connect, structureless 404 from an older hosted
        // replica) keeps the handle untouched and retries on the next tick.
        markTaskExpired(taskId, serverName);
        // A recovered handle the server has forgotten is done for good: drop
        // the registry entry so it is neither re-polled nor re-rendered.
        // (`markTaskExpired` above no-ops for ids the tracker never held.)
        registryHandlesRef.current.delete(taskId);
        confirmedGoneIds.add(taskId);
      };

      let listedCarriedForward: NormalizedTask[] = [];
      if (taskCapabilities?.list) {
        // `tasks/list` is an INSEPARABLE batch: one request returns every task,
        // so issuing it reads — and reschedules — the slowest member along with
        // the fastest. Gating on "any member is due" therefore lets a task
        // advertising 1s drag a task advertising 60s down to 1s polling: the
        // exact floor breach the per-task scheduler exists to prevent, one
        // level up. A batch's floor is its SLOWEST member's, so every active
        // member has to be due before the call goes out.
        //
        // Terminal rows are excluded rather than counted. They never become due
        // again, so including even one would freeze the list forever. When
        // nothing active is left there is no floor to breach at all, and
        // listing is how a task created elsewhere gets discovered — so that
        // case falls back to the tab's own tick.
        const knownListed = listedTasksRef.current;
        const activeListed = knownListed.filter(
          (task) => !isTerminalStatus(task.status)
        );
        const dueListed = scheduler.dueTaskIds(
          activeListed.map((task) => task.taskId)
        );
        const listDue =
          activeListed.length === 0 || dueListed.length === activeListed.length;

        if (listDue) {
          try {
            serverResult = await listTasks(serverName);
            serverTaskIds = new Set(serverResult.tasks.map((t) => t.taskId));
            captureRegistry(serverResult.registryTasks);
          } finally {
            // Claims taken by the due check above. The fold-back below releases
            // what it covers; this releases the rest (terminal members, and any
            // id the list no longer returns) so a claim cannot outlive its tick.
            scheduler.release(dueListed);
          }
        } else {
          // Not due as a batch: keep the last snapshot on screen rather than
          // blanking the list, and do not re-issue the call.
          listedCarriedForward = knownListed;
          serverTaskIds = new Set(knownListed.map((task) => task.taskId));

          // ...but the batch's floor must not STARVE its fastest member. A
          // listed id is excluded from the per-handle path below (it is in
          // `serverTaskIds`), so with a 1s task and a 60s task sharing the
          // list, waiting for the batch would leave the 1s task unread for a
          // minute — long enough to finish, and on a short TTL to be forgotten,
          // before anything observed it. Each individually-due member gets its
          // own `tasks/get` instead: discovery keeps the slowest member's
          // floor, status does not.
          const refreshed = await Promise.all(
            dueListed.map(async (taskId) => {
              try {
                const envelope = await getTask(serverName, taskId);
                return normalizeTask(envelope.wire, envelope.task);
              } catch (err) {
                if (err instanceof TaskUnknownOrExpiredError) {
                  onUnknownTask(taskId);
                }
                // Anything else is transient; the handle backs off below.
                return null;
              }
            })
          );
          const byRefreshedId = new Map(
            refreshed
              .filter((task): task is NormalizedTask => task !== null)
              .map((task) => [task.taskId, task])
          );
          scheduler.recordObservations(
            [...byRefreshedId.values()].map((task) => ({
              taskId: task.taskId,
              status: task.status,
              pollIntervalMs: task.pollInterval,
              ttlMs: task.ttl ?? null,
              lastUpdatedAt: task.lastUpdatedAt,
            }))
          );
          // Reads that produced nothing back off; both calls release the claim.
          scheduler.recordErrors(
            dueListed.filter((taskId) => !byRefreshedId.has(taskId))
          );
          listedCarriedForward = knownListed.map(
            (task) => byRefreshedId.get(task.taskId) ?? task
          );
        }
      }

      // The ONE registry recovery read of this mount (re-armed by a manual
      // refresh), for ticks where the ordinary `tasks/list` did not run — on
      // the extension wire it never runs, and there the route answers
      // `{tasks: []}` locally while the registry attachment is the only way a
      // fresh browser can discover a running task at all. Hosted-only: local
      // mode has no registry and the extra call would buy nothing.
      if (hosted && registryReadDoneRef.current !== serverName) {
        try {
          const recovery = await listTasks(serverName);
          captureRegistry(recovery.registryTasks);
        } catch {
          // Leave the ref unset: the next tick retries the recovery read.
        }
      }

      // Get locally tracked tasks and fetch their current status
      const trackedTasks = getTrackedTasksForServer(serverName);
      const pending = trackedTasks
        .filter((t) => !serverTaskIds.has(t.taskId))
        .filter((t) => !dismissedIds.has(t.taskId));

      // Registry-recovered handles this browser does not track. Merge filter:
      // same wire as the tab, not dismissed here, not already in the server's
      // list, not already tracked (the tracker copy wins — it carries scheduling
      // state the registry doesn't).
      const trackedIds = new Set(trackedTasks.map((t) => t.taskId));
      const recoveredEntries = [...registryHandlesRef.current.values()].filter(
        (entry) =>
          entry.wire === wire &&
          !dismissedIds.has(entry.taskId) &&
          !serverTaskIds.has(entry.taskId) &&
          !trackedIds.has(entry.taskId)
      );
      // A terminal registry row renders as a placeholder and is not part of
      // the recurring poll set — with ONE exception. On the EXTENSION wire a
      // completed result / failed error is carried EXCLUSIVELY by `tasks/get`
      // (there is no `tasks/result`), and the registry stores neither: a
      // recovered `completed`/`failed` handle is a status with nothing behind
      // it, so it owes exactly one bounded recovery read for its inline
      // result. `cancelled` (and the registry's own `expired`) owe nothing —
      // there is no result to fetch — and the legacy wire keeps its
      // placeholder-only behavior: its results come from `tasks/result`
      // semantics, which this one-shot must not be conflated with.
      const recoveredTerminal = recoveredEntries.filter((entry) =>
        isTerminalRegistryStatus(entry.lastKnownStatus)
      );
      const terminalNeedingRead = isExtensionWire
        ? recoveredTerminal.filter(
            (entry) =>
              (entry.lastKnownStatus === "completed" ||
                entry.lastKnownStatus === "failed") &&
              !entry.terminalReadDone
          )
        : [];
      const terminalReadIdSet = new Set(
        terminalNeedingRead.map((entry) => entry.taskId)
      );
      // Spent at ISSUE time, success or not: the read is bounded to one
      // attempt, and a failure below falls back to the placeholder rather
      // than retrying forever against a server that may have purged the task.
      for (const entry of terminalNeedingRead) entry.terminalReadDone = true;
      const recoveredActive = recoveredEntries.filter(
        (entry) => !isTerminalRegistryStatus(entry.lastKnownStatus)
      );
      const recoveredById = new Map(
        recoveredActive.map((entry) => [entry.taskId, entry])
      );
      // Non-terminal recovered ids join the same due-gated poll set as
      // tracked handles. The scheduler has never seen them and the tracker
      // holds no persisted schedule, so they are due immediately — once; the
      // observations recorded from that first read seed their real floors.
      const dueRecovered = scheduler.dueTaskIds(
        recoveredActive.map((entry) => entry.taskId)
      );
      const dueRecoveredSet = new Set(dueRecovered);
      const notDueRecovered = recoveredActive.filter(
        (entry) => !dueRecoveredSet.has(entry.taskId)
      );
      // An expired handle is never re-polled: the server has forgotten it, so
      // it renders from tracker data until the user dismisses it.
      const expiredEntries = pending
        .filter((t) => t.expired)
        .map((t) => expiredPlaceholderTask(t));
      // Only the handles whose own floor has elapsed. A tick that read every
      // pending handle would poll a 30s task at the tab's 1s pace.
      const dueIds = new Set(
        scheduler.dueTaskIds(
          pending.filter((t) => !t.expired).map((t) => t.taskId)
        )
      );
      const livePending = pending.filter(
        (t) => !t.expired && dueIds.has(t.taskId)
      );
      // Handles that exist but are not due keep their last-known state on
      // screen rather than blinking out until their next read.
      const notDue = pending.filter((t) => !t.expired && !dueIds.has(t.taskId));
      const byId = new Map(livePending.map((t) => [t.taskId, t]));
      const pendingIds = [
        ...livePending.map((t) => t.taskId),
        // Due registry-recovered handles ride the same batch; their results
        // (and -32602s) are handled exactly like tracked ones below, except
        // that nothing is ever written into the tracker for them.
        ...dueRecovered,
        // The one-shot terminal recovery reads (extension wire only). These
        // bypass the scheduler — they are not a recurring poll — and are
        // excluded from the failed-read bookkeeping below for the same reason.
        ...terminalNeedingRead.map((entry) => entry.taskId),
      ];

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
            })
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
          })
        );
      }
      // Feed the scheduler what we actually observed, so each handle is
      // rescheduled by its OWN advertised floor. A due handle that came back
      // empty is a failed read: it backs off rather than being retried at the
      // tab's pace.
      // Expired PLACEHOLDERS are excluded. `expiredPlaceholderTask` returns a
      // real `NormalizedTask`, so without this filter it would flow into
      // `recordObservations` and re-register the very handle `onUnknownTask`
      // just told the scheduler to forget — and it carries a display-only
      // status that is not a lifecycle status, so the resurrected record would
      // never read as terminal, stay permanently due, and pin
      // `msUntilNextDue()` at zero for the rest of the session.
      const observed = trackedTaskStatuses.filter(
        (task): task is NormalizedTask => task !== null && !task.expired
      );
      scheduler.recordObservations(
        observed.map((task) => ({
          taskId: task.taskId,
          status: task.status,
          pollIntervalMs: task.pollInterval,
          ttlMs: task.ttl ?? null,
          lastUpdatedAt: task.lastUpdatedAt,
        }))
      );
      const settledIds = new Set(
        trackedTaskStatuses
          .filter((task): task is NormalizedTask => task !== null)
          .map((task) => task.taskId)
      );
      // Only ids that produced NOTHING are failed reads. A confirmed-expired
      // handle answered — it is retired, not unreachable — and backing it off
      // would be recording an error against a handle nobody will poll again.
      const failedIds = pendingIds.filter(
        (id) =>
          !settledIds.has(id) &&
          !confirmedGoneIds.has(id) &&
          // A failed one-shot terminal read is spent, not backed off: it must
          // neither enter the scheduler's error bookkeeping nor keep the
          // auto-refresh loop armed. The placeholder fallback below covers it.
          !terminalReadIdSet.has(id)
      );
      scheduler.recordErrors(failedIds);

      // A handle that was not due this tick keeps its last-known state rather
      // than disappearing from the list until its next read.
      //
      // The fallback is load-bearing, not defensive. On the FIRST tick after a
      // reload `tasksRef.current` is empty while every restored handle is
      // not-yet-due, so without it the list renders empty — which makes
      // `hasActiveTasks` false, so auto-refresh never starts, so the handle is
      // never polled when its floor finally elapses. The task would stay
      // invisible until a manual refresh, and could expire server-side first.
      const previousById = new Map(
        tasksRef.current.map((task) => [task.taskId, task])
      );
      const carriedForward = notDue.map(
        (tracked) =>
          previousById.get(tracked.taskId) ?? restoredPlaceholderTask(tracked)
      );

      // A due read that FAILED keeps its row for exactly the same reason. The
      // failure is transient by construction — a confirmed `-32602` produced an
      // expired placeholder instead, and never lands here — so dropping the row
      // would be self-defeating: with the last active task gone from the list,
      // `hasActiveTasks` goes false, auto-refresh stops, and the backoff
      // `recordErrors` just persisted is never actually retried. The handle
      // strands until the user does something, which is the opposite of what a
      // backoff is for.
      const failedCarriedForward = failedIds
        .map((taskId) => {
          const previous = previousById.get(taskId);
          if (previous) return previous;
          const tracked = byId.get(taskId);
          if (tracked) return restoredPlaceholderTask(tracked);
          const recovered = recoveredById.get(taskId);
          return recovered ? registryPlaceholderTask(recovered) : null;
        })
        .filter((task): task is NormalizedTask => task !== null);

      // Recovered handles that were not due this tick, and terminal registry
      // rows (render-only, never polled), keep a row on screen: last live
      // state when we have one, otherwise the registry's own last-known view.
      const recoveredCarriedForward = notDueRecovered.map(
        (entry) => previousById.get(entry.taskId) ?? registryPlaceholderTask(entry)
      );

      // Terminal registry rows: a handle whose one-shot read answered this
      // tick already has its live row in `trackedTaskStatuses` (and later
      // ticks carry it via `previousById`); a confirmed -32602 dropped it; a
      // failed or never-owed read renders the registry placeholder.
      const recoveredTerminalRows = recoveredTerminal
        .filter(
          (entry) =>
            !settledIds.has(entry.taskId) && !confirmedGoneIds.has(entry.taskId)
        )
        .map(
          (entry) =>
            previousById.get(entry.taskId) ?? registryPlaceholderTask(entry)
        );

      trackedTaskStatuses = [
        ...trackedTaskStatuses,
        ...carriedForward,
        ...failedCarriedForward,
        ...recoveredCarriedForward,
        ...recoveredTerminalRows,
        ...expiredEntries,
      ];

      // Merge server tasks with tracked tasks (tracked tasks first for recency)
      // Filter out dismissed tasks from server results
      const listed =
        listedCarriedForward.length > 0
          ? listedCarriedForward.filter((t) => !dismissedIds.has(t.taskId))
          : serverResult.tasks
              .filter((t) => !dismissedIds.has(t.taskId))
              .map((t) =>
                normalizeTask("legacy", t as unknown as Record<string, unknown>)
              );
      listedTasksRef.current = listed;
      // Learn each listed task's own floor, so the NEXT decision about whether
      // to call `tasks/list` is made per task rather than at the tab's pace.
      if (listedCarriedForward.length === 0 && listed.length > 0) {
        scheduler.recordObservations(
          listed
            .filter((task) => !isTerminalStatus(task.status))
            .map((task) => ({
              taskId: task.taskId,
              status: task.status,
              pollIntervalMs: task.pollInterval,
              ttlMs: task.ttl ?? null,
              lastUpdatedAt: task.lastUpdatedAt,
            }))
        );
      }

      const allTasks: NormalizedTask[] = [
        ...trackedTaskStatuses.filter((t): t is NormalizedTask => t !== null),
        ...listed,
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
  }, [serverName, taskCapabilities, hosted, wire, scheduler]);

  // The Refresh button, as distinct from a tick.
  //
  // A recovery read the tab has given up on is sitting on a backoff that can
  // be a minute long, so plain `fetchTasks` would find it not due and the
  // button would look broken on the one handle the message just told the user
  // to retry. A person clicking Refresh is a better signal than our own guess
  // about a failing transport, so their click drops that guess — and only that
  // one: the server's advertised floor and any `Retry-After` still hold, and
  // the automatic loop keeps backing off exactly as before.
  const handleManualRefresh = useCallback(() => {
    scheduler.retryRecoveryReads(recoveryReads.exhaustedTaskIds);
    // Re-arm the once-per-mount registry recovery read: a person clicking
    // Refresh is exactly the "did I lose a task somewhere?" moment.
    registryReadDoneRef.current = null;
    void fetchTasks();
  }, [scheduler, recoveryReads, fetchTasks]);

  // -------------------------------------------------------------------------
  // Extension task notifications (local persistent connections only).
  //
  // The Tasks tab OWNS the `taskIds` member of the desired subscription
  // interests: the ids worth being told about are exactly the ones this
  // browser tracks — extension wire, not dismissed, not terminal. The
  // SubscriptionStreamsPanel owns every other member, so writes here are
  // fetch-merge-post, never replace. A delivered `notifications/tasks` is a
  // POLL-NOW HINT and nothing more: it triggers one immediate `tasks/get`
  // through the same observation path a scheduled poll uses, and the
  // notification params are never written into state as truth. Polling stays
  // fully sufficient; hosted mode (reconnect-per-op, no persistent stream)
  // posts no `taskIds` at all.
  // -------------------------------------------------------------------------

  /** The active notification interest set, sorted for a stable signature. */
  const notificationTaskIds = useMemo(() => {
    if (!serverName || hosted || !isExtensionWire) return [] as string[];
    const dismissed = getDismissedTaskIds(serverName);
    const tracked = new Set(
      getTrackedTasksForServer(serverName).map((t) => t.taskId)
    );
    return tasks
      .filter(
        (t) =>
          tracked.has(t.taskId) &&
          !dismissed.has(t.taskId) &&
          !t.expired &&
          !isTerminalStatus(t.status)
      )
      .map((t) => t.taskId)
      .sort();
  }, [serverName, hosted, isExtensionWire, tasks]);

  // Debounced fetch-merge-post of the interest set on active-set change.
  useEffect(() => {
    if (!serverName || hosted || !isExtensionWire) return;
    const signature = JSON.stringify(notificationTaskIds);
    if (postedTaskInterestsRef.current === signature) return;
    if (
      postedTaskInterestsRef.current === null &&
      notificationTaskIds.length === 0
    ) {
      // Nothing to declare and nothing declared before: do not touch the
      // panel-owned desired filter at all.
      postedTaskInterestsRef.current = signature;
      return;
    }
    const timer = setTimeout(async () => {
      try {
        // Merge over the CURRENT bridge state so the interests the
        // Subscriptions panel owns survive; only `taskIds` is ours to write
        // (and to remove, once the set empties).
        const state = await fetchSubscriptionState(serverName);
        const { taskIds: _ours, ...panelOwned } = state.desired;
        await setDesiredSubscriptionInterests(serverName, {
          ...panelOwned,
          ...(notificationTaskIds.length > 0
            ? { taskIds: notificationTaskIds }
            : {}),
        });
        postedTaskInterestsRef.current = signature;
      } catch {
        // Notifications only ever reduce polling latency; a failed post
        // changes nothing about correctness. The ref stays unset, so the
        // next active-set change (or effect re-run) retries.
      }
    }, TASK_INTEREST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [serverName, hosted, isExtensionWire, notificationTaskIds]);

  /**
   * The poll-now hint's landing: ONE immediate `tasks/get` for the notified
   * task, folded back through the scheduler exactly like a scheduled read.
   * `tasks/get` stays the source of truth — the notification's own params are
   * discarded.
   */
  const refreshNotifiedTask = useCallback(
    async (taskId: string) => {
      if (!serverName) return;
      // Untracked or dismissed ids are ignored: the interest filter should
      // exclude them already, but the server chooses what it sends.
      const tracked = getTrackedTasksForServer(serverName).some(
        (t) => t.taskId === taskId
      );
      if (!tracked) return;
      if (getDismissedTaskIds(serverName).has(taskId)) return;
      const inFlight = notifiedRefreshInFlightRef.current;
      if (inFlight.has(taskId)) return;
      inFlight.add(taskId);
      try {
        const envelope = await getTask(serverName, taskId);
        const refreshed = normalizeTask(envelope.wire, envelope.task);
        // Same fold-back as a scheduled poll: the observation reschedules the
        // handle by its own advertised floor.
        scheduler.recordObservations([
          {
            taskId: refreshed.taskId,
            status: refreshed.status,
            pollIntervalMs: refreshed.pollInterval,
            ttlMs: refreshed.ttl ?? null,
            lastUpdatedAt: refreshed.lastUpdatedAt,
          },
        ]);
        setTasks((prev) =>
          prev.some((t) => t.taskId === taskId)
            ? prev.map((t) => (t.taskId === taskId ? refreshed : t))
            : [refreshed, ...prev]
        );
      } catch (err) {
        if (err instanceof TaskUnknownOrExpiredError) {
          scheduler.forget([taskId]);
          markTaskExpired(taskId, serverName);
        }
        // Anything else is transient; the ordinary poll loop retries on its
        // own schedule — the hint carried no obligation.
      } finally {
        inFlight.delete(taskId);
      }
    },
    [serverName, scheduler]
  );

  // Observe the bridge's SSE broadcast for `tasks` notifications. Local mode
  // only: hosted connections are reconnect-per-op and never hold the
  // persistent stream a listen rides on.
  useEffect(() => {
    if (!serverName || hosted || !isExtensionWire || !isActive) return;
    // Environments without SSE (jsdom without a stub, SSR) simply keep
    // polling; the notification channel is an optional latency win.
    if (typeof EventSource === "undefined") return;
    const es = new EventSource(addTokenToUrl("/api/mcp/subscriptions/stream"));
    es.onmessage = (ev) => {
      let event: SubscriptionBridgeEvent;
      try {
        event = JSON.parse(ev.data) as SubscriptionBridgeEvent;
      } catch {
        return;
      }
      if (event.type !== "subscription_notification") return;
      if (event.serverId !== serverName) return;
      const notification = event.notification;
      if (notification.kind !== "tasks" || !notification.taskId) return;
      void refreshNotifiedTask(notification.taskId);
    };
    return () => es.close();
  }, [serverName, hosted, isExtensionWire, isActive, refreshNotifiedTask]);

  // Handle elicitation response from the dialog
  const handleElicitationResponse = useCallback(
    async (
      action: "accept" | "decline" | "cancel",
      parameters?: Record<string, unknown>
    ) => {
      try {
        await respondToElicitation(action, parameters);
        // Refresh tasks to get updated status after responding
        await fetchTasks();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to respond to elicitation"
        );
      }
    },
    [respondToElicitation, fetchTasks]
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
          err instanceof Error ? err.message : "Failed to fetch task result"
        );
      } finally {
        setLoading(false);
      }
    },
    [serverName]
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
        setCancellationRequested((prev) => new Set(prev).add(selectedTaskId));
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
    async (inputResponses: Record<string, unknown>): Promise<boolean> => {
      if (!serverName || !selectedTaskId) return false;
      setSubmittingInput(true);
      setError("");
      try {
        await updateTask(serverName, selectedTaskId, inputResponses);
        await fetchTasks();
        return true;
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to submit task input"
        );
        return false;
      } finally {
        setSubmittingInput(false);
      }
    },
    [serverName, selectedTaskId, fetchTasks]
  );

  const handleExtensionInputResponse = useCallback(
    async (
      action: "accept" | "decline" | "cancel",
      parameters?: Record<string, unknown>
    ) => {
      if (!extensionInputRequest) return;
      // Partial responses are allowed: answer the key the user just handled.
      // SEP-2663 `InputResponse` is the BARE result object — never wrapped in a
      // `{method, result}` envelope, which a conforming server would ignore
      // (leaving the task stuck in `input_required`).
      const key = extensionInputRequest.key;
      const acknowledged = await handleSubmitInputResponses({
        [key]: {
          action,
          ...(action === "accept" && parameters ? { content: parameters } : {}),
        },
      });
      // ONLY after the acknowledgement. Marking the key optimistically would
      // silently discard the user's answer whenever the update failed: the
      // re-sent snapshot would still carry the key, we would skip it as
      // "answered", and the task would sit in `input_required` forever.
      if (!acknowledged) return;
      setAnsweredInputKeys((prev) => {
        const next = new Map(prev);
        const keys = new Set(next.get(selectedTaskId) ?? []);
        keys.add(key);
        next.set(selectedTaskId, keys);
        return next;
      });
      // Durable, so a reload does not re-prompt. Keys only — never the prompt
      // or the response.
      scheduler.markInputResponded(selectedTaskId, [key]);
    },
    [
      extensionInputRequest,
      handleSubmitInputResponses,
      selectedTaskId,
      scheduler,
    ]
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

  // Fetch task capabilities when the server changes AND when its connection
  // comes up. Per MCP Tasks spec (2025-11-25) clients SHOULD check
  // capabilities before using task features — but the probe fails closed to
  // `wire: "none"` against a not-yet-connected server, so a fetch keyed only
  // on server identity can race the connect and stick on "Tasks not
  // supported" forever. Keying on `isServerConnected` re-probes once the
  // connection is actually up (and again after a reconnect).
  const isServerConnected = connectionStatus === "connected";
  useEffect(() => {
    if (!serverConfig || !serverName) {
      setTaskCapabilities(undefined);
      return;
    }

    // Reset to undefined while fetching
    setTaskCapabilities(undefined);
    // Registry recovery is per server: drop the previous server's handles and
    // re-arm the one recovery read for the new one.
    registryHandlesRef.current = new Map();
    registryReadDoneRef.current = null;
    // The notification interest set is per server too: the new server's
    // bridge has no `taskIds` posted yet, whatever the old one had.
    postedTaskInterestsRef.current = null;

    const fetchCapabilities = async () => {
      try {
        const capabilities = await getTaskCapabilities(serverName);
        setTaskCapabilities(capabilities);
      } catch {
        // The PROBE failed (transient), which is not the same thing as the
        // server declaring no tasks — null renders a retryable error state.
        setTaskCapabilities(null);
      }
    };

    fetchCapabilities();
  }, [serverConfig, serverName, isServerConnected, capabilitiesFetchAttempt]);

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

  // Auto-refresh: a self-rearming timeout rather than a fixed interval.
  //
  // The delay is whatever the scheduler says the SOONEST task is waiting for,
  // clamped to the tab's own pace. A fixed `setInterval(pollInterval)` would
  // wake up at the fastest task's rate and then find nothing due — burning a
  // render and, on the hosted path, tempting a connection per tick. Only poll
  // when the tab is active.
  useEffect(() => {
    if (!autoRefresh || !serverName || !isActive) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const arm = (delayMs: number) => {
      timer = setTimeout(async () => {
        if (cancelled) return;
        // `finally`, so a throw escaping `fetchTasks` cannot break the chain
        // permanently and silently — the switch would still read "Auto" while
        // nothing ticked again until a dependency changed.
        try {
          await fetchTasks();
        } finally {
          if (!cancelled) {
            // The EARLIEST due handle, floored only by the global terms.
            arm(Math.max(scheduler.msUntilNextDue(), tickFloorMs));
          }
        }
      }, delayMs);
    };
    arm(tickFloorMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [autoRefresh, serverName, fetchTasks, tickFloorMs, isActive, scheduler]);

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

  // The capabilities probe itself failed (network, auth, or it raced the
  // connect). That says nothing about the server's tasks support — offer a
  // retry instead of a false "not supported".
  if (taskCapabilities === null) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Couldn't check tasks support"
        description="The tasks capability check failed — the server may still be connecting."
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCapabilitiesFetchAttempt((n) => n + 1)}
        >
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Retry
        </Button>
      </EmptyState>
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
              onClick={handleManualRefresh}
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

        {/* Giving up on a recovery read has to SAY so. Going quietly idle is
            the failure this whole path exists to prevent: the row still reads
            "completed" while its result was never fetched, so silence would
            look like success. */}
        {recoveryReads.exhaustedTaskIds.length > 0 && (
          <div className="px-2 pb-1.5 flex items-start gap-1.5">
            <AlertCircle className="h-3 w-3 text-warning mt-[3px] flex-shrink-0" />
            <p className="text-[10px] text-muted-foreground leading-snug">
              Could not read back{" "}
              {recoveryReads.exhaustedTaskIds.length === 1
                ? "1 restored task's result"
                : `${recoveryReads.exhaustedTaskIds.length} restored tasks' results`}{" "}
              after {MAX_RECOVERY_READ_ATTEMPTS} attempts. Stopped retrying
              automatically — use Refresh to try again.
            </p>
          </div>
        )}
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
                  className={`text-xs ${
                    statusConfigFor(selectedTask.status).bgColor
                  } ${statusConfigFor(selectedTask.status).color} border-0`}
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
        elicitationRequest={
          extensionDialogElicitation ?? legacyDialogElicitation
        }
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
