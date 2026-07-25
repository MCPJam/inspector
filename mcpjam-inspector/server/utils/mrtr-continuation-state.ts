/**
 * Inspector → Convex client + codec for the hosted **MRTR continuation store**
 * (MCP 2026-07-28 §12.5). Mirrors the FROZEN HTTP contract published by
 * mcpjam-backend PR3a (`/web/mrtr/continuation/*`) BY HAND — the two repos share
 * no codegen, so these types are the inspector-side copy of that table's wire
 * shape.
 *
 * Same bearer-authed fetch shape as `harness-session-state.ts`: the signed-in
 * `userId` / `actorKind` are injected server-side by the backend from the
 * verified bearer and are NEVER sent in the body. Ownership and binding both
 * fail closed at the backend; this client surfaces those failures honestly
 * rather than swallowing them.
 *
 * ## Codec
 *
 * The backend stores an opaque `resumeState` blob. This module owns the
 * serialization of the SDK's data-only {@link MrtrOperationState} into that blob
 * and back, with a strict size cap (a truncated blob would deserialize to a
 * corrupt operation and re-drive the wrong request, so oversized state is
 * REJECTED, never truncated). `requestState` lives inside the state and is
 * therefore inside the blob; it is opaque end to end and MUST NEVER be logged —
 * see {@link redactContinuationForLog}.
 */
import type { MrtrOperationState } from "@mcpjam/sdk";
import {
  MRTR_CONTINUATION_LEASE_TTL_MS,
  MRTR_CONTINUATION_ROUTE_TIMEOUT_MS,
  MRTR_CONTINUATION_TTL_MS,
  MRTR_RESUME_STATE_MAX_BYTES,
} from "../config.js";
import { logger } from "./logger.js";
import type {
  MrtrElicitationResponse,
  MrtrOperationMethod,
} from "@/shared/mrtr-continuation";

// ── Wire contract (mirrors mcpjam-backend PR3a — keep in sync by hand) ────────

/** PR3a `mrtrContinuations.status` union. */
export type MrtrContinuationStatus =
  | "awaiting_input"
  | "resuming"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "indeterminate";

/** The negotiated protocol era bound to a continuation (opaque to the store). */
export type MrtrNegotiatedEra = string;

/** `create` request body (minus server-injected userId/actorKind). */
export interface CreateContinuationBody {
  continuationId: string;
  projectId: string;
  chatSessionId?: string;
  serverId: string;
  operationId: string;
  operationMethod: MrtrOperationMethod;
  negotiatedEra: MrtrNegotiatedEra;
  /** Opaque server-config + auth-principal binding; re-presented on claim. */
  bindingFingerprint: string;
  /** Opaque encoded {@link MrtrOperationState}. */
  resumeState: string;
  round?: number;
  maxRounds?: number;
  ttlMs?: number;
}

export interface CreateContinuationResult {
  continuationId: string;
  status: MrtrContinuationStatus;
  round: number;
  stateVersion: number;
  expiresAt: number;
  createdAt: number;
  idempotent: boolean;
}

/** The `claim` `state` payload (PR3a `claim` → `state`). */
export interface ClaimedContinuationState {
  continuationId: string;
  serverId: string;
  operationId: string;
  operationMethod: MrtrOperationMethod;
  sideEffecting: boolean;
  negotiatedEra: MrtrNegotiatedEra;
  projectId: string;
  chatSessionId?: string;
  /** Opaque encoded {@link MrtrOperationState}. Absent on a terminal row. */
  resumeState?: string;
  currentRoundResponses?: Record<string, MrtrElicitationResponse>;
  round: number;
  maxRounds: number;
  attempt: number;
}

/** Uniform failure envelope. `status` is the HTTP status the backend returned. */
export type ContinuationCallError = {
  ok: false;
  status: number;
  /** Backend `error` code/string, collapsed to not-found for ownership misses. */
  error: string;
};

type Ok<T> = { ok: true } & T;
export type ContinuationCallResult<T> = Ok<T> | ContinuationCallError;

// ── HTTP plumbing (mirrors harness-session-state.postSessionState) ────────────

function getConvexHttpUrl(): string {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is required for mrtr continuation store");
  }
  return convexHttpUrl;
}

async function postContinuation(
  pathSuffix: string,
  bearer: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ ok: true; payload: any } | ContinuationCallError> {
  const url = new URL(
    `/web/mrtr/continuation/${pathSuffix}`,
    getConvexHttpUrl(),
  ).toString();
  const authorization = bearer.startsWith("Bearer ")
    ? bearer
    : `Bearer ${bearer}`;

  // Bound every call: a stalled Convex request must not park a resume forever.
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error("mrtr continuation route deadline")),
    MRTR_CONTINUATION_ROUTE_TIMEOUT_MS,
  );
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // Redaction: log the path + a generic message ONLY — never the body, which
    // carries the opaque resumeState (and thus requestState).
    logger.error(`[mrtr-continuation] ${pathSuffix} network error`);
    return {
      ok: false,
      status: 502,
      error: "Failed to reach mrtr continuation endpoint",
    };
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", onAbort);
  }

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error: `continuation/${pathSuffix} returned ${response.status} with non-JSON body`,
    };
  }
  if (!response.ok || payload?.ok !== true) {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error:
        typeof payload?.error === "string"
          ? payload.error
          : `continuation/${pathSuffix} failed (${response.status})`,
    };
  }
  return { ok: true, payload };
}

