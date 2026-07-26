import { Hono } from "hono";
import type {
  ElicitResult,
  InputRequests,
  InputResponses,
  MCPClientManager,
  MCPServerConfig,
  MrtrInputCollector,
  MrtrOperationState,
} from "@mcpjam/sdk";
import {
  isKnownProtocolVersion,
  isStatelessProtocolVersion,
} from "@mcpjam/sdk";
import { logger } from "../../utils/logger";

/**
 * `mrtr.ts` — the LOCAL Inspector bridge for the modern multi-round-trip
 * (`input_required` / MRTR) interaction (MCP 2026-07-28, spec §12).
 *
 * A modern `tools/call`, `resources/read`, or `prompts/get` can answer
 * `input_required` with embedded `elicitation/create` requests plus an opaque
 * `requestState`; the SDK's manual driver (PR1) collects the responses and
 * retries the original operation. On the LOCAL surface the driver runs
 * server-side inside `manager.executeTool` / `readResource` / `getPrompt`, so
 * the human-input collection is bridged to the browser over SSE — the exact
 * shape as the legacy `elicitation/create` bridge (`elicitation.ts`), except
 * the collected responses are returned INTO the driver loop rather than into a
 * `setRequestHandler` resolver.
 *
 * ## Collector-before-connect (LOAD-BEARING)
 *
 * A 2026-07-28 server checks the request's declared client capabilities before
 * it will embed an `elicitation/create` in an `input_required` result;
 * `buildCapabilities` (SDK) advertises `elicitation` only when an MRTR collector
 * is registered, and registering a collector AFTER connect does not
 * retroactively re-advertise. So {@link registerLocalMrtrCollector} MUST be
 * called BEFORE `manager.connectToServer` (see `local-server-resolver.ts`).
 *
 * ## Decline / cancel are responses, not errors
 *
 * A user who declines or cancels produces an `ElicitResult` (`{ action:
 * 'decline' }` / `{ action: 'cancel' }`) that flows back into the driver as a
 * legitimate response — the driver retries with it; it is never thrown. Only an
 * explicit abort of the whole operation rejects the collector (never converted
 * to a synthetic decline).
 */

// ---------------------------------------------------------------------------
// SSE fan-out (one channel shared across every local surface)
// ---------------------------------------------------------------------------

type Subscriber = { send: (event: unknown) => void; close: () => void };
const subscribers = new Set<Subscriber>();

function broadcast(event: unknown): void {
  for (const sub of Array.from(subscribers)) {
    try {
      sub.send(event);
    } catch {
      try {
        sub.close();
      } catch {}
      subscribers.delete(sub);
    }
  }
}

// ---------------------------------------------------------------------------
// Pending rounds — one in-flight collection per logical operation (opId)
// ---------------------------------------------------------------------------

type PendingRound = {
  opId: string;
  round: number;
  serverId: string;
  /** The exact server-assigned keys this round must answer. */
  keys: string[];
  resolve: (responses: InputResponses) => void;
  reject: (error: unknown) => void;
  /** Detaches the abort listener once the round settles. */
  cleanup: () => void;
};

const pendingRounds = new Map<string, PendingRound>();

/**
 * The browser-facing description of one embedded elicitation request. Untrusted
 * server strings (`message`, `url`, `requestedSchema`) travel verbatim and are
 * rendered as plain text on the client (never linkified).
 */
export type MrtrBridgeInputRequest = {
  key: string;
  mode: "form" | "url";
  message: string;
  /** Present for form mode only. */
  requestedSchema?: Record<string, unknown>;
  /** Present for url mode only. */
  url?: string;
};

/**
 * Projects the driver's validated `inputRequests` map (elicitation-only by the
 * time the collector runs — undeclared roots/sampling are rejected upstream)
 * into the browser payload. Iterates the server keys directly; a hostile key
 * such as `__proto__` is only ever used as a value, never as an object key on
 * the wire event's own prototype.
 */
export function projectInputRequests(
  inputRequests: InputRequests,
): MrtrBridgeInputRequest[] {
  const out: MrtrBridgeInputRequest[] = [];
  for (const key of Object.keys(inputRequests)) {
    const req = inputRequests[key] as {
      method?: string;
      params?: Record<string, unknown>;
    };
    const params = req?.params ?? {};
    const mode = (params.mode as string | undefined) === "url" ? "url" : "form";
    out.push({
      key,
      mode,
      message: typeof params.message === "string" ? params.message : "",
      ...(mode === "form" && params.requestedSchema !== undefined
        ? {
            requestedSchema: params.requestedSchema as Record<string, unknown>,
          }
        : {}),
      ...(mode === "url" && typeof params.url === "string"
        ? { url: params.url }
        : {}),
    });
  }
  return out;
}

/**
 * Builds the collector for one `(manager, serverId)`. On each round it
 * publishes the round to the SSE channel and returns a promise that settles
 * when the browser posts the round's responses (or the operation aborts). Only
 * JSON-serializable data crosses the boundary; no `Client`/promise/closure is
 * persisted anywhere (the resume-safe stepper is a PR3+ concern — local blocks
 * in-process, which is allowed).
 */
