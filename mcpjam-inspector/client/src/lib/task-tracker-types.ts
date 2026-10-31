import type { LiveTasksWire, TaskLifecycleIdentity } from "@mcpjam/sdk/browser";
import type { TasksWire } from "./apis/mcp-tasks-api";

export type PrimitiveType = "tool" | "prompt" | "resource";

export type TaskAccountSelection = { connectionId?: string; wire?: TasksWire };

export interface TrackedTask {
  taskId: string;
  serverId: string;
  wire: LiveTasksWire;
  connectionId?: string;
  sourceExecutionId?: string;
  serverName?: string;
  createdAt: string;
  toolName?: string;
  primitiveType?: PrimitiveType;
  primitiveName?: string;
  dismissed?: boolean;
  /** Server no longer knows this task (JSON-RPC -32602 on a read). */
  expired?: boolean;
  /**
   * Auth/org context the handle was created under (hosted projectId).
   * Undefined for purely local entries, which have no cross-account risk.
   */
  scope?: string;

  // ---- v3: resumable scheduling state -------------------------------------
  /** Last `lastUpdatedAt` observed from the server. Never inferred locally. */
  lastUpdatedAt?: string;
  /** Latest observed status, so a reload can render before the first poll. */
  status?: string;
  /** Latest `ttlMs`. `null` means the server said "no expiry". */
  ttlMs?: number | null;
  /** Latest server-advertised poll floor. MAY change in either direction. */
  pollIntervalMs?: number;
  /** Epoch ms this handle may next be polled; survives a reload. */
  nextPollAt?: number;
  /** Epoch ms a live read last answered for this handle, any status. */
  lastObservedAt?: number;
  /**
   * Input keys whose `tasks/update` was acknowledged. KEYS ONLY — never the
   * request, the prompt, or the response. This is what stops a reload from
   * re-prompting for something the user already answered.
   */
  respondedInputKeys?: string[];
}

export interface TaskObservationPatch {
  status?: string;
  lastUpdatedAt?: string;
  ttlMs?: number | null;
  pollIntervalMs?: number;
  nextPollAt?: number;
  lastObservedAt?: number;
}

export type TaskIdentityRef = TaskLifecycleIdentity;

/** Scheduling and acknowledged inputs restored after a reload. */
export interface TrackedTaskRestoreState {
  nextPollAt?: number;
  lastObservedAt?: number;
  pollIntervalMs?: number;
  ttlMs?: number | null;
  status?: string;
  respondedInputKeys: string[];
}
