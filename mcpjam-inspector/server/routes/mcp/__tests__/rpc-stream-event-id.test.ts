import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import servers from "../servers";
import { rpcLogBus } from "../../../services/rpc-log-bus";

/**
 * The wire contract of the Logs SSE: every frame carries the bus-assigned
 * `eventId`.
 *
 * This is the ONLY link that carries identity from the bus to the browser, and
 * it is carried implicitly — the route spreads the whole event into the frame
 * (`send({ type, ...evt })`). A refactor that made `send` pick fields
 * explicitly would drop `eventId` and silently reintroduce duplicate rows in
 * the Logs panel, with every store-level test still green. So these drive the
 * REAL route and parse the REAL serialized `data:` frames rather than
 * hand-building the wire object.
 *
 * Both `send` call sites are covered, because they are separate lines: the
 * replay-buffer seeding inside `start()`, and the live `rpcLogBus.subscribe`
 * listener.
 */

function streamApp(serverIds: string[]) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    // What the real server's middleware injects (server/index.ts). Only
    // `listServers` is reached by the /rpc/stream handler.
    (c as unknown as { mcpClientManager: unknown }).mcpClientManager = {
      listServers: () => serverIds,
    };
    await next();
  });
  app.route("/", servers);
  return app;
}

/** Parse `count` SSE `data:` frames off the live response body, then hang up. */
async function readFrames(
  response: Response,
  count: number
): Promise<Array<Record<string, any>>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Array<Record<string, any>> = [];
  let buffered = "";

  try {
    while (frames.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let boundary = buffered.indexOf("\n\n");
      while (boundary !== -1) {
        const chunk = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        // Keepalive comments (`: keepalive ...`) are not frames.
        if (chunk.startsWith("data: ")) {
          frames.push(JSON.parse(chunk.slice("data: ".length)));
        }
        boundary = buffered.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel();
  }

  return frames;
}

function frame(serverId: string, jsonRpcId: number) {
  return {
    serverId,
    direction: "send" as const,
    timestamp: new Date().toISOString(),
    message: { jsonrpc: "2.0", id: jsonRpcId, method: "tools/call" },
  };
}

function exchange(serverId: string) {
  return {
    kind: "http" as const,
    serverId,
    timestamp: new Date().toISOString(),
    exchange: {
      serverId,
      request: {
        method: "POST",
        url: "https://stateless.mcpjam.com/mcp",
        headers: { "mcp-method": "tools/call" },
      },
      response: {
        status: 200,
        statusText: "OK",
        headers: { "cf-ray": "a2504a801d1e99a0" },
      },
      durationMs: 22,
    },
  };
}

describe("GET /rpc/stream carries eventId onto the wire", () => {
  it("stamps replayed frames (the ?replay= seeding path)", async () => {
    const serverId = `replay-wire-${crypto.randomUUID()}`;
    // Published BEFORE the stream opens, so these can only reach the client
    // through the replay-buffer `send` inside `start()`.
    rpcLogBus.publish(frame(serverId, 14));
    rpcLogBus.publish(exchange(serverId));

    const response = await streamApp([serverId]).request(
      "/rpc/stream?replay=2"
    );
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    const frames = await readFrames(response, 2);
    expect(frames.map((f) => f.type)).toEqual(["rpc", "http"]);

    // The bus is the source of truth for what the ids should be.
    const expectedIds = rpcLogBus
      .getBuffer([serverId], -1)
      .map((event) => event.eventId);
    expect(expectedIds).toHaveLength(2);
    expect(frames.map((f) => f.eventId)).toEqual(expectedIds);
    for (const f of frames) {
      expect(typeof f.eventId).toBe("string");
      expect(f.eventId.length).toBeGreaterThan(0);
    }
  });

  it("stamps live frames (the subscribe path)", async () => {
    const serverId = `live-wire-${crypto.randomUUID()}`;

    // replay=0 so nothing can be seeded — every frame below arrives through
    // the live subscription's own `send`.
    const response = await streamApp([serverId]).request(
      "/rpc/stream?replay=0"
    );

    rpcLogBus.publish(frame(serverId, 14));
    rpcLogBus.publish(exchange(serverId));

    const frames = await readFrames(response, 2);
    expect(frames.map((f) => f.type)).toEqual(["rpc", "http"]);

    const expectedIds = rpcLogBus
      .getBuffer([serverId], -1)
      .map((event) => event.eventId);
    expect(frames.map((f) => f.eventId)).toEqual(expectedIds);
    for (const f of frames) {
      expect(typeof f.eventId).toBe("string");
      expect(f.eventId.length).toBeGreaterThan(0);
    }
  });

  it("gives a replayed frame the SAME eventId it had when it was live", async () => {
    // The whole point: a client that saw the live frame and then reconnects
    // must recognize the replayed copy as the same event.
    const serverId = `same-id-${crypto.randomUUID()}`;

    const live = streamApp([serverId]);
    const liveResponse = await live.request("/rpc/stream?replay=0");
    rpcLogBus.publish(frame(serverId, 14));
    const [liveFrame] = await readFrames(liveResponse, 1);

    // Reconnect: a fresh stream seeds from the replay buffer.
    const replayResponse = await streamApp([serverId]).request(
      "/rpc/stream?replay=1"
    );
    const [replayedFrame] = await readFrames(replayResponse, 1);

    expect(typeof liveFrame.eventId).toBe("string");
    expect(liveFrame.eventId.length).toBeGreaterThan(0);
    expect(replayedFrame.eventId).toBe(liveFrame.eventId);
    // ...and it is genuinely the same event, not just an equal id.
    expect(replayedFrame.message).toEqual(liveFrame.message);
  });

  it("gives two identical-looking frames different eventIds on the wire", async () => {
    const serverId = `distinct-wire-${crypto.randomUUID()}`;
    const response = await streamApp([serverId]).request(
      "/rpc/stream?replay=0"
    );

    // Same method, same JSON-RPC id — a retry, or two rounds of one MRTR flow.
    // These must stay two rows in the panel.
    rpcLogBus.publish(frame(serverId, 14));
    rpcLogBus.publish(frame(serverId, 14));

    const frames = await readFrames(response, 2);
    expect(frames).toHaveLength(2);
    expect(frames[0].eventId).not.toBe(frames[1].eventId);
  });
});
