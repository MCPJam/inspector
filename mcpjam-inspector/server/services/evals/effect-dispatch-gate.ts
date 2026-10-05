/**
 * The replay-safety rule, enforced at the dispatch boundary (E2 + E4).
 *
 * An attempt may be restarted automatically — retried in place after an
 * infrastructure failure (E2), or resumed after a lost worker (E4) — only with
 * DURABLE PROOF that it never dispatched anything potentially effectful: an
 * MCP tool call, a scripted (pinned) tool call, a browser action, shell
 * execution. A timed-out call may already have changed the remote server, so
 * the proof has to exist BEFORE the dispatch, not after its success.
 *
 * How the proof is kept:
 *
 *  1. At attempt start the gate persists the attempt's identity on the
 *     iteration (`testSuites:beginTrialAttempt`), with
 *     `effectDispatch.mayHaveEffects = false`. The write is idempotent by
 *     attempt id, so a failure of unknown outcome is retried. If it still
 *     fails the gate is UNARMED (the attempt is never replayed in place,
 *     `attempt_state_missing`) but STILL needs the marker below before any
 *     dispatch: the start may have committed with only its answer lost, or
 *     an earlier attempt's proof may still say "no effects" — either way the
 *     row could read as replay-safe while this attempt acts. A marker that
 *     cannot be written then refuses the dispatch. Only a backend that has
 *     no such function at all (deploy skew, so it cannot recover anything
 *     either) keeps the old permissive behaviour.
 *  2. Before the attempt's FIRST potentially effectful dispatch, an armed gate
 *     persists `mayHaveEffects = true` (`testSuites:markTrialEffectDispatch`)
 *     and only then lets the dispatch through. That write is an ADMISSION
 *     BOUNDARY: if it fails, nothing is dispatched — every later dispatch of
 *     the attempt is refused too, and the attempt is unsafe to replay
 *     (`dispatch_marker_failed`). Under E4 the same write also validates the
 *     iteration lease, so a superseded worker cannot admit another dispatch.
 *  3. After the first marker, later dispatches pass without a round trip: the
 *     proof only ever needs to say "something may have happened".
 *
 * Deliberately conservative: EVERY tool the attempt's model or script could
 * run counts, read-only-looking ones included. v1 never infers safety from a
 * tool's name or annotations.
 */
import type { ConvexHttpClient } from "convex/browser";
import { randomUUID } from "node:crypto";
import { logger } from "../../utils/logger";
import { LeaseLostError, isLeaseLostError, leaseTokenArg } from "./run-lease";
import type { ReplaySafety } from "./infra-retry";

export type EffectKind = "tool" | "scripted_tool" | "browser" | "shell";

/** A dispatch the gate refused because the marker could not be persisted. */
export class EffectDispatchRefusedError extends Error {
  override readonly name = "EffectDispatchRefusedError";
  readonly kind: EffectKind;
  constructor(kind: EffectKind, cause?: unknown) {
    super(
      "Not executed: MCPJam could not record this action before running it, " +
        "so it was refused to keep the trial safe to retry.",
    );
    this.kind = kind;
    if (cause !== undefined) this.cause = cause;
  }
}

export interface EffectDispatchGate {
  readonly attempt: number;
  readonly attemptId: string;
  /** The attempt's identity was durably recorded at start. */
  readonly armed: boolean;
  /** Anything was admitted (or attempted) this attempt. */
  readonly dispatched: boolean;
  /** Set once a marker write failed; every later admit throws it. */
  readonly refusal: EffectDispatchRefusedError | undefined;
  /**
   * Await before dispatching anything potentially effectful. Throws
   * {@link EffectDispatchRefusedError} when an armed gate cannot persist the
   * marker — the caller must then NOT dispatch.
   */
  admit(kind: EffectKind): Promise<void>;
  /** May this attempt be restarted automatically? */
  replaySafety(): ReplaySafety;
}

type GateConvex = Pick<ConvexHttpClient, "mutation">;

/** Start writes per attempt; each retry repeats the same attempt id. */
const BEGIN_WRITE_ATTEMPTS = 3;
const BEGIN_RETRY_DELAY_MS = 100;

/** The backend answered with a structured refusal: nothing was committed. */
function isStructuredRefusal(error: unknown): boolean {
  const data = (error as { data?: unknown } | null)?.data;
  return data !== null && typeof data === "object";
}

/** The backend predates the function (deploy skew): it cannot recover either. */
function isMissingFunctionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Could not find (public )?function/i.test(message);
}

/**
 * Start an attempt's gate. A start write that still fails after its retries
 * yields an UNARMED gate, which forbids replay and admits a dispatch only once
 * the marker is written (see the header). On a leased row whose start was
 * refused because this worker no longer owns it, it throws
 * {@link LeaseLostError} instead, so nothing is dispatched for a row a
 * successor now holds.
 */
