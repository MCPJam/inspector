/**
 * Transient SSE data part carrying the harness's working directory for a turn.
 *
 * A Claude Code harness runs each turn inside `/home/user/claude-code-<sessionId>`
 * on the project computer. The server knows this path during the turn; it streams
 * it to the client so the Playground Shell can open a terminal there instead of in
 * the box's home. Transient (not persisted): the client caches the latest path and
 * passes it as the terminal `cwd`.
 */
export interface HarnessSessionInfo {
  /** Absolute path of the harness session workdir on the computer. */
  workdir: string;
}

export interface HarnessSessionDataPart {
  type: "data-harness-session";
  data: HarnessSessionInfo;
}

export function isHarnessSessionDataPart(
  value: unknown,
): value is HarnessSessionDataPart {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "data-harness-session") {
    return false;
  }
  const data = candidate.data;
  if (!data || typeof data !== "object") {
    return false;
  }
  const workdir = (data as Record<string, unknown>).workdir;
  // The contract is an ABSOLUTE path (it becomes the terminal cwd) — reject
  // relative or whitespace-padded values instead of letting cwd drift.
  return (
    typeof workdir === "string" &&
    workdir === workdir.trim() &&
    workdir.startsWith("/")
  );
}

/**
 * Why a harness turn could NOT warm-resume the prior in-box session and started
 * a fresh one. Surfaced to the client so a silent reset (the user's earlier
 * context is gone) becomes a visible, explainable notice instead of the model
 * appearing to "forget" everything.
 *
 *  - `sandbox-replaced`   — the project computer was reprovisioned between turns
 *                           (new sandbox / fresh disk); the saved session is
 *                           unrecoverable.
 *  - `legacy-cold-resume` — the saved sidecar predates warm-detach (no bridge
 *                           coordinates); resume is still attempted from disk but
 *                           continuity isn't guaranteed. (Logged, not necessarily
 *                           shown — it's an attempt, not a hard reset.)
 *  - `resume-failed`      — reattaching to the saved session threw; fell back fresh.
 *  - `runtime-changed`    — the chat's saved session was built for a different
 *                           runtime (model, servers, skills, permission mode or
 *                           transport), so it can't be resumed.
 *
 * NEVER carries raw E2B sandbox ids — only the categorical reason.
 */
export type HarnessResetReason =
  | "sandbox-replaced"
  | "legacy-cold-resume"
  | "resume-failed"
  | "runtime-changed";

export interface HarnessResetInfo {
  reason: HarnessResetReason;
}

export interface HarnessResetDataPart {
  type: "data-harness-reset";
  data: HarnessResetInfo;
}

const HARNESS_RESET_REASONS: ReadonlySet<HarnessResetReason> = new Set([
  "sandbox-replaced",
  "legacy-cold-resume",
  "resume-failed",
  "runtime-changed",
]);

export function isHarnessResetDataPart(
  value: unknown,
): value is HarnessResetDataPart {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "data-harness-reset") {
    return false;
  }
  const data = candidate.data;
  return (
    !!data &&
    typeof data === "object" &&
    typeof (data as Record<string, unknown>).reason === "string" &&
    HARNESS_RESET_REASONS.has(
      (data as Record<string, unknown>).reason as HarnessResetReason,
    )
  );
}

/**
 * Progress of a Claude Code turn's background work, while the bridge holds the
 * turn open for it (the "background drain", `claude-code-background-drain.ts`).
 * Transient: never persisted, so a reload shows only the answers.
 *
 *  - `task`      — a background task started or settled. `toolUseId` is the
 *                  Agent/Bash/Workflow tool call that started it, so the client
 *                  can attach the status to that tool's card.
 *  - `notice`    — something the drain did (`draining`, `idle`, `cap`,
 *                  `stopped`, a denied background approval, a background
 *                  task's failure).
 *  - `keepalive` — sent on a timer while the turn waits, so the stream never
 *                  goes silent long enough for a proxy to cut it.
 */
export type HarnessBackgroundTaskInfo =
  | {
      kind: "task";
      taskId: string;
      status: string;
      toolUseId?: string;
      description?: string;
      subagentType?: string;
      taskType?: string;
    }
  | { kind: "notice"; reason: string }
  | { kind: "keepalive" };

export interface HarnessBackgroundTaskDataPart {
  type: "data-harness-background-task";
  data: HarnessBackgroundTaskInfo;
}

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Read the bridge's `raw` drain parts (`{ mcpjam: "background-task" … }` and
 * `{ mcpjam: "drain-notice", reason }`). Anything else is not ours: undefined.
 */
export function harnessBackgroundTaskInfoFromRaw(
  rawValue: unknown,
): HarnessBackgroundTaskInfo | undefined {
  if (!rawValue || typeof rawValue !== "object") return undefined;
  const raw = rawValue as Record<string, unknown>;
  if (raw.mcpjam === "background-task") {
    const taskId = optionalString(raw.taskId);
    const status = optionalString(raw.status);
    if (!taskId || !status) return undefined;
    const toolUseId = optionalString(raw.toolUseId);
    const description = optionalString(raw.description);
    const subagentType = optionalString(raw.subagentType);
    const taskType = optionalString(raw.taskType);
    return {
      kind: "task",
      taskId,
      status,
      ...(toolUseId ? { toolUseId } : {}),
      ...(description ? { description } : {}),
      ...(subagentType ? { subagentType } : {}),
      ...(taskType ? { taskType } : {}),
    };
  }
  if (raw.mcpjam === "drain-notice") {
    const reason = optionalString(raw.reason);
    return reason ? { kind: "notice", reason } : undefined;
  }
  return undefined;
}

export function isHarnessBackgroundTaskDataPart(
  value: unknown,
): value is HarnessBackgroundTaskDataPart {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "data-harness-background-task") return false;
  const data = candidate.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") return false;
  if (data.kind === "keepalive") return true;
  if (data.kind === "notice") return typeof data.reason === "string";
  return (
    data.kind === "task" &&
    typeof data.taskId === "string" &&
    typeof data.status === "string"
  );
}
