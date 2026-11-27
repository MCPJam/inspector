import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  InputRequest,
} from "@modelcontextprotocol/server";
import { runCase } from "./case-steps.js";
import type { StepHost } from "./case-steps.js";
import type { MockSavedCase } from "./definition-types.js";

/**
 * A saved case that runs as a task. Two wires carry the same record: the
 * 2025-11-25 in-core utility (`tasks/get`, `tasks/result`, `tasks/list`,
 * `tasks/cancel`, a `task` on the call) and the 2026-07-28 extension
 * `io.modelcontextprotocol/tasks` (`tasks/get`, `tasks/update`, `tasks/cancel`,
 * `resultType: "task"`, questions in `inputRequests`). The server SDK has no
 * task runtime, so both are answered here.
 *
 * The record lives in a `MockTaskStore` the host supplies, and every read goes
 * to the store: a task created on one replica is polled on another. The case
 * itself runs on the replica that created the task and writes its progress to
 * the store; if that replica goes away the task stays `working` until its TTL
 * ends. Waiting (`tasks/result`, a question) polls the store.
 */

type Obj = Record<string, unknown>;
export type MockTaskStatus =
  "working" | "input_required" | "completed" | "failed" | "cancelled";

const TERMINAL: MockTaskStatus[] = ["completed", "failed", "cancelled"];
export const isTerminalTask = (status: MockTaskStatus) =>
  TERMINAL.includes(status);

export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";
const RELATED_TASK_KEY = "io.modelcontextprotocol/related-task";
const MAX_TTL_MS = 3_600_000;

/** JSON only, so any document store can hold it. Times are epoch milliseconds. */
export interface MockTaskRecord {
  taskId: string;
  /** Whose task it is; every read and write names the owner and another owner's task is not found. */
  owner: string;
  status: MockTaskStatus;
  statusMessage?: string;
  createdAt: number;
  lastUpdatedAt: number;
  ttlMs: number;
  /** The questions waiting for the client, while `input_required`. */
  inputRequests?: Record<string, InputRequest>;
  /** The replies the client sent with `tasks/update`, by question id. */
  inputResponses?: Record<string, unknown>;
  result?: CallToolResult;
  error?: { code: number; message: string; data?: unknown };
}

/** A change to a record; absent fields stay as stored. */
export interface MockTaskPatch {
  status?: MockTaskStatus;
  /** `null` clears the message. */
  statusMessage?: string | null;
  lastUpdatedAt: number;
  /** `null` clears the questions. */
  inputRequests?: Record<string, InputRequest> | null;
  /** Merged into the stored replies key by key, so two replicas answering at once lose nothing. */
  addInputResponses?: Record<string, unknown>;
  result?: CallToolResult;
  error?: MockTaskRecord["error"];
}

/**
 * Where tasks live. The host implements it over a shared store (the backend,
 * for a task created on one replica and polled on another).
 */
export interface MockTaskStore {
  /** Stores a new record. Resolves only once `get` would find it (the extension requires this before the handle goes out). */
  create(record: MockTaskRecord): Promise<void>;
  get(owner: string, taskId: string): Promise<MockTaskRecord | undefined>;
  list(owner: string): Promise<MockTaskRecord[]>;
  /**
   * Applies the patch and returns the stored record, or `undefined` when the
   * owner has no such task. A task already `completed`, `failed` or
   * `cancelled` is returned unchanged: a finished task never changes.
   */
  update(
    owner: string,
    taskId: string,
    patch: MockTaskPatch
  ): Promise<MockTaskRecord | undefined>;
}

/** What `buildMock` needs to run cases as tasks. */
export interface MockTasks {
  store: MockTaskStore;
  owner: string;
  /** How often a client is told to poll, and how often the runtime re-reads the store. Default 250 ms. */
  pollIntervalMs?: number;
  /** How long a task is kept. Default 5 minutes; a 2025-11-25 caller may ask for less. */
  ttlMs?: number;
  now?: () => number;
  newId?: () => string;
  /**
   * Told about a failure nobody is waiting on: the store refusing a write while
   * the case runs in the background. The host logs it. The task is marked
   * failed when the store allows it.
   */
  onError: (error: unknown) => void;
}

const iso = (ms: number) => new Date(ms).toISOString();
const pollOf = (tasks: MockTasks) => tasks.pollIntervalMs ?? 250;
const nowOf = (tasks: MockTasks) => (tasks.now ?? Date.now)();

/** A task past its TTL is gone, as a receiver may purge it. */
function alive(tasks: MockTasks, record: MockTaskRecord | undefined) {
  return record && nowOf(tasks) - record.createdAt <= record.ttlMs
    ? record
    : undefined;
}

/** The questions asked now that have no reply yet. */
function waitingOn(record: MockTaskRecord): Record<string, InputRequest> {
  const replies = record.inputResponses ?? {};
  return Object.fromEntries(
    Object.entries(record.inputRequests ?? {}).filter(
      ([key]) => !Object.hasOwn(replies, key)
    )
  );
}

