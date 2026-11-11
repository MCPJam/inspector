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
 * The backend judges eval, scenario and playground boxes idle by the row's
 * `lastUsedAt` alone. A harness turn that runs past the box's idle window
 * without touching the row can lose its box mid-turn — and a harness that
 * renews no model lease (Cursor, which brings its own key) touches nothing at
 * all. So while a box is held, this touches the row every quarter of the
 * window (the backend's bar is "at most a third"), and stops the moment the
 * box is released, the turn's signal aborts, or the control plane says it is
 * gone. A conversation box's window comes from the backend (`idleMs` in its
 * reserve and touch replies); an eval or swarm box's is the copy below.
 *
 * ── Who releases ───────────────────────────────────────────────────────────
 * An OWNED box (eval iteration, swarm attempt) belongs to this caller alone, so
 * `release()` also tears it down. A CONVERSATION box (scenario, playground)
 * outlives the turn — the next turn reattaches to it — so `release()` stops
 * the heartbeat and sends the turn's FINAL touch (`ended`), which tells the
 * control plane no turn holds the box any more: the idle window runs from the
 * end of the turn, E2B's timer is renewed to match, and at the member's cap
 * an idle box is evicted to make room instead of refusing a new conversation.
 *
 * An abort is not a release. A caller can stop waiting on work that never
 * unwinds (an eval iteration past its budget grace is abandoned, so its
 * `finally` may never run); the abort stops the heartbeat so the box can go
 * idle and reap, but `release()` stays the one teardown path.
 *
 * ── What it does not own ───────────────────────────────────────────────────
 * Provisioning. Each surface's control-plane route takes different ids and
 * answers with different refusals, and each already retries capacity through
 * `withCapacityRetry` with its own policy. The caller passes that call in, and
 * its refusal comes back untouched.
 */
import { HOSTED_MODE } from "../../config.js";
import { logger } from "../logger.js";
import {
  isComputersDataPlaneConfigured,
  releaseSandbox,
  touchSandbox,
  type TouchSandboxResult,
} from "../computers/control-plane-client.js";
import type { TrustedHarnessSandboxBinding } from "./resolve-sandbox.js";

const MINUTE_MS = 60_000;

export type HarnessBoxSurface =
  "eval" | "single-case" | "swarm" | "scenario" | "playground";

type HarnessBoxScope =
  /** An OWNED box, torn down by `release()`, on the backend's TTL copied here. */
  | { ownsBox: true; idleTtlMs: number }
  /** A CONVERSATION box; its window comes from the backend (`idleMs`). */
  | { ownsBox: false };

/**
 * The eval and swarm TTLs mirror `SANDBOX_TTL_MS` in the backend's
 * `convex/lib/ephemeralSandboxes.ts`. A copy that drifts LOWER only touches
 * more often; one that drifts higher could let a turn outlive its box, so when
 * in doubt, take the smaller value. Journey boxes are kept alive by the attempt
 * heartbeat as well; touching them too costs one cheap write and keeps the rule
 * "every harness turn heartbeats".
 */
export const HARNESS_BOX_SCOPES: Record<HarnessBoxSurface, HarnessBoxScope> = {
  eval: { idleTtlMs: 30 * MINUTE_MS, ownsBox: true },
  "single-case": { idleTtlMs: 30 * MINUTE_MS, ownsBox: true },
  swarm: { idleTtlMs: 60 * MINUTE_MS, ownsBox: true },
  scenario: { ownsBox: false },
  playground: { ownsBox: false },
};

/**
 * A quarter of the box's idle window: two touches can be lost before the box
 * is at risk. The window is the backend's `idleMs` when it sent one, else the
 * owned scope's copy; undefined when neither is known.
 */
export function harnessBoxHeartbeatIntervalMs(
  surface: HarnessBoxSurface,
  idleMs?: number,
): number | undefined {
  const scope = HARNESS_BOX_SCOPES[surface];
  const windowMs = idleMs ?? (scope.ownsBox ? scope.idleTtlMs : undefined);
  return windowMs === undefined ? undefined : Math.floor(windowMs / 4);
}

