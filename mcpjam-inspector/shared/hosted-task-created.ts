/**
 * Hosted delivery of a created MCP task, browser-bound.
 *
 * A task created during a hosted chat turn exists on the MCP server whether or
 * not the browser ever hears about it. This part is how the browser learns the
 * handle in time to track it, so the user's next page load can poll it rather
 * than discovering an orphaned task nobody is watching.
 *
 * ## Deliberately thin
 *
 * The payload carries no result, no `inputRequests` and no tool arguments.
 * Consumers of this part persist and route; live state always comes from
 * `tasks/get` against the server. Anything richer here would be a second source
 * of truth that goes stale the moment it is written.
 */

/**
 * Version of the hosted-tasks wire contract the client speaks, sent on every
 * chat request as `hostedTasksVersion`.
 *
 * ## Why a mismatch degrades silently, unlike MRTR
 *
 * `hostedMrtrVersion` fails fast with a 409, and correctly so: an MRTR round is
 * a multi-step suspend → display → resume protocol, and a browser that cannot
 * resume strands a durable continuation until its TTL expires.
 *
 * This part is a one-way notification about a task that ALREADY EXISTS. The
 * tool call succeeded and may have had side effects; the server work is running
 * regardless. Refusing the turn over an unrecognized notification would convert
 * a successful call into a failed one while the task runs on — strictly worse
 * than the client simply not tracking it, which is the pre-feature behavior and
 * is recoverable from the server's own task list.
 *
 * So: absent or mismatched ⇒ no bridge, no part, 200. Never a 409.
 */
export const HOSTED_TASKS_VERSION = 1;

/** Wire literal for the stream data part carrying a {@link TaskCreatedPayload}. */
export const HOSTED_TASK_CREATED_DATA_PART_TYPE = "data-task-created" as const;

/** The two wires a live task can exist on. `none` is not a task-bearing wire. */
export type HostedTaskWire = "legacy" | "extension";

export interface TaskCreatedPayload {
  taskId: string;
  /**
   * The server's stable id, as the execution surface knows it. Hosted callers
   * pass a Convex document id here.
   */
  serverId: string;
  /**
   * The server's display NAME, and load-bearing rather than decorative.
   *
   * The browser's task tracker is keyed by server name — `ToolsTab` stores
   * `serverId: serverName`, and `TasksTab` reads back with
   * `getTrackedTasksForServer(serverName)`. A hosted `serverId` is a Convex
   * document id, so tracking a task under the id files it exactly where the
   * Tasks tab will never look. Both are carried; consumers prefer this.
   */
  serverName?: string;
  wire: HostedTaskWire;
  /** ISO timestamp from the server, never a local clock reading. */
  createdAt?: string;
  status?: string;
  /** The tool whose call produced this task. */
  toolName?: string;
  /** `null` means "no expiry", distinct from an absent field. */
  ttlMs?: number | null;
  pollIntervalMs?: number;
}

export interface TaskCreatedDataPart {
  type: typeof HOSTED_TASK_CREATED_DATA_PART_TYPE;
  data: TaskCreatedPayload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export function isTaskCreatedPayload(
  value: unknown,
): value is TaskCreatedPayload {
  if (!isRecord(value)) return false;
  if (typeof value.taskId !== "string" || value.taskId.length === 0) {
    return false;
  }
  if (typeof value.serverId !== "string" || value.serverId.length === 0) {
    return false;
  }
  if (value.wire !== "legacy" && value.wire !== "extension") return false;
  if (!isOptionalString(value.serverName)) return false;
  if (!isOptionalString(value.createdAt)) return false;
  if (!isOptionalString(value.status)) return false;
  if (!isOptionalString(value.toolName)) return false;
  // `null` is meaningful here (no expiry) and must pass.
  if (
    value.ttlMs !== undefined &&
    value.ttlMs !== null &&
    typeof value.ttlMs !== "number"
  ) {
    return false;
  }
  if (
    value.pollIntervalMs !== undefined &&
    typeof value.pollIntervalMs !== "number"
  ) {
    return false;
  }
  return true;
}

export function isTaskCreatedDataPart(
  value: unknown,
): value is TaskCreatedDataPart {
  if (!isRecord(value)) return false;
  return (
    value.type === HOSTED_TASK_CREATED_DATA_PART_TYPE &&
    isTaskCreatedPayload(value.data)
  );
}

/**
 * Whether a client speaking `clientVersion` should receive this part.
 *
 * Exact-match like MRTR's, but the CONSEQUENCE of a mismatch is different: see
 * {@link HOSTED_TASKS_VERSION}. The caller's only correct response to `false`
 * is to skip the bridge — never to reject the turn.
 */
export function isCompatibleHostedTasksVersion(clientVersion: unknown): boolean {
  return clientVersion === HOSTED_TASKS_VERSION;
}
