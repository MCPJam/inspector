/**
 * A raw `io.modelcontextprotocol/tasks` (SEP-2663) extension-wire fixture
 * server, spoken over Streamable HTTP on a real socket.
 *
 * PIN: modelcontextprotocol/ext-tasks @ 2c1425d9a288b9b1f489430fe1e00bb392b47e48
 * (`specification/draft/tasks.md`, `schema/draft/schema.ts`). Every wire shape
 * below is copied from that commit — re-diff when re-syncing.
 *
 * Why hand-rolled JSON-RPC rather than `@modelcontextprotocol/server`: beta.4
 * implements neither the extension's `resultType: "task"` discriminator nor the
 * `tasks/*` methods, and the point of this fixture is to drive the REAL client
 * against wire bytes we control byte-for-byte — including bytes that VIOLATE
 * the spec, so client-side validation and the conformance suite have something
 * to fail against. HTTP (not in-memory) because the extension's `Mcp-Name`
 * routing header only exists on the Streamable HTTP binding (tasks.md:511).
 *
 * The fixture is stateless per connection and keeps its task store in the
 * server closure, so a task created on one connection is readable from a fresh
 * one — that is what makes the durability MUST (tasks.md:300) testable.
 *
 * ## Spec MUSTs enforced by default
 *   - `resultType: "task"` on `CreateTaskResult` (tasks.md:102) — the real
 *     discriminator, always on outside misbehaving mode;
 *   - `resultType: "complete"` on `tasks/get|update|cancel` (tasks.md:338,
 *     :381, :410). This was recorded here as "prose-only, appears NOWHERE in
 *     the pinned schema" — that is FALSE for the 2026-07-28 ext-tasks document
 *     vendored under `src/mcp-conformance/schemas/`: `Result.required` lists
 *     `resultType`, and `UpdateTaskResult`/`CancelTaskResult` each re-declare
 *     it as `required` with `const: "complete"`. `wire-schema-valid` grades it
 *     there. The TOGGLE
 *     ({@link ExtensionTasksFixtureOptions.emitTaskResultType}, default on)
 *     stays, because both directions are still worth testing;
 *   - never a `CreateTaskResult` to a `tools/call` that did not declare the
 *     extension in `_meta` (tasks.md:61);
 *   - `-32021` for `tasks/get|update|cancel` and task-filtered
 *     `subscriptions/listen` from a non-declaring client (tasks.md:797-799);
 *   - `-32602` for an unknown/expired `taskId` (tasks.md:793);
 *   - per-status payloads: `inputRequests` on `input_required`, inline
 *     `result` on `completed`, JSON-RPC `error` on `failed` (tasks.md:326-332);
 *   - empty acknowledgements for `tasks/update` / `tasks/cancel`, with the
 *     observable status changing only on a LATER poll (tasks.md:377, :404);
 *   - `inputRequests` re-sent verbatim on every poll while outstanding
 *     (tasks.md:637), keys unique over the task's lifetime (tasks.md:350).
 *
 * ## Deliberately UNconstrained (the schema does not constrain them either)
 *   - timestamps are plain strings — "ISO 8601" is a JSDoc comment, there is
 *     no `format: date-time` anywhere in `schema.json`;
 *   - `ttlMs` / `pollIntervalMs` are plain numbers with no integer or minimum
 *     constraint, and both MAY change across polls (tasks.md:308, :340) — see
 *     {@link oddNumbersPhases};
 *   - `inputRequests` values render as an unconstrained `anyOf` in
 *     `schema.json`, so an unknown method or a hostile key is representable —
 *     see {@link HOSTILE_INPUT_REQUESTS}.
 *
 * ## Spec MUSTs it can deliberately violate
 * Everything under {@link ExtensionTasksMisbehavior} — see that type.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

/** The extension identifier (tasks.md:21). */
export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";

/** Where a client declares its per-request capabilities (tasks.md:33). */
export const CLIENT_CAPABILITIES_META_KEY =
  "io.modelcontextprotocol/clientCapabilities";

/** `MISSING_REQUIRED_CLIENT_CAPABILITY` (tasks.md:63, tasks.md:797). */
export const MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;
/**
 * The code the extension carried before ext-tasks corrected it to `-32021`
 * (`c523f2c`). Kept so a test can drive a pre-final server deliberately.
 */
