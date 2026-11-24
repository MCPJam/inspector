import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  InputRequest,
} from "@modelcontextprotocol/server";
import { runCase } from "./case-steps.js";
import type { MockSavedCase } from "./definition-types.js";

/**
 * A saved case that runs as a task. The store is memory in this process, so a
 * task is reachable only on the replica that created it (the route says so).
 * Written by hand over the server SDK's request handlers, which have no task
 * runtime: the 2026-07-28 extension (`io.modelcontextprotocol/tasks`) and the
 * 2025-11-25 in-core utility are two wires over the same record.
 */

type Obj = Record<string, unknown>;
export type TaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

const TERMINAL: TaskStatus[] = ["completed", "failed", "cancelled"];

export interface MockTaskRecord {
  taskId: string;
  owner: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: number;
  lastUpdatedAt: number;
  ttlMs: number;
  inputRequests?: Record<string, InputRequest>;
  result?: CallToolResult;
  error?: { code: number; message: string; data?: unknown };
}

export interface MockTaskStoreOptions {
  /** Tasks held at once, finished ones evicted first. Default 200. */
  maxTasks?: number;
  /** How long a task is kept. Default 5 minutes. */
  ttlMs?: number;
  /** How often a client is told to poll. Default 250 ms. */
  pollIntervalMs?: number;
  now?: () => number;
  newId?: () => string;
}

interface Live {
  record: MockTaskRecord;
  abort: AbortController;
  /** Set while the run waits for replies. */
  answer?: (responses: Obj) => void;
  waiters: Set<() => void>;
}

export interface MockTaskStore {
  readonly pollIntervalMs: number;
  /** Starts the case in the background. Throws `ProtocolError` when the store is full of running tasks. */
  create(owner: string, chosen: MockSavedCase, input: Obj): MockTaskRecord;
  get(owner: string, taskId: string): MockTaskRecord | undefined;
  list(owner: string): MockTaskRecord[];
  /** Hands replies to a task waiting on questions; returns false when it is not waiting. */
  update(owner: string, taskId: string, responses: Obj): boolean;
  cancel(owner: string, taskId: string): MockTaskRecord | undefined;
  /** Resolves when the task is finished or the signal aborts. */
  settled(
    owner: string,
    taskId: string,
    signal?: AbortSignal
  ): Promise<MockTaskRecord | undefined>;
  size(): number;
}