function makeCollector(serverId: string): MrtrInputCollector {
  return ({
    state,
    inputRequests,
    signal,
  }: {
    state: MrtrOperationState;
    inputRequests: InputRequests;
    signal?: AbortSignal;
  }): Promise<InputResponses> => {
    const opId = state.opId;
    const round = state.round;
    const keys = Object.keys(inputRequests);
    const requests = projectInputRequests(inputRequests);

    return new Promise<InputResponses>((resolve, reject) => {
      // An abort of the whole operation rejects the collector — never a
      // synthetic decline. Detach on settle to avoid leaks across rounds.
      const onAbort = () => {
        const pending = pendingRounds.get(opId);
        if (pending) {
          pendingRounds.delete(opId);
          pending.cleanup();
        }
        broadcast({ type: "mrtr_input_cancelled", opId });
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const cleanup = () => {
        try {
          signal?.removeEventListener?.("abort", onAbort);
        } catch {}
      };

      if (signal?.aborted) {
        broadcast({ type: "mrtr_input_cancelled", opId });
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      signal?.addEventListener?.("abort", onAbort, { once: true });

      // A stale pending round for the same op (should not happen — one round at
      // a time) is superseded so the driver never dangles on an old resolver.
      const stale = pendingRounds.get(opId);
      if (stale) {
        pendingRounds.delete(opId);
        stale.cleanup();
        stale.reject(new Error("Superseded by a newer MRTR round"));
      }

      pendingRounds.set(opId, {
        opId,
        round,
        serverId,
        keys,
        resolve,
        reject,
        cleanup,
      });

      broadcast({
        type: "mrtr_input_request",
        opId,
        // A per-round identity so the browser can dedupe SSE redelivery and key
        // its dialog to exactly one round.
        roundKey: `${opId}:${round}`,
        round,
        serverId,
        requests,
        timestamp: new Date().toISOString(),
      });
    });
  };
}

// ---------------------------------------------------------------------------
// Registration (before connect)
// ---------------------------------------------------------------------------

// Per-manager set of server ids whose collector is already registered. WeakMap
// so a discarded manager (hot reload) is collected with its set.
const registered = new WeakMap<MCPClientManager, Set<string>>();

/**
 * The `elicitation` capability a local MRTR connection may advertise.
 *
 * The MRTR bridge completes BOTH modes — form rounds through
 * `ElicitationDialog`, url rounds through `UrlElicitationConsent` — so on a
 * modern connection it is honest to declare both. Bare `{}` means form-ONLY
 * under the spec's back-compat rule, and the SDK now derives the MRTR mode
 * allowlist from what was actually advertised, so leaving it bare makes every
 * url round fail validation before the consent dialog is ever reached.
 */
const MRTR_ELICITATION_CAPABILITY = { form: {}, url: {} } as const;

/**
 * Widens the advertised `elicitation` capability to include `url` — but ONLY
 * when the connection cannot land on a pre-2026 version.
 *
 * The two eras share ONE capability on the wire, and they are fulfilled by
 * different bridges. On 2026-07-28 elicitation arrives exclusively inside an
 * `input_required` result ("Servers MUST send server-to-client requests using
 * the MRTR pattern"), which the MRTR bridge handles in both modes. On
 * 2025-11-25 and earlier it arrives as an inbound `elicitation/create`, which
 * the legacy SSE bridge fulfils — and that one is form-only: it broadcasts
 * `{requestId, message, schema}` with no url, so a url request would ask the
 * user to approve a destination they cannot see.
 *
 * Capabilities are sent in `initialize`, before the negotiated version is
 * known, so declaring `url` is only safe when every acceptable version is
 * modern. An `auto` accept-list that still permits a legacy answer stays
 * form-only — fail closed. Lifting this needs the legacy bridge to carry url
 * (it can reuse the same consent dialog), not a wider declaration here.
 */
export function withLocalMrtrElicitationCapability<T extends MCPServerConfig>(
  config: T,
): T {
  // An exact set (host profile / explicit client capabilities) is advertised
  // verbatim — widening it would defeat the point of pinning one.
  if ((config as { clientCapabilities?: unknown }).clientCapabilities) {
    return config;
  }
  const accepted = (config as { supportedProtocolVersions?: unknown })
    .supportedProtocolVersions;
  if (!Array.isArray(accepted) || accepted.length === 0) return config;
  const modernOnly = accepted.every(
    (version) =>
      typeof version === "string" &&
      isKnownProtocolVersion(version) &&
      isStatelessProtocolVersion(version),
  );
  if (!modernOnly) return config;

  const capabilities = ((config as { capabilities?: Record<string, unknown> })
    .capabilities ?? {}) as Record<string, unknown>;
  return {
    ...config,
    capabilities: {
      ...capabilities,
      elicitation: {
        ...MRTR_ELICITATION_CAPABILITY,
        ...(isPlainObject(capabilities.elicitation)
          ? capabilities.elicitation
          : {}),
      },
    },
  } as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Idempotently registers the MRTR input collector for `serverId` on `manager`.
 * MUST be called BEFORE `manager.connectToServer(serverId, …)` so the
 * `elicitation` client capability is advertised on the connect envelope (see
 * the module header).
 */
export function registerLocalMrtrCollector(
  manager: MCPClientManager,
  serverId: string,
): void {
  let ids = registered.get(manager);
  if (!ids) {
    ids = new Set<string>();
    registered.set(manager, ids);
  }
  if (ids.has(serverId)) return;
  try {
    manager.setMrtrInputCollector(serverId, makeCollector(serverId));
    ids.add(serverId);
  } catch (err) {
    // Pass the original error as the 2nd (error) arg so Sentry captures a stack
    // and Axiom serializes the real message; serverId is the context (3rd) arg.
    logger.error("[mrtr] Failed to register MRTR collector", err, { serverId });
  }
}

// ---------------------------------------------------------------------------
// Response submission (called by the route; also usable in tests)
// ---------------------------------------------------------------------------

/** Normalizes one browser answer into the strict `ElicitResult` shape. */
function toElicitResult(answer: {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}): ElicitResult {
  // Content rides accepts only; decline/cancel carry nothing. The elicitation
  // content is a primitive map on the wire; the driver self-validates it
  // against the request's `requestedSchema`, so the cast here is safe.
  return answer.action === "accept"
    ? {
        action: "accept",
        content: (answer.content ?? {}) as ElicitResult["content"],
      }
    : { action: answer.action };
}

export type MrtrRespondResult =
  | { ok: true }
  | { ok: false; status: 404 | 400; error: string };

/**
 * Resolves the pending round for `opId` with the browser's per-key responses,
 * feeding them back into the SDK driver loop. Missing/extra keys are rejected
 * here (the driver also self-validates, but a clear 400 is friendlier than a
 * driver throw surfacing as a 500 on the original operation).
 */
export function submitMrtrResponses(
  opId: string,
  responsesByKey: Record<
    string,
    { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }
  >,
): MrtrRespondResult {
  const pending = pendingRounds.get(opId);
  if (!pending) {
    return { ok: false, status: 404, error: "Unknown or already-answered opId" };
  }

  const answeredKeys = Object.keys(responsesByKey);
  for (const key of pending.keys) {
    if (!answeredKeys.includes(key)) {
      return { ok: false, status: 400, error: `Missing response for "${key}"` };
    }
  }
  for (const key of answeredKeys) {
    if (!pending.keys.includes(key)) {
      return {
        ok: false,
        status: 400,
        error: `Unexpected response key "${key}" not requested this round`,
      };
    }
  }

  // Validate each answer's action BEFORE resolving the collector: an unknown
  // action would otherwise be forwarded verbatim to the MCP server as an invalid
  // `inputResponses` entry (and an `accept` with no content is malformed too).
  for (const key of answeredKeys) {
    const answer = responsesByKey[key];
    if (
      !answer ||
      (answer.action !== "accept" &&
        answer.action !== "decline" &&
        answer.action !== "cancel")
    ) {
      return {
        ok: false,
        status: 400,
        error: `Invalid action for "${key}" (expected accept | decline | cancel)`,
      };
    }
  }

  // Null-prototype map — the keys are server-chosen and untrusted.
  const responses = Object.create(null) as InputResponses;
  for (const key of answeredKeys) {
    responses[key] = toElicitResult(responsesByKey[key]);
  }

  pendingRounds.delete(opId);
  pending.cleanup();
  pending.resolve(responses);
  broadcast({ type: "mrtr_input_complete", opId, roundKey: `${opId}:${pending.round}` });
  return { ok: true };
}

/** Test-only: how many rounds are awaiting a browser response. */
export function pendingMrtrRoundCount(): number {
  return pendingRounds.size;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const mrtr = new Hono();

// SSE stream of MRTR round events (mirrors the legacy elicitation bridge).
mrtr.get("/stream", async (c) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keep-alive\n\n`));
        } catch {}
      }, 25000);
      const close = () => {
        clearInterval(keepAlive);
        try {
          controller.close();
        } catch {}
      };

      controller.enqueue(encoder.encode(`retry: 1500\n\n`));
      const subscriber: Subscriber = { send, close };
      subscribers.add(subscriber);

      (c.req.raw as any).signal?.addEventListener?.("abort", () => {
        subscribers.delete(subscriber);
        close();
      });
    },
  });

  return new Response(stream as any, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

// Submit a whole round's responses (all keys together).
mrtr.post("/respond", async (c) => {
  try {
    const body = (await c.req.json()) as {
      opId?: string;
      responses?: Record<
        string,
        {
          action: "accept" | "decline" | "cancel";
          content?: Record<string, unknown>;
        }
      >;
    };
    if (!body.opId || !body.responses || typeof body.responses !== "object") {
      return c.json({ error: "Missing opId or responses" }, 400);
    }
    const result = submitMrtrResponses(body.opId, body.responses);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e?.message || "Failed to submit MRTR responses" }, 400);
  }
});

export default mrtr;