export const OBSOLETE_MISSING_REQUIRED_CLIENT_CAPABILITY = -32003;
/** `INVALID_PARAMS`, used for unknown/expired task ids (tasks.md:793). */
export const INVALID_PARAMS = -32602;

/** The first protocol version that can carry the extension. */
export const EXTENSION_PROTOCOL_VERSION = "2026-07-28";

/**
 * `CacheableResult` fields the modern wire REQUIRES on `tools/list` (SEP-2549).
 * Values are arbitrary-but-valid: a non-negative integer and one of the two
 * `cacheScope` literals. They are not part of any tasks assertion — they exist
 * so the fixture's `tools/list` decodes at all.
 */
export const LIST_RESULT_TTL_MS = 60_000;
export const LIST_RESULT_CACHE_SCOPE = "private" as const;

/** Default tool that only ever answers synchronously. */
export const SYNC_TOOL_NAME = "sync_tool";
/** Default tool that answers with a `CreateTaskResult` to a declaring caller. */
export const TASK_TOOL_NAME = "task_tool";

export type TaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * One observable state of a task's lifetime. The fixture serves phases in
 * order: each `tasks/get` first advances past an exhausted phase, then renders
 * the current one, so a phase gated on `awaitInputKeys` / `awaitCancel` becomes
 * visible only on the poll AFTER the gating request — which is exactly the
 * eventual consistency the spec requires of `tasks/update` and `tasks/cancel`.
 * The last phase sticks forever.
 */
export interface TaskPhase {
  status: TaskStatus;
  statusMessage?: string;
  /** `null` = unlimited. Omitted → inherits the previous phase's value. */
  ttlMs?: number | null;
  /** Omitted → inherits the previous phase's value. */
  pollIntervalMs?: number;
  /** Required on `input_required`; a keyed snapshot re-sent on every poll. */
  inputRequests?: Record<string, unknown>;
  /** Required on `completed` — the original request's result, INLINE. */
  result?: unknown;
  /** Required on `failed` — a JSON-RPC error object. */
  error?: { code: number; message: string; data?: unknown };
  /** How many polls render this phase before it may advance. Default 1. */
  polls?: number;
  /** Hold this phase until `tasks/update` has answered all of these keys. */
  awaitInputKeys?: string[];
  /** Hold this phase until a `tasks/cancel` arrives for the task. */
  awaitCancel?: boolean;
  /** Extra keys merged onto the emitted task object (raw-wire escape hatch). */
  extra?: Record<string, unknown>;
  /** Keys deleted from the emitted task object (missing-required-field cases). */
  omit?: string[];
}

export interface ToolBehavior {
  /**
   * `"sync"` — always a plain `CallToolResult`.
   * `"task"` — a `CreateTaskResult` when (and only when) the caller declared
   * the extension; a plain result otherwise (tasks.md:61).
   */
  mode: "sync" | "task";
  /** The plain result for `"sync"` mode (and for undeclared `"task"` calls). */
  result?: Record<string, unknown>;
  /** The lifecycle served for `"task"` mode. Must be non-empty. */
  phases?: TaskPhase[];
  /** Seed `ttlMs` for the created task when phase 0 omits it. Default 60000. */
  ttlMs?: number | null;
  /** Seed `pollIntervalMs` when phase 0 omits it. Default 10. */
  pollIntervalMs?: number;
  /** Tool metadata for `tools/list`. */
  description?: string;
}

/**
 * Deliberate spec violations, for driving NEGATIVE tests of client-side
 * validation and of the conformance suite. Each flag is off by default.
 */
