/**
 * Hosted-mode MCP elicitation bridge (MCP 2025-11-25, form + URL modes).
 *
 * ## Why a bridge at all
 *
 * An MCP server can send `elicitation/create` in the middle of a `tools/call`.
 * Answering it means asking a HUMAN, which takes minutes — and the hosted plane
 * is horizontally scaled, so the answer arrives as a *separate* HTTP request the
 * load balancer may route to any replica.
 *
 * The split that makes this tractable:
 *
 * - **Delivery (server → user) needs no coordination.** Hosted chat builds a
 *   per-request `MCPClientManager` and tears it down at end of turn, so the MCP
 *   connection, the blocked tool call, and the browser's stream all live on THIS
 *   replica for the turn. The request rides the turn's own UI message stream as
 *   a transient `data-elicitation` part — inherently scoped to the one user who
 *   asked, with no broadcast surface.
 * - **The answer (user → blocked replica) is the only cross-replica leg.** It
 *   rendezvouses through Convex: the browser writes the answer with its own live
 *   Convex auth; this replica polls until answered/expired/aborted. Node cannot
 *   subscribe to Convex (HTTP client only), hence polling.
 *
 * ## Ordering guarantee (do not "optimize" this)
 *
 * poll (read, side-effect-free) → resolve the ElicitResult to the MCP server →
 * ack (scrub the payload). Scrubbing during the poll read is a CORRECTNESS BUG:
 * if that response is lost in flight, the retry returns `answered` with the
 * content already destroyed, and this bridge cannot distinguish that from a
 * legitimately contentless accept (URL mode carries none; an empty form accept
 * is valid) — it would fabricate a cancel over a real accept, or an empty accept
 * over real content. If a replica dies before acking, the payload simply waits
 * for the backend's 24h cleanup; retention is unchanged.
 *
 * ## Fail-fast before the writer exists
 *
 * The stream writer only arrives at `onStreamWriterReady`, which fires after MCP
 * connect + tool discovery (`prepareChatV2`). An elicitation raised during that
 * window has nowhere to render AND its consumer (the stream) is created by the
 * very code path it would block — buffering it would deadlock until TTL. Every
 * legitimate elicitation happens during tool execution, when the writer exists,
 * so we resolve pre-writer requests as `cancel` immediately.
 */

import { ConvexHttpClient } from "convex/browser";
import type { UIMessageChunk } from "ai";
import type { ElicitResult } from "@modelcontextprotocol/client";
import type { ElicitationCallback } from "@mcpjam/sdk";
import {
  ELICITATION_FORM_TTL_MS,
  ELICITATION_POLL_INTERVAL_MS,
  ELICITATION_POLL_JITTER_MS,
  ELICITATION_POLL_MAX_FAILURES,
  ELICITATION_URL_CONSENT_TTL_MS,
} from "../../config.js";
import { logger } from "../../utils/logger.js";
import {
  HOSTED_ELICITATION_DATA_PART_TYPE,
  type HostedElicitationEvent,
  type HostedElicitationMode,
} from "@/shared/hosted-elicitation";

type ElicitationChunkWriter = {
  write: (chunk: UIMessageChunk) => void;
};

/** Terminal states the rendezvous row can report. */
type PollStatus = "pending" | "answered" | "cancelled" | "expired";

type PollResult = {
  status: PollStatus;
  action?: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
};

export interface HostedElicitationBridgeOptions {
  /**
   * A CONVEX-VALID bearer, i.e. the output of `getConvexBearerForRequest(c)` —
   * not the raw Authorization header, which for WorkOS API-key callers is an
   * `sk_…` key Convex cannot verify.
   */
  convexBearer: string;
  projectId: string;
  chatSessionId?: string;
  /** Display labels only; `serverId` stays the trusted anchor. */
  serverNamesById: Record<string, string>;
  /** The turn's abort signal — a closed stream must not leave a pending row. */
  abortSignal?: AbortSignal;
}

function stripBearer(token: string): string {
  return token.replace(/^Bearer\s+/i, "").trim();
}

function requireConvexUrl(): string {
  const url = process.env.CONVEX_URL;
  if (!url) throw new Error("CONVEX_URL is not configured");
  return url;
}

function requireConvexHttpUrl(): string {
  const url = process.env.CONVEX_HTTP_URL;
  if (!url) throw new Error("CONVEX_HTTP_URL is not configured");
  return url;
}

