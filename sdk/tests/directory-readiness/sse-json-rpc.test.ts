import { describe, expect, it } from "vitest";
import { readSseJsonRpc } from "../../src/directory-readiness/discovery.js";

/** An event stream that sends `frames` and then stays open. */
function openStream(frames: unknown[]): Response {
  const events = frames
    .map((frame) => `event: message\ndata: ${JSON.stringify(frame)}\n\n`)
    .join("");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(events));
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const NOTIFICATION = { jsonrpc: "2.0", method: "notifications/progress" };
const SERVER_REQUEST = { jsonrpc: "2.0", id: 7, method: "ping" };
const RESPONSE = { jsonrpc: "2.0", id: 7, result: {} };

describe("readSseJsonRpc", () => {
  it("returns the first message when no request id is given", async () => {
    await expect(
      readSseJsonRpc(openStream([NOTIFICATION, RESPONSE])),
    ).resolves.toEqual(NOTIFICATION);
  });

  it("returns the response to the request id, past notifications and server requests", async () => {
    await expect(
      readSseJsonRpc(
        openStream([NOTIFICATION, SERVER_REQUEST, RESPONSE]),
        undefined,
        7,
      ),
    ).resolves.toEqual(RESPONSE);
  });

  it("returns nothing from a closed stream that never answered the request", async () => {
    const closed = new Response(
      `data: ${JSON.stringify(NOTIFICATION)}\n\ndata: ${JSON.stringify(SERVER_REQUEST)}`,
      { headers: { "content-type": "text/event-stream" } },
    );
    await expect(readSseJsonRpc(closed, undefined, 7)).resolves.toBeUndefined();
  });
});