const terminalTask = (status: string) =>
  new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `Cannot cancel task: already in terminal status '${status}'.`
  );

export const unknownCursor = () =>
  new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    "That cursor is not one this mock gave out. List tasks again without a cursor."
  );

/** This mock's live tasks for the owner, in the 2025-11-25 shape. */
export async function heldTasks(tasks: MockTasks): Promise<Obj[]> {
  const all = await tasks.store.list(tasks.owner);
  return all
    .filter((record) => alive(tasks, record))
    .map((record) => legacyTask(record, pollOf(tasks)));
}

const unknownTask = () =>
  new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    "No task has that id. It may have finished long ago, or it was never created here; call the tool again."
  );

/** The 2026-07-28 extension's `DetailedTask`: the status decides which payload rides along. */
export function extTask(record: MockTaskRecord, pollIntervalMs: number): Obj {
  return {
    taskId: record.taskId,
    status: record.status,
    ...(record.statusMessage !== undefined && {
      statusMessage: record.statusMessage,
    }),
    createdAt: iso(record.createdAt),
    lastUpdatedAt: iso(record.lastUpdatedAt),
    ttlMs: record.ttlMs,
    pollIntervalMs,
    ...(record.status === "input_required" && {
      inputRequests: waitingOn(record),
    }),
    ...(record.status === "completed" && { result: record.result }),
    ...(record.status === "failed" && { error: record.error }),
  };
}

/**
 * The 2025-11-25 in-core `Task`. A tool call that ended with `isError` is
 * `failed` there (the spec says the task "should reach failed status"); the
 * extension keeps it `completed`.
 */
export function legacyTask(record: MockTaskRecord, pollInterval: number): Obj {
  const failed = record.status === "completed" && record.result?.isError;
  return {
    taskId: record.taskId,
    status: failed ? "failed" : record.status,
    ...(record.statusMessage !== undefined && {
      statusMessage: record.statusMessage,
    }),
    createdAt: iso(record.createdAt),
    lastUpdatedAt: iso(record.lastUpdatedAt),
    ttl: record.ttlMs,
    pollInterval,
  };
}

/** What a task run needs: the case, how to finish it, and the notifications it may send. */
export interface TaskRun {
  chosen: MockSavedCase;
  input: Obj;
  finish: (replies: Obj) => CallToolResult;
  /** Notification steps; a legacy task has no stream to send them on, so these are no-ops there. */
  notify: Pick<StepHost, "listChanged" | "resourceUpdated">;
}

class TaskStopped extends Error {}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Runs the case in the background, writing each change to the store. */
async function drive(tasks: MockTasks, taskId: string, run: TaskRun) {
  const { store, owner } = tasks;
  const write = async (patch: Omit<MockTaskPatch, "lastUpdatedAt">) => {
    const stored = await store.update(owner, taskId, {
      ...patch,
      lastUpdatedAt: nowOf(tasks),
    });
    // A cancelled, expired or deleted task stops the run at its next write.
    const current = alive(tasks, stored);
    if (!current || isTerminalTask(current.status)) throw new TaskStopped();
    return current;
  };
  const note = (text: string) => write({ statusMessage: text });
  const host: StepHost = {
    sleep: (ms) => sleep(ms),
    progress: (p) =>
      note(
        p.message ??
          `Progress ${p.progress}${p.total === undefined ? "" : ` of ${p.total}`}`
      ).then(() => undefined),
    log: (level, data) =>
      note(
        `[${level}] ${typeof data === "string" ? data : JSON.stringify(data)}`
      ).then(() => undefined),
    ...run.notify,
    ask: async (requests) => {
      await write({ status: "input_required", inputRequests: requests });
      for (;;) {
        await sleep(pollOf(tasks));
        const current = alive(tasks, await store.get(owner, taskId));
        if (!current || isTerminalTask(current.status)) throw new TaskStopped();
        const replies = current.inputResponses ?? {};
        if (Object.keys(requests).every((key) => Object.hasOwn(replies, key))) {
          await write({ status: "working", inputRequests: null });
          return replies;
        }
      }
    },
  };
  try {
    const outcome = await runCase(run.chosen, run.input, host, run.finish);
    if (outcome.kind === "result") {
      await write({ status: "completed", result: outcome.result });
    }
  } catch (error) {
    if (error instanceof TaskStopped) return;
    // A case that failed fails the task with its protocol error; any other
    // failure (the store's, usually) is the host's to log, and the task is
    // failed with a message that names no internals.
    if (!(error instanceof ProtocolError)) tasks.onError(error);
    const failure =
      error instanceof ProtocolError
        ? { code: error.code, message: error.message, data: error.data }
        : {
            code: ProtocolErrorCode.InternalError,
            message: "The mock could not finish this task. Run it again.",
          };
    try {
      await store.update(owner, taskId, {
        status: "failed",
        error: failure,
        lastUpdatedAt: nowOf(tasks),
      });
    } catch (writeError) {
      tasks.onError(writeError);
    }
  }
}

