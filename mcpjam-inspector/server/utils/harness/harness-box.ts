/**
 * One way to hold a disposable harness box, for every surface that boots one.
 *
 * Every non-Playground surface (suite and single-case evals, swarms, User
 * Testing) runs a harness on an EPHEMERAL box the control plane provisions per
 * iteration, attempt or conversation. Each surface used to hand-roll the same
 * three things around its own provision call: the data-plane check, the binding
 * the harness attaches to, and the release. This module owns them once, plus
 * the one thing none of them had: a TURN HEARTBEAT.
 *
 * ── Why a heartbeat ────────────────────────────────────────────────────────
 * The reaper judges eval, scenario and playground boxes idle by the row's
 * `lastUsedAt` alone. A harness turn that runs past the scope's idle TTL
 * without touching the row can lose its box mid-turn — and a harness that
 * renews no model lease (Cursor, which brings its own key) touches nothing at
 * all. So while a box is held, this touches the row every quarter of the
 * scope's TTL (the backend's bar is "at most a third"), and stops the moment
 * the box is released or the control plane says it is gone.
 *
 * ── Who releases ───────────────────────────────────────────────────────────
 * An OWNED box (eval iteration, swarm attempt) belongs to this caller alone, so
 * `release()` also tears it down. A CONVERSATION box (scenario, playground)
 * outlives the turn — the next turn reattaches to it — so `release()` only
 * stops the heartbeat and leaves the box to its idle TTL.
 *
 * ── What it does not own ───────────────────────────────────────────────────
 * Provisioning. Each surface's control-plane route takes different ids and
 * answers with different refusals, and each already retries capacity through
 * `withCapacityRetry` with its own policy. The caller passes that call in, and
 * its refusal comes back untouched.
 */
import { logger } from "../logger.js";
import {
  isComputersDataPlaneConfigured,
  releaseSandbox,
  touchSandbox,
  type TouchSandboxOutcome,
} from "../computers/control-plane-client.js";
import type { TrustedHarnessSandboxBinding } from "./resolve-sandbox.js";

const MINUTE_MS = 60_000;

export type HarnessBoxSurface =
  "eval" | "single-case" | "swarm" | "scenario" | "playground";

interface HarnessBoxScope {
  /** The backend's idle TTL for this scope (`SANDBOX_TTL_MS`). */
  idleTtlMs: number;
  /** Does `release()` tear the box down, or only stop the heartbeat? */
  ownsBox: boolean;
}

/**
 * Mirrors `SANDBOX_TTL_MS` in the backend's `convex/lib/ephemeralSandboxes.ts`.
 * A copy that drifts LOWER only touches more often; one that drifts higher
 * could let a turn outlive its box, so when in doubt, take the smaller value.
 * Journey boxes are kept alive by the attempt heartbeat as well; touching them
 * too costs one cheap write and keeps the rule "every harness turn heartbeats".
 */
export const HARNESS_BOX_SCOPES: Record<HarnessBoxSurface, HarnessBoxScope> = {
  eval: { idleTtlMs: 30 * MINUTE_MS, ownsBox: true },
  "single-case": { idleTtlMs: 30 * MINUTE_MS, ownsBox: true },
  swarm: { idleTtlMs: 60 * MINUTE_MS, ownsBox: true },
  scenario: { idleTtlMs: 20 * MINUTE_MS, ownsBox: false },
  playground: { idleTtlMs: 30 * MINUTE_MS, ownsBox: false },
};

/** A quarter of the TTL: two touches can be lost before the box is at risk. */
export function harnessBoxHeartbeatIntervalMs(
  surface: HarnessBoxSurface,
): number {
  return Math.floor(HARNESS_BOX_SCOPES[surface].idleTtlMs / 4);
}

/** Each touch gets its own deadline, well inside the beat. */
const TOUCH_REQUEST_TIMEOUT_MS = 10_000;
/** Teardown deadline. Nothing waits on it, and the reaper takes any miss. */
const RELEASE_REQUEST_TIMEOUT_MS = 15_000;

const DATA_PLANE_REQUIREMENT =
  "but this server isn't a computers data plane (deployed servers bootstrap " +
  "credentials from INSPECTOR_SERVICE_TOKEN; see docs/project-computers.md) " +
  "— it could provision a sandbox but not exec or release it.";

/**
 * Can this server run a disposable box end to end? Provisioning needs only a
 * user bearer, but EXEC needs the vendor key and RELEASE needs the service
 * token, so a server that can boot a box but not use or free it would burn a
 * paid sandbox per attempt until the reaper noticed. Every surface asks this
 * before it provisions.
 */
export function canProvisionHarnessBoxes(): boolean {
  return isComputersDataPlaneConfigured();
}

/**
 * The refusal when {@link canProvisionHarnessBoxes} is false, worded for the
 * surface: `need` says what wanted the box ("This eval runs on a harness,
 * which boots a disposable computer per iteration"). Null when it is fine.
 */
export function harnessBoxUnavailableReason(need: string): string | null {
  return canProvisionHarnessBoxes()
    ? null
    : `${need}, ${DATA_PLANE_REQUIREMENT}`;
}

/** What the surface's provision call booted. */
export interface ProvisionedHarnessBox {
  sandboxRowId: string;
  sandboxId: string;
  /** What ACTUALLY booted; absent means terminal. */
  runtimeKind?: "terminal" | "desktop-browser";
  workdir?: string;
}

