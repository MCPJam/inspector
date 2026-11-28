import type {
  CallToolResult,
  InputRequiredResult,
  LoggingLevel,
  ServerContext,
} from "@modelcontextprotocol/server";
import { inputRequiredFor, readState, runCase } from "./case-steps.js";
import type { StepHost } from "./case-steps.js";
import type { MockSavedCase } from "./definition-types.js";
import type { MockNotifier } from "./notifier.js";

type Obj = Record<string, unknown>;

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

export interface CaseCall {
  host: StepHost;
  /** The client's replies to the questions the last round asked. */
  responses?: Obj;
  requestState?: unknown;
}

/**
 * A chosen case that has steps. It runs in place and either gives its result
 * or stops at its questions, which a 2026-07-28 caller answers in a retry.
 */
export async function answerCase(
  chosen: MockSavedCase,
  input: Obj,
  call: CaseCall,
  finish: (replies: Obj) => CallToolResult
): Promise<CallToolResult | InputRequiredResult> {
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