export interface ExtensionTasksMisbehavior {
  /**
   * Answer `tasks/get|update|cancel` normally even when the request carried no
   * extension declaration — violates tasks.md:799.
   */
  answerUndeclaredTaskRequests?: boolean;
  /**
   * Answer a task-filtered `subscriptions/listen` from a non-declaring client
   * — violates tasks.md:798.
   */
  answerUndeclaredTaskSubscription?: boolean;
  /**
   * Return a `CreateTaskResult` to a `tools/call` that did NOT declare the
   * extension — violates tasks.md:61.
   */
  createTaskForUndeclaredCall?: boolean;
  /** Emit this literal in `status` on every emitted task (invalid enum value). */
  status?: string;
  /** Delete these fields from every emitted task (missing required fields). */
  omitTaskFields?: string[];
  /** `resultType` on `CreateTaskResult`. Spec requires `"task"` (MUST). */
  createResultType?: string;
  /**
   * OMIT `resultType` from `CreateTaskResult` entirely — distinct from
   * {@link createResultType}, which can only change its VALUE. Absence is the
   * more dangerous violation of tasks.md:102: a wrong value at least stays
   * visible, while an absent one makes the task invisible to a client that
   * discriminates on it, so the response reads as an ordinary tool result.
   * Wins over `createResultType` when both are set.
   */
  omitCreateResultType?: boolean;
  /**
   * `resultType` on `tasks/get`. The prose requires `"complete"`; setting it
   * to `"task"` is the "wrong discriminator" case. To OMIT it instead (which
   * is arguably schema-conformant, not misbehavior) use
   * {@link ExtensionTasksFixtureOptions.emitTaskResultType}.
   */
  getResultType?: string;
  /**
   * Drop the status-specific payload: no `inputRequests` on `input_required`,
   * no `result` on `completed`, no `error` on `failed` — violates
   * tasks.md:326-332.
   */
  omitStatusPayload?: boolean;
  /** Serve a fabricated task for an unknown id instead of `-32602`. */
  answerUnknownTaskId?: boolean;
}

export interface ExtensionTasksFixtureOptions {
  /** Advertised in `server/discover`. Default `["2026-07-28"]`. */
  supportedVersions?: string[];
  /**
   * Advertise `capabilities.extensions["io.modelcontextprotocol/tasks"]`.
   * Set false to prove the client refuses to speak the wire at all.
   */
  advertiseTasksExtension?: boolean;
  /**
   * The VALUE advertised under the extension key. `schema.json` renders
   * `TasksExtensionCapability` as an object with zero properties, but the
   * prose only says no settings are "currently" defined — so a non-empty
   * object must still read as support (forward compat). Non-object values
   * (`true`, `"x"`, `[]`, `null`) are the malformed-declaration cases.
   * Default `{}`.
   */
  tasksExtensionCapability?: unknown;
  /**
   * Emit `resultType: "complete"` on `tasks/get|update|cancel`. Default true —
   * and it is a schema `required`, not merely prose (see the note at the top of
   * this file). Set false to exercise the omission, which `wire-schema-valid`
   * reports and the Tasks ack check warns about.
   */
  emitTaskResultType?: boolean;
  /**
   * JSON-RPC code for an unknown/expired `taskId` on `tasks/update` and
   * `tasks/cancel`. `-32602` is only a SHOULD there (tasks.md:795), so another
   * code is still compliant; on `tasks/get` it is a MUST and is not
   * configurable. Default `-32602`.
   */
  unknownTaskCodeForMutations?: number;
  /**
   * Reject `tasks/update` with `-32602` for a task that EXISTS, as a server
   * does when the `inputResponses` themselves are unacceptable.
   *
   * The code is the same one that means "unknown task id", which is why a
   * client must confirm with `tasks/get` before reporting expiry — otherwise
   * this validation message is lost and the user is told to re-create a live
   * task. The message is distinctive so a test can prove it survived.
   */
  rejectUpdateWithInvalidParams?: boolean;
  serverInfo?: { name: string; version: string };
  /** Replaces the default tool set entirely when provided. */
  tools?: Record<string, ToolBehavior>;
  misbehave?: ExtensionTasksMisbehavior;
  /** Task ids handed out, in order. Default `ext-task-1`, `ext-task-2`, … */
  taskIds?: string[];
}

export interface ReceivedRequest {
  method: string;
  params: Record<string, unknown> | undefined;
  /** Lower-cased HTTP request headers — `mcp-name` lives here. */
  headers: Record<string, string>;
}

export interface TaskInspection {
  taskId: string;
  toolName: string;
  phaseIndex: number;
  polls: number;
  /** Current TTL, `null` meaning unlimited — distinct from an absent one. */
  ttlMs: number | null;
  /** `inputRequests` keys answered so far via `tasks/update`. */
  answeredKeys: string[];
  cancelRequested: boolean;
}