export async function beginEffectDispatchGate(args: {
  convexClient: GateConvex;
  iterationId: string;
  attempt: number;
  attemptId?: string;
  /** E4: the iteration lease token, validated on every marker write. */
  leaseToken?: string;
}): Promise<EffectDispatchGate> {
  const attemptId = args.attemptId ?? randomUUID();
  // E4.2: the iteration's lease token, when the run is leased.
  const leaseToken =
    args.leaseToken ?? leaseTokenArg(args.iterationId).leaseToken;
  let armed = false;
  let legacyBackend = false;
  for (let write = 1; ; write += 1) {
    try {
      await args.convexClient.mutation("testSuites:beginTrialAttempt" as any, {
        iterationId: args.iterationId,
        attempt: args.attempt,
        attemptId,
        ...(leaseToken ? { leaseToken } : {}),
      });
      armed = true;
      break;
    } catch (error) {
      if (leaseToken && attemptRefusedForOwnership(error)) {
        throw new LeaseLostError(
          "trial attempt refused: this worker no longer owns the iteration",
        );
      }
      // Only the FIRST write can conclude "legacy backend": after a write
      // of unknown outcome, that write may have committed whatever a later
      // one reports.
      legacyBackend = write === 1 && isMissingFunctionError(error);
      const unknownOutcome = !legacyBackend && !isStructuredRefusal(error);
      if (unknownOutcome && write < BEGIN_WRITE_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, BEGIN_RETRY_DELAY_MS * write),
        );
        continue;
      }
      logger.warn("[evals] could not record trial attempt; replay disabled", {
        iterationId: args.iterationId,
        attempt: args.attempt,
        markerRequired: !legacyBackend,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  return createEffectDispatchGate({
    attempt: args.attempt,
    attemptId,
    armed,
    requireMarker: !legacyBackend,
    persistMarker: (kind) =>
      args.convexClient.mutation("testSuites:markTrialEffectDispatch" as any, {
        iterationId: args.iterationId,
        attemptId,
        kind,
        ...(leaseToken ? { leaseToken } : {}),
      }),
  });
}

/**
 * The backend refused the attempt because the row is not this worker's to
 * run: the lease fence (`LEASE_LOST`), or `TRIAL_ATTEMPT_REFUSED` (a newer
 * attempt already began, or the row is terminal).
 */
function attemptRefusedForOwnership(error: unknown): boolean {
  if (isLeaseLostError(error)) return true;
  const data = (error as { data?: { code?: unknown } } | null)?.data;
  if (data && typeof data === "object" && data.code === "TRIAL_ATTEMPT_REFUSED") {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  return /\bTRIAL_ATTEMPT_REFUSED\b/.test(message);
}

/** The gate's state machine, with its persistence injected (testable). */
export function createEffectDispatchGate(args: {
  attempt: number;
  attemptId: string;
  armed: boolean;
  /**
   * Write the marker before the first dispatch. Defaults to `armed`; an
   * unarmed gate that could not rule out a committed start passes `true`.
   */
  requireMarker?: boolean;
  persistMarker: (kind: EffectKind) => Promise<unknown>;
}): EffectDispatchGate {
  const requireMarker = args.requireMarker ?? args.armed;
  let dispatched = false;
  let marked = false;
  let refusal: EffectDispatchRefusedError | undefined;
  /** One in-flight marker write shared by concurrent first dispatches. */
  let pending: Promise<void> | undefined;

  const gate: EffectDispatchGate = {
    attempt: args.attempt,
    attemptId: args.attemptId,
    armed: args.armed,
    get dispatched() {
      return dispatched;
    },
    get refusal() {
      return refusal;
    },
    async admit(kind) {
      // Set BEFORE any await: even if the process dies mid-write, this
      // attempt is already unsafe in memory.
      dispatched = true;
      if (refusal) throw refusal;
      if (!requireMarker || marked) return;
      pending ??= args.persistMarker(kind).then(
        () => {
          marked = true;
        },
        (error: unknown) => {
          refusal = new EffectDispatchRefusedError(kind, error);
          logger.warn("[evals] effect-dispatch marker failed; refusing dispatch", {
            attemptId: args.attemptId,
            kind,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
      await pending;
      if (refusal) throw refusal;
    },
    replaySafety() {
      if (!args.armed) return { safe: false, reason: "attempt_state_missing" };
      if (refusal) return { safe: false, reason: "dispatch_marker_failed" };
      if (dispatched || marked) {
        return { safe: false, reason: "effects_dispatched" };
      }
      return { safe: true };
    },
  };
  return gate;
}

/**
 * Wrap a tool set so every tool's `execute` passes the gate first. Applied
 * INSIDE any tracing wrapper, so a refused call still shows up as a failed
 * tool span — and never reaches the tool.
 */
export function wrapToolSetWithEffectGate<T extends Record<string, unknown>>(
  tools: T,
  gate: EffectDispatchGate | undefined,
  kindFor: (toolName: string) => EffectKind = () => "tool",
): T {
  if (!gate) return tools;
  const out: Record<string, unknown> = { ...tools };
  for (const name of Object.keys(out)) {
    const raw = out[name] as {
      execute?: (...args: unknown[]) => unknown;
    };
    if (!raw || typeof raw.execute !== "function") continue;
    const original = raw.execute.bind(raw);
    out[name] = {
      ...raw,
      execute: async (...args: unknown[]) => {
        await gate.admit(kindFor(name));
        return await original(...args);
      },
    };
  }
  return out as T;
}
