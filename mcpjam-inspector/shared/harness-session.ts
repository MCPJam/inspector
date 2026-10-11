/**
 * Transient SSE data part carrying the harness's working directory for a turn.
 *
 * A Claude Code harness runs each turn inside `/home/user/claude-code-<sessionId>`
 * on the project computer. The server knows this path during the turn; it streams
 * it to the client so the Playground Shell can open a terminal there instead of in
 * the box's home. Transient (not persisted): the client caches the latest path and
 * passes it as the terminal `cwd`.
 */
/**
 * Which machine the turn ran on.
 *
 *  - `personal`   — the member's own computer (the Shell rail's terminal).
 *  - `disposable` — this conversation's disposable box: a harness that signs in
 *    with the member's own account, or a compare column. The workdir is a path
 *    on THAT machine, so the Shell rail's terminal (which is the personal
 *    computer) must not be opened there.
 *
 * Absent ⇒ `personal`: a server that predates the field only ever ran there.
 */
export type HarnessMachine = "personal" | "disposable";

export interface HarnessSessionInfo {
  /** Absolute path of the harness session workdir on the computer. */
  workdir: string;
  machine?: HarnessMachine;
}

export interface HarnessSessionDataPart {
  type: "data-harness-session";
  data: HarnessSessionInfo;
}

/**
 * The transient part a harness turn streams for the Playground Shell rail.
 * `disposable` is whether the turn ran on the conversation's own box rather
 * than the member's personal computer.
 */
export function buildHarnessSessionDataPart(args: {
  workdir: string;
  disposable: boolean;
}): HarnessSessionDataPart {
  return {
    type: "data-harness-session",
    data: {
      workdir: args.workdir,
      machine: args.disposable ? "disposable" : "personal",
    },
  };
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
  const machine = (data as Record<string, unknown>).machine;
  // The contract is an ABSOLUTE path (it becomes the terminal cwd) — reject
  // relative or whitespace-padded values instead of letting cwd drift.
  return (
    typeof workdir === "string" &&
    workdir === workdir.trim() &&
    workdir.startsWith("/") &&
    (machine === undefined ||
      machine === "personal" ||
      machine === "disposable")
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

/**
 * One step of a Claude Code subagent, while it works (the bridge's Group E,
 * `claude-code-subagent-steps.ts`). `rootToolUseId` is the main-thread Agent
 * call the step belongs to, through any nesting, so the client attaches it to
 * that call's card. A step is a label, not a transcript: inputs keep scalar
 * fields cut to 300 characters, and a result says only whether it failed.
 * Transient, like the background-task part: a reload shows the Agent call's
 * result only.
 */
export type HarnessSubagentStepInfo =
  | {
      kind: "tool-call";
      rootToolUseId: string;
      parentToolUseId: string;
      toolUseId: string;
      toolName: string;
      input?: Record<string, string | number | boolean>;
    }
  | {
      kind: "tool-result";
      rootToolUseId: string;
      parentToolUseId: string;
      toolUseId: string;
      isError: boolean;
      error?: string;
    };

export interface HarnessSubagentStepDataPart {
  type: "data-harness-subagent-step";
  data: HarnessSubagentStepInfo;
}

const STEP_STRING_MAX = 300;
const STEP_FIELDS_MAX = 8;

function stepInput(
  value: unknown,
): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string | number | boolean> = {};
  let fields = 0;
  for (const [key, field] of Object.entries(value)) {
    if (fields >= STEP_FIELDS_MAX) break;
    if (typeof field === "string") {
      out[key] = field.slice(0, STEP_STRING_MAX + 1);
    } else if (typeof field === "number" || typeof field === "boolean") {
      out[key] = field;
    } else {
      continue;
    }
    fields++;
  }
  return out;
}

/**
 * Read the bridge's `raw` subagent steps (`{ mcpjam: "subagent-step" … }`).
 * Re-bounds what it forwards, since the raw part crossed a process boundary.
 * Anything else is not ours: undefined.
 */
export function harnessSubagentStepFromRaw(
  rawValue: unknown,
): HarnessSubagentStepInfo | undefined {
  if (!rawValue || typeof rawValue !== "object") return undefined;
  const raw = rawValue as Record<string, unknown>;
  if (raw.mcpjam !== "subagent-step") return undefined;
  const rootToolUseId = optionalString(raw.rootToolUseId);
  const parentToolUseId = optionalString(raw.parentToolUseId);
  const toolUseId = optionalString(raw.toolUseId);
  if (!rootToolUseId || !parentToolUseId || !toolUseId) return undefined;
  if (raw.kind === "tool-call") {
    const toolName = optionalString(raw.toolName);
    if (!toolName) return undefined;
    const input = stepInput(raw.input);
    return {
      kind: "tool-call",
      rootToolUseId,
      parentToolUseId,
      toolUseId,
      toolName: toolName.slice(0, STEP_STRING_MAX),
      ...(input ? { input } : {}),
    };
  }
  if (raw.kind === "tool-result") {
    const error = optionalString(raw.error);
    return {
      kind: "tool-result",
      rootToolUseId,
      parentToolUseId,
      toolUseId,
      isError: raw.isError === true,
      ...(error ? { error: error.slice(0, STEP_STRING_MAX + 1) } : {}),
    };
  }
  return undefined;
}

export function isHarnessSubagentStepDataPart(
  value: unknown,
): value is HarnessSubagentStepDataPart {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "data-harness-subagent-step") return false;
  const data = candidate.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") return false;
  if (
    typeof data.rootToolUseId !== "string" ||
    typeof data.toolUseId !== "string"
  ) {
    return false;
  }
  if (data.kind === "tool-call") return typeof data.toolName === "string";
  return data.kind === "tool-result" && typeof data.isError === "boolean";
}