function serviceToken(): string {
  const token = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!token) throw new Error("INSPECTOR_SERVICE_TOKEN is not configured");
  return token;
}

const CANCEL: ElicitResult = { action: "cancel" };

/**
 * Build the ElicitResult for an answered row.
 *
 * `content` rides ONLY on a form-mode accept. The backend already validates the
 * shape, and the MCP server re-validates against its own schema; we simply must
 * not invent a `content` key where the spec says there is none (URL accepts,
 * declines, cancels).
 */
function toElicitResult(poll: PollResult, mode: HostedElicitationMode): ElicitResult {
  const action = poll.action ?? "cancel";
  if (action === "accept" && mode === "form") {
    return { action: "accept", content: poll.content ?? {} } as ElicitResult;
  }
  return { action } as ElicitResult;
}

export class HostedElicitationBridge {
  private writer: ElicitationChunkWriter | null = null;
  /** Rendezvous ids still awaiting an answer — cancelled on dispose. */
  private readonly pending = new Set<string>();
  private disposed = false;

  constructor(private readonly options: HostedElicitationBridgeOptions) {}

  attachStreamWriter(writer: ElicitationChunkWriter): void {
    this.writer = writer;
  }

  /**
   * The SDK global elicitation callback. Registered on the per-turn manager
   * ONLY when the host declares the capability (see `chat-v2.ts`), because the
   * SDK gates advertisement on a handler being present — registering is what
   * makes `elicitation` appear in `initialize`.
   */
  readonly callback: ElicitationCallback = async (request) => {
    const mode: HostedElicitationMode = request.mode === "url" ? "url" : "form";
    const serverId = request.serverId ?? "unknown";

    // Pre-writer: nothing can render this, and its consumer is the very stream
    // that hasn't been created yet. Fail fast rather than deadlock to TTL.
    if (!this.writer || this.disposed) {
      logger.warn(
        "[elicitation] request arrived with no live stream; cancelling",
        { serverId, mode, disposed: this.disposed },
      );
      return CANCEL;
    }

    // URL mode is a consent decision (seconds); form mode is data entry.
    const ttlMs =
      mode === "url" ? ELICITATION_URL_CONSENT_TTL_MS : ELICITATION_FORM_TTL_MS;
    const rendezvousId = crypto.randomUUID();
    const expiresAt = Date.now() + ttlMs;

    try {
      await this.createRow({ rendezvousId, request, mode, ttlMs, serverId });
    } catch (error) {
      // A broken rendezvous must never hang a tool call: without a row there is
      // nothing for the browser to answer, so the only honest outcome is cancel.
      logger.error("[elicitation] failed to create rendezvous row; cancelling", {
        error,
        serverId,
        mode,
      });
      return CANCEL;
    }

    this.pending.add(rendezvousId);
    this.emit({
      kind: "request",
      rendezvousId,
      serverId,
      serverName: this.options.serverNamesById[serverId],
      mode,
      message: request.message,
      ...(mode === "form" ? { requestedSchema: request.schema } : {}),
      ...(mode === "url" && request.url ? { url: request.url } : {}),
      ...(request.elicitationId
        ? { serverElicitationId: request.elicitationId }
        : {}),
      expiresAt,
      ...(this.options.chatSessionId
        ? { chatSessionId: this.options.chatSessionId }
        : {}),
    });

    try {
      return await this.awaitAnswer({ rendezvousId, expiresAt, mode });
    } finally {
      this.pending.delete(rendezvousId);
    }
  };

  /**
   * Surface a `-32042 URLElicitationRequiredError` raised by a failed
   * `tools/call`. Display-only: the call already failed, so no JSON-RPC response
   * is owed and there is nothing to rendezvous on.
   */
  emitUrlRequired(info: {
    serverId: string;
    toolCallId?: string;
    elicitations: Array<{ url: string; elicitationId: string; message?: string }>;
  }): void {
    if (info.elicitations.length === 0) return;
    this.emit({
      kind: "url_required",
      serverId: info.serverId,
      serverName: this.options.serverNamesById[info.serverId],
      ...(info.toolCallId ? { toolCallId: info.toolCallId } : {}),
      elicitations: info.elicitations,
    });
  }

