import type {
  CallToolResult,
  InputRequiredResult,
  LoggingLevel,
  ServerContext,
} from "@modelcontextprotocol/server";
import { inputRequiredFor, readState, runCase } from "./case-steps.js";
import type { StepHost } from "./case-steps.js";
import type { MockSavedCase } from "./definition-types.js";

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

export interface CaseCall {
  host: StepHost;
  /** The client's replies to the questions the last round asked. */
  responses?: Obj;
  requestState?: unknown;
}

/**
 * A chosen case that has steps. It runs in place and either gives its result or stops
 * at its questions, which the server SDK carries to the client (a
 * 2026-07-28 caller answers in a retry; an older one in the session).
 */
export async function answerCase(
  chosen: MockSavedCase,
  input: Obj,
  call: CaseCall
): Promise<CallToolResult | InputRequiredResult> {
  const resume = readState(call.requestState, chosen);
  const run = await runCase(
    chosen,
    input,
    call.host,
    resume && { ...resume, responses: call.responses ?? {} }
  );
  return run.kind === "result" ? run.result : inputRequiredFor(run);
}
