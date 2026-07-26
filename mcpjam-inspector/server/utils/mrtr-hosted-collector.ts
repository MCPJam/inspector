/**
 * Hosted MRTR transport glue (MCP 2026-07-28 §12.5): the **suspending
 * collector** the worker registers before connect, and the **resume primitive**
 * a fresh authenticated request drives after the human answers.
 *
 * ## Suspend, don't block
 *
 * Legacy hosted elicitation blocks the worker on an SSE-held tool call while a
 * human answers. §12.5.2 forbids that for MRTR. The collector here therefore
 * does the opposite: it persists the SDK's data-only {@link MrtrOperationState}
 * to the durable continuation store (PR3a), emits a safe `data-mrtr-input-
 * required` part to the browser, and **throws {@link MrtrSuspendedSignal}** to
 * unwind `runInputRequiredOperation` and return control to the worker. It never
 * polls, never blocks. The caller (PR4 direct ops / PR5 chat loop) catches the
 * signal and returns a pending outcome to the browser.
 *
 * ## Resume
 *
 * {@link resumeMrtrContinuationLeg} is the reusable primitive: claim the record
 * (binding fails closed at the backend), idempotently submit the browser's
 * response, fence a side-effecting wire (`markWireStarted`), drive exactly one
 * retry leg via an INJECTED `driveLeg`, then finalize (complete) or re-suspend
 * (another round). The `driveLeg` seam keeps the primitive testable against a
 * fake continuation backend with no live MCP server; the HTTP route (PR3b) wires
 * a thin real `driveLeg` over `resumeInputRequiredOperation`, and PR5 replaces it
 * with the full engine splice.
 *
 * `requestState` is opaque and lives inside the encoded state; it is NEVER
 * emitted to the browser and NEVER logged (see `redactContinuationForLog`).
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  InputRequests,
  InputResponses,
  MrtrInputCollector,
  MrtrLegResult,
  MrtrOperationState,
} from "@mcpjam/sdk";
import {
  MRTR_DISPLAY_FIELD_MAX_BYTES,
  MRTR_CONTINUATION_TTL_MS,
} from "../config.js";
import { logger } from "./logger.js";
import {
  claimContinuation,
  createContinuation,
  encodeResumeState,
  decodeResumeState,
  finalizeContinuation,
  markContinuationWireStarted,
  releaseContinuation,
  resuspendContinuation,
  submitContinuationResponse,
  cancelContinuation,
  redactContinuationForLog,
  type ClaimedContinuationState,
  type ContinuationCallError,
} from "./mrtr-continuation-state.js";
import {
  HOSTED_MRTR_DATA_PART_TYPE,
  HOSTED_MRTR_VERSION,
  type MrtrContinuationEvent,
  type MrtrInputRequestDisplay,
  type MrtrInputRequiredEvent,
  type MrtrOperationMethod,
  type MrtrResumeSubmission,
} from "@/shared/mrtr-continuation";

// ── Suspend signal ─────────────────────────────────────────────────────────

/**
 * Thrown by the hosted collector to suspend an MRTR operation. NOT an error —
 * a control-flow signal that unwinds `runInputRequiredOperation` so the worker
 * returns without blocking. Callers detect it with {@link isMrtrSuspendedSignal}
 * and return a pending outcome carrying the `continuationId`.
 */