  /**
   * End-of-turn cleanup. Withdraws any row still pending so a closed stream
   * can't leave an answerable prompt behind for its TTL.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.writer = null;
    const outstanding = Array.from(this.pending);
    this.pending.clear();
    await Promise.all(
      outstanding.map((rendezvousId) => this.cancelRow(rendezvousId)),
    );
  }

  // ── internals ────────────────────────────────────────────────────────────

  private emit(event: HostedElicitationEvent): void {
    if (!this.writer) return;
    try {
      this.writer.write({
        type: HOSTED_ELICITATION_DATA_PART_TYPE,
        data: event,
        transient: true,
      } as unknown as UIMessageChunk);
    } catch (error) {
      // A dead writer means the browser is gone; the poll loop's abort/TTL
      // paths still resolve the blocked call, so this is not fatal.
      logger.warn("[elicitation] stream write failed", { error });
      this.writer = null;
    }
  }

  /**
   * Written with the USER's bearer (not the service token) so the backend
   * derives ownership from verified identity via `ctx.actor` — the row is never
   * told who owns it. Works identically for guests.
   */
  private async createRow(args: {
    rendezvousId: string;
    request: Parameters<ElicitationCallback>[0];
    mode: HostedElicitationMode;
    ttlMs: number;
    serverId: string;
  }): Promise<void> {
    const client = new ConvexHttpClient(requireConvexUrl());
    client.setAuth(stripBearer(this.options.convexBearer));
    await client.mutation("elicitations:createElicitation" as any, {
      rendezvousId: args.rendezvousId,
      projectId: this.options.projectId,
      ...(this.options.chatSessionId
        ? { chatSessionId: this.options.chatSessionId }
        : {}),
      serverId: args.serverId,
      ...(this.options.serverNamesById[args.serverId]
        ? { serverName: this.options.serverNamesById[args.serverId] }
        : {}),
      mode: args.mode,
      message: args.request.message,
      ...(args.mode === "form"
        ? { requestedSchema: args.request.schema ?? {} }
        : {}),
      ...(args.mode === "url" && args.request.url
        ? { url: args.request.url }
        : {}),
      ...(args.request.elicitationId
        ? { serverElicitationId: args.request.elicitationId }
        : {}),
      ttlMs: args.ttlMs,
    });
  }

