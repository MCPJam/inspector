import { Hono } from "hono";
import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import {
  broadcastElicitationComplete,
  ensureElicitationCallback,
  getElicitationHub,
} from "../../services/elicitation-hub";

const elicitation = new Hono();

// Ensure callback is registered for this manager instance.
elicitation.use("*", async (c, next) => {
  ensureElicitationCallback(c.mcpClientManager);
  await next();
});

// SSE stream for elicitation events
elicitation.get("/stream", async (c) => {
  const hub = getElicitationHub(c.mcpClientManager);
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

      const subscriber = { send, close } as const;
      const unsubscribe = hub.subscribe(subscriber);

      // On client disconnect
      (c.req.raw as any).signal?.addEventListener?.("abort", () => {
        unsubscribe();
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

    broadcastElicitationComplete(c.mcpClientManager, requestId);

    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e?.message || "Failed to respond" }, 400);
  }
});

export default elicitation;
