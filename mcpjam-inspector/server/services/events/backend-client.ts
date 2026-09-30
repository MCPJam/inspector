/**
 * Typed client for the backend's MCP Events service routes (contracts
 * "Backend HTTP API": `POST ${CONVEX_HTTP_URL}/internal/v1/events/*`, header
 * `x-inspector-service-token`).
 *
 * Only the hosted keeper, the event-job executor and the internal/web events
 * routes call this. Conflicts the contract lists as 409 come back as typed
 * errors — a stale keeper commit ({@link StaleLeaseError}) is dropped, and a
 * tool call that began and never finished ({@link ToolOutcomeUnknownError})
 * parks its run — so callers branch on classes, never on messages.
 *
 * Nothing here logs; response bodies are never folded into error messages
 * beyond the backend's own short `{error}` code.
 */

import { getInternalBackendConfig } from "../internal-backend.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
export const EVENTS_BACKEND_PREFIX = "/internal/v1/events";

export class EventsBackendError extends Error {
  readonly status: number;
  /** The backend's `{error}` code, when it sent a plain identifier. */
  readonly reason?: string;

  constructor(route: string, status: number, reason?: string) {
    // A refused service token is OUR misconfiguration: phrased so no auth
    // heuristic downstream mistakes it for a user's credential failing.
    super(
      `Events backend ${route} failed (${
        status === 401 || status === 403 ? "service token refused" : `status ${status}`
      }${reason && !/auth|forbid/i.test(reason) ? `: ${reason}` : ""})`,
    );
    this.name = "EventsBackendError";
    this.status = status;
    if (reason) this.reason = reason;
  }
}

/** 409 `stale_generation` / `lease_lost`: this holder's work is moot. */
export class StaleLeaseError extends EventsBackendError {
  constructor(route: string, reason: string) {
    super(route, 409, reason);
    this.name = "StaleLeaseError";
  }
}

/** 409 `tool_outcome_unknown`: a call began and never finished (C6). */
export class ToolOutcomeUnknownError extends EventsBackendError {
  constructor(route: string) {
    super(route, 409, "tool_outcome_unknown");
    this.name = "ToolOutcomeUnknownError";
  }
}

// ---------------------------------------------------------------------------
// Wire shapes (C4, C5, C6)
// ---------------------------------------------------------------------------

/** A C4 registry row as `subscriptions/claim` and `subscriptions/get` return it. */
export interface EventSubscriptionRow {
  _id: string;
  projectId: string;
  organizationId: string;
  environmentId?: string | null;
  ownerUserId: string;
  logicalId: string;
  binding: {
    serverId: string;
    credentialOwnerUserId: string;
    credentialFingerprint: string | null;
  };
  bindingKey: string;
  locality: "hosted" | "local";
  profile: "draft@28ec35e" | "chatgpt@2026-09-30";
  protocolVersion?: string;
  eventName: string;
  arguments: Record<string, unknown>;
  argumentsHash?: string;
  descriptor?: { hash: string; payloadSchema?: unknown; delivery: string[] };
  descriptorHash?: string;
  mode: "webhook" | "poll" | "push";
  desiredState: "active" | "paused" | "removed";
  observedState:
    | "pending"
    | "active"
    | "paused"
    | "error"
    | "terminated"
    | "paused_auth"
    | "removing"
    | "removed";
  generation: number;
  nextActionAt: number;
  refreshBefore?: number | null;
  lastCursor?: string | null;
  maxAgeMs?: number;
  ttlMs?: number | null;
  inboxId?: string;
  slotId?: string;
  callbackUrl?: string;
  serverSubscriptionId?: string;
  conflictingServerSubscriptionId?: string;
  deliveryStatus?: unknown;
  lastError?: { kind: string; message: string; at: number; retryable: boolean };
  consecutiveFailures: number;
  rotation?: { phase: "requested" | "rotated"; at: number };
  lastHealthCheckAt?: number;
  removedAt?: number;
  removalUnsubscribedAt?: number;
  settledRemovalAt?: number;
  lastGapAt?: number;
  terminatedError?: unknown;
  createdAt?: number;
  updatedAt?: number;
  [key: string]: unknown;
}

