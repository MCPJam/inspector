import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openWebMcpFrameStream } from "../frame-stream-connection";
import {
  encodeFrameStreamRecord,
  FRAME_STREAM_KIND,
} from "@/shared/browserd-frame-stream";

/**
 * Every bitmap the shared reader produced, so a test can assert the releases
 * the pane's memory story depends on.
 *
 * jsdom has no `createImageBitmap`; this stands in for the browser's image
 * pipeline, and its asynchrony is the point — a frame reaches `onFrame` a
 * microtask after the message, not synchronously.
 */
interface FakeBitmap {
  closed: boolean;
  close(): void;
}
let bitmaps: FakeBitmap[] = [];
beforeEach(() => {
  bitmaps = [];
  vi.stubGlobal("createImageBitmap", async () => {
    const bitmap: FakeBitmap = {
      closed: false,
      close() {
        this.closed = true;
      },
    };
    bitmaps.push(bitmap);
    return bitmap;
  });
});

/** Let a decode (and any record queued behind it) settle. */
async function decoded(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

function harness() {
  const ws = {
    readyState: WebSocket.OPEN,
    binaryType: "",
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
  const onFrame = vi.fn();
  const onInputSent = vi.fn();
  const onInputAck = vi.fn();
  const connection = openWebMcpFrameStream({
    sessionId: "s",
    token: "test",
    baseUrl: "ws://localhost",
    wsFactory: () => ws,
    onFrame,
    onInputSent,
    onInputAck,
    onClose: vi.fn(),
    inputAckTimeoutMs: 100,
  });
  const message = (data: unknown) =>
    ws.onmessage?.call(ws, { data } as MessageEvent);
  const control = (data: unknown) => message(JSON.stringify(data));
  return {
    connection,
    ws,
    onFrame,
    onInputSent,
    onInputAck,
    control,
    enable: () => control({ type: "capabilities", features: ["input"] }),
    /** Push one frame record; `await` the harness to let it decode. */
    frame(seq: number) {
      const bytes = encodeFrameStreamRecord({
        kind: FRAME_STREAM_KIND.frame,
        deviceWidth: 100,
        deviceHeight: 100,
        scale: 1,
        ts: 1,
        seq,
        jpeg: new Uint8Array([1, 2]),
      });
      message(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      );
    },
    disconnect() {
      ws.onclose?.call(ws, { code: 1006, reason: "" } as CloseEvent);
    },
  };
}
const wheel = [{ kind: "wheel" as const, x: 10, y: 10, deltaX: 0, deltaY: 12 }];
afterEach(() => vi.useRealTimers());

describe("Node WebMCP frame connection", () => {
  it("decodes a burst down to the newest picture, and delivers the last one", async () => {
    const h = harness();
    // A burst arriving faster than the image pipeline can decode. The shared
    // reader keeps ONE decode in flight and ONE newest pending record, so what
    // reaches the pane is the current picture rather than a backlog — and the
    // FINAL frame is never the one dropped, because a settled page sends no
    // other.
    for (let i = 1; i <= 30; i++) h.frame(i);
    expect(h.onFrame).not.toHaveBeenCalled();
    await decoded();
    const delivered = h.onFrame.mock.calls.map((call) => call[0].seq);
    expect(delivered.length).toBeLessThan(30);
    expect(delivered.at(-1)).toBe(30);
    h.connection.close();
  });

  it("drops a record older than the picture already delivered", async () => {
    const h = harness();
    h.frame(10);
    await decoded();
    h.frame(9);
    await decoded();
    expect(h.onFrame.mock.calls.map((call) => call[0].seq)).toEqual([10]);
    h.connection.close();
  });

  it("closes the bitmap a newer frame replaces, and the last one on close", async () => {
    const h = harness();
    h.frame(1);
    await decoded();
    h.frame(2);
    await decoded();
    // An ImageBitmap holds a decoded surface the garbage collector cannot see
    // the cost of. The CONNECTION owns them, because it is the thing that
    // knows when the stream is over.
    expect(bitmaps.map((b) => b.closed)).toEqual([true, false]);
    h.connection.close();
    expect(bitmaps.every((b) => b.closed)).toBe(true);
  });

  it("releases the held bitmap when live view stops, without closing the socket", async () => {
    const h = harness();
    h.frame(1);
    await decoded();
    h.connection.clearFrame();
    expect(bitmaps.every((b) => b.closed)).toBe(true);
    // A screencast toggle follows tab visibility; a handshake per flip is pure
    // cost.
    expect(h.ws.close).not.toHaveBeenCalled();
  });

  it.each(["close", "disconnect"] as const)(
    "delivers nothing decoded after %s",
    async (action) => {
      const h = harness();
      h.frame(1);
      if (action === "close") h.connection.close();
      else h.disconnect();
      await decoded();
      h.frame(2);
      await decoded();
      expect(h.onFrame).not.toHaveBeenCalled();
      // And the surface decoded for a socket that had already gone is released
      // rather than leaked.
      expect(bitmaps.every((b) => b.closed)).toBe(true);
    },
  );

  it("drops the socket on a record it cannot make sense of", () => {
    const h = harness();
    // There is no framing marker to resynchronise against, so a reader that
    // has lost its place can never find it again.
    const corrupt = encodeFrameStreamRecord({
      kind: FRAME_STREAM_KIND.frame,
      deviceWidth: 100,
      deviceHeight: 100,
      scale: 1,
      ts: 1,
      seq: 1,
      jpeg: new Uint8Array([1, 2]),
    });
    corrupt[1] = 9;
    h.ws.onmessage?.call(h.ws, {
      data: corrupt.buffer.slice(
        corrupt.byteOffset,
        corrupt.byteOffset + corrupt.byteLength,
      ),
    } as MessageEvent);
    expect(h.ws.close).toHaveBeenCalled();
  });

  it("falls back until the server advertises input, then awaits the matching ack", async () => {
    const h = harness();
    expect(h.connection.sendInput(wheel)).toBeUndefined();
    h.enable();
    const pending = h.connection.sendInput(wheel)!;
    const done = vi.fn();
    void pending.then(done);
    expect(h.ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "input", seq: 1, events: wheel }),
    );
    h.control({ type: "input_ack", seq: 2, dispatched: 1 });
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    h.control({ type: "input_ack", seq: 1, dispatched: 1 });
    await pending;
    expect(h.onInputSent).toHaveBeenCalledWith(1);
    expect(h.onInputAck).toHaveBeenCalledWith(1);
    h.connection.close();
  });

  it("surfaces a refusal and does not replay input", async () => {
    const h = harness();
    h.enable();
    const pending = h.connection.sendInput(wheel)!;
    h.control({
      type: "input_ack",
      seq: 1,
      dispatched: 0,
      refused: "overloaded",
    });
    await expect(pending).rejects.toThrow("refused");
    expect(h.ws.send).toHaveBeenCalledTimes(1);
    h.connection.close();
  });

  it("rejects interrupted input as uncertain and allows no replay on that socket", async () => {
    const h = harness();
    h.enable();
    const pending = h.connection.sendInput(wheel)!;
    h.disconnect();
    await expect(pending).rejects.toThrow("may already have executed");
    expect(h.connection.sendInput(wheel)).toBeUndefined();
    expect(h.ws.send).toHaveBeenCalledTimes(1);
  });

  it("times out a missing acknowledgement without replaying the gesture", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.enable();
    const pending = h.connection.sendInput(wheel)!;
    const rejection = expect(pending).rejects.toThrow("not replayed");
    await vi.advanceTimersByTimeAsync(101);
    await rejection;
    expect(h.ws.close).not.toHaveBeenCalled();
    // The FRAME stream survives an input timeout: pixels and gestures fail
    // independently.
    h.frame(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onFrame).toHaveBeenCalledOnce();
    // A repeated capability announcement must not re-enable timed-out input.
    h.enable();
    expect(h.ws.send).toHaveBeenCalledOnce();
    expect(h.connection.sendInput(wheel)).toBeUndefined();
  });
});
