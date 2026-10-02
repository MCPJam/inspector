/**
 * The HOSTED adapter of the events coordinator's inbox port (contract C5):
 * an HTTP client for one inbox on the `hooks.mcpjam.com` Worker's admin API.
 *
 * The local runtime and the tests use the SDK's `MemoryEventInbox`; the hosted
 * keeper uses this. Both are proven against the same coordinator lifecycle
 * suite (`__tests__/inbox-client.test.ts`), so a rule the in-memory inbox
 * keeps is a rule this client keeps too.
 *
 * Secrets. Slot secrets come back from `allocateSlot`, `getSecret` and
 * `rotate`; they go into `events/subscribe` and nowhere else. This module never
 * logs, and never puts a response body into an error message — only the
 * inbox's own short error CODE, and only when it is a plain identifier. The
 * admin token rides in a header on a request that refuses redirects, so a
 * misconfigured origin cannot bounce it somewhere we did not choose.
 *
 * Errors are phrased so the SDK's auth heuristics (`isAuthError`) never read
 * an inbox refusal as the USER'S credentials failing: a wrong admin token is
 * our misconfiguration, and must back off, never park a subscription in
 * `paused_auth`.
 */

import {
  InboxBackpressureError,
  type EventOrigin,
  type EventRunNamespace,
  type InboxAppendEntry,
  type InboxPort,
  type InboxSlotAllocation,
} from "@mcpjam/sdk/events";
import {
  EVENTS_INBOX_ADMIN_TOKEN_HEADER,
  getEventsInboxAdminToken,
  getEventsInboxUrl,
} from "./config.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_AFTER_MS = 5_000;
const MAX_RETRY_AFTER_MS = 10 * 60 * 1000;
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** A non-2xx, non-backpressure answer from the inbox admin API. */
export class InboxHttpError extends Error {
  /** HTTP status. Deliberately NOT named `code` (see the module header). */
  readonly httpStatus: number;
  /** The inbox's `{error}` code when it is a plain identifier. */
  readonly inboxError?: string;

  constructor(operation: string, httpStatus: number, inboxError?: string) {
    super(
      `Event inbox ${operation} failed (${describeStatus(httpStatus)}${
        inboxError && !/auth|forbid/i.test(inboxError) ? `: ${inboxError}` : ""
      })`,
    );
    this.name = "InboxHttpError";
    this.httpStatus = httpStatus;
    if (inboxError) this.inboxError = inboxError;
  }
}

function describeStatus(status: number): string {
  if (status === 401 || status === 403) return "admin credential refused";
  if (status === 404) return "not found";
  if (status === 409) return "conflict";
  if (status === 410) return "gone";
  if (status === 413) return "payload too large";
  if (status >= 400 && status < 500) return "request rejected";
  if (status >= 500) return "inbox error";
  return "unexpected response";
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date. */
export function parseRetryAfterMs(
  header: string | null | undefined,
  now: number = Date.now(),
): number {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const trimmedHeader = header.trim();
  if (/^\d+$/.test(trimmedHeader)) {
    return Math.min(MAX_RETRY_AFTER_MS, Number(trimmedHeader) * 1000);
  }
  const at = Date.parse(trimmedHeader);
  if (Number.isNaN(at)) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - now));
}

