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
 * Feature flag. Default OFF — swarm bash is currently suppressed entirely, so
 * the worst outcome of a bug behind this flag is "still no bash", the status
 * quo. Flip it on once the mechanism has soaked.
 */
export function isSwarmEphemeralBashEnabled(): boolean {
  const raw = process.env.MCPJAM_SWARM_EPHEMERAL_BASH?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

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
  if (!targetWantsBash(target)) return { kind: "skip" };
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
        "This environment has no computer image available, so bash is unavailable in this run.",
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
      ...(args.signal ? { signal: args.signal } : {}),
    });
    if (result.ok) {
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
    // 0 is a network error — also transient.
    const retryable = result.status === 503 || result.status === 0;
    last = {
      code: result.status === 503 ? "sandbox_at_capacity" : "sandbox_error",
      message: result.error,
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
        status: result.status,
      });
      await sleep(backoffMs(attempt), args.signal);
    }
  }
  return { ok: false, retryable: true, ...last };
}

/**
 * Release an attempt's box. Best-effort and never throws — a release failure
 * must not turn a successful session into a failed one, and the backend's GC
 * cron reaps anything this misses. Deliberately takes no abort signal: the
 * whole point is that it still runs when the run was cancelled.
 */
export async function releaseAttemptSandbox(
  sandboxRowId: string
): Promise<void> {
  try {
    await releaseSandbox({ sandboxRowId });
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
  return isSwarmEphemeralBashEnabled() && isComputersDataPlaneConfigured();
}