// ── Codec ─────────────────────────────────────────────────────────────────

/** A collected-input codec cap violation (oversized `resumeState`). */
export class MrtrResumeStateTooLargeError extends Error {
  readonly code = "MRTR_RESUME_STATE_TOO_LARGE";
  constructor(readonly bytes: number, readonly cap: number) {
    super(
      `Encoded MRTR resumeState is ${bytes} bytes, over the ${cap}-byte cap.`,
    );
    this.name = "MrtrResumeStateTooLargeError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The opaque blob is malformed / not a valid encoded state. */
export class MrtrResumeStateDecodeError extends Error {
  readonly code = "MRTR_RESUME_STATE_DECODE";
  constructor(message: string) {
    super(message);
    this.name = "MrtrResumeStateDecodeError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface EncodedResumeState {
  /** Codec version; lets a later change migrate old blobs deterministically. */
  v: 1;
  state: MrtrOperationState;
}

/**
 * Serialize an {@link MrtrOperationState} into the opaque `resumeState` blob.
 * Enforces the byte cap BEFORE the value leaves the process — an oversized
 * operation (e.g. a pathological original-params payload) is rejected here so
 * the store never holds a blob it cannot round-trip.
 */
export function encodeResumeState(
  state: MrtrOperationState,
  maxBytes: number = MRTR_RESUME_STATE_MAX_BYTES,
): string {
  const envelope: EncodedResumeState = { v: 1, state };
  const encoded = JSON.stringify(envelope);
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > maxBytes) {
    throw new MrtrResumeStateTooLargeError(bytes, maxBytes);
  }
  return encoded;
}

/**
 * Deserialize the opaque `resumeState` blob back into an
 * {@link MrtrOperationState}. Rejects an oversized blob (defense in depth: a
 * store that somehow held one is not trusted) and a structurally invalid one.
 * Never logs the decoded value.
 */
export function decodeResumeState(
  blob: string,
  maxBytes: number = MRTR_RESUME_STATE_MAX_BYTES,
): MrtrOperationState {
  const bytes = Buffer.byteLength(blob, "utf8");
  if (bytes > maxBytes) {
    throw new MrtrResumeStateTooLargeError(bytes, maxBytes);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    throw new MrtrResumeStateDecodeError("resumeState is not valid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as EncodedResumeState).v !== 1
  ) {
    throw new MrtrResumeStateDecodeError(
      "resumeState envelope is missing or has an unknown version",
    );
  }
  const state = (parsed as EncodedResumeState).state as
    | MrtrOperationState
    | undefined;
  if (
    !state ||
    typeof state.opId !== "string" ||
    typeof state.method !== "string" ||
    typeof state.round !== "number" ||
    typeof state.maxRounds !== "number" ||
    typeof state.originalParams !== "object" ||
    state.originalParams === null ||
    typeof state.pendingInputRequests !== "object" ||
    state.pendingInputRequests === null
  ) {
    throw new MrtrResumeStateDecodeError(
      "resumeState does not decode to a valid MrtrOperationState",
    );
  }
  return state;
}

/**
 * Produce a log-safe view of a continuation. Strips the opaque `resumeState`
 * (and thus `requestState`) and any collected content. Use this — never the raw
 * object — anywhere a continuation is logged.
 */
export function redactContinuationForLog(value: {
  continuationId?: string;
  status?: MrtrContinuationStatus;
  round?: number;
  serverId?: string;
  operationMethod?: MrtrOperationMethod;
}): Record<string, unknown> {
  return {
    continuationId: value.continuationId,
    status: value.status,
    round: value.round,
    serverId: value.serverId,
    operationMethod: value.operationMethod,
  };
}

// ── Client (one function per FROZEN route) ────────────────────────────────

export async function createContinuation(
  bearer: string,
  body: CreateContinuationBody,
  signal?: AbortSignal,
): Promise<ContinuationCallResult<CreateContinuationResult>> {
  const res = await postContinuation(
    "create",
    bearer,
    {
      ...body,
      ttlMs: body.ttlMs ?? MRTR_CONTINUATION_TTL_MS,
    },
    signal,
  );
  if (!res.ok) return res;
  const p = res.payload;
  return {
    ok: true,
    continuationId: String(p.continuationId),
    status: p.status as MrtrContinuationStatus,
    round: Number(p.round ?? 0),
    stateVersion: Number(p.stateVersion ?? 0),
    expiresAt: Number(p.expiresAt ?? 0),
    createdAt: Number(p.createdAt ?? 0),
    idempotent: Boolean(p.idempotent),
  };
}

export async function submitContinuationResponse(
  bearer: string,
  args: {
    continuationId: string;
    round: number;
    responses: Record<string, MrtrElicitationResponse>;
  },
  signal?: AbortSignal,
): Promise<
  ContinuationCallResult<{ idempotent: boolean; stateVersion?: number; reason?: string }>
> {
  const res = await postContinuation("submit-response", bearer, args, signal);
  if (!res.ok) return res;
  const p = res.payload;
  return {
    ok: true,
    idempotent: Boolean(p.idempotent),
    ...(p.stateVersion !== undefined
      ? { stateVersion: Number(p.stateVersion) }
      : {}),
    ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
  };
}

export async function claimContinuation(
  bearer: string,
  args: {
    continuationId: string;
    bindingFingerprint: string;
    leaseId: string;
    leasedBy?: string;
    leaseTtlMs?: number;
    expectedStateVersion?: number;
  },
  signal?: AbortSignal,
): Promise<
  ContinuationCallResult<{
    state: ClaimedContinuationState | null;
    status: MrtrContinuationStatus;
    stateVersion: number;
    reason?: string;
  }>
> {
  const res = await postContinuation(
    "claim",
    bearer,
    {
      ...args,
      leaseTtlMs: args.leaseTtlMs ?? MRTR_CONTINUATION_LEASE_TTL_MS,
    },
    signal,
  );
  if (!res.ok) return res;
  const p = res.payload;
  return {
    ok: true,
    state: (p.state ?? null) as ClaimedContinuationState | null,
    status: p.status as MrtrContinuationStatus,
    stateVersion: Number(p.stateVersion ?? 0),
    ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
  };
}

export async function heartbeatContinuation(
  bearer: string,
  args: { continuationId: string; leaseId: string; leaseTtlMs?: number },
): Promise<ContinuationCallResult<{ extended: boolean }>> {
  const res = await postContinuation("heartbeat", bearer, {
    ...args,
    leaseTtlMs: args.leaseTtlMs ?? MRTR_CONTINUATION_LEASE_TTL_MS,
  });
  if (!res.ok) return res;
  return { ok: true, extended: Boolean(res.payload.extended) };
}

export async function markContinuationWireStarted(
  bearer: string,
  args: { continuationId: string; leaseId: string },
  signal?: AbortSignal,
): Promise<ContinuationCallResult<{ attempt: number }>> {
  const res = await postContinuation("mark-wire-started", bearer, args, signal);
  if (!res.ok) return res;
  return { ok: true, attempt: Number(res.payload.attempt ?? 0) };
}

export async function resuspendContinuation(
  bearer: string,
  args: {
    continuationId: string;
    leaseId: string;
    expectedStateVersion: number;
    round: number;
    resumeState: string;
    ttlMs?: number;
  },
  signal?: AbortSignal,
): Promise<
  ContinuationCallResult<{
    status: MrtrContinuationStatus;
    round: number;
    stateVersion: number;
    expiresAt: number;
  }>
> {
  const res = await postContinuation(
    "resuspend",
    bearer,
    { ...args, ttlMs: args.ttlMs ?? MRTR_CONTINUATION_TTL_MS },
    signal,
  );
  if (!res.ok) return res;
  const p = res.payload;
  return {
    ok: true,
    status: p.status as MrtrContinuationStatus,
    round: Number(p.round ?? 0),
    stateVersion: Number(p.stateVersion ?? 0),
    expiresAt: Number(p.expiresAt ?? 0),
  };
}

export async function finalizeContinuation(
  bearer: string,
  args: {
    continuationId: string;
    leaseId: string;
    expectedStateVersion: number;
    status: "completed" | "failed";
    terminalReason?: string;
  },
  signal?: AbortSignal,
): Promise<ContinuationCallResult<{ stateVersion: number; status: MrtrContinuationStatus }>> {
  const res = await postContinuation("finalize", bearer, args, signal);
  if (!res.ok) return res;
  const p = res.payload;
  return {
    ok: true,
    stateVersion: Number(p.stateVersion ?? 0),
    status: p.status as MrtrContinuationStatus,
  };
}

export async function releaseContinuation(
  bearer: string,
  args: { continuationId: string; leaseId: string },
): Promise<ContinuationCallResult<{ status: MrtrContinuationStatus; reason?: string }>> {
  const res = await postContinuation("release", bearer, args);
  if (!res.ok) {
    logger.warn("[mrtr-continuation] release failed", { error: res.error });
    return res;
  }
  const p = res.payload;
  return {
    ok: true,
    status: p.status as MrtrContinuationStatus,
    ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
  };
}

export async function cancelContinuation(
  bearer: string,
  args: { continuationId: string; reason?: string },
): Promise<ContinuationCallResult<{ status: MrtrContinuationStatus; reason?: string }>> {
  const res = await postContinuation("cancel", bearer, args);
  if (!res.ok) return res;
  const p = res.payload;
  return {
    ok: true,
    status: p.status as MrtrContinuationStatus,
    ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
  };
}

export async function scrubContinuation(
  bearer: string,
  args: { continuationId: string },
): Promise<ContinuationCallResult<{ reason?: string }>> {
  const res = await postContinuation("scrub", bearer, args);
  if (!res.ok) return res;
  const p = res.payload;
  return {
    ok: true,
    ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
  };
}
