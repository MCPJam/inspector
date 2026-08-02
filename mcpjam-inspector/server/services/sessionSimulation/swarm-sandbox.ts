/**
 * Per-attempt ephemeral sandboxes for swarm (journey) sessions — B-isolation.
 *
 * Swarm sessions have had NO bash since #3595, which suppressed it fail-closed
 * because every session in a run reserved — and concurrently shared — the
 * launcher's single persistent project computer. This is the mechanism that
 * pays that back: each claimed attempt provisions its own disposable box from
 * the environment's pinned image, execs bash there, and releases it.
 *
 * Isolation here is STRUCTURAL, not policed: one attempt, one box, one
 * filesystem. Nothing at the tool layer has to remember to keep sessions apart.
 */
import { logger } from "../../utils/logger.js";
import {
  isComputersDataPlaneConfigured,
  provisionJourneySandbox,
  releaseSandbox,
} from "../../utils/computers/control-plane-client.js";
import type { PinnedHostExecutionSpec } from "../swarm-agent.js";
import type { TrustedSandboxBinding } from "../../utils/built-in-tools/registry.js";
import { BASH_TOOL_NAME } from "../../utils/built-in-tools/bash.js";

/**
 * Does this target want a shell at all? Mirrors the backend's `wantsBash` gate
 * exactly — if the two disagree, we either provision a box nothing uses (paid,
 * silent) or ask for one the backend refused to pin (a spurious attempt
 * failure).
 */
export function targetWantsBash(target: PinnedHostExecutionSpec): boolean {
  return (
    target.computer !== undefined &&
    (target.builtInToolIds ?? []).includes(BASH_TOOL_NAME)
  );
}

/**
 * Does this target run a HARNESS, which needs a box of its own?
 *
 * The real Claude Code / Codex runtime executes ON a machine, so a harness
 * target needs a sandbox even when it advertises no `bash` tool. Mirrors the
 * backend's `wantsSandbox` gate exactly — the two must agree or we either
 * provision a box nothing uses (paid, silent) or ask for one the backend
 * refused to pin (a spurious attempt failure).
 */
export function targetWantsHarnessBox(
  target: PinnedHostExecutionSpec
): boolean {
  return target.computer !== undefined && target.harness !== undefined;
}

/** Either consumer of the per-attempt box. */
export function targetWantsSandbox(target: PinnedHostExecutionSpec): boolean {
  return targetWantsBash(target) || targetWantsHarnessBox(target);
}

/**
 * Whether an ephemeral sandbox should be attempted for this target, and if not,
 * why — so the caller can tell "nothing to do" apart from "we should have had
 * one and didn't".
 *
 * Wire contract: the pin/reason pair is an explicit tri-state, and BOTH ABSENT
 * means a pre-B-isolation run snapshot, NOT "unavailable". Absence alone cannot
 * distinguish an old backend from a new backend with no image, and the two need
 * different behaviour — the first must keep today's suppression silently, the
 * second must say what's wrong.
 */
export type SandboxIntent =
  | { kind: "provision" }
  | { kind: "skip"; reason?: string };

export function sandboxIntentFor(
  target: PinnedHostExecutionSpec
): SandboxIntent {
  if (!targetWantsSandbox(target)) return { kind: "skip" };
  if (target.computerEnvironment) return { kind: "provision" };
  // PRESENCE, not truthiness: an empty-string reason is still the backend
  // saying "known-unavailable", and treating it as absent would silently
  // downgrade it to the legacy "pre-B-isolation snapshot" branch and drop the
  // notice entirely.
  if (target.computerUnavailableReason !== undefined) {
    return {
      kind: "skip",
      reason:
        target.computerUnavailableReason.trim() ||
        "This environment has no computer image available, so this run has " +
          "no sandbox to execute in.",
    };
  }
  // Pre-B-isolation snapshot: the backend never resolved an image for this
  // target because it did not know how to. Silently skip — announcing "no
  // image" would be a guess, and a wrong one on a run that simply predates the
  // feature.
  return { kind: "skip" };
}

export interface ProvisionedAttemptSandbox {
  binding: TrustedSandboxBinding;
  sandboxRowId: string;
}

export type ProvisionAttemptResult =
  | { ok: true; sandbox: ProvisionedAttemptSandbox }
  /** Terminal for this attempt: retrying cannot help. */
  | { ok: false; retryable: false; code: string; message: string }
  /** Exhausted the bounded retry; the attempt should fail honestly. */
  | { ok: false; retryable: true; code: string; message: string };

const MAX_PROVISION_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 4_000;
const MAX_BACKOFF_MS = 45_000;
/**
 * Per-REQUEST deadline, distinct from the run-level signal.
 *
 * `postJson` has no timeout of its own, and `sessionSignal` only fires on a
 * run-level stop — which an ordinary control-plane outage is not. So a server
 * that accepts the connection and then stalls would park this await forever:
 * the retry loop never advances past its first attempt, the already-claimed
 * attempt never reaches a terminal, and the target-worker slot is held for the
 * life of the process. Bounding each request is what keeps a hung dependency
 * from becoming a hung run.
 */
const PROVISION_REQUEST_TIMEOUT_MS = 30_000;
/** Deadline for the teardown call. Shorter than provisioning: nothing is
 * waiting on the result, and the GC cron reaps whatever this misses. */