export type ProvisionHarnessBoxResult<Refusal> =
  { ok: true; box: ProvisionedHarnessBox } | { ok: false; refusal: Refusal };

/**
 * The binding a harness attaches to, plus what booted. `runtimeKind` rides
 * along because the bash/browser registry keys on it; the harness reads only
 * the {@link TrustedHarnessSandboxBinding} fields.
 */
export type HarnessBoxBinding = TrustedHarnessSandboxBinding & {
  runtimeKind: "terminal" | "desktop-browser";
};

export interface HarnessBox {
  readonly surface: HarnessBoxSurface;
  readonly binding: HarnessBoxBinding;
  /**
   * Stop the heartbeat and, for an owned box, release it. Idempotent and never
   * throws: it runs in `finally` blocks, and a release failure must not turn a
   * finished turn into a failed one.
   */
  release(): Promise<void>;
}

export type AcquireHarnessBoxResult<Refusal> =
  { ok: true; box: HarnessBox } | { ok: false; refusal: Refusal };

export interface AcquireHarnessBoxOptions<Refusal> {
  surface: HarnessBoxSurface;
  /** The surface's own control-plane call, capacity retry included. */
  provision: () => Promise<ProvisionHarnessBoxResult<Refusal>>;
  /**
   * How an OWNED box is torn down. Defaults to the scope-agnostic release.
   * A surface that has to read something off the box first (a hosted browser
   * recording) passes its own. Never called for a conversation box.
   */
  release?: (sandboxRowId: string) => Promise<void>;
  /** Test seams. */
  touch?: typeof touchSandbox;
  heartbeatIntervalMs?: number;
}

/**
 * Provision a box through the surface's own call, start its turn heartbeat,
 * and hand back the binding with a single `release()`.
 */
export async function acquireHarnessBox<Refusal>(
  options: AcquireHarnessBoxOptions<Refusal>,
): Promise<AcquireHarnessBoxResult<Refusal>> {
  const provisioned = await options.provision();
  if (!provisioned.ok) return provisioned;
  return { ok: true, box: holdHarnessBox(options, provisioned.box) };
}

/**
 * Hold a box the caller already has: the same heartbeat and release, for a
 * surface whose provisioning cannot be passed in as a callback.
 */
export function holdHarnessBox(
  options: Omit<AcquireHarnessBoxOptions<unknown>, "provision">,
  provisioned: ProvisionedHarnessBox,
): HarnessBox {
  const binding: HarnessBoxBinding = {
    sandboxRowId: provisioned.sandboxRowId,
    sandboxId: provisioned.sandboxId,
    runtimeKind: provisioned.runtimeKind ?? "terminal",
    ...(provisioned.workdir ? { workdir: provisioned.workdir } : {}),
  };
  const stopHeartbeat = startHarnessBoxHeartbeat({
    surface: options.surface,
    binding,
    ...(options.touch ? { touch: options.touch } : {}),
    ...(options.heartbeatIntervalMs !== undefined
      ? { intervalMs: options.heartbeatIntervalMs }
      : {}),
  });
  let released: Promise<void> | null = null;
  const release = (): Promise<void> => {
    released ??= (async () => {
      stopHeartbeat();
      if (!HARNESS_BOX_SCOPES[options.surface].ownsBox) return;
      try {
        await (options.release ?? releaseByRowId)(binding.sandboxRowId);
      } catch (err) {
        logger.warn("[harness-box] release failed; the reaper will take it", {
          surface: options.surface,
          sandboxRowId: binding.sandboxRowId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return released;
  };
  return { surface: options.surface, binding, release };
}

async function releaseByRowId(sandboxRowId: string): Promise<void> {
  await releaseSandbox({
    sandboxRowId,
    signal: AbortSignal.timeout(RELEASE_REQUEST_TIMEOUT_MS),
  });
}

/**
 * Touch the box's row on a fixed beat until stopped or told the box is gone.
 * Returns the stop function. One touch in flight at a time, and the timer is
 * unref'd so a forgotten heartbeat can never hold the process open.
 */
export function startHarnessBoxHeartbeat(args: {
  surface: HarnessBoxSurface;
  binding: TrustedHarnessSandboxBinding;
  intervalMs?: number;
  touch?: typeof touchSandbox;
}): () => void {
  const intervalMs =
    args.intervalMs ?? harnessBoxHeartbeatIntervalMs(args.surface);
  const touch = args.touch ?? touchSandbox;
  let stopped = false;
  let inFlight = false;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = true;
    void (async () => {
      let outcome: TouchSandboxOutcome;
      try {
        outcome = await touch({
          sandboxRowId: args.binding.sandboxRowId,
          sandboxId: args.binding.sandboxId,
          signal: AbortSignal.timeout(TOUCH_REQUEST_TIMEOUT_MS),
        });
      } catch {
        outcome = "failed";
      } finally {
        inFlight = false;
      }
      if (outcome === "gone") {
        // Released, reaping, or not this box. Nothing a later touch can fix,
        // and the turn finds out on its own next exec.
        stop();
      } else if (outcome === "failed") {
        logger.warn(
          "[harness-box] heartbeat touch failed; retrying next beat",
          {
            surface: args.surface,
            sandboxRowId: args.binding.sandboxRowId,
          },
        );
      }
    })();
  }, intervalMs);
  timer.unref?.();
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  return stop;
}