export interface ServedExtensionTasksFixture {
  url: string;
  received: ReceivedRequest[];
  /** Every task the fixture has created, in creation order. */
  tasks: () => TaskInspection[];
  task: (taskId: string) => TaskInspection | undefined;
  /** Mutate the misbehavior toggles mid-test. */
  misbehave: (patch: ExtensionTasksMisbehavior) => void;
  close: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Default surface
// ---------------------------------------------------------------------------

/** The elicitation the default task tool blocks on, keyed `name`. */
export const DEFAULT_INPUT_REQUEST_KEY = "name";

export const DEFAULT_INPUT_REQUESTS: Record<string, unknown> = {
  [DEFAULT_INPUT_REQUEST_KEY]: {
    method: "elicitation/create",
    params: {
      mode: "form",
      message: "Please enter your name.",
      requestedSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
};

/**
 * working → input_required (re-sent while outstanding) → working → completed,
 * with `ttlMs` and `pollIntervalMs` CHANGING across polls (tasks.md:140-147).
 * Mirrors the spec's own example message flow (tasks.md:513-780).
 */
export function defaultTaskPhases(): TaskPhase[] {
  return [
    {
      status: "working",
      statusMessage: "The operation is now in progress.",
      ttlMs: 60_000,
      pollIntervalMs: 10,
    },
    {
      status: "input_required",
      statusMessage: "Waiting on the user's name.",
      inputRequests: DEFAULT_INPUT_REQUESTS,
      // Rendered on at least two polls so the repeated-snapshot rule is
      // observable, and held until the client answers the `name` key.
      polls: 2,
      awaitInputKeys: [DEFAULT_INPUT_REQUEST_KEY],
      ttlMs: 45_000,
      pollIntervalMs: 20,
    },
    {
      status: "working",
      statusMessage: "Input accepted; finishing up.",
      ttlMs: 30_000,
      pollIntervalMs: 30,
    },
    {
      status: "completed",
      statusMessage: "Done.",
      result: {
        content: [{ type: "text", text: "Hello, Luca!" }],
        isError: false,
      },
    },
  ];
}

/**
 * Two outstanding requests, so a `tasks/update` answering only one exercises
 * the partial-response rule (tasks.md:379): the task stays `input_required`
 * and the remaining key keeps being re-sent.
 */
export const PARTIAL_INPUT_REQUESTS: Record<string, unknown> = {
  ...DEFAULT_INPUT_REQUESTS,
  city: {
    method: "elicitation/create",
    params: {
      mode: "form",
      message: "Which city?",
      requestedSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
};

/**
 * `inputRequests` the JSON Schema permits but the TypeScript union does not:
 * an UNKNOWN method (the schema renders the value as an unconstrained
 * `anyOf`), plus prototype-pollution keys. A client must keep these
 * visible-but-unanswerable and must never let the keys reach an object
 * prototype.
 */
// Built with `Object.fromEntries` on purpose: in an object literal a
// `__proto__:` key sets the prototype instead of defining an own property, so
// the hostile key would never reach the wire.
export const HOSTILE_INPUT_REQUESTS: Record<string, unknown> =
  Object.fromEntries([
    [
      "unknown_method",
      { method: "tasks/definitely-not-a-real-method", params: {} },
    ],
    [
      "__proto__",
      { method: "elicitation/create", params: { message: "polluted" } },
    ],
    ["constructor", { method: "roots/list", params: {} }],
  ]);

/**
 * `ttlMs` / `pollIntervalMs` that are legal but unusual — non-integer, huge,
 * and CHANGING across polls — plus a `ttlMs: null` (unlimited) phase. Nothing
 * here is an anomaly: the schema types both as plain numbers and the prose
 * explicitly allows them to change (tasks.md:308, :340).
 */
export function oddNumbersPhases(): TaskPhase[] {
  return [
    { status: "working", ttlMs: 1234.567, pollIntervalMs: 0.5 },
    { status: "working", ttlMs: Number.MAX_SAFE_INTEGER, pollIntervalMs: 1 },
    { status: "working", ttlMs: null, pollIntervalMs: 2 },
    {
      status: "completed",
      ttlMs: -1,
      result: { content: [{ type: "text", text: "odd but legal" }] },
    },
  ];
}

/**
 * A tool result with `isError: true`. The task MUST be `completed`, not
 * `failed` — `failed` is strictly for JSON-RPC-level faults
 * (tasks.md:837, :891-892).
 */
export function isErrorCompletedPhases(): TaskPhase[] {
  return [
    {
      status: "completed",
      statusMessage: "The tool reported an error.",
      result: {
        content: [
          { type: "text", text: "Failed to process request: invalid input" },
        ],
        isError: true,
      },
    },
  ];
}

/** A genuine JSON-RPC fault during execution → `failed` + `error`. */
export function failedTaskPhases(): TaskPhase[] {
  return [
    {
      status: "failed",
      statusMessage: "Tool execution failed: API rate limit exceeded",
      error: { code: -32603, message: "API rate limit exceeded" },
    },
  ];
}

/** `working` until a `tasks/cancel` arrives, then `cancelled` on a later poll. */
export function cancellablePhases(): TaskPhase[] {
  return [
    { status: "working", awaitCancel: true, pollIntervalMs: 10 },
    {
      status: "cancelled",
      statusMessage: "Cancelled at the client's request.",
    },
  ];
}

function defaultTools(): Record<string, ToolBehavior> {
  return {
    [SYNC_TOOL_NAME]: {
      mode: "sync",
      description: "Always answers synchronously.",
      result: { content: [{ type: "text", text: "sync result" }] },
    },
    [TASK_TOOL_NAME]: {
      mode: "task",
      description: "Answers with a task handle when the client declares tasks.",
      phases: defaultTaskPhases(),
      result: { content: [{ type: "text", text: "undeclared sync fallback" }] },
    },
  };
}

/** A `"task"` tool with a caller-supplied lifecycle. */
export function taskTool(
  phases: TaskPhase[],
  overrides: Partial<ToolBehavior> = {}
): ToolBehavior {
  return {
    mode: "task",
    description: "Scripted task tool.",
    result: { content: [{ type: "text", text: "undeclared sync fallback" }] },
    phases,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface TaskEntry {
  taskId: string;
  toolName: string;
  phases: TaskPhase[];
  phaseIndex: number;
  pollsOnPhase: number;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs: number | undefined;
  answered: Set<string>;
  cancelRequested: boolean;
}

class JsonRpcFailure extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

function missingCapabilityFailure(): JsonRpcFailure {
  return new JsonRpcFailure(
    MISSING_REQUIRED_CLIENT_CAPABILITY,
    "Missing required client capability",
    { requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether THIS request declared the tasks extension in its per-request
 * capabilities (tasks.md:27-41). Prior declarations do not count.
 */
export function declaresTasksExtension(
  params: Record<string, unknown> | undefined
): boolean {
  const meta = params?._meta;
  if (!isRecord(meta)) return false;
  const capabilities = meta[CLIENT_CAPABILITIES_META_KEY];
  if (!isRecord(capabilities)) return false;
  const extensions = capabilities.extensions;
  return isRecord(extensions) && TASKS_EXTENSION_ID in extensions;
}

export async function serveExtensionTasksFixture(
  options: ExtensionTasksFixtureOptions = {}
): Promise<ServedExtensionTasksFixture> {
  const supportedVersions = options.supportedVersions ?? [
    EXTENSION_PROTOCOL_VERSION,
  ];
  const advertiseExtension = options.advertiseTasksExtension !== false;
  const extensionCapability =
    options.tasksExtensionCapability === undefined
      ? {}
      : options.tasksExtensionCapability;
  const emitTaskResultType = options.emitTaskResultType !== false;
  const unknownTaskCodeForMutations =
    options.unknownTaskCodeForMutations ?? INVALID_PARAMS;
  const serverInfo = options.serverInfo ?? {
    name: "extension-tasks-fixture",
    version: "1.0.0",
  };
  const tools = options.tools ?? defaultTools();
  const misbehavior: ExtensionTasksMisbehavior = { ...options.misbehave };

  const received: ReceivedRequest[] = [];
  const store = new Map<string, TaskEntry>();
  const order: string[] = [];
  const reservedIds = [...(options.taskIds ?? [])];
  let idCounter = 0;

  // A deterministic clock keeps timestamps stable for golden comparisons.
  const clockStart = Date.parse("2026-07-28T10:00:00.000Z");
  let ticks = 0;
  const nowIso = () => new Date(clockStart + ticks++ * 1000).toISOString();

  const nextTaskId = () => reservedIds.shift() ?? `ext-task-${++idCounter}`;

  function createTask(toolName: string, behavior: ToolBehavior): TaskEntry {
    const phases = behavior.phases ?? defaultTaskPhases();
    if (phases.length === 0) {
      throw new Error(`Task tool "${toolName}" has no phases.`);
    }
    const createdAt = nowIso();
    const entry: TaskEntry = {
      taskId: nextTaskId(),
      toolName,
      phases,
      phaseIndex: 0,
      pollsOnPhase: 0,
      createdAt,
      lastUpdatedAt: createdAt,
      // `null` is "unlimited" and is NOT absence — the same distinction the
      // SDK's task validation preserves — so a `??` chain here would silently
      // turn a deliberate unlimited-TTL phase into 60s and the fixture could
      // never emit the shape it exists to exercise. Only `undefined` inherits.
      ttlMs:
        phases[0].ttlMs !== undefined
          ? phases[0].ttlMs
          : behavior.ttlMs !== undefined
            ? behavior.ttlMs
            : 60_000,
      pollIntervalMs: phases[0].pollIntervalMs ?? behavior.pollIntervalMs ?? 10,
      answered: new Set(),
      cancelRequested: false,
    };
    store.set(entry.taskId, entry);
    order.push(entry.taskId);
    return entry;
  }

  /** Gates satisfied → the phase may retire. */
  function phaseExhausted(entry: TaskEntry): boolean {
    const phase = entry.phases[entry.phaseIndex];
    if (entry.pollsOnPhase < (phase.polls ?? 1)) return false;
    if (phase.awaitCancel && !entry.cancelRequested) return false;
    for (const key of phase.awaitInputKeys ?? []) {
      if (!entry.answered.has(key)) return false;
    }
    return true;
  }

  function advanceIfDue(entry: TaskEntry): void {
    const isLast = entry.phaseIndex >= entry.phases.length - 1;
    if (isLast || !phaseExhausted(entry)) return;
    entry.phaseIndex += 1;
    entry.pollsOnPhase = 0;
    entry.lastUpdatedAt = nowIso();
    const phase = entry.phases[entry.phaseIndex];
    if (phase.ttlMs !== undefined) entry.ttlMs = phase.ttlMs;
    if (phase.pollIntervalMs !== undefined) {
      entry.pollIntervalMs = phase.pollIntervalMs;
    }
  }

  /** The bare `Task` fields, shared by `CreateTaskResult` and `tasks/get`. */
  function taskFields(entry: TaskEntry): Record<string, unknown> {
    const phase = entry.phases[entry.phaseIndex];
    const task: Record<string, unknown> = {
      taskId: entry.taskId,
      status: misbehavior.status ?? phase.status,
      createdAt: entry.createdAt,
      lastUpdatedAt: entry.lastUpdatedAt,
      ttlMs: entry.ttlMs,
    };
    if (phase.statusMessage !== undefined) {
      task.statusMessage = phase.statusMessage;
    }
    if (entry.pollIntervalMs !== undefined) {
      task.pollIntervalMs = entry.pollIntervalMs;
    }
    return applyRawOverrides(task, phase);
  }

  /**
   * The prose-mandated `resultType: "complete"` on the `tasks/*` results, or
   * nothing when {@link ExtensionTasksFixtureOptions.emitTaskResultType} is
   * off — the key is absent from the pinned schema entirely.
   */
  function taskResultTypeField(): Record<string, unknown> {
    if (misbehavior.getResultType !== undefined) {
      return { resultType: misbehavior.getResultType };
    }
    return emitTaskResultType ? { resultType: "complete" } : {};
  }

  /** `Task` plus the status-specific payload (tasks.md:326-332). */
  function detailedTaskFields(entry: TaskEntry): Record<string, unknown> {
    const phase = entry.phases[entry.phaseIndex];
    const task = taskFields(entry);
    if (!misbehavior.omitStatusPayload) {
      if (phase.status === "input_required") {
        // A point-in-time snapshot: re-sent verbatim on every poll while the
        // requests stay outstanding (tasks.md:637). Answered keys drop out.
        // `Object.fromEntries` defines own properties, so a hostile
        // `__proto__` key survives to the wire instead of mutating a
        // prototype (see HOSTILE_INPUT_REQUESTS).
        task.inputRequests = Object.fromEntries(
          Object.entries(phase.inputRequests ?? DEFAULT_INPUT_REQUESTS).filter(
            ([key]) => !entry.answered.has(key)
          )
        );
      } else if (phase.status === "completed") {
        task.result = phase.result ?? { content: [], isError: false };
      } else if (phase.status === "failed") {
        task.error = phase.error ?? {
          code: -32603,
          message: "Internal error",
        };
      }
    }
    return applyRawOverrides(task, phase);
  }

  function applyRawOverrides(
    task: Record<string, unknown>,
    phase: TaskPhase
  ): Record<string, unknown> {
    for (const key of phase.omit ?? []) delete task[key];
    for (const key of misbehavior.omitTaskFields ?? []) delete task[key];
    return phase.extra ? { ...task, ...phase.extra } : task;
  }

  function requireTask(
    taskId: unknown,
    notFoundCode = INVALID_PARAMS
  ): TaskEntry {
    const entry = typeof taskId === "string" ? store.get(taskId) : undefined;
    if (entry) return entry;
    if (misbehavior.answerUnknownTaskId) {
      // Fabricate a task for an id that was never issued.
      const behavior = tools[TASK_TOOL_NAME] ?? {
        mode: "task" as const,
        phases: defaultTaskPhases(),
      };
      const fabricated = createTask(TASK_TOOL_NAME, behavior);
      fabricated.taskId = String(taskId);
      return fabricated;
    }
    throw new JsonRpcFailure(
      notFoundCode,
      `Failed to retrieve task: Task not found (${String(taskId)})`
    );
  }

  function requireDeclaration(params: Record<string, unknown> | undefined) {
    if (misbehavior.answerUndeclaredTaskRequests) return;
    if (!declaresTasksExtension(params)) throw missingCapabilityFailure();
  }

  function handle(
    method: string,
    params: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    switch (method) {
      case "server/discover":
        return {
          resultType: "complete",
          supportedVersions,
          capabilities: {
            tools: {},
            ...(advertiseExtension
              ? { extensions: { [TASKS_EXTENSION_ID]: extensionCapability } }
              : {}),
          },
          serverInfo,
        };

      case "initialize":
        // Present so a mis-pinned client gets a coherent refusal rather than a
        // socket error; the extension only exists on the modern wire.
        return {
          resultType: "complete",
          protocolVersion: supportedVersions[0],
          capabilities: {
            tools: {},
            ...(advertiseExtension
              ? { extensions: { [TASKS_EXTENSION_ID]: extensionCapability } }
              : {}),
          },
          serverInfo,
        };

      case "tools/list":
        return {
          resultType: "complete",
          // SEP-2549 (`draft/changelog.mdx:36`) made `ttlMs` + `cacheScope`
          // REQUIRED on `tools/list`, and beta.4's 2026 decoder enforces both
          // without a `.catch()` fallback (`ListToolsResultSchema` /
          // `dispatchResultSchemas["tools/list"]`, `src-CMjk3S93.mjs:2778`,
          // `:3036`). Omitting them makes every consumer — including the tasks
          // conformance runner — fail during DISCOVERY, before any tasks
          // behavior is reached. `server/discover` is NOT in the same boat: its
          // two fields carry `.catch()` defaults (`:3074`).
          ttlMs: LIST_RESULT_TTL_MS,
          cacheScope: LIST_RESULT_CACHE_SCOPE,
          tools: Object.entries(tools).map(([name, behavior]) => ({
            name,
            description: behavior.description ?? name,
            inputSchema: { type: "object", properties: {} },
          })),
        };

      case "tools/call": {
        const name = params?.name;
        const behavior =
          typeof name === "string" ? tools[name] : (undefined as undefined);
        if (!behavior) {
          throw new JsonRpcFailure(
            INVALID_PARAMS,
            `Unknown tool: ${String(name)}`
          );
        }
        const declared = declaresTasksExtension(params);
        const wantsTask =
          behavior.mode === "task" &&
          // tasks.md:61 — a non-declaring caller MUST NOT be handed a task.
          (declared || misbehavior.createTaskForUndeclaredCall === true);
        if (!wantsTask) {
          return {
            resultType: "complete",
            ...(behavior.result ?? {
              content: [{ type: "text", text: "plain call" }],
            }),
          };
        }
        const entry = createTask(name as string, behavior);
        // `CreateTaskResult = Result & Task` — flat, and bare `Task` fields
        // only (no inputRequests/result/error).
        return {
          ...(misbehavior.omitCreateResultType
            ? {}
            : { resultType: misbehavior.createResultType ?? "task" }),
          ...taskFields(entry),
        };
      }

      case "tasks/get": {
        requireDeclaration(params);
        // `-32602` on an unknown id is a MUST for `tasks/get` (tasks.md:794),
        // so this one is not configurable.
        const entry = requireTask(params?.taskId);
        advanceIfDue(entry);
        entry.pollsOnPhase += 1;
        return {
          ...taskResultTypeField(),
          ...detailedTaskFields(entry),
        };
      }

      case "tasks/update": {
        requireDeclaration(params);
        const entry = requireTask(params?.taskId, unknownTaskCodeForMutations);
        if (options.rejectUpdateWithInvalidParams) {
          throw new JsonRpcFailure(
            INVALID_PARAMS,
            "inputResponses rejected: `confirm` must be a boolean",
          );
        }
        const phase = entry.phases[entry.phaseIndex];
        const outstanding = new Set(
          Object.keys(
            phase.status === "input_required"
              ? phase.inputRequests ?? DEFAULT_INPUT_REQUESTS
              : {}
          )
        );
        const responses = params?.inputResponses;
        if (isRecord(responses)) {
          for (const key of Object.keys(responses)) {
            // tasks.md:379 — unknown / already-answered keys are ignored.
            if (outstanding.has(key)) entry.answered.add(key);
          }
        }
        // An EMPTY, eventually-consistent acknowledgement (tasks.md:374-381):
        // the observable status does not move until a later `tasks/get`.
        return { ...taskResultTypeField() };
      }

      case "tasks/cancel": {
        requireDeclaration(params);
        const entry = requireTask(params?.taskId, unknownTaskCodeForMutations);
        entry.cancelRequested = true;
        // Empty ack; cancellation is cooperative (tasks.md:400-406).
        return { ...taskResultTypeField() };
      }

      case "subscriptions/listen": {
        const notifications = params?.notifications;
        const taskIds = isRecord(notifications)
          ? notifications.taskIds
          : undefined;
        const wantsTaskNotifications =
          Array.isArray(taskIds) && taskIds.length > 0;
        if (
          wantsTaskNotifications &&
          !misbehavior.answerUndeclaredTaskSubscription &&
          !declaresTasksExtension(params)
        ) {
          // tasks.md:457, :798.
          throw missingCapabilityFailure();
        }
        // This fixture never opens an SSE stream, so it acknowledges the
        // subscription without agreeing to any task ids.
        return { resultType: "complete" };
      }

      default:
        return { resultType: "complete" };
    }
  }

  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let message: {
        id?: unknown;
        method?: string;
        params?: Record<string, unknown>;
      };
      try {
        message = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (typeof message.method === "string") {
        received.push({
          method: message.method,
          params: message.params,
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([key, value]) => [
              key,
              Array.isArray(value) ? value.join(", ") : String(value ?? ""),
            ])
          ),
        });
      }
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }

      let payload: Record<string, unknown>;
      try {
        payload = {
          jsonrpc: "2.0",
          id: message.id,
          result: handle(message.method as string, message.params),
        };
      } catch (error) {
        const failure =
          error instanceof JsonRpcFailure
            ? error
            : new JsonRpcFailure(-32603, String(error));
        payload = {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: failure.code,
            message: failure.message,
            ...(failure.data === undefined ? {} : { data: failure.data }),
          },
        };
      }

      res.writeHead(200, {
        "content-type": "application/json",
        "mcp-protocol-version": supportedVersions[0],
      });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve)
  );
  const address = httpServer.address() as AddressInfo;

  const inspect = (entry: TaskEntry): TaskInspection => ({
    taskId: entry.taskId,
    toolName: entry.toolName,
    phaseIndex: entry.phaseIndex,
    polls: entry.pollsOnPhase,
    ttlMs: entry.ttlMs,
    answeredKeys: [...entry.answered],
    cancelRequested: entry.cancelRequested,
  });

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    received,
    tasks: () =>
      order
        .map((id) => store.get(id))
        .filter((entry): entry is TaskEntry => entry !== undefined)
        .map(inspect),
    task: (taskId) => {
      const entry = store.get(taskId);
      return entry ? inspect(entry) : undefined;
    },
    misbehave: (patch) => Object.assign(misbehavior, patch),
    close: () =>
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}
