import { Hono } from "hono";
import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";

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

let isCallbackRegistered = false;

// Ensure manager callback gets registered exactly once on first request
elicitation.use("*", async (c, next) => {
  if (!isCallbackRegistered) {
    const manager = c.mcpClientManager;
    manager.setElicitationCallback(({ requestId, message, schema }) => {
      return new Promise<ElicitResult>((resolve, reject) => {
        try {
          manager.getPendingElicitations().set(requestId, { resolve, reject });
        } catch {}
        broadcastElicitation({
          type: "elicitation_request",
          requestId,
          message,
          schema,
          timestamp: new Date().toISOString(),
        });
      });
    });
    isCallbackRegistered = true;
  }
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
