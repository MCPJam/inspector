import { Hono } from "hono";
import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";
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
export function initElicitationCallback(manager: MCPClientManager): void {
  // Use WeakSet to track registration per manager instance
  // This handles hot reload scenarios where a new manager is created
  if (registeredManagers.has(manager)) return;

  // Per MCP Tasks spec (2025-11-25), elicitations related to a task include relatedTaskId
  manager.setElicitationCallback(
    ({ requestId, message, schema, relatedTaskId }) => {
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
