import type {
  CallToolResult,
  InputRequiredResult,
  LoggingLevel,
  ServerContext,
} from "@modelcontextprotocol/server";
import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";
import { inputRequiredFor, readState, runCase } from "./case-steps.js";
import type { StepHost } from "./case-steps.js";
import type { MockSavedCase } from "./definition-types.js";
import type { TaskCreated } from "./mock-server.js";
import { startTask, taskHandle, TASKS_EXTENSION_ID } from "./mock-tasks.js";
import type { MockTasks, TaskRun } from "./mock-tasks.js";
import type { MockNotifier } from "./notifier.js";

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A wait that ends early, and quietly, when the call is cancelled. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * The steps' view of one call. Progress goes out only when the caller sent a
 * progress token; logs go through the caller's own level (the server SDK
 * filters by it: 2026-07-28 sends none without one); list changes and resource
 * updates go where the revision sends them (`notifier`).
 */
export function stepHostFor(
  ctx: ServerContext,
  progressToken: string | number | undefined,
  notifier: MockNotifier
): StepHost {
  return {
    ...(progressToken !== undefined && {
      progress: (p: { progress: number; total?: number; message?: string }) =>
        ctx.mcpReq.notify({
          method: "notifications/progress",
          params: { progressToken, ...p },
        }),
    }),
    log: (level, data, logger) =>
      ctx.mcpReq.log(level as LoggingLevel, data, logger),
    listChanged: (list) => notifier.listChanged(list),
    resourceUpdated: (uri) => notifier.resourceUpdated(uri),
    sleep: (ms) => sleep(ms, ctx.mcpReq.signal),
  };
}

/** Whether a 2026-07-28 caller declared on this request that it can take a task. */
export function callerTakesExtensionTask(ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Obj | undefined;
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY];
  const extensions = isObj(capabilities) ? capabilities.extensions : undefined;
  return isObj(extensions) && isObj(extensions[TASKS_EXTENSION_ID]);
}

export interface CaseCall {
  host: StepHost;
  /** The client's replies to the questions the last round asked. */
  responses?: Obj;
  requestState?: unknown;
  /** Present when the caller can take a task: starts the case as one and answers with its handle. */
  startTask?: (run: Omit<TaskRun, "notify">) => Promise<TaskCreated>;
}

/**
 * A chosen case that has steps or runs as a task. As a task it answers with
 * the handle; otherwise it runs in place and either gives its result or stops
 * at its questions, which a 2026-07-28 caller answers in a retry.
 */
export async function answerCase(
  chosen: MockSavedCase,
  input: Obj,
  call: CaseCall,
  finish: (replies: Obj) => CallToolResult
): Promise<CallToolResult | InputRequiredResult | TaskCreated> {
  if (chosen.task && call.startTask) {
    return call.startTask({ chosen, input, finish });
  }
  const resume = readState(call.requestState, chosen);
  const run = await runCase(
    chosen,
    input,
    call.host,
    finish,
    resume && { ...resume, responses: call.responses ?? {} }
  );
  return run.kind === "result" ? run.result : inputRequiredFor(run);
}

/**
 * How a case that runs as a task starts one for this call, or `undefined`
 * when this caller cannot take a task. The server decides, but only for a
 * caller that said it can: a 2026-07-28 caller by declaring the extension on
 * the request, a 2025-11-25 caller by sending `params.task`. Earlier
 * revisions have no tasks, so the case answers in place. `detached` sends the
 * notification steps of a task, which runs after its request ended.
 */
export function taskStarter(
  tasks: MockTasks | undefined,
  revision: string,
  ctx: ServerContext,
  taskParam: unknown,
  detached: MockNotifier
): CaseCall["startTask"] {
  if (!tasks) return undefined;
  const wire =
    revision === "2026-07-28" && callerTakesExtensionTask(ctx)
      ? "extension"
      : revision === "2025-11-25" && isObj(taskParam)
        ? "legacy"
        : undefined;
  if (!wire) return undefined;
  const ttl = isObj(taskParam) ? taskParam.ttl : undefined;
  return async (run) => ({
    taskCreated: taskHandle(
      wire,
      await startTask(
        tasks,
        { ...run, notify: detached },
        wire === "legacy" ? ttl : undefined
      ),
      tasks
    ),
  });
}