  /**
   * Service-token routes: the wait spans human time and can outlive a WorkOS
   * access token, so the poll leg must not depend on the user's bearer staying
   * fresh. Safe because `rendezvousId` is a replica-minted UUID and these routes
   * are read/withdraw-only.
   */
  private async serviceRoute<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(
      new URL(path, requireConvexHttpUrl()).toString(),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-inspector-service-token": serviceToken(),
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      throw new Error(`${path} returned ${response.status}`);
    }
    return (await response.json()) as T;
  }

  private async poll(rendezvousId: string): Promise<PollResult | null> {
    const payload = await this.serviceRoute<{
      ok: boolean;
      elicitation: PollResult | null;
    }>("/elicitations/poll", { rendezvousId });
    return payload.elicitation ?? null;
  }

  /** Fire-and-forget: scrubs the payload once we've resolved to the server. */
  private ackRow(rendezvousId: string): void {
    void this.serviceRoute("/elicitations/ack", { rendezvousId }).catch(
      (error) => {
        // Harmless: the backend's 24h cleanup is the real retention bound.
        logger.warn("[elicitation] ack failed; payload waits for cleanup", {
          error,
          rendezvousId,
        });
      },
    );
  }

  private async cancelRow(rendezvousId: string): Promise<void> {
    try {
      await this.serviceRoute("/elicitations/cancel", { rendezvousId });
    } catch (error) {
      logger.warn("[elicitation] cancel failed; TTL will expire the row", {
        error,
        rendezvousId,
      });
    }
  }

  private async awaitAnswer(args: {
    rendezvousId: string;
    expiresAt: number;
    mode: HostedElicitationMode;
  }): Promise<ElicitResult> {
    const { rendezvousId, expiresAt, mode } = args;
    let consecutiveFailures = 0;

    for (;;) {
      if (this.options.abortSignal?.aborted || this.disposed) {
        // Client hung up: withdraw the row, and don't emit — nobody is reading.
        void this.cancelRow(rendezvousId);
        return CANCEL;
      }

      if (Date.now() >= expiresAt) {
        // Enforce the deadline locally rather than waiting on the 1-min cron.
        void this.cancelRow(rendezvousId);
        this.emit({ kind: "resolved", rendezvousId, outcome: "expired" });
        return CANCEL;
      }

      let result: PollResult | null;
      try {
        result = await this.poll(rendezvousId);
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= ELICITATION_POLL_MAX_FAILURES) {
          logger.error("[elicitation] poll failed repeatedly; cancelling", {
            error,
            rendezvousId,
          });
          void this.cancelRow(rendezvousId);
          this.emit({ kind: "resolved", rendezvousId, outcome: "cancelled" });
          return CANCEL;
        }
        await this.waitOnePollInterval();
        continue;
      }

      if (!result || result.status === "pending") {
        await this.waitOnePollInterval();
        continue;
      }

      if (result.status === "answered") {
        const elicitResult = toElicitResult(result, mode);
        // Ack only AFTER we hold the answer (see the ordering note up top).
        this.ackRow(rendezvousId);
        this.emit({
          kind: "resolved",
          rendezvousId,
          outcome: "answered",
          action: result.action,
        });
        return elicitResult;
      }

      // expired | cancelled — terminal, no answer to deliver.
      this.emit({
        kind: "resolved",
        rendezvousId,
        outcome: result.status === "expired" ? "expired" : "cancelled",
      });
      return CANCEL;
    }
  }

  /**
   * Jittered so concurrent turns don't lock-step onto Convex (mirrors the
   * scheduled-evals worker). Wakes early on abort so a closed stream resolves
   * immediately instead of sleeping out the interval.
   */
  private waitOnePollInterval(): Promise<void> {
    const delay =
      ELICITATION_POLL_INTERVAL_MS + Math.random() * ELICITATION_POLL_JITTER_MS;
    return new Promise((resolve) => {
      const signal = this.options.abortSignal;
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delay);
      function onAbort() {
        clearTimeout(timer);
        resolve();
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/**
 * True when a host's declared client capabilities enable elicitation.
 *
 * Lenient by design: bare `{}` is form-only per the spec's back-compat rule,
 * and the catalog ships both `{}` and `{form:{}}`. Presence of the key — in any
 * object shape — is the toggle.
 */
export function hostDeclaresElicitation(
  clientCapabilities: unknown,
): boolean {
  if (!clientCapabilities || typeof clientCapabilities !== "object") {
    return false;
  }
  const elicitation = (clientCapabilities as Record<string, unknown>)
    .elicitation;
  return (
    typeof elicitation === "object" &&
    elicitation !== null &&
    !Array.isArray(elicitation)
  );
}

/** The hosted-elicitation wire contract this server speaks. */
export const HOSTED_ELICITATION_VERSION = 1;

/**
 * Decide (a) whose client capabilities go on the initialize wire and (b) whether
 * this turn may honor elicitation at all.
 *
 * Two independent gates, both required:
 *
 * 1. **Capability, from the right authority.** For a chatbox turn the published
 *    host wins — a share-link visitor controls the request body, so reading
 *    capabilities from it would let anyone switch elicitation on for a host
 *    whose owner has it off. (Same host-wins reasoning chat-v2 already applies
 *    to model/approval.) A backend predating `clientCapabilities` on
 *    runtime-config omits it → treated as absent → fail closed. For a direct
 *    turn the body IS the owner's own host config, sent by their own client.
 *
 * 2. **Client handshake.** Catalog hosts (claude-code, cursor, vscode, …)
 *    ALREADY declare `elicitation`, so honoring it for every client would make
 *    stale browser bundles — which cannot render the prompt — hang for a full
 *    TTL on any server that elicits. Only clients that announce the version get
 *    the callback; everyone else keeps today's fail-fast behavior.
 */
export function resolveElicitationGate(args: {
  isChatboxSession: boolean;
  /** `clientCapabilities` from the chatbox/host runtime-config (authoritative). */
  hostClientCapabilities: unknown;
  /** `clientCapabilities` from the request body (owner-supplied on direct turns). */
  bodyClientCapabilities: unknown;
  /** `hostedElicitationVersion` from the request body. */
  clientVersion: number | undefined;
}): {
  effectiveClientCapabilities: Record<string, unknown> | undefined;
  enabled: boolean;
} {
  const effectiveClientCapabilities = (
    args.isChatboxSession ? args.hostClientCapabilities : args.bodyClientCapabilities
  ) as Record<string, unknown> | undefined;

  return {
    effectiveClientCapabilities: effectiveClientCapabilities ?? undefined,
    enabled:
      hostDeclaresElicitation(effectiveClientCapabilities) &&
      args.clientVersion === HOSTED_ELICITATION_VERSION,
  };
}
