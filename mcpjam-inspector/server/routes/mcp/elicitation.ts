import { Hono } from "hono";
import type { ElicitResult } from "@modelcontextprotocol/client";
import type { MCPClientManager } from "@mcpjam/sdk";

const elicitation = new Hono();

// Track SSE subscribers
const elicitationSubscribers = new Set<{
  send: (event: unknown) => void;
  close: () => void;
}>();

function broadcastElicitation(event: unknown) {
  for (const sub of Array.from(elicitationSubscribers)) {
    try {
      sub.send(event);
    } catch {
      try {
        sub.close();
      } catch {}
      elicitationSubscribers.delete(sub);
    }
  }
}

// Track which manager instances have had their callback registered
const registeredManagers = new WeakSet<MCPClientManager>();

/**
 * Initialize the global elicitation callback on the MCPClientManager.
 * This should be called immediately after creating the manager to ensure
 * elicitations work for task-augmented requests (MCP Tasks spec 2025-11-25).
 *
 * Without this, tasks/result calls might fail with "Method not found" if
 * no one has hit the elicitation routes yet.
 */
/**
 * Elicitation modes the LOCAL bridges can actually complete.
 *
 * TWO bridges fulfil this one capability, split by era, and only one of them
 * carries url:
 *
 * - **Legacy (2025-11-25 and earlier)** — elicitation arrives as an inbound
 *   `elicitation/create` handled by the SSE flow in this module, which is
 *   form-only: it broadcasts `{requestId, message, schema}` and resolves with
 *   form content. It carries no url and its dialog has no consent surface, so
 *   a url request would reach the user as a form with nothing to fill in and
 *   no way to finish. (The SDK does hand `mode` and `url` to the callback —
 *   see `initElicitationCallback`, which uses `mode` to refuse rather than to
 *   fulfil.)
 * - **Modern (2026-07-28)** — elicitation arrives exclusively inside an
 *   `input_required` result, handled by the MRTR bridge (`routes/mcp/mrtr.ts`
 *   → `MrtrElicitationHost`), which completes BOTH modes: form rounds through
 *   `ElicitationDialog`, url rounds through `UrlElicitationConsent`.
 *
 * (Hosted chat has its own bridge, `routes/web/hosted-elicitation.ts`, which
 * does both on either era and never comes through here.)
 */
const LOCAL_FORM_ONLY_ELICITATION_MODES = ["form"] as const;
const LOCAL_URL_CAPABLE_ELICITATION_MODES = ["form", "url"] as const;

/**
 * Drop elicitation modes the local bridge for this connection can't complete,
 * before they reach the wire.
 *
 * Advertising `url` on a connection whose only fulfiller is the form-only SSE
 * bridge would be a lie with teeth: the SDK would accept a conforming url-mode
 * request, the bridge would drop the `url`, and the user would get a form they
 * cannot complete. Not advertising it means the request is rejected and the
 * server can fall back — the honest outcome.
 *
 * `urlCapable` is the caller's assertion that this connection's fulfiller is
 * the MRTR bridge (see {@link LOCAL_URL_CAPABLE_ELICITATION_MODES}). It is a
 * per-connection fact, not a global one, which is why it is a parameter:
 * `local-server-resolver.ts` derives it from the transport and the protocol
 * pins. Passing `true` never INVENTS the mode — it only stops pruning a `url`
 * the host config actually declared.
 *
 * Only prunes; a config that never mentioned elicitation is returned untouched
 * so this can sit on the shared local path without inventing capabilities.
 */
export function narrowElicitationToLocalSupport(
  capabilities: Record<string, unknown> | undefined,
  options?: { urlCapable?: boolean },
): Record<string, unknown> | undefined {
  const elicitation = capabilities?.elicitation;
  if (
    !capabilities ||
    typeof elicitation !== "object" ||
    elicitation === null ||
    Array.isArray(elicitation)
  ) {
    return capabilities;
  }

  const declared = elicitation as Record<string, unknown>;
  // Bare `{}` is form-only per the spec's back-compat rule — already safe, and
  // rewriting it would churn configs for no behavior change.
  if (Object.keys(declared).length === 0) return capabilities;

  const supportedModes = options?.urlCapable
    ? LOCAL_URL_CAPABLE_ELICITATION_MODES
    : LOCAL_FORM_ONLY_ELICITATION_MODES;

  const narrowed: Record<string, unknown> = {};
  for (const mode of supportedModes) {
    if (declared[mode] !== undefined) narrowed[mode] = declared[mode];
  }
  // Everything was unsupported (e.g. `{url:{}}`): declaring `elicitation: {}`
  // would silently mean "form", which the caller never asked for. Drop the
  // capability entirely instead.
  if (Object.keys(narrowed).length === 0) {
    const { elicitation: _dropped, ...rest } = capabilities;
    return rest;
  }
  return { ...capabilities, elicitation: narrowed };
}