const RELEASE_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Compose the run-level stop with a per-request deadline. `AbortSignal.any`
 * keeps both live, so a run-level abort still cancels an in-flight request
 * immediately rather than waiting out the deadline.
 */
function requestSignal(runSignal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(PROVISION_REQUEST_TIMEOUT_MS);
  return runSignal ? AbortSignal.any([runSignal, deadline]) : deadline;
}

function backoffMs(attempt: number): number {
  const exponential = Math.min(
    BASE_BACKOFF_MS * 2 ** (attempt - 1),
    MAX_BACKOFF_MS
  );
  // Jitter so several targets that hit capacity together don't retry in
  // lockstep and keep colliding.
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Provision the attempt's sandbox, retrying only what retrying can fix.
 *
 * 503 (at capacity) is transient — back off, up to ~2 minutes total. Everything
 * else (409 no_pin / attempt_not_running / image_unavailable, 403, 404) is
 * terminal: the answer will not change by asking again, and burning two minutes
 * to re-learn it delays the attempt's honest failure.
 */
export async function provisionAttemptSandbox(args: {
  bearer: string;
  runId: string;
  targetId: string;
  sessionIdx: number;
  signal?: AbortSignal;
}): Promise<ProvisionAttemptResult> {
  let last: { code: string; message: string } = {
    code: "provision_failed",
    message: "Could not provision a sandbox for this session.",
  };
  for (let attempt = 1; attempt <= MAX_PROVISION_ATTEMPTS; attempt++) {
    if (args.signal?.aborted) {
      return {
        ok: false,
        retryable: false,
        code: "aborted",
        message: "Run was cancelled while provisioning a sandbox.",
      };
    }
    const result = await provisionJourneySandbox({
      bearer: args.bearer,
      runId: args.runId,
      targetId: args.targetId,
      sessionIdx: args.sessionIdx,
      signal: requestSignal(args.signal),
    });
    // `ok: true` is NOT enough to dereference. `postJson` swallows a body-parse
    // failure and returns `{ok: true, value: null}` on any 2xx — reachable when
    // the deadline above fires AFTER the response headers arrive but before the
    // body is read. Blindly reading `.sandboxId` there would throw a TypeError
    // straight past this bounded retry, turning the hang the deadline exists to
    // contain into a worse failure. Treat an unusable body as transient.
    if (result.ok && result.value?.sandboxId && result.value?.sandboxRowId) {
      return {
        ok: true,
        sandbox: {
          sandboxRowId: result.value.sandboxRowId,
          binding: {
            sandboxId: result.value.sandboxId,
            ...(result.value.workdir ? { workdir: result.value.workdir } : {}),
          },
        },
      };
    }
    if (result.ok) {
      logger.warn("[swarm.sandbox] provision returned an unusable body", {
        runId: args.runId,
        targetId: args.targetId,
        sessionIdx: args.sessionIdx,
      });
    }
    // 0 is a network error — also transient. A request that hit its own
    // deadline surfaces the same way, and is likewise worth retrying; only the
    // RUN-level signal means "stop", which the loop head checks separately.
    // An `ok`-but-unusable body reaches here too and is likewise transient.
    const status = result.ok ? 0 : result.status;
    const retryable = status === 503 || status === 0;
    last = {
      code: status === 503 ? "sandbox_at_capacity" : "sandbox_error",
      message: result.ok
        ? "The control plane returned an incomplete provisioning response."
        : result.error,
    };
    if (!retryable) {
      return { ok: false, retryable: false, ...last };
    }
    if (attempt < MAX_PROVISION_ATTEMPTS) {
      logger.warn("[swarm.sandbox] provision retrying", {
        runId: args.runId,
        targetId: args.targetId,
        sessionIdx: args.sessionIdx,
        attempt,
        status,
      });
      await sleep(backoffMs(attempt), args.signal);
    }
  }
  return { ok: false, retryable: true, ...last };
}

/**
 * Release an attempt's box. Best-effort and never throws — a release failure
 * must not turn a successful session into a failed one, and the backend's GC
 * cron reaps anything this misses.
 *
 * Deliberately independent of the RUN signal (cleanup must still run when the
 * run was cancelled) but NOT unbounded: it runs inside the attempt's `finally`,
 * so a control-plane that accepts the connection and never responds would stop
 * the target scheduling further sessions, leave the worker pool's `Promise.all`
 * unresolved, and keep the whole run alive with pending attempts and a live
 * heartbeat. "Don't use the run's signal" and "have no deadline" are different
 * requirements; this needs the first, not the second.
 */
export async function releaseAttemptSandbox(
  sandboxRowId: string
): Promise<void> {
  try {
    await releaseSandbox({
      sandboxRowId,
      signal: AbortSignal.timeout(RELEASE_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn("[swarm.sandbox] release failed; GC will reap it", {
      sandboxRowId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Can this process actually run the ephemeral path end to end?
 *
 * Provision and RELEASE share one credential set, so a server that can boot a
 * box but not tear one down would burn paid sandboxes until the cron notices.
 * Checking configuration once, up front, keeps that from ever happening —
 * the same check `evals-runner.ts` makes before its own sandbox path.
 */
export function canProvisionSwarmSandboxes(): boolean {
  return isComputersDataPlaneConfigured();
}