export interface SubscriptionClaimItem {
  subscription: EventSubscriptionRow;
  leaseToken: string;
  generation: number;
  ownerExternalId: string;
  organizationId: string;
}

export interface SubscriptionCommitRequest {
  subscriptionId: string;
  leaseToken: string;
  generation: number;
  patch: Record<string, unknown>;
  /** Keys to UNSET (JSON cannot carry `undefined`). */
  clear?: string[];
  release?: boolean;
}

/** One C5 delivery, as the inbox dispatches it. */
export interface EventDelivery {
  seq?: number;
  deliveryKey: string;
  kind: string;
  slotId?: string | null;
  logicalSubscriptionId: string;
  projectId: string;
  environmentId?: string | null;
  bindingKey: string;
  origin?: string;
  namespace?: string;
  eventId?: string;
  name?: string;
  timestamp?: string;
  data?: unknown;
  cursor?: string | null;
  webhookId?: string;
  serverSubscriptionId?: string | null;
  error?: unknown;
  receivedAt: number;
  [key: string]: unknown;
}

export type EnqueueOutcome =
  | "scheduled"
  | "no_triggers"
  | "subscription_removed"
  | "unknown_subscription"
  | "quarantined"
  | "control_recorded";

export interface EnqueueResult {
  deliveryKey: string;
  outcome: EnqueueOutcome;
  runIds: string[];
}

/** The frozen run snapshot (C2), as `eventTriggerRuns` writes it. */
export interface EventRunInput {
  trigger: {
    id: string;
    revision: number;
    name?: string;
    instructions: string;
    modelId?: string | null;
    approvalPolicy: "deny_writes" | "auto_deny";
    hostProfile?: unknown;
    maxSteps: number;
    environmentId?: string | null;
  };
  event: {
    eventId: string;
    name: string;
    timestamp?: string | null;
    data: unknown;
    cursor?: string | null;
    origin?: string;
    namespace?: string;
    receivedAt?: number;
    deliveryKey?: string;
  };
  subscription: {
    id: string;
    logicalId?: string;
    generation: number;
    bindingKey: string;
    serverId: string;
    environmentId?: string | null;
    eventName?: string;
    profile?: string;
  };
}

export interface EventRunCallRecord {
  callId: string;
  operation: string;
  status: "pending" | "completed";
  replayable: boolean;
  result?: unknown;
}

