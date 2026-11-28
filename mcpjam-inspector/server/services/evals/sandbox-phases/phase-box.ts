/**
 * A box for one phase of a run (EFTW-90): provisioned through the control
 * plane like the iteration's own box, attached, used, and released.
 *
 * The control plane decides everything that matters about it from the run's
 * frozen config: whether the run may have it, which image it boots and its
 * network (none for grading unless the suite allows it). This client only
 * names the phase. Capacity waits are bounded by the caller's clock, since a
 * phase box counts against the run's 4 boxes like any other.
 */
import {
  provisionEvalSandbox,
  releaseEvalSandbox,
  type EvalBoxPhase,
} from "../../../utils/computers/control-plane-client.js";
import { attachRunningSandbox } from "../../../utils/computers/attach-sandbox.js";
import { logger } from "../../../utils/logger.js";
import type { PhaseSandbox } from "./exec.js";

export type PhaseBoxRequest = {
  runId: string;
  /** Required for iteration phases; ignored for run phases. */
  iterationId?: string;
  phase: EvalBoxPhase;
  attempt?: number;
  bearer: string;
  /** How long a capacity wait may take; the caller knows its remaining clock. */
  timeoutMs: number;
  signal?: AbortSignal;
};

export type PhaseBoxOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      /** `unavailable` when no box could be had; `lost` when it went away mid-use. */
      reason: "unavailable" | "lost";
      error: string;
    };

/** The control plane's own words, prefixed with what was being booted. */
function describeRefusal(
  phase: EvalBoxPhase,
  refusal: { status: number; error: string },
): string {
  const noun = phase === "grading" ? "the grading box" : "the script's box";
  return refusal.status === 503
    ? `No eval sandbox was free in time for ${noun}: ${refusal.error}`
    : `Could not start ${noun}: ${refusal.error}`;
}

/** Injected in tests; the real ones talk to the control plane and E2B. */
export type PhaseBoxDeps = {
  provision: typeof provisionEvalSandbox;
  attach: (sandboxId: string) => Promise<PhaseSandbox>;
  release: (sandboxRowId: string) => Promise<void>;
};

/**
 * How long a release may take. Nothing waits on its answer and the reaper
 * takes a box it misses, so a stalled control plane must not hold the phase
 * (or the run's box budget) open.
 */
export const PHASE_BOX_RELEASE_TIMEOUT_MS = 15_000;

const defaultDeps: PhaseBoxDeps = {
  provision: provisionEvalSandbox,
  attach: (sandboxId) => attachRunningSandbox(sandboxId),
  release: (sandboxRowId) =>
    releaseEvalSandbox({
      sandboxRowId,
      // Its own clock, not the request's: it must run after an abort too.
      signal: AbortSignal.timeout(PHASE_BOX_RELEASE_TIMEOUT_MS),
    }),
};

/**
 * Provision the phase's box, run `work` in it, and release it however `work`
 * ends. `work` reports its own results; a throw from it means the box itself
 * failed (lost, unreachable) and comes back as `lost`.
 */
export async function withPhaseBox<T>(
  request: PhaseBoxRequest,
  work: (sandbox: PhaseSandbox) => Promise<T>,
  deps: PhaseBoxDeps = defaultDeps,
): Promise<PhaseBoxOutcome<T>> {
  const provisioned = await deps.provision({
    runId: request.runId,
    ...(request.iterationId ? { iterationId: request.iterationId } : {}),
    phase: request.phase,
    ...(request.attempt ? { attempt: request.attempt } : {}),
    bearer: request.bearer,
    timeoutMs: request.timeoutMs,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  if (!provisioned.ok) {
    return {
      ok: false,
      reason: "unavailable",
      error: describeRefusal(request.phase, provisioned),
    };
  }
  const { sandboxId, sandboxRowId } = provisioned.value;
  try {
    const sandbox = await deps.attach(sandboxId);
    return { ok: true, value: await work(sandbox) };
  } catch (error) {
    return {
      ok: false,
      reason: "lost",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // A release that fails leaves the box to the reaper, which takes it once
    // the iteration or run is done; it must not fail the phase.
    await deps.release(sandboxRowId).catch((error: unknown) => {
      logger.warn("[evals] could not release a phase box", {
        phase: request.phase,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