export function initElicitationCallback(manager: MCPClientManager): void {
  // Use WeakSet to track registration per manager instance
  // This handles hot reload scenarios where a new manager is created
  if (registeredManagers.has(manager)) return;

  // Per MCP Tasks spec (2025-11-25), elicitations related to a task include relatedTaskId
  manager.setElicitationCallback(
    ({ requestId, serverId, message, schema, relatedTaskId, mode }) => {
      // BACKSTOP for the one case the connect-time narrowing cannot cover.
      //
      // `narrowElicitationToLocalSupport` keeps `elicitation.url` for any
      // connection that *can* land modern, which includes the unpinned
      // auto-negotiating one — and auto lands legacy against a legacy server.
      // Capabilities are declared before the era is knowable, so such a
      // connection advertises url and then gets fulfilled by THIS form-only
      // bridge. The SDK's own mode gate (`assertElicitationModeDeclared`)
      // checks the request against what was advertised, so it passes url
      // through here: we said url was fine.
      //
      // Refusing is the honest answer. Resolving `{action:"decline"}` would
      // fabricate a user decision that no user made; an error tells the server
      // its request could not be handled, which is what a client that cannot
      // render the consent surface owes it.
      if (mode === "url") {
        return Promise.reject(
          new Error(
            "URL-mode elicitation is not supported on this connection: it " +
              "negotiated a pre-2026 protocol revision, whose inbound " +
              "elicitation bridge is form-only. URL mode is available on " +
              "2026-07-28 connections, where it is served over MRTR.",
          ),
        );
      }
      return new Promise<ElicitResult>((resolve, reject) => {
        try {
          manager.getPendingElicitations().set(requestId, { resolve, reject });
        } catch (err) {
          logger.error("[elicitation] Failed to store pending elicitation", {
            error: err,
          });
        }
        broadcastElicitation({
          type: "elicitation_request",
          requestId,
          // Spec: the client MUST make it clear which server is asking. This
          // matters most in local chat, where several servers are connected at
          // once and the dialog is otherwise anonymous. The SDK supplies the
          // id; it is the trusted, immutable anchor (there is no display name
          // on this path, so the dialog shows the id itself).
          serverId,
          message,
          schema,
          timestamp: new Date().toISOString(),
          // Include related task ID if this elicitation is associated with a task
          relatedTaskId,
        });
      });
    },
  );
  registeredManagers.add(manager);
}

// Legacy middleware - kept for backwards compatibility, but initElicitationCallback
// should be called during app initialization for tasks to work properly
elicitation.use("*", async (c, next) => {
  // Ensure callback is registered (handles edge cases where middleware is hit first)
  initElicitationCallback(c.mcpClientManager);
  await next();
});

// SSE stream for elicitation events
elicitation.get("/stream", async (c) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: unknown) => {
        const payload = `data: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(encoder.encode(payload));
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

      // Initial retry suggestion
      controller.enqueue(encoder.encode(`retry: 1500\n\n`));

      const subscriber = { send, close };
      elicitationSubscribers.add(subscriber);

      // On client disconnect
      (c.req.raw as any).signal?.addEventListener?.("abort", () => {
        elicitationSubscribers.delete(subscriber);
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

// Endpoint for UI to respond to elicitation
elicitation.post("/respond", async (c) => {
  try {
    const body = await c.req.json();
    const { requestId, action, content } = body as {
      requestId: string;
      action: "accept" | "decline" | "cancel";
      content?: Record<string, unknown>;
    };
    if (!requestId || !action) {
      return c.json({ error: "Missing requestId or action" }, 400);
    }

    const response: ElicitResult =
      action === "accept"
        ? { action: "accept", content: content ?? {} }
        : { action };

    const ok = c.mcpClientManager.respondToElicitation(requestId, response);
    if (!ok) {
      return c.json({ error: "Unknown or expired requestId" }, 404);
    }

    // Optional: notify completion
    broadcastElicitation({ type: "elicitation_complete", requestId });

    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e?.message || "Failed to respond" }, 400);
  }
});

export default elicitation;