export interface EventRunClaim {
  run: {
    _id: string;
    projectId: string;
    organizationId?: string;
    triggerId: string;
    subscriptionId: string;
    namespace?: string;
    conversationKey?: string;
    step?: number;
    [key: string]: unknown;
  };
  token: string;
  input: EventRunInput | null;
  messages: unknown[] | null;
  step: number;
  calls: EventRunCallRecord[];
  ownerExternalId: string;
  organizationId: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface EventsBackendClientOptions {
  /** Default: `getInternalBackendConfig()` at call time. */
  config?: () => { convexUrl: string; serviceToken: string };
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class EventsBackendClient {
  private readonly config: () => { convexUrl: string; serviceToken: string };
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: EventsBackendClientOptions = {}) {
    this.config = options.config ?? getInternalBackendConfig;
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** POST one route; returns `{status, body}` without interpreting errors. */
  private async post(
    route: string,
    body: unknown,
  ): Promise<{ status: number; body: any }> {
    const { convexUrl, serviceToken } = this.config();
    const response = await this.doFetch(
      `${convexUrl.replace(/\/+$/, "")}${EVENTS_BACKEND_PREFIX}/${route}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-inspector-service-token": serviceToken,
        },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    let parsed: any = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  }

  private fail(route: string, status: number, body: any): never {
    const code = body?.error;
    throw new EventsBackendError(
      route,
      status,
      typeof code === "string" && SAFE_ERROR_CODE.test(code) ? code : undefined,
    );
  }

  /** Throws the typed 409s every lease-fenced route shares. */
  private leaseFenced(route: string, status: number, body: any): void {
    if (status !== 409) return;
    const code = body?.error;
    if (code === "tool_outcome_unknown") throw new ToolOutcomeUnknownError(route);
    if (code === "stale_generation" || code === "lease_lost") {
      throw new StaleLeaseError(route, code);
    }
  }

  async ensureInbox(projectId: string): Promise<{ inboxId: string }> {
    const route = "inboxes/ensure";
    const { status, body } = await this.post(route, { projectId });
    if (status !== 200 || typeof body?.inboxId !== "string") this.fail(route, status, body);
    return { inboxId: body.inboxId };
  }

  async claimSubscriptions(args: {
    holder: string;
    limit?: number;
    leaseMs?: number;
  }): Promise<SubscriptionClaimItem[]> {
    const route = "subscriptions/claim";
    const { status, body } = await this.post(route, args);
    if (status !== 200) this.fail(route, status, body);
    return Array.isArray(body?.items) ? (body.items as SubscriptionClaimItem[]) : [];
  }

  async commitSubscription(
    request: SubscriptionCommitRequest,
  ): Promise<{ ok: true; generation: number }> {
    const route = "subscriptions/commit";
    const { status, body } = await this.post(route, request);
    this.leaseFenced(route, status, body);
    if (status !== 200 || body?.ok !== true) this.fail(route, status, body);
    return { ok: true, generation: Number(body.generation) };
  }

  /** `null` when the backend answers 404 (unknown subscription). */
  async getSubscription(subscriptionId: string): Promise<EventSubscriptionRow | null> {
    const route = "subscriptions/get";
    const { status, body } = await this.post(route, { subscriptionId });
    if (status === 404) return null;
    if (status !== 200 || !body?.subscription) this.fail(route, status, body);
    return body.subscription as EventSubscriptionRow;
  }

  async recordControl(args: {
    inboxId: string;
    logicalSubscriptionId: string;
    kind: string;
    cursor?: string | null;
    error?: unknown;
    serverSubscriptionId?: string | null;
    at: number;
  }): Promise<void> {
    const route = "subscriptions/control";
    const { status, body } = await this.post(route, args);
    if (status !== 200) this.fail(route, status, body);
  }

  async enqueue(request: {
    inboxId: string;
    deliveries: EventDelivery[];
  }): Promise<{ results: EnqueueResult[] }> {
    const route = "enqueue";
    const { status, body } = await this.post(route, request);
    if (status !== 200 || !Array.isArray(body?.results)) this.fail(route, status, body);
    return { results: body.results as EnqueueResult[] };
  }

  async claimRun(holder: string): Promise<EventRunClaim | null> {
    const route = "runs/claim";
    const { status, body } = await this.post(route, { holder });
    if (status !== 200) this.fail(route, status, body);
    return (body?.claim as EventRunClaim | null) ?? null;
  }

  async checkpointRun(args: {
    runId: string;
    token: string;
    messages: unknown[];
    step: number;
  }): Promise<void> {
    const route = "runs/checkpoint";
    const { status, body } = await this.post(route, args);
    this.leaseFenced(route, status, body);
    if (status !== 200) this.fail(route, status, body);
  }

  async beginCall(args: {
    runId: string;
    token: string;
    callId: string;
    operation: string;
    input: unknown;
    replayable: boolean;
  }): Promise<{ replay: boolean; result?: unknown }> {
    const route = "runs/begin-call";
    const { status, body } = await this.post(route, args);
    this.leaseFenced(route, status, body);
    if (status !== 200) this.fail(route, status, body);
    return {
      replay: body?.replay === true,
      ...(body?.replay === true ? { result: body.result } : {}),
    };
  }

  async finishCall(args: {
    runId: string;
    token: string;
    callId: string;
    result: unknown;
  }): Promise<void> {
    const route = "runs/finish-call";
    const { status, body } = await this.post(route, args);
    this.leaseFenced(route, status, body);
    if (status !== 200) this.fail(route, status, body);
  }

  async finishRun(args: {
    runId: string;
    token: string;
    status: "completed" | "failed" | "parked";
    result?: unknown;
    error?: string;
    costMicros?: number;
    chatSessionId?: string;
  }): Promise<void> {
    const route = "runs/finish";
    const { status, body } = await this.post(route, args);
    this.leaseFenced(route, status, body);
    if (status !== 200) this.fail(route, status, body);
  }
}

/** True when the internal backend is configured (hosted deployments only). */
export function isEventsBackendConfigured(): boolean {
  try {
    getInternalBackendConfig();
    return true;
  } catch {
    return false;
  }
}
