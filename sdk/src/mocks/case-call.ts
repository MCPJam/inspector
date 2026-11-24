import type {
  CallToolResult,
  LoggingLevel,
  ServerContext,
} from "@modelcontextprotocol/server";
import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";
import { inputRequiredFor, readState, runCase } from "./case-steps.js";
import type { StepHost } from "./case-steps.js";
import { isInputStep } from "./definition-types.js";
import type { MockSavedCase } from "./definition-types.js";
import type { CallAnswer } from "./mock-server.js";
import { extTask, legacyTask, TASKS_EXTENSION_ID } from "./mock-tasks.js";
import type { MockTaskStore } from "./mock-tasks.js";

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

/** The steps' view of one call: progress only with the caller's token, logs through the caller's own level. */
export function stepHostFor(
  ctx: ServerContext,
  progressToken: string | number | undefined
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
  startTask?: (
    chosen: MockSavedCase,
    input: Obj
  ) => CallAnswer | CallToolResult;
}

/**
 * A chosen case that has steps or runs as a task. As a task it answers with
 * the handle; otherwise it runs in place and either gives its result or stops
 * at its questions, which the server SDK carries to the client (a
 * 2026-07-28 caller answers in a retry; an older one in the session).
 */
export async function answerCase(
  chosen: MockSavedCase,
  input: Obj,
  call: CaseCall
): Promise<CallAnswer> {
  if (chosen.task && call.startTask) return call.startTask(chosen, input);
  const resume = readState(call.requestState, chosen);
  const run = await runCase(
    chosen,
    input,
    call.host,
    resume && { ...resume, responses: call.responses ?? {} }
  );
  return run.kind === "result" ? run.result : inputRequiredFor(run);
}

/**
 * How a case that runs as a task starts one for this call, or `undefined`
 * when this caller cannot take a task (the server decides, but only for a
 * caller that said it can: a 2026-07-28 caller by declaring the extension,
 * a 2025-11-25 caller by sending `params.task`).
 */
export function taskStarter(
  tasks: { store: MockTaskStore; owner: string } | undefined,
  era: "legacy" | "modern",
  ctx: ServerContext,
  taskParam: unknown
): CaseCall["startTask"] {
  if (!tasks) return undefined;
  const { store, owner } = tasks;
  if (era === "modern") {
    if (!callerTakesExtensionTask(ctx)) return undefined;
    return (chosen, input) => ({
      taskCreated: {
        resultType: "task",
        ...extTask(store.create(owner, chosen, input), store.pollIntervalMs),
      },
    });
  }
  if (!isObj(taskParam)) return undefined;
  return (chosen, input) => {
    if (chosen.steps?.some(isInputStep)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "This case asks a question while it runs as a task, and the 2025-11-25 task wire cannot carry one. Call it without a task, or connect with protocol revision 2026-07-28.",
          },
        ],
      };
    }
    return {
      taskCreated: {
        task: legacyTask(
          store.create(owner, chosen, input),
          store.pollIntervalMs
        ),
      },
    };
  };
}
