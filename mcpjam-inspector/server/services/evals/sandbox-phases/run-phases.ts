/**
 * Run setup and run cleanup (EFTW-90): once before the run's first iteration,
 * once after its last, each in a box of its own.
 *
 * - **Run setup** heartbeats the run while it works, because the cases have
 *   not started yet and the run's watchdog times a silent run out after a
 *   minute; setup may take five. It stops when the run is cancelled. A failure
 *   throws, so the runner records the run's setup failure and no iteration
 *   starts.
 * - **Run cleanup** runs after every iteration has settled, including after a
 *   cancel, a timeout or an error, and at most once. Best effort: it never
 *   throws, and a crash of this process skips it (the backend reports a run
 *   that ended without it).
 */
import { lastOutputLine, runPhaseScript } from "./exec.js";
import type { FrozenCodeGrading } from "./frozen-config.js";
import { withPhaseBox, type PhaseBoxDeps } from "./phase-box.js";
import {
  PHASE_LIMITS_MS,
  type IterationScriptResult,
} from "./iteration-phases.js";
import { logger } from "../../../utils/logger.js";
import { makeFunctionReference } from "convex/server";
import type { ConvexHttpClient } from "convex/browser";

/** How often run setup heartbeats the run and checks for a cancel. */
const SETUP_TICK_MS = 15_000;
/** The most run cleanup waits for iterations still cleaning up after a stop. */
const SETTLE_WAIT_MS = PHASE_LIMITS_MS.capacity + PHASE_LIMITS_MS.cleanup;

type RunScriptResults = Partial<
  Record<"runSetup" | "runCleanup", IterationScriptResult>
>;

export type RunPhaseContext = {
  config: FrozenCodeGrading;
  runId: string;
  bearer: () => string;
  /** Keeps the run alive while run setup works. */
  heartbeat: () => Promise<unknown>;
  /** True once the run has been cancelled or has ended elsewhere. */
  isStopped: () => Promise<boolean>;
  signal?: AbortSignal;
  /** Each script's result, for the run's record. */
  results: RunScriptResults;
  /** Stores results on the run, where the app and the API show them. */
  record: (results: RunScriptResults) => Promise<unknown>;
  cleanedUp?: boolean;
  deps?: PhaseBoxDeps;
};

const HEARTBEAT = makeFunctionReference<"mutation">(
  "testSuites:heartbeatTestSuiteRun",
);
const GET_RUN = makeFunctionReference<"query">("testSuites:getTestSuiteRun");
const RECORD = makeFunctionReference<"mutation">(
  "evalRunScripts:recordRunScriptResults",
);

export function runPhaseContext(args: {
  config: FrozenCodeGrading | undefined;
  runId: string | null;
  /** The runner's client: run setup heartbeats the run through it. */
  convexClient?: Pick<ConvexHttpClient, "mutation" | "query">;
  heartbeat?: () => Promise<unknown>;
  isStopped?: () => Promise<boolean>;
  record?: (results: RunScriptResults) => Promise<unknown>;
  bearer: () => string;
  signal?: AbortSignal;
}): RunPhaseContext | undefined {
  const { config, runId, convexClient } = args;
  if (!config || !runId) return undefined;
  const { runSetup, runCleanup } = config.scripts;
  if (!runSetup && !runCleanup) return undefined;
  return {
    config,
    runId,
    bearer: args.bearer,
    heartbeat:
      args.heartbeat ??
      (async () => await convexClient?.mutation(HEARTBEAT, { runId })),
    isStopped:
      args.isStopped ??
      (async () =>
        (
          (await convexClient?.query(GET_RUN, { runId })) as {
            status?: string;
          } | null
        )?.status !== "running"),
    record:
      args.record ??
      (async (results) =>
        await convexClient?.mutation(RECORD, { runId, ...results })),
    ...(args.signal ? { signal: args.signal } : {}),
    results: {},
  };
}