/** Each touch gets its own deadline, well inside the beat. */
const TOUCH_REQUEST_TIMEOUT_MS = 10_000;
/**
 * A heartbeat stops itself after this long whatever happens. No turn runs this
 * long (the backend's absolute ceilings are shorter), so this only ever fires
 * for a holder whose `release()` was never reached — and a conversation box
 * kept alive by a forgotten timer would otherwise never idle out.
 */
export const HARNESS_BOX_MAX_HEARTBEAT_MS = 4 * 60 * MINUTE_MS;
/** Teardown deadline. Nothing waits on it, and the reaper takes any miss. */
const RELEASE_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Who can turn cloud execution on: MCPJam runs the data plane behind its
 * hosted app, while on npx or a self-hosted Inspector the operator configures
 * it, and MCPJam support cannot.
 */
export function cloudExecutionContact(): string {
  return HOSTED_MODE
    ? "Contact MCPJam support"
    : "Ask your MCPJam administrator";
}

const DATA_PLANE_REQUIREMENT = `but cloud execution is unavailable. ${cloudExecutionContact()} to enable it.`;

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
  /** The backend's idle window for this box, from its reserve reply. */
  idleMs?: number;
  /** What ACTUALLY booted; absent means terminal. */
  runtimeKind?: "terminal" | "desktop-browser";
  workdir?: string;
  /**
   * A desktop booted beside this box for Browser alone, when the run pins a
   * terminal image. Shell, files and harness stay on this box.
   */
  browser?: { sandboxRowId: string; sandboxId: string };
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
  /** The desktop Browser runs on, when one was booted beside `binding`. */
  readonly browserBinding?: HarnessBoxBinding;
  /**
   * Stop the heartbeat and, for an owned box, release it (and its paired
   * desktop). Idempotent and never throws: it runs in `finally` blocks, and a
   * release failure must not turn a finished turn into a failed one.
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
  /**
   * The turn's own abort signal (iteration budget, attempt, cancel). Aborting
   * it stops the heartbeat and leaves the box to its idle TTL; it never tears
   * the box down — that is still `release()`.
   */
  signal?: AbortSignal;
  /** Test seams. */
  touch?: typeof touchSandbox;
  heartbeatIntervalMs?: number;
  maxHeartbeatMs?: number;
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
    ...(provisioned.idleMs ? { idleMs: provisioned.idleMs } : {}),
  };
  const ownsBox = HARNESS_BOX_SCOPES[options.surface].ownsBox;
  if (!ownsBox && !provisioned.idleMs) {
    // The backend sends the window with every conversation box; without it
    // the turn still runs, held by its model lease, but nothing heartbeats.
    // A backend older than this release sends none, so this stays a warning.
    logger.warn(
      "[harness-box] conversation box arrived without its idle window",
      { surface: options.surface, sandboxRowId: provisioned.sandboxRowId },
    );
  }
  const browserBinding: HarnessBoxBinding | undefined = provisioned.browser
    ? {
        sandboxRowId: provisioned.browser.sandboxRowId,
        sandboxId: provisioned.browser.sandboxId,
        runtimeKind: "desktop-browser",
      }
    : undefined;
  // The paired desktop has its own row and idle clock, so it is touched and
  // released exactly like the box it sits beside.
  const boxes = browserBinding ? [binding, browserBinding] : [binding];
  const touch = options.touch ?? touchSandbox;
  const stopHeartbeats = boxes.map((box) =>
    startHarnessBoxHeartbeat({
      surface: options.surface,
      binding: box,
      ...(box.idleMs ? { idleMs: box.idleMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.touch ? { touch: options.touch } : {}),
      ...(options.heartbeatIntervalMs !== undefined
        ? { intervalMs: options.heartbeatIntervalMs }
        : {}),
      ...(options.maxHeartbeatMs !== undefined
        ? { maxHeartbeatMs: options.maxHeartbeatMs }
        : {}),
    }),
  );
  let released: Promise<void> | null = null;
  const release = (): Promise<void> => {
    released ??= (async () => {
      for (const stop of stopHeartbeats) stop();
      if (!ownsBox) {
        await Promise.all(boxes.map((box) => endTurn(touch, box)));
        return;
      }
      await Promise.all(
        boxes.map(async (box) => {
          try {
            await (options.release ?? releaseByRowId)(box.sandboxRowId);
          } catch (err) {
            logger.warn("[harness-box] release failed; the reaper will take it", {
              surface: options.surface,
              sandboxRowId: box.sandboxRowId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
      );
    })();
    return released;
  };
  return {
    surface: options.surface,
    binding,
    ...(browserBinding ? { browserBinding } : {}),
    release,
  };
}

/**
 * A conversation box's FINAL touch: the turn is over. Best-effort: a lost end
 * touch only leaves the box looking held until the window runs out from the
 * turn's last heartbeat instead of its end.
 */
async function endTurn(
  touch: typeof touchSandbox,
  box: TrustedHarnessSandboxBinding,
): Promise<void> {
  try {
    await touch({
      sandboxRowId: box.sandboxRowId,
      sandboxId: box.sandboxId,
      ended: true,
      signal: AbortSignal.timeout(TOUCH_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn("[harness-box] end-of-turn touch failed", {
      sandboxRowId: box.sandboxRowId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function releaseByRowId(sandboxRowId: string): Promise<void> {
  await releaseSandbox({
    sandboxRowId,
    signal: AbortSignal.timeout(RELEASE_REQUEST_TIMEOUT_MS),
  });
}

/**
 * Touch the box's row on a beat until stopped, aborted, or told the box is
 * gone. Returns the stop function. One touch in flight at a time (the next is
 * scheduled when it settles), the timer is unref'd so a forgotten heartbeat can
 * never hold the process open, and a reply carrying a new idle window moves the
 * beat to a quarter of it, so a backend change reaches a turn already running.
 */
export function startHarnessBoxHeartbeat(args: {
  surface: HarnessBoxSurface;
  binding: TrustedHarnessSandboxBinding;
  /** The backend's idle window for this box, from its reserve reply. */
  idleMs?: number;
  /** A fixed beat, ignoring the window (tests). */
  intervalMs?: number;
  touch?: typeof touchSandbox;
  maxHeartbeatMs?: number;
  signal?: AbortSignal;
}): () => void {
  const initialMs =
    args.intervalMs ?? harnessBoxHeartbeatIntervalMs(args.surface, args.idleMs);
  // No window known: nothing to beat against. `holdHarnessBox` reported it.
  if (initialMs === undefined) return () => {};
  let intervalMs = initialMs;
  const touch = args.touch ?? touchSandbox;
  const stopAt =
    Date.now() + (args.maxHeartbeatMs ?? HARNESS_BOX_MAX_HEARTBEAT_MS);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(beat, delayMs);
    timer.unref?.();
  };
  const beat = () => {
    if (stopped) return;
    if (Date.now() >= stopAt) {
      logger.warn("[harness-box] heartbeat outlived its cap; stopping", {
        surface: args.surface,
        sandboxRowId: args.binding.sandboxRowId,
      });
      stop();
      return;
    }
    void (async () => {
      let result: TouchSandboxResult;
      try {
        result = await touch({
          sandboxRowId: args.binding.sandboxRowId,
          sandboxId: args.binding.sandboxId,
          signal: AbortSignal.timeout(TOUCH_REQUEST_TIMEOUT_MS),
        });
      } catch {
        result = { outcome: "failed" };
      }
      if (result.outcome === "gone") {
        // Released, reaping, or not this box. Nothing a later touch can fix,
        // and the turn finds out on its own next exec.
        stop();
        return;
      }
      if (result.outcome === "failed") {
        logger.warn(
          "[harness-box] heartbeat touch failed; retrying next beat",
          {
            surface: args.surface,
            sandboxRowId: args.binding.sandboxRowId,
          },
        );
      }
      if (args.intervalMs === undefined && result.idleMs) {
        intervalMs = Math.floor(result.idleMs / 4);
      }
      schedule(intervalMs);
    })();
  };
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    // The signal can be shared by many boxes (a swarm run's), so drop ours.
    args.signal?.removeEventListener("abort", stop);
  };
  if (args.signal?.aborted) stop();
  else {
    args.signal?.addEventListener("abort", stop, { once: true });
    schedule(intervalMs);
  }
  return stop;
}