/**
 * Creates the task and starts its case in the background. The record is in the
 * store before this resolves. `requestedTtlMs` is a 2025-11-25 caller's wish.
 */
export async function startTask(
  tasks: MockTasks,
  run: TaskRun,
  requestedTtlMs?: unknown
): Promise<MockTaskRecord> {
  const wish =
    typeof requestedTtlMs === "number" && requestedTtlMs > 0
      ? requestedTtlMs
      : undefined;
  const at = nowOf(tasks);
  const record: MockTaskRecord = {
    taskId: (tasks.newId ?? (() => crypto.randomUUID()))(),
    owner: tasks.owner,
    status: "working",
    createdAt: at,
    lastUpdatedAt: at,
    ttlMs: Math.min(wish ?? tasks.ttlMs ?? 300_000, MAX_TTL_MS),
  };
  await tasks.store.create(record);
  // A very short ttl can run out while the record is stored; a handle to it
  // would name a task that no read can find.
  if (!alive(tasks, record)) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `The task's ttl of ${record.ttlMs} ms ran out before the task was stored. Ask for a longer ttl.`
    );
  }
  void drive(tasks, record.taskId, run);
  return record;
}

/** The task handle a `tools/call` answers with, on the wire the caller's revision speaks. */
export function taskHandle(
  wire: "extension" | "legacy",
  record: MockTaskRecord,
  tasks: MockTasks
): Obj {
  return wire === "extension"
    ? { resultType: "task", ...extTask(record, pollOf(tasks)) }
    : { task: legacyTask(record, pollOf(tasks)) };
}

/** Waits until the task is terminal; `undefined` when it is gone or the caller gave up. */
async function settled(
  tasks: MockTasks,
  taskId: string,
  signal?: AbortSignal
): Promise<MockTaskRecord | undefined> {
  for (;;) {
    const record = alive(tasks, await tasks.store.get(tasks.owner, taskId));
    if (!record || isTerminalTask(record.status) || signal?.aborted) {
      return record;
    }
    await sleep(pollOf(tasks), signal);
  }
}

/**
 * Answers a task method of one wire, or `undefined` when the method is not a
 * task method of that wire or the store holds no such task (the caller then
 * decides: the real server's, or not found). The 2025-11-25 `tasks/list` is
 * `listLegacyTasks`, since it also lists the real server's tasks.
 */
export async function answerTaskMethod(
  tasks: MockTasks,
  wire: "extension" | "legacy",
  method: string,
  params: Obj | undefined,
  signal?: AbortSignal
): Promise<Obj | undefined> {
  const poll = pollOf(tasks);
  const { store, owner } = tasks;
  const taskId = typeof params?.taskId === "string" ? params.taskId : undefined;
  if (!taskId) return undefined;
  const record = alive(tasks, await store.get(owner, taskId));
  if (!record) return undefined;
  if (method === "tasks/get") {
    return wire === "extension"
      ? { resultType: "complete", ...extTask(record, poll) }
      : legacyTask(record, poll);
  }
  if (method === "tasks/cancel") {
    if (wire === "legacy" && isTerminalTask(record.status)) {
      throw terminalTask(record.status);
    }
    const stored = await store.update(owner, taskId, {
      status: "cancelled",
      inputRequests: null,
      lastUpdatedAt: nowOf(tasks),
    });
    if (wire === "extension" || !stored) return {};
    // The case can finish between the read above and this write. The store
    // then keeps the finished record, and the cancel is refused.
    if (stored.status !== "cancelled") throw terminalTask(stored.status);
    return legacyTask(stored, poll);
  }
  if (wire === "extension" && method === "tasks/update") {
    const responses = params?.inputResponses;
    // Only replies to questions the task is waiting on are kept. A reply sent
    // before its question is asked, or a second reply to a question already
    // answered, is dropped, so the first answer stands.
    const waiting = waitingOn(record);
    if (typeof responses === "object" && responses !== null) {
      const current = Object.fromEntries(
        Object.entries(responses as Obj).filter(([key]) =>
          Object.hasOwn(waiting, key)
        )
      );
      if (Object.keys(current).length > 0) {
        await store.update(owner, taskId, {
          addInputResponses: current,
          lastUpdatedAt: nowOf(tasks),
        });
      }
    }
    return {};
  }
  if (wire === "legacy" && method === "tasks/result") {
    const done = await settled(tasks, taskId, signal);
    if (!done) throw unknownTask();
    if (done.status === "failed" && done.error) {
      throw new ProtocolError(
        done.error.code,
        done.error.message,
        done.error.data
      );
    }
    if (done.status !== "completed" || !done.result) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        "The task did not finish, so it has no result."
      );
    }
    return {
      ...done.result,
      _meta: { ...done.result._meta, [RELATED_TASK_KEY]: { taskId } },
    };
  }
  return undefined;
}

export { unknownTask };
