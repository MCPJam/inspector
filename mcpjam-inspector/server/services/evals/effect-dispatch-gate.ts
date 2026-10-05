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
 *     `effectDispatch.mayHaveEffects = false`. If that write fails the gate is
 *     UNARMED: dispatch proceeds exactly as before this existed, but the
 *     attempt can never be replayed (`attempt_state_missing`).
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
import { leaseTokenArg } from "./run-lease";
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

/**
 * Start an attempt's gate. Never throws: a failed start write yields an
 * UNARMED gate, which changes nothing about execution and forbids replay.
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
  try {
    await args.convexClient.mutation("testSuites:beginTrialAttempt" as any, {
      iterationId: args.iterationId,
      attempt: args.attempt,
      attemptId,
      ...(leaseToken ? { leaseToken } : {}),
    });
    armed = true;
  } catch (error) {
    logger.warn("[evals] could not record trial attempt; replay disabled", {
      iterationId: args.iterationId,
      attempt: args.attempt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return createEffectDispatchGate({
    attempt: args.attempt,
    attemptId,
    armed,
    persistMarker: (kind) =>
      args.convexClient.mutation("testSuites:markTrialEffectDispatch" as any, {
        iterationId: args.iterationId,
        attemptId,
        kind,
        ...(leaseToken ? { leaseToken } : {}),
      }),
  });
}

/** The gate's state machine, with its persistence injected (testable). */
export function createEffectDispatchGate(args: {
  attempt: number;
  attemptId: string;
  armed: boolean;
  persistMarker: (kind: EffectKind) => Promise<unknown>;
}): EffectDispatchGate {
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
      if (!args.armed || marked) return;
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