export class MrtrSuspendedSignal extends Error {
  readonly code = "MRTR_SUSPENDED";
  constructor(
    readonly continuationId: string,
    readonly round: number,
  ) {
    super(`MRTR operation suspended at round ${round} (${continuationId}).`);
    this.name = "MrtrSuspendedSignal";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isMrtrSuspendedSignal(
  value: unknown,
): value is MrtrSuspendedSignal {
  return (
    value instanceof MrtrSuspendedSignal ||
    (typeof value === "object" &&
      value !== null &&
      (value as { code?: unknown }).code === "MRTR_SUSPENDED")
  );
}

/** Raised when a safe-display field exceeds its byte cap. Fails the round closed. */
export class MrtrDisplayTooLargeError extends Error {
  readonly code = "MRTR_DISPLAY_TOO_LARGE";
  constructor(readonly field: string, readonly bytes: number, readonly cap: number) {
    super(`MRTR display field "${field}" is ${bytes} bytes, over the ${cap}-byte cap.`);
    this.name = "MrtrDisplayTooLargeError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Binding fingerprint ──────────────────────────────────────────────────

/**
 * Compute the opaque `bindingFingerprint` the store binds a continuation to and
 * re-checks on every claim. A changed effective server (config) or auth
 * principal produces a different fingerprint, so a resume against a
 * different-than-suspended server fails closed at the backend rather than
 * re-driving the wrong request. The backend treats this as an opaque equality
 * token; the hash inputs are an inspector-side decision.
 */
export function computeMrtrBindingFingerprint(args: {
  serverId: string;
  negotiatedEra: string;
  /** Stable digest of the effective server config (URL, auth method, headers…). */
  serverConfigDigest: string;
  /** The resolved auth principal (user/guest id, or a token-derived subject). */
  authPrincipal: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        args.serverId,
        args.negotiatedEra,
        args.serverConfigDigest,
        args.authPrincipal,
      ]),
    )
    .digest("hex");
}

// ── Safe display ─────────────────────────────────────────────────────────

function capField(field: string, value: string, cap: number): string {
  if (Buffer.byteLength(value, "utf8") > cap) {
    throw new MrtrDisplayTooLargeError(field, Buffer.byteLength(value, "utf8"), cap);
  }
  return value;
}

/**
 * Build the browser-safe display of one round's embedded requests. Only
 * `elicitation/create` reaches here (the SDK driver already rejects undeclared
 * roots/sampling before any UI); a non-elicitation method is defensively
 * dropped. Each field is byte-capped; the raw `requestState` and original
 * params never appear.
 */
export function buildInputRequestDisplays(
  inputRequests: InputRequests,
  fieldCap: number = MRTR_DISPLAY_FIELD_MAX_BYTES,
): MrtrInputRequestDisplay[] {
  const displays: MrtrInputRequestDisplay[] = [];
  for (const key of Object.keys(inputRequests)) {
    const req = inputRequests[key] as {
      method?: string;
      params?: Record<string, unknown>;
    };
    if (req?.method !== "elicitation/create") continue;
    const params = req.params ?? {};
    const mode = params.mode === "url" ? "url" : "form";
    const message = capField(
      `${key}.message`,
      typeof params.message === "string" ? params.message : "",
      fieldCap,
    );
    if (mode === "url") {
      const url = typeof params.url === "string" ? params.url : "";
      displays.push({
        key,
        mode: "url",
        message,
        url: capField(`${key}.url`, url, fieldCap),
      });
      continue;
    }
    const schema = params.requestedSchema;
    if (schema !== undefined) {
      // Reject an oversized schema rather than ship an unbounded blob to the UI.
      const bytes = Buffer.byteLength(JSON.stringify(schema), "utf8");
      if (bytes > fieldCap) {
        throw new MrtrDisplayTooLargeError(`${key}.requestedSchema`, bytes, fieldCap);
      }
    }
    displays.push({
      key,
      mode: "form",
      message,
      ...(schema !== undefined ? { requestedSchema: schema } : {}),
    });
  }
  return displays;
}

function operationLabel(state: MrtrOperationState): string | undefined {
  const p = state.originalParams;
  const raw =
    state.method === "resources/read"
      ? p.uri
      : p.name; // tools/call + prompts/get both key on `name`
  if (typeof raw !== "string") return undefined;
  return raw.length > 256 ? `${raw.slice(0, 256)}…` : raw;
}

function makeInputRequiredEvent(args: {
  continuationId: string;
  serverId: string;
  serverName?: string;
  method: MrtrOperationMethod;
  operationLabel?: string;
  round: number;
  displays: MrtrInputRequestDisplay[];
  expiresAt: number;
  chatSessionId?: string;
}): MrtrInputRequiredEvent {
  return {
    kind: "input_required",
    version: HOSTED_MRTR_VERSION,
    continuationId: args.continuationId,
    serverId: args.serverId,
    ...(args.serverName ? { serverName: args.serverName } : {}),
    method: args.method,
    ...(args.operationLabel ? { operationLabel: args.operationLabel } : {}),
    round: args.round,
    inputRequests: args.displays,
    expiresAt: args.expiresAt,
    ...(args.chatSessionId ? { chatSessionId: args.chatSessionId } : {}),
  };
}

// ── Suspending collector ──────────────────────────────────────────────────

export interface HostedMrtrCollectorDeps {
  bearer: string;
  projectId: string;
  serverId: string;
  serverName?: string;
  chatSessionId?: string;
  negotiatedEra: string;
  bindingFingerprint: string;
  /** Emit a transient `data-mrtr-input-required` part on the turn's stream. */
  emit: (event: MrtrContinuationEvent) => void;
  ttlMs?: number;
  // Seams for testing.
  create?: typeof createContinuation;
  encode?: typeof encodeResumeState;
  mintId?: () => string;
  now?: () => number;
}

/**
 * Build the hosted MRTR input collector for one server. Registered SYNCHRONOUSLY
 * before connect (same microtask discipline as `elicitationCallback`) so the
 * modern server advertises `elicitation` and is willing to embed the round.
 *
 * On invocation it persists → emits → throws {@link MrtrSuspendedSignal}. It
 * NEVER returns responses (there are none yet — a human has to answer out of
 * band), so the return type is unreachable at runtime.
 */
export function createHostedMrtrCollector(
  deps: HostedMrtrCollectorDeps,
): MrtrInputCollector {
  const create = deps.create ?? createContinuation;
  const encode = deps.encode ?? encodeResumeState;
  const mintId = deps.mintId ?? (() => randomUUID());
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? MRTR_CONTINUATION_TTL_MS;

  return async ({ state, inputRequests }) => {
    // Build the display first: an oversized/hostile round fails closed here,
    // before anything is persisted or emitted.
    const displays = buildInputRequestDisplays(inputRequests);
    const resumeState = encode(state);
    const continuationId = mintId();

    const created = await create(deps.bearer, {
      continuationId,
      projectId: deps.projectId,
      ...(deps.chatSessionId ? { chatSessionId: deps.chatSessionId } : {}),
      serverId: deps.serverId,
      operationId: state.opId,
      operationMethod: state.method as MrtrOperationMethod,
      negotiatedEra: deps.negotiatedEra,
      bindingFingerprint: deps.bindingFingerprint,
      resumeState,
      round: state.round,
      maxRounds: state.maxRounds,
      ttlMs,
    });
    if (!created.ok) {
      // No durable record ⇒ nothing for the browser to answer. Fail the op
      // honestly rather than emit a continuation id the store never accepted.
      logger.error("[mrtr-continuation] create failed; failing operation", {
        error: created.error,
        ...redactContinuationForLog({
          continuationId,
          serverId: deps.serverId,
          round: state.round,
          operationMethod: state.method as MrtrOperationMethod,
        }),
      });
      throw new Error(
        `Failed to persist MRTR continuation (${created.status}): ${created.error}`,
      );
    }

    const expiresAt = created.expiresAt || now() + ttlMs;
    deps.emit(
      makeInputRequiredEvent({
        continuationId,
        serverId: deps.serverId,
        serverName: deps.serverName,
        method: state.method as MrtrOperationMethod,
        operationLabel: operationLabel(state),
        round: state.round,
        displays,
        expiresAt,
        chatSessionId: deps.chatSessionId,
      }),
    );

    throw new MrtrSuspendedSignal(continuationId, state.round);
  };
}

// ── Resume primitive ──────────────────────────────────────────────────────

export type ResumeMrtrOutcome =
  | { outcome: "completed"; result: unknown }
  | {
      outcome: "input_required";
      round: number;
      displays: MrtrInputRequestDisplay[];
      /**
       * Absent when the round is being REPLAYED from a claim rather than freshly
       * re-suspended: the claim payload does not carry the record's deadline, so
       * absence means "unknown", never "already expired". (If PR3a adds
       * `expiresAt` to the claim payload it flows through automatically.)
       */
      expiresAt?: number;
    }
  | {
      outcome: "failed" | "cancelled" | "expired" | "indeterminate";
      reason: string;
      /** HTTP status to surface (defaults per outcome). */
      status?: number;
      /**
       * Present only when the MCP leg COMPLETED but the durable record could not
       * be finalized: the result is real and in hand, the store just does not
       * know it. Callers may surface it, but MUST treat the continuation as
       * indeterminate and never re-drive a side-effecting operation on it.
       */
      result?: unknown;
    };

export interface ResumeMrtrDeps {
  bearer: string;
  submission: MrtrResumeSubmission;
  bindingFingerprint: string;
  /**
   * Drives exactly one retry leg. Injected so the primitive is testable without
   * a live MCP server; the route wires this over `resumeInputRequiredOperation`
   * against a freshly-authorized manager.
   */
  driveLeg: (
    state: MrtrOperationState,
    responses: InputResponses,
  ) => Promise<MrtrLegResult<unknown>>;
  emit?: (event: MrtrContinuationEvent) => void;
  serverName?: string;
  // Store seams (default to the real client) for testing.
  claim?: typeof claimContinuation;
  submitResponse?: typeof submitContinuationResponse;
  markWireStarted?: typeof markContinuationWireStarted;
  resuspend?: typeof resuspendContinuation;
  finalize?: typeof finalizeContinuation;
  release?: typeof releaseContinuation;
  cancel?: typeof cancelContinuation;
  decode?: typeof decodeResumeState;
  encode?: typeof encodeResumeState;
  mintLeaseId?: () => string;
  leasedBy?: string;
}

function terminalFromStatus(status: string): ResumeMrtrOutcome {
  switch (status) {
    case "completed":
      return { outcome: "completed", result: undefined };
    case "cancelled":
      return { outcome: "cancelled", reason: "continuation already cancelled" };
    case "expired":
      return { outcome: "expired", reason: "continuation expired" };
    case "indeterminate":
      return {
        outcome: "indeterminate",
        reason: "continuation is in an indeterminate state",
      };
    default:
      return { outcome: "failed", reason: `continuation already ${status}` };
  }
}

function emitResolved(
  deps: ResumeMrtrDeps,
  continuationId: string,
  outcome: "completed" | "failed" | "cancelled" | "expired",
  indeterminate?: boolean,
): void {
  deps.emit?.({
    kind: "resolved",
    version: HOSTED_MRTR_VERSION,
    continuationId,
    outcome,
    ...(indeterminate ? { indeterminate: true } : {}),
  });
}

/**
 * Re-serve the round the store is currently parked on, for a browser replaying
 * the round before it. Read-only: no leg is driven and nothing is written, so
 * this cannot double-execute anything. Returns `null` when the parked state
 * cannot be rendered (corrupt blob, oversized display), leaving the caller to
 * fall through to the ordinary stale-round rejection.
 */
function replayCurrentRound(
  cs: ClaimedContinuationState,
  decode: typeof decodeResumeState,
  deps: ResumeMrtrDeps,
  continuationId: string,
): ResumeMrtrOutcome | null {
  try {
    const parked = decode(cs.resumeState as string);
    const displays = buildInputRequestDisplays(parked.pendingInputRequests);
    if (displays.length === 0) return null;
    // The claim payload carries no deadline; only emit the browser event when
    // the backend did supply one, rather than inventing an `expiresAt` the UI
    // would render as an expiry. The HTTP outcome below is the direct path's
    // actual channel either way.
    if (cs.expiresAt !== undefined) {
      deps.emit?.(
        makeInputRequiredEvent({
          continuationId,
          serverId: cs.serverId,
          serverName: deps.serverName,
          method: cs.operationMethod,
          operationLabel: operationLabel(parked),
          round: cs.round,
          displays,
          expiresAt: cs.expiresAt,
          chatSessionId: cs.chatSessionId,
        }),
      );
    }
    return {
      outcome: "input_required",
      round: cs.round,
      displays,
      ...(cs.expiresAt !== undefined ? { expiresAt: cs.expiresAt } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Resume one suspended MRTR round. Idempotent for a duplicate browser submit of
 * the same round: the response is submitted round-keyed to the store (which
 * de-dupes), and a caller that retries lands on the same claim → same outcome.
 */
export async function resumeMrtrContinuationLeg(
  deps: ResumeMrtrDeps,
): Promise<ResumeMrtrOutcome> {
  const claim = deps.claim ?? claimContinuation;
  const submitResponse = deps.submitResponse ?? submitContinuationResponse;
  const markWireStarted = deps.markWireStarted ?? markContinuationWireStarted;
  const resuspend = deps.resuspend ?? resuspendContinuation;
  const finalize = deps.finalize ?? finalizeContinuation;
  const release = deps.release ?? releaseContinuation;
  const cancel = deps.cancel ?? cancelContinuation;
  const decode = deps.decode ?? decodeResumeState;
  const encode = deps.encode ?? encodeResumeState;
  const leaseId = (deps.mintLeaseId ?? (() => randomUUID()))();
  const { continuationId, round, responses } = deps.submission;

  const mapError = (e: ContinuationCallError): ResumeMrtrOutcome => ({
    outcome: e.status === 409 ? "cancelled" : "failed",
    reason: e.error,
    status: e.status,
  });

  const claimed = await claim(deps.bearer, {
    continuationId,
    bindingFingerprint: deps.bindingFingerprint,
    leaseId,
    ...(deps.leasedBy ? { leasedBy: deps.leasedBy } : {}),
  });
  if (!claimed.ok) return mapError(claimed);

  // No state ⇒ already terminal (idempotent replay of a finished continuation).
  if (!claimed.state) return terminalFromStatus(claimed.status);

  const cs: ClaimedContinuationState = claimed.state;
  let stateVersion = claimed.stateVersion;

  /**
   * Outcome for a store write that fails AFTER the MCP leg already went out.
   *
   * `mapError` is wrong here for a side-effecting operation: the wire left, so
   * the operation may have (or, on a completed leg, definitely did) execute.
   * Reporting `failed`/`cancelled` invites the caller to retry and double-
   * execute it. Only durability failed, so resolve as `indeterminate` and mark
   * the record indeterminate best-effort (`cancel` needs no lease — the lease
   * is exactly what may have just been lost). A non-side-effecting operation is
   * safe to replay, so it keeps the ordinary mapping.
   */
  const postWireFailure = async (
    e: ContinuationCallError,
    result?: unknown,
  ): Promise<ResumeMrtrOutcome> => {
    if (!cs.sideEffecting) return mapError(e);
    await cancel(deps.bearer, {
      continuationId,
      reason: "post_wire_store_error_indeterminate",
    });
    emitResolved(deps, continuationId, "failed", true);
    return {
      outcome: "indeterminate",
      reason: `MCP leg left the wire but the continuation could not be persisted: ${e.error}`,
      status: e.status,
      ...(result !== undefined ? { result } : {}),
    };
  };

  // Round fence: a submission for a different round is stale.
  if (round !== cs.round) {
    // …EXCEPT the one recoverable stale round: the immediately preceding one.
    // If the browser's submit for round N succeeded but the HTTP response was
    // lost, the store already advanced to N+1 and the browser can only retry N.
    // Failing that retry strands the continuation — it sits awaiting answers the
    // browser was never shown until the TTL expires. Replay the current round's
    // display instead. This drives no leg and writes nothing: it only re-serves
    // what `resuspend` already durably recorded.
    if (round === cs.round - 1 && cs.resumeState) {
      const replay = replayCurrentRound(cs, decode, deps, continuationId);
      await release(deps.bearer, { continuationId, leaseId });
      if (replay) return replay;
    } else {
      await release(deps.bearer, { continuationId, leaseId });
    }
    return {
      outcome: "failed",
      reason: `stale round: submitted ${round}, pending ${cs.round}`,
      status: 409,
    };
  }

  if (!cs.resumeState) {
    await release(deps.bearer, { continuationId, leaseId });
    return { outcome: "failed", reason: "continuation carries no resumable state" };
  }

  let state: MrtrOperationState;
  try {
    state = decode(cs.resumeState);
  } catch (err) {
    await finalize(deps.bearer, {
      continuationId,
      leaseId,
      expectedStateVersion: stateVersion,
      status: "failed",
      terminalReason: "resume_state_decode_error",
    });
    emitResolved(deps, continuationId, "failed");
    return {
      outcome: "failed",
      reason: err instanceof Error ? err.message : "resumeState decode error",
    };
  }

  // Idempotent, round-keyed durable submit (a duplicate returns the same row).
  const submit = await submitResponse(deps.bearer, {
    continuationId,
    round,
    responses,
  });
  if (!submit.ok) {
    await release(deps.bearer, { continuationId, leaseId });
    return mapError(submit);
  }
  if (submit.stateVersion !== undefined) stateVersion = submit.stateVersion;

  // Exactly-once fence: persist BEFORE a side-effecting wire leaves.
  if (cs.sideEffecting) {
    const marked = await markWireStarted(deps.bearer, { continuationId, leaseId });
    if (!marked.ok) {
      await release(deps.bearer, { continuationId, leaseId });
      return mapError(marked);
    }
  }

  let leg: MrtrLegResult<unknown>;
  try {
    leg = await deps.driveLeg(state, responses as InputResponses);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "resume leg failed";
    if (cs.sideEffecting) {
      // A side-effecting wire went out; we cannot prove it did not execute.
      // Transition to indeterminate (backend maps cancel-in-flight) — never a
      // silent replay. The UI surfaces an explicit user retry decision.
      await cancel(deps.bearer, {
        continuationId,
        reason: "resume_error_indeterminate",
      });
      emitResolved(deps, continuationId, "failed", true);
      return { outcome: "indeterminate", reason };
    }
    await finalize(deps.bearer, {
      continuationId,
      leaseId,
      expectedStateVersion: stateVersion,
      status: "failed",
      terminalReason: "resume_leg_error",
    });
    emitResolved(deps, continuationId, "failed");
    return { outcome: "failed", reason };
  }

  if (leg.status === "complete") {
    const fin = await finalize(deps.bearer, {
      continuationId,
      leaseId,
      expectedStateVersion: stateVersion,
      status: "completed",
    });
    // The leg COMPLETED: for a side-effecting op the tool definitively ran, so a
    // finalize failure is a durability failure, not an execution failure.
    if (!fin.ok) return postWireFailure(fin, leg.result);
    emitResolved(deps, continuationId, "completed");
    return { outcome: "completed", result: leg.result };
  }

  // Another round: re-suspend the SAME logical operation at round + 1.
  const nextState = leg.state;
  let nextBlob: string;
  try {
    nextBlob = encode(nextState);
  } catch (err) {
    await finalize(deps.bearer, {
      continuationId,
      leaseId,
      expectedStateVersion: stateVersion,
      status: "failed",
      terminalReason: "resume_state_encode_error",
    });
    emitResolved(deps, continuationId, "failed");
    return {
      outcome: "failed",
      reason: err instanceof Error ? err.message : "resumeState encode error",
    };
  }

  let displays: MrtrInputRequestDisplay[];
  try {
    displays = buildInputRequestDisplays(nextState.pendingInputRequests);
  } catch (err) {
    await finalize(deps.bearer, {
      continuationId,
      leaseId,
      expectedStateVersion: stateVersion,
      status: "failed",
      terminalReason: "resume_display_error",
    });
    emitResolved(deps, continuationId, "failed");
    return {
      outcome: "failed",
      reason: err instanceof Error ? err.message : "display build error",
    };
  }

  const rs = await resuspend(deps.bearer, {
    continuationId,
    leaseId,
    expectedStateVersion: stateVersion,
    round: nextState.round,
    resumeState: nextBlob,
  });
  // Same post-wire rule as the finalize path: the leg already went out (the
  // server answered with another `input_required`), so a side-effecting op that
  // cannot be re-suspended is indeterminate, not `failed` — the caller must not
  // re-drive it from round zero.
  if (!rs.ok) return postWireFailure(rs);

  deps.emit?.(
    makeInputRequiredEvent({
      continuationId,
      serverId: cs.serverId,
      serverName: deps.serverName,
      method: cs.operationMethod,
      operationLabel: operationLabel(nextState),
      round: nextState.round,
      displays,
      expiresAt: rs.expiresAt,
      chatSessionId: cs.chatSessionId,
    }),
  );

  return {
    outcome: "input_required",
    round: nextState.round,
    displays,
    expiresAt: rs.expiresAt,
  };
}

/** Re-exported so route/tests build the part type without importing shared twice. */
export { HOSTED_MRTR_DATA_PART_TYPE };