export interface HttpInboxClientOptions {
  inboxId: string;
  /** Inbox Worker origin. Default `EVENTS_INBOX_URL`. */
  baseUrl?: string;
  /** Default `EVENTS_INBOX_ADMIN_TOKEN`. */
  adminToken?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** `GET …/slots/{slotId}/state` (C5 admin table), as the inbox answers it. */
export interface InboxSlotStateResponse {
  slotId?: string;
  state: string;
  serverSubscriptionId?: string | null;
  observedSubscriptionIds?: string[];
  counts?: Record<string, number>;
  rejections?: Array<{
    reason: string;
    slotId?: string | null;
    at: number;
    headerNames: string[];
    bodyBytes: number;
  }>;
  [key: string]: unknown;
}

export interface InboxSimulateArgs {
  logicalSubscriptionId: string;
  projectId: string;
  environmentId: string | null;
  bindingKey: string;
  slotId?: string;
  event: {
    eventId: string;
    name: string;
    timestamp: string;
    data: Record<string, unknown>;
  };
}

export class HttpInboxClient implements InboxPort {
  readonly inboxId: string;
  private readonly baseUrl: string;
  private readonly adminToken: string | undefined;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpInboxClientOptions) {
    this.inboxId = options.inboxId;
    this.baseUrl = (options.baseUrl ?? getEventsInboxUrl()).replace(/\/+$/, "");
    this.adminToken = options.adminToken ?? getEventsInboxAdminToken();
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private adminPath(suffix: string): string {
    return `${this.baseUrl}/admin/i/${encodeURIComponent(this.inboxId)}${suffix}`;
  }

  private slotPath(slotId: string, action: string): string {
    return this.adminPath(`/slots/${encodeURIComponent(slotId)}/${action}`);
  }

  private async request<T>(
    operation: string,
    method: "GET" | "POST",
    url: string,
    body?: unknown,
  ): Promise<T> {
    if (!this.adminToken) {
      throw new InboxHttpError(operation, 0, "admin_token_not_configured");
    }
    const response = await this.doFetch(url, {
      method,
      headers: {
        [EVENTS_INBOX_ADMIN_TOKEN_HEADER]: this.adminToken,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      // A redirect would carry the admin token to an origin we did not pick.
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 503) {
      // Drain without reading into anything that could be logged.
      await response.body?.cancel().catch(() => undefined);
      throw new InboxBackpressureError(
        parseRetryAfterMs(response.headers.get("retry-after")),
      );
    }
    let parsed: unknown = undefined;
    const text = await response.text().catch(() => "");
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (response.status < 200 || response.status >= 300) {
      const code = (parsed as { error?: unknown } | undefined)?.error;
      throw new InboxHttpError(
        operation,
        response.status,
        typeof code === "string" && SAFE_ERROR_CODE.test(code) ? code : undefined,
      );
    }
    return (parsed ?? {}) as T;
  }

  // --- InboxPort ------------------------------------------------------------

  async allocateSlot(args: {
    logicalSubscriptionId: string;
    projectId: string;
    environmentId: string | null;
    bindingKey: string;
    dispatch: boolean;
    idempotencyKey: string;
    pendingTtlMs?: number;
  }): Promise<InboxSlotAllocation> {
    const result = await this.request<unknown>(
      "slot allocation",
      "POST",
      this.adminPath("/slots"),
      {
        logicalSubscriptionId: args.logicalSubscriptionId,
        projectId: args.projectId,
        environmentId: args.environmentId,
        bindingKey: args.bindingKey,
        dispatch: args.dispatch,
        idempotencyKey: args.idempotencyKey,
        ...(args.pendingTtlMs !== undefined ? { pendingTtlMs: args.pendingTtlMs } : {}),
      },
    );
    return this.allocationFrom("slot allocation", result);
  }

  async findAllocation(idempotencyKey: string): Promise<InboxSlotAllocation | null> {
    try {
      const result = await this.request<unknown>(
        "slot allocation lookup",
        "POST",
        this.adminPath("/slots"),
        { idempotencyKey, recoverOnly: true },
      );
      return this.allocationFrom("slot allocation lookup", result);
    } catch (error) {
      if (
        error instanceof InboxHttpError &&
        error.httpStatus === 404 &&
        error.inboxError === "unknown_allocation"
      ) {
        return null;
      }
      throw error;
    }
  }

  private allocationFrom(operation: string, raw: unknown): InboxSlotAllocation {
    const result = raw as {
      slotId?: unknown;
      callbackUrl?: unknown;
      secret?: unknown;
      state?: unknown;
    };
    if (
      typeof result.slotId !== "string" ||
      typeof result.callbackUrl !== "string" ||
      typeof result.secret !== "string"
    ) {
      throw new InboxHttpError(operation, 200, "malformed_response");
    }
    return {
      inboxId: this.inboxId,
      slotId: result.slotId,
      callbackUrl: result.callbackUrl,
      secret: result.secret,
      ...(typeof result.state === "string" ? { state: result.state } : {}),
    };
  }

  async getSecret(
    slotId: string,
  ): Promise<{ secret: string; previousSecret?: string; state?: string }> {
    const result = await this.request<{
      secret: string;
      previousSecret?: string;
      state?: string;
    }>("secret read", "POST", this.slotPath(slotId, "secret"));
    if (typeof result.secret !== "string") {
      throw new InboxHttpError("secret read", 200, "malformed_response");
    }
    return {
      secret: result.secret,
      ...(typeof result.previousSecret === "string"
        ? { previousSecret: result.previousSecret }
        : {}),
      ...(typeof result.state === "string" ? { state: result.state } : {}),
    };
  }

  async reconcile(
    slotId: string,
    serverSubscriptionId: string,
  ): Promise<{ state: string; conflict?: { existing: string; proposed: string } }> {
    const result = await this.request<{
      state: string;
      conflict?: { existing: string; proposed: string };
    }>("reconcile", "POST", this.slotPath(slotId, "reconcile"), {
      serverSubscriptionId,
    });
    return {
      state: String(result.state ?? "unknown"),
      ...(result.conflict ? { conflict: result.conflict } : {}),
    };
  }

  async unbind(slotId: string): Promise<void> {
    await this.request("slot unbind", "POST", this.slotPath(slotId, "unbind"));
  }

  async rotate(slotId: string, overlapMs?: number): Promise<{ secret: string }> {
    const result = await this.request<{ secret: string }>(
      "rotation",
      "POST",
      this.slotPath(slotId, "rotate"),
      overlapMs !== undefined ? { overlapMs } : {},
    );
    if (typeof result.secret !== "string") {
      throw new InboxHttpError("rotation", 200, "malformed_response");
    }
    return { secret: result.secret };
  }

  async retirePrevious(slotId: string): Promise<void> {
    await this.request("secret retirement", "POST", this.slotPath(slotId, "retire-previous"));
  }

  async remove(slotId: string): Promise<void> {
    await this.request("slot removal", "POST", this.slotPath(slotId, "remove"));
  }

  async append(args: {
    slotId?: string;
    logicalSubscriptionId: string;
    projectId: string;
    environmentId: string | null;
    bindingKey: string;
    batchId: string;
    origin: EventOrigin;
    namespace?: EventRunNamespace;
    entries: InboxAppendEntry[];
  }): Promise<{ accepted: number; duplicates: number }> {
    // The C5 body names `{slotId?, logicalSubscriptionId, batchId, origin,
    // entries}`; the tenant fields ride along because a poll or simulated
    // entry has no slot to take them from (the Worker requires them then, and
    // checks them against the slot when there is one).
    const result = await this.request<{ accepted?: number; duplicates?: number }>(
      "append",
      "POST",
      this.adminPath("/append"),
      {
        ...(args.slotId ? { slotId: args.slotId } : {}),
        logicalSubscriptionId: args.logicalSubscriptionId,
        projectId: args.projectId,
        environmentId: args.environmentId,
        bindingKey: args.bindingKey,
        batchId: args.batchId,
        origin: args.origin,
        ...(args.namespace ? { namespace: args.namespace } : {}),
        entries: args.entries,
      },
    );
    return {
      accepted: Number(result.accepted ?? 0),
      duplicates: Number(result.duplicates ?? 0),
    };
  }

  // --- Admin helpers beyond the port -----------------------------------------

  async setDispatch(slotId: string, enabled: boolean): Promise<void> {
    await this.request("dispatch toggle", "POST", this.slotPath(slotId, "dispatch"), {
      enabled,
    });
  }

  async slotState(slotId: string): Promise<InboxSlotStateResponse> {
    return this.request<InboxSlotStateResponse>(
      "slot state",
      "GET",
      this.slotPath(slotId, "state"),
    );
  }

  /** The inbox's current viewer epoch (tokens must carry it, C7). */
  async getViewerEpoch(): Promise<number> {
    const result = await this.request<{ epoch?: unknown }>(
      "viewer epoch read",
      "GET",
      this.adminPath("/viewer-epoch"),
    );
    return typeof result.epoch === "number" && Number.isSafeInteger(result.epoch)
      ? result.epoch
      : 0;
  }

  /** Bump the viewer epoch: revokes every outstanding viewer token. */
  async bumpViewerEpoch(): Promise<number> {
    const result = await this.request<{ epoch?: unknown }>(
      "viewer epoch bump",
      "POST",
      this.adminPath("/viewer-epoch"),
    );
    return typeof result.epoch === "number" ? result.epoch : 0;
  }

  /**
   * Append one simulated event (origin and namespace `simulation`, C2): it
   * lands in the journal and the feed, dispatches to `simulation`-namespace
   * runs, and can never collide with or suppress a live one.
   */
  async simulate(args: InboxSimulateArgs): Promise<{ accepted: number; duplicates: number }> {
    return this.append({
      ...(args.slotId ? { slotId: args.slotId } : {}),
      logicalSubscriptionId: args.logicalSubscriptionId,
      projectId: args.projectId,
      environmentId: args.environmentId,
      bindingKey: args.bindingKey,
      batchId: `sim_${crypto.randomUUID()}`,
      origin: "simulation",
      namespace: "simulation",
      entries: [
        {
          eventId: args.event.eventId,
          name: args.event.name,
          timestamp: args.event.timestamp,
          data: args.event.data,
        } as InboxAppendEntry,
      ],
    });
  }
}
