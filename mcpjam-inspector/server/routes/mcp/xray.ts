/**
 * X-Ray endpoint - SSE stream for AI request inspection.
 *
 * Provides real-time streaming of X-ray events that capture what messages
 * are sent to AI models (generateText/streamText calls).
 */

import { Hono } from "hono";
import { xrayLogBus } from "../../services/xray-log-bus";
import type { XRayLogEvent } from "@/shared/xray-types";

const xray = new Hono();

/**
 * GET /api/mcp/xray/stream
 *
 * SSE endpoint for X-ray events.
 * Sends the latest event on connect, then streams new events as they arrive.
 */
xray.get("/stream", async (c) => {
  console.log("[xray] SSE connection request received");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      console.log("[xray] SSE stream started");
      const send = (data: unknown) => {
        try {
          console.log("[xray] Sending event to SSE client");
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // Ignore encoding errors
        }
      };

      // Send the latest event if it exists
      try {
        const latest = xrayLogBus.getLatest();
        if (latest) {
          console.log("[xray] Sending latest event");
          // Use eventType to avoid overwriting with evt.type
          send({ ...latest, eventType: "xray" });
        }
      } catch {
        // Ignore errors
      }

      // Subscribe to live events
      const unsubscribe = xrayLogBus.subscribe((evt: XRayLogEvent) => {
        console.log("[xray] Received event from bus, forwarding to SSE");
        // Use eventType to avoid overwriting with evt.type
        send({ ...evt, eventType: "xray" });
      });

      // Keepalive comments every 15 seconds
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
        } catch {
          // Ignore keepalive errors
        }
      }, 15000);

      // Cleanup on client disconnect
      c.req.raw.signal.addEventListener("abort", () => {
        try {
          clearInterval(keepalive);
          unsubscribe();
        } catch {
          // Ignore cleanup errors
        }
        try {
          controller.close();
        } catch {
          // Ignore close errors
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "*",
    },
  });
});

export default xray;