export function createMockTaskStore(
  options: MockTaskStoreOptions = {}
): MockTaskStore {
  const maxTasks = options.maxTasks ?? 200;
  const ttlMs = options.ttlMs ?? 300_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const tasks = new Map<string, Live>();

  const touch = (live: Live, change: Partial<MockTaskRecord>) => {
    Object.assign(live.record, change, { lastUpdatedAt: now() });
    for (const wake of [...live.waiters]) wake();
  };
  const purge = () => {
    for (const [id, live] of tasks) {
      if (now() - live.record.createdAt > live.record.ttlMs) {
        live.abort.abort();
        tasks.delete(id);
      }
    }
  };
  const find = (owner: string, taskId: string) => {
    purge();
    const live = tasks.get(taskId);
    return live && live.record.owner === owner ? live : undefined;
  };

  async function run(live: Live, chosen: MockSavedCase, input: Obj) {
    const { signal } = live.abort;
    const sleep = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true }
        );
      });
    try {
      const run = await runCase(chosen, input, {
        sleep,
        progress: async (p) =>
          touch(live, {
            statusMessage:
              p.message ??
              `Progress ${p.progress}${p.total === undefined ? "" : ` of ${p.total}`}`,
          }),
        log: async (level, data) =>
          touch(live, {
            statusMessage: `[${level}] ${typeof data === "string" ? data : JSON.stringify(data)}`,
          }),
        ask: (requests) =>
          new Promise<Obj>((resolve, reject) => {
            touch(live, {
              status: "input_required",
              inputRequests: requests,
            });
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
            live.answer = (responses) => {
              const missing = Object.keys(requests).filter(
                (key) => !(key in responses)
              );
              if (missing.length > 0) return;
              live.answer = undefined;
              touch(live, { status: "working", inputRequests: undefined });
              resolve(responses);
            };
          }),
      });
      if (run.kind === "result") {
        touch(live, { status: "completed", result: run.result });
      }
    } catch (error) {
      if (signal.aborted) return;
      touch(live, {
        status: "failed",
        error:
          error instanceof ProtocolError
            ? { code: error.code, message: error.message, data: error.data }
            : {
                code: ProtocolErrorCode.InternalError,
                message: "The mock could not finish this task. Run it again.",
              },
      });
    }
  }

  return {
    pollIntervalMs,
    create(owner, chosen, input) {
      purge();
      if (tasks.size >= maxTasks) {
        const finished = [...tasks.values()].find((l) =>
          TERMINAL.includes(l.record.status)
        );
        if (!finished) {
          throw new ProtocolError(
            ProtocolErrorCode.InternalError,
            "This mock is running as many tasks as it allows. Wait for one to finish, then call again."
          );
        }
        tasks.delete(finished.record.taskId);
      }
      const at = now();
      const live: Live = {
        record: {
          taskId: newId(),
          owner,
          status: "working",
          createdAt: at,
          lastUpdatedAt: at,
          ttlMs,
        },
        abort: new AbortController(),
        waiters: new Set(),
      };
      tasks.set(live.record.taskId, live);
      void run(live, chosen, input);
      return live.record;
    },
    get: (owner, taskId) => find(owner, taskId)?.record,
    list: (owner) => {
      purge();
      return [...tasks.values()]
        .filter((l) => l.record.owner === owner)
        .map((l) => l.record);
    },
    update(owner, taskId, responses) {
      const live = find(owner, taskId);
      if (!live?.answer) return false;
      live.answer(responses);
      return true;
    },
    cancel(owner, taskId) {
      const live = find(owner, taskId);
      if (!live) return undefined;
      if (!TERMINAL.includes(live.record.status)) {
        live.abort.abort();
        touch(live, { status: "cancelled", inputRequests: undefined });
      }
      return live.record;
    },
    settled(owner, taskId, signal) {
      const live = find(owner, taskId);
      if (!live) return Promise.resolve(undefined);
      return new Promise((resolve) => {
        const check = () => {
          if (TERMINAL.includes(live.record.status) || signal?.aborted) {
            live.waiters.delete(check);
            resolve(live.record);
          }
        };
        live.waiters.add(check);
        signal?.addEventListener("abort", check, { once: true });
        check();
      });
    },
    size: () => tasks.size,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The record as the 2026-07-28 extension's `DetailedTask` (the status decides which payload rides along). */
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
      inputRequests: record.inputRequests ?? {},
    }),
    ...(record.status === "completed" && { result: record.result }),
    ...(record.status === "failed" && { error: record.error }),
  };
}

/** The record as the 2025-11-25 in-core `Task`. */
export function legacyTask(record: MockTaskRecord, pollInterval: number): Obj {
  return {
    taskId: record.taskId,
    status: record.status,
    ...(record.statusMessage !== undefined && {
      statusMessage: record.statusMessage,
    }),
    createdAt: iso(record.createdAt),
    lastUpdatedAt: iso(record.lastUpdatedAt),
    ttl: record.ttlMs,
    pollInterval,
  };
}

export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";

const unknownTask = () =>
  new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    "No task has that id. It may have finished long ago or run on another replica; call the tool again."
  );

/**
 * Answers the task methods of one wire for one owner, or `undefined` for a
 * method that is not one (or a task id this store does not hold).
 */
export async function answerTaskMethod(
  store: MockTaskStore,
  owner: string,
  wire: "extension" | "legacy",
  method: string,
  params: Obj | undefined,
  signal?: AbortSignal
): Promise<Obj | undefined> {
  const taskId = typeof params?.taskId === "string" ? params.taskId : undefined;
  if (wire === "legacy" && method === "tasks/list") {
    return {
      tasks: store.list(owner).map((r) => legacyTask(r, store.pollIntervalMs)),
    };
  }
  if (!taskId) return undefined;
  const record = store.get(owner, taskId);
  if (!record) return undefined;
  if (method === "tasks/get") {
    return wire === "extension"
      ? { resultType: "complete", ...extTask(record, store.pollIntervalMs) }
      : legacyTask(record, store.pollIntervalMs);
  }
  if (method === "tasks/cancel") {
    const cancelled = store.cancel(owner, taskId);
    return wire === "extension" || !cancelled
      ? {}
      : legacyTask(cancelled, store.pollIntervalMs);
  }
  if (wire === "extension" && method === "tasks/update") {
    const responses = params?.inputResponses;
    if (typeof responses === "object" && responses !== null) {
      store.update(owner, taskId, responses as Obj);
    }
    return {};
  }
  if (wire === "legacy" && method === "tasks/result") {
    const done = await store.settled(owner, taskId, signal);
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
        "The task was cancelled, so it has no result."
      );
    }
    return {
      ...done.result,
      _meta: {
        ...done.result._meta,
        "io.modelcontextprotocol/related-task": { taskId },
      },
    };
  }
  return undefined;
}
export { unknownTask };
