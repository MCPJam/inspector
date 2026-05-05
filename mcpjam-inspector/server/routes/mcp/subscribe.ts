import { Hono } from "hono";
import type { InspectorCommand } from "@/shared/inspector-command.js";
import { inspectorCommandBus } from "../../services/inspector-command-bus.js";

const subscribe = new Hono();

subscribe.get("/", async (c) => {
  const encoder = new TextEncoder();
  const clientId =
    c.req.query("clientId") ??
    `client_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unregistered = false;
      let unregister = () => {};
      const send = (command: InspectorCommand) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(command)}\n\n`),
        );
      };

      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {}
      }, 15_000);

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        try {
          controller.close();
        } catch {}
      };

      const supersede = () => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode("event: superseded\ndata: {}\n\n"));
        } catch {}
      };

      const unregisterOnce = () => {
        if (unregistered) return;
        unregistered = true;
        unregister();
      };

      const onAbort = () => {
        unregisterOnce();
        close();
      };

      controller.enqueue(encoder.encode("retry: 1500\n\n"));
      if (c.req.raw.signal.aborted) {
        close();
        return;
      }

      unregister = inspectorCommandBus.registerSubscriber({
        clientId,
        send,
        supersede,
        close,
      });

      if (c.req.raw.signal.aborted) {
        onAbort();
        return;
      }

      c.req.raw.signal.addEventListener("abort", onAbort, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

export default subscribe;