/**
 * The agent's own plan for the turn, as a checklist: Codex's `update_plan`,
 * which the app-server reports as `turn/plan/updated` with the WHOLE plan each
 * time. NOT transient: the part sits in the reply where the plan first
 * appeared, and each update replaces it in place (same `id`). Like every data
 * part it is never sent to the model, and a reload shows the answers only.
 */
export type HarnessPlanStepStatus = "pending" | "inProgress" | "completed";

export interface HarnessPlanInfo {
  explanation?: string;
  steps: Array<{ step: string; status: HarnessPlanStepStatus }>;
}

export interface HarnessPlanDataPart {
  type: "data-harness-plan";
  id?: string;
  data: HarnessPlanInfo;
}

const PLAN_STEPS_MAX = 50;
const PLAN_STATUSES = new Set<HarnessPlanStepStatus>([
  "pending",
  "inProgress",
  "completed",
]);

/**
 * Read Codex's `turn/plan/updated` notification (a `raw` passthrough). Returns
 * the plan and the turn it belongs to; anything else is not a plan.
 */
export function harnessPlanFromRaw(
  rawValue: unknown,
): { turnId?: string; plan: HarnessPlanInfo } | undefined {
  if (!rawValue || typeof rawValue !== "object") return undefined;
  const raw = rawValue as Record<string, unknown>;
  if (raw.method !== "turn/plan/updated") return undefined;
  const params = raw.params as Record<string, unknown> | undefined;
  if (!params || !Array.isArray(params.plan)) return undefined;
  const steps: HarnessPlanInfo["steps"] = [];
  for (const entry of params.plan.slice(0, PLAN_STEPS_MAX)) {
    const item = entry as Record<string, unknown> | null;
    const step = optionalString(item?.step);
    const status = item?.status as HarnessPlanStepStatus;
    if (!step || !PLAN_STATUSES.has(status)) continue;
    steps.push({ step: step.slice(0, STEP_STRING_MAX), status });
  }
  const explanation = optionalString(params.explanation);
  const turnId = optionalString(params.turnId);
  return {
    ...(turnId ? { turnId } : {}),
    plan: {
      ...(explanation
        ? { explanation: explanation.slice(0, STEP_STRING_MAX) }
        : {}),
      steps,
    },
  };
}

export function isHarnessPlanDataPart(
  value: unknown,
): value is HarnessPlanDataPart {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "data-harness-plan") return false;
  const data = candidate.data as Record<string, unknown> | undefined;
  return (
    !!data &&
    typeof data === "object" &&
    Array.isArray(data.steps) &&
    data.steps.every(
      (step) =>
        !!step &&
        typeof (step as Record<string, unknown>).step === "string" &&
        PLAN_STATUSES.has(
          (step as Record<string, unknown>).status as HarnessPlanStepStatus,
        ),
    )
  );
}

/**
 * Output a running command printed, as it prints it: Codex's
 * `item/commandExecution/outputDelta`. `toolCallId` is the command's item id,
 * which is the id of its `bash` tool call. Transient: the command's full output
 * still arrives as the tool call's result.
 */
export interface HarnessToolOutputInfo {
  toolCallId: string;
  delta: string;
}

export interface HarnessToolOutputDataPart {
  type: "data-harness-tool-output";
  data: HarnessToolOutputInfo;
}

/** One delta's ceiling; a chunk past it is cut, not dropped. */
export const HARNESS_TOOL_OUTPUT_DELTA_MAX = 4096;

export function harnessToolOutputFromRaw(
  rawValue: unknown,
): HarnessToolOutputInfo | undefined {
  if (!rawValue || typeof rawValue !== "object") return undefined;
  const raw = rawValue as Record<string, unknown>;
  if (raw.method !== "item/commandExecution/outputDelta") return undefined;
  const params = raw.params as Record<string, unknown> | undefined;
  const toolCallId = optionalString(params?.itemId);
  const delta = optionalString(params?.delta);
  if (!toolCallId || !delta) return undefined;
  return {
    toolCallId,
    delta: delta.slice(0, HARNESS_TOOL_OUTPUT_DELTA_MAX),
  };
}

export function isHarnessToolOutputDataPart(
  value: unknown,
): value is HarnessToolOutputDataPart {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "data-harness-tool-output") return false;
  const data = candidate.data as Record<string, unknown> | undefined;
  return (
    !!data &&
    typeof data === "object" &&
    typeof data.toolCallId === "string" &&
    typeof data.delta === "string"
  );
}
