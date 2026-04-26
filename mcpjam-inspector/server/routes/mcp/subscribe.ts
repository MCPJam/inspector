import { Hono } from "hono";
import type { InspectorCommand } from "@/shared/inspector-command.js";
import { inspectorCommandBus } from "../../services/inspector-command-bus.js";

const subscribe = new Hono();

subscribe.get("/", async (c) => {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
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
        clearInterval(keepAlive);
        try {
          controller.close();
        } catch {}
      };

      controller.enqueue(encoder.encode("retry: 1500\n\n"));
      const unregister = inspectorCommandBus.registerSubscriber({ send, close });

      c.req.raw.signal.addEventListener("abort", () => {
        unregister();
        close();
      });
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