/** Best effort: the record is for people, and no verdict reads it. */
async function report(
  ctx: RunPhaseContext,
  results: RunScriptResults,
): Promise<void> {
  await ctx.record(results).catch((error: unknown) => {
    logger.warn("[evals] could not record a run script result", {
      runId: ctx.runId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function runRunScript(
  ctx: RunPhaseContext,
  phase: "run_setup" | "run_cleanup",
  script: string,
  limitMs: number,
  signal: AbortSignal | undefined,
): Promise<IterationScriptResult> {
  const boxed = await withPhaseBox(
    {
      runId: ctx.runId,
      phase,
      bearer: ctx.bearer(),
      timeoutMs: PHASE_LIMITS_MS.capacity,
      ...(signal ? { signal } : {}),
    },
    async (sandbox) => {
      const run = await runPhaseScript({
        sandbox,
        scriptPath: `/tmp/mcpjam/${phase}.sh`,
        script,
        fileName: `${phase}.sh`,
        env: { MCPJAM_RUN_ID: ctx.runId, MCPJAM_PHASE: phase },
        cwd: "/home/user",
        timeoutMs: limitMs,
        ...(signal ? { signal } : {}),
      });
      return {
        status:
          run.status === "exited"
            ? run.exitCode === 0
              ? ("passed" as const)
              : ("failed" as const)
            : run.status,
        ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
        output: run.output,
        durationMs: run.durationMs,
        ...(run.error ? { error: run.error } : {}),
      };
    },
    ctx.deps,
  );
  return boxed.ok
    ? boxed.value
    : { status: "error", output: "", durationMs: 0, error: boxed.error };
}

function logTickFailure(error: unknown): undefined {
  logger.warn("[evals] run setup could not reach the run", {
    error: error instanceof Error ? error.message : String(error),
  });
  return undefined;
}

export class RunSetupFailedError extends Error {
  constructor(readonly result: IterationScriptResult) {
    const why =
      result.status === "timeout"
        ? "was stopped at its time limit"
        : result.status === "error"
          ? `couldn't run: ${result.error ?? "unknown error"}`
          : `exited with code ${result.exitCode}`;
    const line = lastOutputLine(result.output);
    super(
      `The run setup script ${why}, so no iteration started.${line ? ` Last output: ${line}` : ""}`,
    );
    this.name = "RunSetupFailedError";
  }
}

/**
 * Run the run setup script, heartbeating the run until it finishes. Throws
 * {@link RunSetupFailedError} when it didn't pass; returns quietly when the
 * run was cancelled meanwhile (its iterations then see the cancel and stop).
 */
export async function runRunSetupOrThrow(
  ctx: RunPhaseContext | undefined,
): Promise<void> {
  const script = ctx?.config.scripts.runSetup;
  if (!ctx || !script) return;
  const stop = new AbortController();
  const signal = ctx.signal
    ? AbortSignal.any([ctx.signal, stop.signal])
    : stop.signal;
  let cancelled = false;
  const tick = async () => {
    // A missed heartbeat or status read is retried on the next tick; the
    // watchdog allows a minute, so one miss doesn't stop the run.
    await ctx.heartbeat().catch(logTickFailure);
    if (await ctx.isStopped().catch(logTickFailure)) {
      cancelled = true;
      stop.abort();
    }
  };
  const ticker = setInterval(() => void tick(), SETUP_TICK_MS);
  try {
    const result = await runRunScript(
      ctx,
      "run_setup",
      script,
      PHASE_LIMITS_MS.setup,
      signal,
    );
    ctx.results.runSetup = result;
    await report(ctx, { runSetup: result });
    if (cancelled) return;
    if (result.status !== "passed") throw new RunSetupFailedError(result);
  } finally {
    clearInterval(ticker);
  }
}

/**
 * Wait (boundedly) for the iterations to settle, then run the run cleanup
 * script once. Never throws.
 */
export async function runRunCleanupOnce(
  ctx: RunPhaseContext | undefined,
  inFlight: ReadonlyArray<Promise<unknown>> = [],
): Promise<void> {
  const script = ctx?.config.scripts.runCleanup;
  if (!ctx || !script || ctx.cleanedUp) return;
  ctx.cleanedUp = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(inFlight),
    new Promise((resolve) => {
      timer = setTimeout(resolve, SETTLE_WAIT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  try {
    // Its own clock and signal: it also runs after the run's was aborted.
    const result = await runRunScript(
      ctx,
      "run_cleanup",
      script,
      PHASE_LIMITS_MS.cleanup,
      undefined,
    );
    ctx.results.runCleanup = result;
    await report(ctx, { runCleanup: result });
  } catch (error) {
    logger.warn("[evals] run cleanup failed", {
      runId: ctx.runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
